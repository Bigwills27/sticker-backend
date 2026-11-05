import {zipSync,strToU8} from 'fflate';
import {AppError,inspect} from './media.js';

const safeName=value=>String(value||'comment').replace(/[^a-z0-9_-]/gi,'_').slice(0,60);

export async function createMediaBundle(candidates,{videoId,download,onProgress=()=>{},maxBytes=100*1024*1024,timeoutMs=180000}={}){
 const entries=Object.create(null),results=new Array(candidates.length),deadline=Date.now()+timeoutMs;
 let next=0,totalBytes=0,completed=0,fatal=null;
 const controller=new AbortController();
 const timeoutError=()=>new AppError('BUNDLE_TIMEOUT','Preparing these files took too long. Try selecting fewer files.',504);
 const timer=setTimeout(()=>{fatal=fatal||timeoutError();controller.abort();},timeoutMs);
 const checkDeadline=()=>{if(!fatal&&Date.now()>=deadline){fatal=timeoutError();controller.abort();}if(fatal)throw fatal;};
 try{await Promise.all(Array.from({length:Math.min(3,candidates.length)},async()=>{
  while(next<candidates.length&&!fatal){
   if(Date.now()>=deadline){fatal=timeoutError();controller.abort();break;}
   const index=next++,candidate=candidates[index];
   try{
    const bytes=await download(candidate.mediaUrl,{signal:controller.signal});checkDeadline();
    const metadata=await inspect(bytes);checkDeadline();
    if(totalBytes+bytes.length>maxBytes)throw new AppError('BUNDLE_TOO_LARGE','This selection exceeds the 100 MB download limit. Select fewer files.',413);
    totalBytes+=bytes.length;
    const ext=metadata.format==='jpeg'?'jpg':metadata.format;
    const name=`${safeName(candidate.type)}_${safeName(candidate.author)}_${safeName(candidate.commentId)}_${safeName(candidate.id)}.${ext}`;
    entries[name]=bytes;
    results[index]={file:{id:candidate.id,commentId:candidate.commentId,type:candidate.type,author:candidate.author,name,mimeType:`image/${metadata.format}`,bytes:bytes.length}};
   }catch(error){
    if(['BUNDLE_TOO_LARGE','BUNDLE_TIMEOUT'].includes(error.code)){fatal=fatal||error;controller.abort();}
    results[index]={failure:{id:candidate.id,commentId:candidate.commentId,type:candidate.type,code:error.code||'DOWNLOAD_FAILED',message:error instanceof AppError?error.message:'This file could not be downloaded.'}};
   }
   completed++;onProgress({completed,total:candidates.length});
  }
 }));}finally{clearTimeout(timer);}
 checkDeadline();
 if(fatal)throw fatal;
 const files=results.flatMap(result=>result?.file?[result.file]:[]);
 const failed=results.flatMap(result=>result?.failure?[result.failure]:[]);
 if(!files.length)throw new AppError('BUNDLE_EMPTY','None of these files could be downloaded. Their links may have expired. Scan the video again.',502);
 const report={videoId,requestedCount:candidates.length,downloadedCount:files.length,files,failed,partial:failed.length>0,totalBytes};
 entries['download-report.json']=strToU8(JSON.stringify(report,null,2));
 const bytes=zipSync(entries,{level:0});checkDeadline();return {bytes,report};
}
