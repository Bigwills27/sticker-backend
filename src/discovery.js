import { createHash } from 'node:crypto';
import { AppError, classifyUrl, identifiers } from './media.js';

const blocked=()=>new AppError('DISCOVERY_BLOCKED','TikTok did not return readable comment data. Try again later; no example or unrelated sticker has been substituted.',502);
const request=(url)=>fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});

export async function resolveTikTokUrl(input,{request:send=request}={}){
 let current=input,commentId=null;
 for(let hop=0;hop<8;hop++){
  if(classifyUrl(current)!=='comment')throw new AppError('INVALID_URL','Paste a TikTok comment or video link.');
  const ids=identifiers(current);
  if(commentId&&ids.commentId&&commentId!==ids.commentId)throw new AppError('INVALID_COMMENT_ID','TikTok redirected to a different comment. Copy the comment link again.');
  commentId=commentId||ids.commentId;
  if(ids.videoId)return {...ids,commentId,resolvedUrl:current};
  const response=await send(current);
  const location=response.headers.get('location');
  await response.body?.cancel();
  if(!location||response.status<300||response.status>=400)throw new AppError('VIDEO_NOT_IDENTIFIED','This link did not resolve to a TikTok video. Copy its share link again.');
  current=new URL(location,current).href;
 }
 throw new AppError('REDIRECT_LIMIT','This TikTok link redirected too many times. Copy its full video or comment URL.');
}

function mediaUrl(value){
 if(typeof value==='string'){try{return classifyUrl(value)==='media'?value:null}catch{return null}}
 if(Array.isArray(value)){for(const item of value){const url=mediaUrl(item);if(url)return url}return null}
 if(value&&typeof value==='object'){for(const item of Object.values(value)){const url=mediaUrl(item);if(url)return url}}
 return null;
}

function logMissingMedia(comment,{videoId,commentId}){
 if(process.env.DISCOVERY_DEBUG!=='1')return;
 const sticker=comment.cmt_sticker_struct;
 const mediaFields=[];
 function inspect(value,path,depth=0){
  if(depth>8||mediaFields.length>=30)return;
  if(typeof value==='string'&&/^https?:\/\//.test(value)){
   try{
    const url=new URL(value);let accepted=false;
    try{accepted=classifyUrl(value)==='media'}catch{}
    mediaFields.push({path,host:url.hostname,accepted});
   }catch{}
  }else if(value&&typeof value==='object'){
   for(const [key,child]of Object.entries(value))inspect(child,`${path}.${key}`,depth+1);
  }
 }
 inspect(sticker,'cmt_sticker_struct');
 console.info('[sticker-discovery] '+JSON.stringify({
  event:'matched_media_unavailable',renderCommit:process.env.RENDER_GIT_COMMIT||null,
  videoId,commentId,contentType:comment.content_type,
  stickerPresent:!!sticker,stickerKeys:Object.keys(sticker||{}),
  animatedKeys:Object.keys(sticker?.animated_url||{}),staticKeys:Object.keys(sticker?.static_url||{}),mediaFields,
 }));
}

export function extractCommentMedia(comment,videoId){
 if(String(comment.aweme_id)!==videoId||typeof comment.cid!=='string'||!/^\d+$/.test(comment.cid))return [];
 const base={commentId:comment.cid,videoId,author:comment.user?.unique_id||comment.user?.nickname||null,text:comment.text||'',parentCommentId:comment.reply_id&&comment.reply_id!=='0'?comment.reply_id:null};
 const rows=[];
 const add=(type,url,index)=>rows.push({...base,id:createHash('sha256').update(`${videoId}:${comment.cid}:${type}:${index}`).digest('hex').slice(0,24),type,mediaUrl:url,available:!!url});
 const sticker=comment.cmt_sticker_struct;
 if(sticker){
  const groups=[sticker.animated_url,sticker.static_url];let url=null;
  for(const group of groups){for(const size of ['high_resolution_url','mid_resolution_url','low_resolution_url']){url=mediaUrl(group?.[size]);if(url)break;}if(url)break;}
  add('sticker',url,0);
 }else if(comment.content_type===17||/^\[Sticker\]/i.test(comment.text||''))add('sticker',null,0);
 for(const [index,image]of (comment.image_list||[]).entries())add('photo',mediaUrl(image.origin_url),index);
 return rows;
}

async function readTikTokPage({videoId,parentCommentId,commentId,cursor,signal}){
 const url=new URL(parentCommentId?'https://www.tiktok.com/api/comment/list/reply/':'https://www.tiktok.com/api/comment/list/');
 // Current mobile response includes original media for newer type-17 stickers.
 // Without the version/platform fields TikTok returns only a "[Sticker]" marker.
 url.search=new URLSearchParams({aid:'1233',version_code:'420000',version_name:'42.0.0',device_platform:'android',[parentCommentId?'item_id':'aweme_id']:videoId,count:'50',cursor:String(cursor),...(parentCommentId?{comment_id:parentCommentId}:commentId&&cursor===0?{insert_ids:commentId}:{})}).toString();
 const response=await fetch(url,{redirect:'error',headers:{'Accept':'application/json','Accept-Language':'en-US,en;q=0.9','User-Agent':'Mozilla/5.0 (Linux; Android 13; Pixel 7)','Referer':'https://www.tiktok.com/'},signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 if(!response.ok)throw blocked();
 const text=await response.text();
 if(text.length>12*1024*1024)throw blocked();
 try{return JSON.parse(text)}catch{throw blocked()}
}

export async function scanComments(target,{readPage=readTikTokPage,maxPages=200,signal=AbortSignal.timeout(Number(process.env.DISCOVERY_TIMEOUT_MS||150000))}={}){
 const {videoId,commentId}=target;
 const comments=new Map(),candidates=new Map(),replyQueue=[],queuedReplies=new Set(),replyTotals=new Map();
 let requests=0,total=null,stopReason=null,topExhausted=false,matchedComment=null,repliesExhausted=true;
 const remember=(comment,parentCommentId=null)=>{
  if(String(comment.aweme_id)!==videoId||typeof comment.cid!=='string')return;
  if(parentCommentId)comment={...comment,reply_id:parentCommentId};
  if(!comments.has(comment.cid))comments.set(comment.cid,comment);
  for(const row of extractCommentMedia(comment,videoId)){
   if(!candidates.get(row.id)?.available||row.available)candidates.set(row.id,row);
  }
  if(comment.cid===commentId)matchedComment=comment;
  if(Number(comment.reply_comment_total)>0&&!queuedReplies.has(comment.cid)){
   queuedReplies.add(comment.cid);replyQueue.push(comment.cid);
  }
  if(Number(comment.reply_comment_total)>0)replyTotals.set(comment.cid,Math.max(replyTotals.get(comment.cid)||0,Number(comment.reply_comment_total)));
  for(const reply of comment.reply_comment||[])remember(reply,comment.cid);
 };
 async function paginate(parentCommentId=null){
  let cursor=0;const cursors=new Set();
  while(true){
   if(requests>=maxPages||signal.aborted){stopReason=signal.aborted?'timeout':'scan_limit';return false;}
   cursors.add(String(cursor));requests++;
   let data;
   try{
    data=await readPage({videoId,parentCommentId,commentId,cursor,signal});
    if(data?.status_code!==0||!Array.isArray(data.comments)||![0,1,false,true].includes(data.has_more))throw blocked();
   }catch{
    if(!comments.size&&requests===1)throw blocked();
    stopReason=signal.aborted?'timeout':'source_unavailable';return false;
   }
   if(!parentCommentId&&Number.isFinite(data.total))total=data.total;
   if(parentCommentId&&Number.isFinite(data.total))replyTotals.set(parentCommentId,Math.max(replyTotals.get(parentCommentId)||0,data.total));
   for(const comment of data.comments)remember(comment,parentCommentId);
   if(commentId&&matchedComment)return false;
   if(!data.has_more)return true;
   const next=data.cursor;
   if(next===undefined||next===null||cursors.has(String(next))){stopReason='stalled_cursor';return false;}
   cursor=next;
  }
 }
 topExhausted=await paginate();
 if(!matchedComment){
  for(let i=0;i<replyQueue.length;i++){
   if(signal.aborted||requests>=maxPages||['timeout','scan_limit'].includes(stopReason))break;
   if(!await paginate(replyQueue[i]))repliesExhausted=false;
   if(matchedComment)break;
  }
 }
 const topLevelCount=[...comments.values()].filter(c=>!c.reply_id||c.reply_id==='0').length;
 const replyCounts=new Map();for(const comment of comments.values()){if(comment.reply_id&&comment.reply_id!=='0')replyCounts.set(comment.reply_id,(replyCounts.get(comment.reply_id)||0)+1);}
 const repliesMissing=[...replyTotals].some(([id,count])=>(replyCounts.get(id)||0)<count);
 const commentsMissing=total!==null&&topLevelCount<total;
 const coverage={scannedComments:comments.size,reportedComments:total,complete:topExhausted&&repliesExhausted&&!stopReason&&!commentsMissing&&!repliesMissing,stopReason:stopReason||(topExhausted&&(commentsMissing||repliesMissing)?'comments_not_exposed':null),requests};
 const selected=[...candidates.values()].filter(row=>!commentId||row.commentId===commentId);
 const counts={sticker:selected.filter(r=>r.type==='sticker').length,photo:selected.filter(r=>r.type==='photo').length,unavailable:selected.filter(r=>!r.available).length};
 const matchStatus=!commentId?null:!matchedComment?'not_retrieved':!selected.length?'no_media':selected.some(r=>r.available)?'matched':'media_unavailable';
 if(matchStatus==='media_unavailable')logMissingMedia(matchedComment,{videoId,commentId});
 return {videoId,commentId,resolvedUrl:target.resolvedUrl,videoUrl:`https://www.tiktok.com/@/video/${videoId}`,provider:'tiktok-public-comments',scope:commentId?'comment':'video',exactCommentMatched:!!matchedComment,matchStatus,matchedComment:matchedComment?{id:matchedComment.cid,author:matchedComment.user?.unique_id||matchedComment.user?.nickname||null,text:matchedComment.text||''}:null,candidates:selected,counts,coverage};
}

export async function discover(url,{scope}={}){
 try{
  const target=await resolveTikTokUrl(url);
  if(scope==='video')target.commentId=null;
  return await scanComments(target);
 }catch(e){if(e instanceof AppError)throw e;throw blocked();}
}
