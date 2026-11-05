import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import * as api from '../src/server.js';

const url='https://www.tiktok.com/@test/video/123?share_comment_id=456';
const row={id:'candidate',commentId:'456',videoId:'123',author:'oneizi',text:'She’s like',type:'sticker',available:true,mediaUrl:'https://test.ibyteimg.com/sticker.webp'};
const discovery={videoId:'123',commentId:'456',scope:'comment',exactCommentMatched:true,matchStatus:'matched',matchedComment:{id:'456',author:'oneizi',text:'She’s like'},candidates:[row]};
const input=await sharp({create:{width:60,height:40,channels:4,background:'#148040'}}).png().toBuffer();

async function withApi(discoverMedia,run,downloadBytes=input){
 assert.equal(typeof api.createStickerServer,'function','The server needs an injectable discovery boundary');
 const app=api.createStickerServer({discoverMedia,download:async()=>downloadBytes});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${app.address().port}`;
 const post=async body=>{const r=await fetch(base+'/api/stickers/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {...await r.json(),httpStatus:r.status}};
 const poll=async id=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const d=await(await fetch(base+`/api/jobs/${id}`)).json();if(!['queued','running'].includes(d.status))return d;await new Promise(r=>setTimeout(r,15));}assert.fail('Job did not finish')};
 try{await run({post,poll,base})}finally{await new Promise(r=>app.close(r))}
}

test('HTTP: exact match automatically converts only its media and retains provenance',async()=>{
 await withApi(async()=>discovery,async({post,poll,base})=>{
  const submitted=await post({url});assert.equal(submitted.httpStatus,202);
  const job=await poll(submitted.id);assert.equal(job.status,'succeeded');
  assert.equal(job.result.exactCommentMatched,true);assert.equal(job.result.sourceMode,'exact_comment');
  assert.equal(job.result.source.commentId,'456');assert.equal(job.result.source.videoId,'123');assert.equal(job.result.source.author,'oneizi');
  const bytes=Buffer.from(await(await fetch(base+job.result.originalFile)).arrayBuffer());assert.deepEqual(bytes,input);
 });
});

test('HTTP: video selection retains photo type and downloads original bytes',async()=>{
 const photo={...row,type:'photo'};
 await withApi(async()=>({...discovery,scope:'video',commentId:null,exactCommentMatched:false,candidates:[photo]}),async({post,poll,base})=>{
  const first=await poll((await post({url,scope:'video'})).id);assert.equal(first.status,'needs_selection');
  const job=await poll((await post({url,discoveryJobId:first.id,candidateId:photo.id})).id);
  assert.equal(job.status,'succeeded');assert.equal(job.result.source.type,'photo');assert.equal(job.result.exactCommentMatched,false);
  assert.deepEqual(Buffer.from(await(await fetch(base+job.result.originalFile)).arrayBuffer()),input);
 });
});

test('HTTP: unavailable exact comments stay unavailable and reject fabricated selections',async()=>{
 await withApi(async()=>({...discovery,matchStatus:'media_unavailable',candidates:[{...row,available:false,mediaUrl:null}]}),async({post,poll})=>{
  const first=await poll((await post({url})).id);assert.equal(first.status,'needs_selection');assert.equal(first.result.matchStatus,'media_unavailable');
  const selected=await post({url,discoveryJobId:first.id,candidateId:row.id});assert.equal(selected.httpStatus,400);assert.equal(selected.error.code,'MEDIA_UNAVAILABLE');
  assert.equal((await post({url,discoveryJobId:first.id,candidateId:'invented'})).httpStatus,400);
 });
});

test('HTTP: scope must be explicit and valid; selections remain bound to their input link',async()=>{
 let received;
 await withApi(async(_url,options)=>{received=options;return {...discovery,scope:'video',commentId:null,exactCommentMatched:false}},async({post,poll})=>{
  assert.equal((await post({url,scope:'anything'})).httpStatus,400);
  const first=await poll((await post({url,scope:'video'})).id);assert.equal(received.scope,'video');
  assert.equal((await post({url:url+'&extra=1',discoveryJobId:first.id,candidateId:row.id})).httpStatus,400);
 });
});

test('HTTP: refuses an inconsistent discovery result instead of converting another comment',async()=>{
 await withApi(async()=>({...discovery,candidates:[{...row,commentId:'999'}]}),async({post,poll})=>{
  const first=await poll((await post({url})).id);assert.equal(first.status,'failed');assert.equal(first.error.code,'COMMENT_MISMATCH');
 });
});

test('HTTP: conversion limits preserve the matched original for download',async()=>{
 const original=await sharp(await readFile(new URL('../samples/transparent.webp',import.meta.url)),{animated:true}).webp({delay:[6000,6000]}).toBuffer();
 await withApi(async()=>discovery,async({post,poll,base})=>{
  const job=await poll((await post({url})).id);assert.equal(job.status,'succeeded');assert.equal(job.result.stickerFile,null);assert.equal(job.result.exactCommentMatched,true);
  assert.equal(job.result.conversionUnavailable.code,'UNSUPPORTED_TIMING');assert.deepEqual(Buffer.from(await(await fetch(base+job.result.originalFile)).arrayBuffer()),original);
 },original);
});
