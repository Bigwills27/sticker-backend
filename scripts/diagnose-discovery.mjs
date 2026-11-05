// Read-only probe of the actual discovery code. Run locally and in Render Shell.
// Reports payload structure and CDN hosts, never signed URLs or comment bodies.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { discover, resolveTikTokUrl } from '../src/discovery.js';
import { classifyUrl } from '../src/media.js';

const input=process.argv[2];
if(!input){
 console.error('Usage: npm run diagnose -- "https://vt.tiktok.com/your-comment-link/"');
 process.exit(1);
}
const report={
 node:process.version,
 renderCommit:process.env.RENDER_GIT_COMMIT||null,
 discoverySha256:createHash('sha256').update(await readFile(new URL('../src/discovery.js',import.meta.url))).digest('hex'),
 pages:[],matchedPayloads:[],
};
const originalFetch=globalThis.fetch;
function mediaFields(value,path='cmt_sticker_struct',fields=[]){
 if(typeof value==='string'&&/^https?:\/\//.test(value)){
  try{
   const url=new URL(value);let accepted=false;
   try{accepted=classifyUrl(value)==='media'}catch{}
   fields.push({path,host:url.hostname,accepted});
  }catch{}
 }else if(value&&typeof value==='object'){
  for(const [key,child]of Object.entries(value))mediaFields(child,`${path}.${key}`,fields);
 }
 return fields;
}
try{
 const target=await resolveTikTokUrl(input);
 if(!target.commentId)throw new Error('Use a link containing one exact comment ID.');
 report.target={videoId:target.videoId,commentId:target.commentId};
 globalThis.fetch=async(...args)=>{
  const response=await originalFetch(...args);
  const url=new URL(String(args[0]));
  if(url.hostname==='www.tiktok.com'&&url.pathname.startsWith('/api/comment/')){
   const page={endpoint:url.pathname,cursor:url.searchParams.get('cursor'),httpStatus:response.status};
   report.pages.push(page);
   try{
    const data=await response.clone().json();
    Object.assign(page,{statusCode:data.status_code,commentCount:data.comments?.length??null});
    function inspect(comments){
     for(const comment of comments||[]){
      if(comment.cid===target.commentId&&String(comment.aweme_id)===target.videoId){
       report.matchedPayloads.push({
        contentType:comment.content_type,
        stickerPresent:!!comment.cmt_sticker_struct,
        stickerKeys:Object.keys(comment.cmt_sticker_struct||{}),
        animatedKeys:Object.keys(comment.cmt_sticker_struct?.animated_url||{}),
        staticKeys:Object.keys(comment.cmt_sticker_struct?.static_url||{}),
        mediaFields:mediaFields(comment.cmt_sticker_struct),
       });
      }
      inspect(comment.reply_comment);
     }
    }
    inspect(data.comments);
   }catch{page.readableJson=false}
  }
  return response;
 };
 const result=await discover(`https://www.tiktok.com/@/video/${target.videoId}?share_comment_id=${target.commentId}`);
 report.result={matchStatus:result.matchStatus,exactCommentMatched:result.exactCommentMatched,counts:result.counts,coverage:result.coverage};
}catch(error){
 report.error={code:error.code||'DIAGNOSTIC_FAILED',message:'The probe could not complete. Check page statuses and run the normal extraction for its user-facing error.'};
 process.exitCode=1;
}finally{
 globalThis.fetch=originalFetch;
 console.log(JSON.stringify(report,null,2));
}
