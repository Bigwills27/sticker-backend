import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile,writeFile,mkdir,rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AppError,classifyUrl,downloadMedia,prepareMedia } from './media.js';
import { discover } from './discovery.js';
import { createMediaBundle } from './bundle.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir=path.resolve(root,process.env.DATA_DIR||'./data');await mkdir(dataDir,{recursive:true});
export function createStickerServer({discoverMedia=discover,download=downloadMedia}={}){
const jobs=new Map();let active=0;
const origins=new Set((process.env.FRONTEND_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim().replace(/\/+$/,'')).filter(Boolean));
origins.add('http://127.0.0.1:5173');origins.add('http://localhost:4173');origins.add('http://127.0.0.1:4173');
const queue=[];const TTL=60*60*1000;
function publicJob(j){const {inputUrl,...publicFields}=j;return publicFields;}
function json(res,status,body){const data=JSON.stringify(body);res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':Buffer.byteLength(data)});res.end(data);}
async function body(req,maxSize=16384){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>maxSize)throw new AppError('BODY_TOO_LARGE','The request is too large.');chunks.push(c)}try{return JSON.parse(Buffer.concat(chunks).toString())}catch{throw new AppError('INVALID_BODY','Send a valid JSON request.')}}
function submitBundle(input){
 if(jobs.size>=200)throw new AppError('JOB_LIMIT','This local session is full. Restart the backend to continue.',429);
 if(queue.length>=8)throw new AppError('QUEUE_FULL','Please wait for your current download to finish.',429);
 const previous=jobs.get(input?.discoveryJobId);
 if(!previous||previous.status!=='needs_selection'||previous.result?.scope!=='video'||previous.inputUrl!==input.url)throw new AppError('INVALID_SELECTION','These results have expired or do not match your video. Scan the video again.');
 const available=previous.result.candidates.filter(row=>row.available&&row.mediaUrl);
 let candidates=available;
 if(input.candidateIds!==undefined){
  if(!Array.isArray(input.candidateIds)||!input.candidateIds.length||input.candidateIds.some(id=>typeof id!=='string'))throw new AppError('INVALID_SELECTION','Choose at least one available sticker or photo.');
  const byId=new Map(available.map(row=>[row.id,row]));
  candidates=[...new Set(input.candidateIds)].map(id=>{const row=byId.get(id);if(!row)throw new AppError('INVALID_SELECTION','One of the selected files is unavailable or does not belong to these results.');return row;});
 }
 if(!candidates.length)throw new AppError('NO_MEDIA','This scan has no downloadable files.');
 const job={id:randomUUID().replaceAll('-',''),status:'queued',createdAt:Date.now(),inputUrl:input.url};jobs.set(job.id,job);
 queue.push({job,kind:'bundle',candidates,videoId:previous.result.videoId});pump();return publicJob(job);
}
function submit(input,{example=false}={}){
 if(jobs.size>=200)throw new AppError('JOB_LIMIT','This local session is full. Restart the backend to continue.',429);
 if(queue.length>=8)throw new AppError('QUEUE_FULL','Please wait for your current sticker to finish.',429);
 if(!input||typeof input.url!=='string'||input.url.length>8192)throw new AppError('INVALID_URL','Paste a TikTok comment link.');
 if(input.scope!==undefined&&input.scope!=='video')throw new AppError('INVALID_SCOPE','Use a comment link, or choose to browse its video.');
 let kind=example?'example':classifyUrl(input.url),source=input.url,provenance=null;
 if(Boolean(input.candidateId)!==Boolean(input.discoveryJobId))throw new AppError('INVALID_SELECTION','Choose a sticker from your current results.');
 if(input.candidateId){const previous=jobs.get(input.discoveryJobId);const row=previous?.result?.candidates?.find(x=>x.id===input.candidateId);if(!row||previous.inputUrl!==input.url||previous.status!=='needs_selection')throw new AppError('INVALID_SELECTION','This selection has expired. Fetch the comment again.');if(!row.available||!row.mediaUrl)throw new AppError('MEDIA_UNAVAILABLE','TikTok did not expose the original file for this comment.');source=row.mediaUrl;kind='media';provenance={...row,exactCommentMatched:previous.result.scope==='comment'&&previous.result.exactCommentMatched&&previous.result.commentId===row.commentId};}
 const job={id:randomUUID().replaceAll('-',''),status:'queued',createdAt:Date.now(),inputUrl:input.url};jobs.set(job.id,job);
 queue.push({job,source,kind,selected:!!input.candidateId,provenance,scope:input.scope});pump();return publicJob(job);
}
async function pump(){if(active||!queue.length)return;active++;let {job,source,kind,selected,provenance,scope,candidates,videoId}=queue.shift();job.status='running';
 try{
  if(kind==='bundle'){
   job.stage=`Preparing 0 of ${candidates.length} files`;
   const {bytes,report}=await createMediaBundle(candidates,{videoId,download,onProgress:progress=>{job.progress=progress;job.stage=`Preparing ${progress.completed} of ${progress.total} files`;}});
   const folder=path.join(dataDir,job.id);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'media.zip'),bytes);
   job.result={...report,archiveFile:`/files/${job.id}/media.zip`,sourceMode:'bulk_originals'};job.status='succeeded';
  }
  if(kind==='comment') {
   job.stage='Reading TikTok comments';const found=await discoverMedia(source,{scope});
   if(found.candidates.some(row=>row.videoId!==found.videoId||(found.scope==='comment'&&(!found.exactCommentMatched||row.commentId!==found.commentId))))throw new AppError('COMMENT_MISMATCH','The returned media could not be verified against your link. Please try again.',502);
   if(found.scope==='comment'&&found.exactCommentMatched&&found.candidates.length===1&&found.candidates[0].available){
    provenance={...found.candidates[0],exactCommentMatched:true};source=provenance.mediaUrl;kind='media';
   }else{job.result=found;job.status='needs_selection';}
  }
  if(kind!=='comment'&&kind!=='bundle') {
   job.stage=kind==='example'?'Opening saved sticker':'Downloading sticker';
   const original=kind==='example'?await readFile(path.join(root,'samples','animated.webp')):await download(source);
   job.stage=provenance?.type==='photo'?'Preparing original photo':'Converting sticker';
   const {bytes,metadata}=await prepareMedia(original,{type:provenance?.type});
   const folder=path.join(dataDir,job.id);await mkdir(folder,{recursive:true});
   const ext={jpeg:'jpg',png:'png',gif:'gif',webp:'webp'}[metadata.original.format];
   await writeFile(path.join(folder,`original.${ext}`),original);if(bytes)await writeFile(path.join(folder,'sticker.webp'),bytes);
   const exactCommentMatched=!!provenance?.exactCommentMatched;
   const sourceDetails=provenance?{videoId:provenance.videoId,commentId:provenance.commentId,author:provenance.author,text:provenance.text,type:provenance.type}:null;
   job.result={...metadata,originalFile:`/files/${job.id}/original.${ext}`,stickerFile:bytes?`/files/${job.id}/sticker.webp`:null,source:sourceDetails,sourceMode:kind==='example'?'saved_example':exactCommentMatched?'exact_comment':selected?'selected_candidate':'live_media',exactCommentMatched};
   await writeFile(path.join(folder,'metadata.json'),JSON.stringify(job.result,null,2));job.status='succeeded';
  }
 }catch(e){job.status='failed';job.error={code:e.code||'PROCESSING_FAILED',message:e instanceof AppError?e.message:'Something went wrong while processing this sticker. Please try again.'};}
 finally{delete job.stage;active--;pump();}
}
const server=http.createServer(async(req,res)=>{
 const origin=req.headers.origin;
 if(origin&&!origins.has(origin))return json(res,403,{error:{code:'ORIGIN_DENIED',message:'This frontend origin is not configured.'}});
 if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end();}
 try{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET'&&pathname==='/api/health')return json(res,200,{ok:true,version:'1.0.0'});
  if(req.method==='POST'&&pathname==='/api/stickers/extract'){const job=submit(await body(req));return json(res,202,{...job,statusUrl:`/api/jobs/${job.id}`});}
  if(req.method==='POST'&&pathname==='/api/stickers/bundle'){const job=submitBundle(await body(req,512*1024));return json(res,202,{...job,statusUrl:`/api/jobs/${job.id}`});}
  if(req.method==='POST'&&pathname==='/api/examples/convert'){const job=submit({url:'saved-example'},{example:true});return json(res,202,{...job,statusUrl:`/api/jobs/${job.id}`});}
  let m=pathname.match(/^\/api\/jobs\/([a-f0-9]{32})$/);
  if(req.method==='GET'&&m){const j=jobs.get(m[1]);if(!j)throw new AppError('JOB_NOT_FOUND','This result has expired. Please fetch it again.',404);return json(res,200,publicJob(j));}
  m=pathname.match(/^\/files\/([a-f0-9]{32})\/(sticker\.webp|original\.(webp|png|jpg|gif)|metadata\.json|media\.zip)$/);
  if(req.method==='GET'&&m){if(jobs.get(m[1])?.status!=='succeeded')throw new AppError('FILE_NOT_FOUND','This file is no longer available.',404);let bytes;try{bytes=await readFile(path.join(dataDir,m[1],m[2]))}catch{throw new AppError('FILE_NOT_FOUND','This file is no longer available.',404)}res.writeHead(200,{'Content-Type':m[2].endsWith('.zip')?'application/zip':m[2].endsWith('.json')?'application/json':`image/${m[2].endsWith('.jpg')?'jpeg':m[2].split('.').pop()}`,'Content-Length':bytes.length,'Content-Disposition':`attachment; filename="${m[2]}"`,'Cache-Control':'private, max-age=300'});return res.end(bytes);}
  throw new AppError('NOT_FOUND','This endpoint does not exist.',404);
 }catch(e){json(res,e.status||500,{error:{code:e.code||'INTERNAL_ERROR',message:e instanceof AppError?e.message:'The request could not be completed.'}});}
});
server.requestTimeout=30000;
const cleaner=setInterval(()=>{for(const [id,j]of jobs){if(Date.now()-j.createdAt>TTL&&!['queued','running'].includes(j.status)){jobs.delete(id);rm(path.join(dataDir,id),{recursive:true,force:true}).catch(()=>{});}}},60000);cleaner.unref();
server.on('close',()=>clearInterval(cleaner));
return server;
}
export const server=createStickerServer();
if(process.argv[1]===fileURLToPath(import.meta.url))server.listen(Number(process.env.PORT||8080),process.env.HOST||'0.0.0.0',()=>console.log(`Sticker Studio API: http://localhost:${process.env.PORT||8080}`));
