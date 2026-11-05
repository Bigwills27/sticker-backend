import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class AppError extends Error { constructor(code,message,status=400){super(message);this.code=code;this.status=status;} }
export function classifyUrl(value){
 let u;try{u=new URL(value)}catch{throw new AppError('INVALID_URL','Paste a complete TikTok comment link.');}
 if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')) throw new AppError('INVALID_URL','Use an HTTPS link without credentials or a custom port.');
 const h=u.hostname.toLowerCase();
 if(h==='tiktok.com'||h.endsWith('.tiktok.com'))return 'comment';
 if(['ibyteimg.com','tiktokcdn.com','tiktokcdn-us.com'].some(d=>h.endsWith('.'+d)))return 'media';
 throw new AppError('UNSUPPORTED_URL','This version accepts TikTok links and TikTok sticker media links.');
}
export function identifiers(value){
 const u=new URL(value);
 const ids=['share_comment_id','comment_id','cid'].flatMap(k=>u.searchParams.getAll(k)).map(value=>{
  if(/^\d+$/.test(value))return value;
  const decoded=Buffer.from(value,'base64url').toString('utf8');
  if(/^\d+$/.test(decoded))return decoded;
  throw new AppError('INVALID_COMMENT_ID','This link contains an invalid comment ID. Copy the comment link again.');
 });
 if(new Set(ids).size>1)throw new AppError('INVALID_COMMENT_ID','This link contains conflicting comment IDs. Copy the comment link again.');
 const videoId=u.pathname.match(/\/(?:video|photo|v)\/(\d+)/)?.[1]||u.searchParams.get('share_item_id');
 return {videoId:videoId||null,commentId:ids[0]||null};
}
const unsafeAddress = a => a==='::1'||a==='::'||a.startsWith('fc')||a.startsWith('fd')||a.startsWith('fe80:')||a.includes('::ffff:')||/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|224\.|240\.)/.test(a);
export async function downloadMedia(url,{signal}={}){
 if(classifyUrl(url)!=='media')throw new AppError('INVALID_MEDIA_URL','A direct sticker media URL is required.');
 const aborted=()=>new AppError('DOWNLOAD_ABORTED','The download was cancelled.');
 if(signal?.aborted)throw aborted();
 try{const ips=await lookup(new URL(url).hostname,{all:true});if(ips.some(x=>unsafeAddress(x.address)))throw new AppError('UNSAFE_HOST','The media URL must point to a public host.');}
 catch(e){if(e instanceof AppError)throw e;if(!process.env.HTTPS_PROXY&&!process.env.https_proxy)throw new AppError('DNS_FAILED','The media host could not be reached.');}
 if(signal?.aborted)throw aborted();
 return new Promise((resolve,reject)=>{
  const max=20*1024*1024;let chunks=[],size=0,done=false,timer;
  const child=spawn('curl',['--fail','--silent','--show-error','--proto','=https','--connect-timeout','10','--max-time','45','--max-filesize',String(max),url]);
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort)};
  const fail=e=>{if(done)return;done=true;cleanup();child.kill();reject(e)};
  const abort=()=>fail(aborted());signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>fail(new AppError('DOWNLOAD_TIMEOUT','The download took too long. Try again.')),50000);
  child.stdout.on('data',c=>{if(done)return;size+=c.length;if(size>max)fail(new AppError('MEDIA_TOO_LARGE','The source exceeds the 20 MB limit.'));else chunks.push(c)});
  child.stderr.resume();child.on('error',()=>fail(new AppError('DOWNLOAD_UNAVAILABLE','Install curl to download source stickers.')));
  child.on('close',code=>{cleanup();if(done)return;done=true;if(code!==0)return reject(new AppError('DOWNLOAD_FAILED','The media could not be downloaded. Its link may have expired.'));resolve(Buffer.concat(chunks));});
 });
}
export async function inspect(buffer){
 try{
  const m=await sharp(buffer,{animated:true,limitInputPixels:80000000}).metadata();
  if(!['webp','gif','png','jpeg'].includes(m.format))throw new Error('format');
  const frames=m.pages||1,height=m.pageHeight||m.height;
  if(frames>300||m.width*height>16000000||m.width*height*frames>80000000)throw new AppError('MEDIA_TOO_COMPLEX','This sticker exceeds the image or frame limit.');
  return {format:m.format,width:m.width,height,frames,animated:frames>1,durationMs:frames>1?(m.delay||[]).reduce((a,b)=>a+b,0):0,frameDurationsMs:frames>1?(m.delay||[]):[],loop:m.loop??0,hasAlpha:!!m.hasAlpha,bytes:buffer.length};
 }catch(e){if(e instanceof AppError)throw e;throw new AppError('INVALID_MEDIA','The link did not return a supported image. Try another sticker.');}
}
export async function convertMedia(buffer){
 if(buffer.length>20*1024*1024)throw new AppError('MEDIA_TOO_LARGE','The source exceeds 20 MB.');
 const original=await inspect(buffer);
 if(original.animated&&(original.durationMs>10000||original.frameDurationsMs.length!==original.frames||original.frameDurationsMs.some(d=>d<8)))throw new AppError('UNSUPPORTED_TIMING','Animations must be 10 seconds or shorter, with frames of at least 8 ms.');
 const limit=(original.animated?500:100)*1024;
 for(const quality of [85,65,45,25]){
  const bytes=await sharp(buffer,{animated:true,limitInputPixels:80000000}).rotate().resize({width:512,height:512,fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).webp({quality,effort:4,loop:original.loop,...(original.animated?{delay:original.frameDurationsMs}:{}),minSize:false}).toBuffer();
  const output=await inspect(bytes);
  const checks={webp:output.format==='webp',dimensions:output.width===512&&output.height===512,size:bytes.length<=limit,animationPreserved:output.animated===original.animated,timingPreserved:JSON.stringify(output.frameDurationsMs)===JSON.stringify(original.frameDurationsMs),loopPreserved:!original.animated||output.loop===original.loop,alphaPreserved:!original.hasAlpha||output.hasAlpha};
  if(Object.values(checks).every(Boolean))return {bytes,metadata:{original,output,checks,quality,validated:true,deviceImportTested:false}};
 }
 throw new AppError('CONVERSION_LIMIT','This sticker cannot fit the output limits while preserving its animation.');
}

export async function prepareMedia(buffer,{type='sticker'}={}){
 if(type==='photo')return {bytes:null,metadata:{original:await inspect(buffer),validated:true}};
 try{return await convertMedia(buffer)}catch(error){
  if(!['CONVERSION_LIMIT','UNSUPPORTED_TIMING'].includes(error.code))throw error;
  return {bytes:null,metadata:{original:await inspect(buffer),validated:true,conversionUnavailable:{code:error.code,message:'The original file is ready. A smaller sticker cannot meet the conversion limits while preserving this animation.'}}};
 }
}
