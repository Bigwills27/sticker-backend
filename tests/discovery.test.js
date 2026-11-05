import test from 'node:test';
import assert from 'node:assert/strict';
import { identifiers } from '../src/media.js';
import { resolveTikTokUrl, scanComments, extractCommentMedia } from '../src/discovery.js';

const videoId='7703938702157860118', commentId='7704357278421992213';
const videoUrl=`https://www.tiktok.com/@kirstygallagher4/video/${videoId}`;
const media='https://p16-tiktok-dm-sticker-sign-sg.ibyteimg.com/sticker.awebp';
const photo='https://p16-comment-sign-sg.tiktokcdn.com/original.jpeg';
const sticker=(cid=commentId,aweme_id=videoId)=>({cid,aweme_id,text:'She’s like',user:{unique_id:'oneizi'},content_type:3,cmt_sticker_struct:{animated_url:{high_resolution_url:{url_list:[media]}}}});
const page=(comments,cursor=50,has_more=0,total=comments.length)=>({status_code:0,comments,cursor,has_more,total});
const target={videoId,commentId,resolvedUrl:`${videoUrl}?share_comment_id=${commentId}`};

function diagnosticEnv(t,enabled){
 const before=process.env.DISCOVERY_DEBUG,commit=process.env.RENDER_GIT_COMMIT;
 if(enabled)process.env.DISCOVERY_DEBUG='1';else delete process.env.DISCOVERY_DEBUG;
 process.env.RENDER_GIT_COMMIT='test-deploy';
 t.after(()=>{if(before===undefined)delete process.env.DISCOVERY_DEBUG;else process.env.DISCOVERY_DEBUG=before;if(commit===undefined)delete process.env.RENDER_GIT_COMMIT;else process.env.RENDER_GIT_COMMIT=commit;});
 return t.mock.method(console,'info',()=>{});
}

test('opt-in logs identify missing upstream sticker payload without exposing comment data',async t=>{
 const log=diagnosticEnv(t,true);
 const result=await scanComments(target,{readPage:async()=>page([{cid:commentId,aweme_id:videoId,content_type:17,text:'private comment',user:{unique_id:'private user'}}])});
 assert.equal(result.matchStatus,'media_unavailable');
 assert.equal(log.mock.callCount(),1);
 const output=log.mock.calls[0].arguments[0];
 assert.ok(output.startsWith('[sticker-discovery] '));
 const report=JSON.parse(output.slice('[sticker-discovery] '.length));
 assert.equal(report.stickerPresent,false);assert.equal(report.renderCommit,'test-deploy');
 assert.equal(report.commentId,commentId);assert.deepEqual(report.mediaFields,[]);
 assert.ok(!output.includes('private comment')&&!output.includes('private user'));
});

test('missing-media logs reveal rejected CDN hosts without signed URLs',async t=>{
 const log=diagnosticEnv(t,true);
 const comment=sticker();comment.cmt_sticker_struct.animated_url.high_resolution_url.url_list=['https://cdn.example.org/private-path.webp?signature=SECRET'];
 await scanComments(target,{readPage:async()=>page([comment])});
 assert.equal(log.mock.callCount(),1);
 const output=log.mock.calls[0].arguments[0];
 const report=JSON.parse(output.slice('[sticker-discovery] '.length));
 assert.equal(report.stickerPresent,true);
 assert.ok(report.mediaFields.some(field=>field.host==='cdn.example.org'&&field.accepted===false));
 assert.ok(!output.includes('SECRET')&&!output.includes('private-path'));
});

test('missing-media diagnostics are disabled by default',async t=>{
 const log=diagnosticEnv(t,false);
 await scanComments(target,{readPage:async()=>page([{cid:commentId,aweme_id:videoId,content_type:17}])});
 assert.equal(log.mock.callCount(),0);
});

test('recognizes supported comment URL forms without rounding 64-bit IDs',()=>{
 for(const key of ['share_comment_id','comment_id','cid'])assert.deepEqual(identifiers(`${videoUrl}?${key}=${commentId}`),{videoId,commentId});
 assert.deepEqual(identifiers(`https://m.tiktok.com/v/${videoId}.html?cid=${Buffer.from(commentId).toString('base64')}`),{videoId,commentId});
 assert.throws(()=>identifiers(`${videoUrl}?comment_id=invalid`),e=>e.code==='INVALID_COMMENT_ID');
 assert.throws(()=>identifiers(`${videoUrl}?comment_id=${commentId}&share_comment_id=123`),e=>e.code==='INVALID_COMMENT_ID');
});

test('preserves the comment identifier through redirects which strip query parameters',async()=>{
 const result=await resolveTikTokUrl('https://vt.tiktok.com/example/',{request:async url=>new Response('',{status:302,headers:{location:url.includes('vt.tiktok')?`${videoUrl}?share_comment_id=${commentId}`:videoUrl}})});
 assert.equal(result.commentId,commentId);assert.equal(result.videoId,videoId);
});

test('rejects redirects outside TikTok',async()=>{
 await assert.rejects(()=>resolveTikTokUrl('https://vt.tiktok.com/example/',{request:async()=>new Response('',{status:302,headers:{location:'https://unrelated.test/'}})}),e=>e.code==='UNSUPPORTED_URL');
});

test('extracts original sticker/photo URLs and keeps comment provenance',()=>{
 const c=sticker();c.image_list=[{origin_url:{url_list:[photo]},crop_url:{url_list:[`${photo}?thumbnail`]}}];
 const rows=extractCommentMedia(c,videoId);assert.equal(rows.length,2);
 assert.deepEqual(rows.map(r=>r.type),['sticker','photo']);assert.equal(rows[1].mediaUrl,photo);
 assert.ok(rows.every(r=>r.commentId===commentId&&r.videoId===videoId&&r.author==='oneizi'&&r.available));
 assert.deepEqual(extractCommentMedia(sticker(commentId,'999'),videoId),[]);
});

test('represents newer type-17 stickers with missing media honestly',()=>{
 const rows=extractCommentMedia({cid:commentId,aweme_id:videoId,content_type:17,text:'[Sticker] She’s like'},videoId);
 assert.equal(rows.length,1);assert.equal(rows[0].type,'sticker');assert.equal(rows[0].available,false);assert.equal(rows[0].mediaUrl,null);
});

test('extracts the newer type-17 original instead of its thumbnail',()=>{
 const comment={...sticker(),content_type:17};
 comment.cmt_sticker_struct.animated_url.low_resolution_url={url_list:['https://test.ibyteimg.com/thumbnail.webp']};
 const [row]=extractCommentMedia(comment,videoId);assert.equal(row.available,true);assert.equal(row.mediaUrl,media);assert.equal(row.commentId,commentId);
});

test('extracts sticker URLs from nested payload variants',()=>{
 const comment={...sticker(),cmt_sticker_struct:{animated_url:{high_resolution_url:{url:media}}}};
 const [row]=extractCommentMedia(comment,videoId);
 assert.equal(row.mediaUrl,media);assert.equal(row.available,true);
});

test('rejects empty or conflicting duplicate comment IDs',()=>{
 assert.throws(()=>identifiers(`${videoUrl}?comment_id=`),e=>e.code==='INVALID_COMMENT_ID');
 assert.throws(()=>identifiers(`${videoUrl}?comment_id=123&comment_id=456`),e=>e.code==='INVALID_COMMENT_ID');
});

test('a duplicate placeholder does not discard previously retrieved original media',async()=>{
 const result=await scanComments({...target,commentId:null},{readPage:async q=>q.cursor===0?page([sticker()],50,1,1):page([{cid:commentId,aweme_id:videoId,content_type:17}],100,0,1)});
 assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].mediaUrl,media);assert.equal(result.candidates[0].available,true);
});

test('never accepts avatars or unrelated URLs as comment media',()=>{
 assert.deepEqual(extractCommentMedia({cid:commentId,aweme_id:videoId,text:'hello',user:{avatar_thumb:{url_list:[photo]}}},videoId),[]);
 const c=sticker();c.cmt_sticker_struct.animated_url.high_resolution_url.url_list=['https://unrelated.test/image.webp'];
 assert.ok(extractCommentMedia(c,videoId).every(r=>!r.available));
});

test('exact comment lookup never returns other commenters’ stickers',async()=>{
 const result=await scanComments(target,{readPage:async()=>page([sticker('111'),sticker()])});
 assert.equal(result.scope,'comment');assert.equal(result.exactCommentMatched,true);
 assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].commentId,commentId);
 assert.equal(result.matchedComment.author,'oneizi');
});

test('distinguishes a matched but unavailable sticker from a comment without media',async()=>{
 const result=await scanComments(target,{readPage:async()=>page([{cid:commentId,aweme_id:videoId,text:'[Sticker] She’s like',content_type:17}])});
 assert.equal(result.exactCommentMatched,true);assert.equal(result.matchStatus,'media_unavailable');assert.equal(result.candidates[0].available,false);
 const textOnly=await scanComments(target,{readPage:async()=>page([{cid:commentId,aweme_id:videoId,text:'hello',content_type:1}])});
 assert.equal(textOnly.matchStatus,'no_media');assert.deepEqual(textOnly.candidates,[]);
});

test('missing exact comment never falls back to video candidates',async()=>{
 const result=await scanComments(target,{readPage:async()=>page([sticker('111')],50,0,149)});
 assert.equal(result.exactCommentMatched,false);assert.equal(result.matchStatus,'not_retrieved');assert.deepEqual(result.candidates,[]);
 assert.equal(result.coverage.complete,false);
});

test('video scans paginate, deduplicate comments, retain repeated artwork and photos',async()=>{
 const calls=[];
 const result=await scanComments({...target,commentId:null},{readPage:async q=>{
  calls.push(q.cursor);
  return q.cursor===0?page([sticker('111')],50,1,3):page([sticker('111'),sticker('222'),{cid:'333',aweme_id:videoId,image_list:[{origin_url:{url_list:[photo]}}]}],100,0,3);
 }});
 assert.deepEqual(calls,[0,50]);assert.equal(result.scope,'video');assert.equal(result.candidates.length,3);
 assert.equal(result.counts.sticker,2);assert.equal(result.counts.photo,1);assert.equal(result.coverage.complete,true);
 assert.notEqual(result.candidates[0].id,result.candidates[1].id);
});

test('video scans paginate replies and reject comments belonging to other videos',async()=>{
 const calls=[];
 const result=await scanComments({...target,commentId:null},{readPage:async q=>{
  calls.push(q);
  if(!q.parentCommentId)return page([{...sticker('111'),reply_comment_total:1},sticker('bad','999')],50,0,2);
  return page([sticker('222')],50,0,1);
 }});
 assert.equal(calls.length,2);assert.equal(calls[1].parentCommentId,'111');
 assert.deepEqual(result.candidates.map(c=>c.commentId),['111','222']);
 assert.equal(result.coverage.complete,false);
});

test('detects stalled cursors without looping or claiming full coverage',async()=>{
 let calls=0;
 const result=await scanComments({...target,commentId:null},{readPage:async()=>{calls++;return page([sticker('111')],0,1,100)}});
 assert.equal(calls,1);assert.equal(result.coverage.complete,false);assert.equal(result.coverage.stopReason,'stalled_cursor');
});

test('keeps partial results if a later page is blocked',async()=>{
 let calls=0;
 const result=await scanComments({...target,commentId:null},{readPage:async()=>{if(calls++)throw new Error('blocked');return page([sticker('111')],50,1,100)}});
 assert.equal(result.candidates.length,1);assert.equal(result.coverage.complete,false);assert.equal(result.coverage.stopReason,'source_unavailable');
});

test('a missing/failed comments response is not treated as an empty video',async()=>{
 await assert.rejects(()=>scanComments({...target,commentId:null},{readPage:async()=>({status_code:0})}),e=>e.code==='DISCOVERY_BLOCKED');
 await assert.rejects(()=>scanComments({...target,commentId:null},{readPage:async()=>({status_code:1,comments:[]})}),e=>e.code==='DISCOVERY_BLOCKED');
});

test('request limit returns explicit incomplete coverage',async()=>{
 const result=await scanComments({...target,commentId:null},{maxPages:1,readPage:async()=>page([sticker('111')],50,1,500)});
 assert.equal(result.coverage.complete,false);assert.equal(result.coverage.stopReason,'scan_limit');
});

test('omitted replies prevent a complete-coverage claim',async()=>{
 const result=await scanComments({...target,commentId:null},{readPage:async q=>q.parentCommentId?page([sticker('222')],50,0,5):page([{...sticker('111'),reply_comment_total:5}],50,0,1)});
 assert.equal(result.coverage.complete,false);assert.equal(result.coverage.stopReason,'comments_not_exposed');
});

test('an unavailable reply thread does not prevent scanning other threads',async()=>{
 const calls=[];
 const result=await scanComments({...target,commentId:null},{readPage:async q=>{
  calls.push(q.parentCommentId);
  if(!q.parentCommentId)return page([{...sticker('10'),reply_comment_total:1},{...sticker('11'),reply_comment_total:1}],50,0,2);
  if(q.parentCommentId==='10')throw new Error('Thread unavailable');
  return page([sticker('21')],50,0,1);
 }});
 assert.deepEqual(calls,[null,'10','11']);assert.ok(result.candidates.some(c=>c.commentId==='21'));assert.equal(result.coverage.complete,false);
});
