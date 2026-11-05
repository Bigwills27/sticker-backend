import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {unzipSync,strFromU8} from 'fflate';
import {createStickerServer} from '../src/server.js';
import {createMediaBundle} from '../src/bundle.js';

const url='https://www.tiktok.com/@test/video/123';
const sticker={id:'sticker',commentId:'456',videoId:'123',author:'../../oneizi',text:'Hello',type:'sticker',available:true,mediaUrl:'https://test.ibyteimg.com/sticker'};
const photo={...sticker,id:'photo',commentId:'789',type:'photo',mediaUrl:'https://test.ibyteimg.com/photo'};
const other={...photo,id:'other',commentId:'999',mediaUrl:'https://test.ibyteimg.com/other'};
const unavailable={...sticker,id:'unavailable',available:false,mediaUrl:null};
const bytes=await sharp({create:{width:60,height:40,channels:4,background:'#148040'}}).png().toBuffer();

async function withApi(run,{download=async()=>bytes}={}){
 const app=createStickerServer({discoverMedia:async()=>({videoId:'123',scope:'video',commentId:null,exactCommentMatched:false,candidates:[sticker,photo,other,unavailable]}),download});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {...await r.json(),httpStatus:r.status}};
 const poll=async id=>{for(let i=0;i<1000;i++){const job=await(await fetch(base+`/api/jobs/${id}`)).json();if(!['queued','running'].includes(job.status))return job;await new Promise(r=>setTimeout(r,10));}assert.fail('Job did not finish')};
 try{const found=await poll((await post('/api/stickers/extract',{url})).id);await run({base,post,poll,found})}finally{await new Promise(r=>app.close(r))}
}

test('bulk selected ZIP contains only the chosen original sticker and photo bytes',async()=>{
 await withApi(async({base,post,poll,found})=>{
  const submitted=await post('/api/stickers/bundle',{url,discoveryJobId:found.id,candidateIds:['sticker','photo']});assert.equal(submitted.httpStatus,202);
  const job=await poll(submitted.id);assert.equal(job.status,'succeeded');assert.equal(job.result.requestedCount,2);assert.equal(job.result.files.length,2);assert.deepEqual(job.result.failed,[]);
  const response=await fetch(base+job.result.archiveFile);assert.equal(response.headers.get('content-type'),'application/zip');
  const archive=unzipSync(new Uint8Array(await response.arrayBuffer()));
  for(const file of job.result.files){assert.equal(file.name.includes('..'),false);assert.equal(file.name.includes('/'),false);assert.deepEqual(Buffer.from(archive[file.name]),bytes)}
  assert.deepEqual(job.result.files.map(f=>f.commentId).sort(),['456','789']);
  assert.equal(JSON.parse(strFromU8(archive['download-report.json'])).downloadedCount,2);
 });
});

test('bulk all includes both tabs and skips unavailable files',async()=>{
 await withApi(async({post,poll,found})=>{
  const job=await poll((await post('/api/stickers/bundle',{url,discoveryJobId:found.id})).id);
  assert.equal(job.status,'succeeded');assert.equal(job.result.files.length,3);assert.equal(job.result.requestedCount,3);assert.equal(job.result.partial,false);
  assert.deepEqual(job.result.files.map(f=>f.id).sort(),['other','photo','sticker']);
 });
});

test('bulk validates selections against the original discovery and input link',async()=>{
 await withApi(async({post,found})=>{
  const valid={url,discoveryJobId:found.id};
  for(const body of [{...valid,url:url+'?different=1'},{...valid,discoveryJobId:'missing'},{...valid,candidateIds:[]},{...valid,candidateIds:null},{...valid,candidateIds:'sticker'},{...valid,candidateIds:['invented']},{...valid,candidateIds:['unavailable']}]){
   const response=await post('/api/stickers/bundle',body);assert.equal(response.httpStatus,400);
  }
 });
});

test('bulk deduplicates selected IDs without dropping distinct comments',async()=>{
 await withApi(async({post,poll,found})=>{
  const job=await poll((await post('/api/stickers/bundle',{url,discoveryJobId:found.id,candidateIds:['sticker','sticker','photo']})).id);
  assert.equal(job.status,'succeeded');assert.equal(job.result.files.length,2);assert.equal(job.result.requestedCount,2);
 });
});

test('bulk returns successful originals and explicitly reports failed downloads',async()=>{
 await withApi(async({base,post,poll,found})=>{
  const job=await poll((await post('/api/stickers/bundle',{url,discoveryJobId:found.id})).id);
  assert.equal(job.status,'succeeded');assert.equal(job.result.partial,true);assert.equal(job.result.files.length,2);assert.equal(job.result.failed.length,1);assert.equal(job.result.failed[0].id,'photo');
  const archive=unzipSync(new Uint8Array(await(await fetch(base+job.result.archiveFile)).arrayBuffer()));
  assert.equal(JSON.parse(strFromU8(archive['download-report.json'])).failed[0].id,'photo');
 },{download:async source=>{if(source===photo.mediaUrl)throw new Error('Expired');return bytes}});
});

test('bulk fails honestly when every file is unavailable or is not an image',async()=>{
 await withApi(async({post,poll,found})=>{
  const job=await poll((await post('/api/stickers/bundle',{url,discoveryJobId:found.id})).id);
  assert.equal(job.status,'failed');assert.equal(job.error.code,'BUNDLE_EMPTY');assert.equal(job.result,undefined);
 },{download:async()=>Buffer.from('<html>not media</html>')});
});

test('bulk deadline also rejects a final download that completes too late',async()=>{
 await assert.rejects(()=>createMediaBundle([sticker],{videoId:'123',timeoutMs:5,download:async()=>{await new Promise(r=>setTimeout(r,30));return bytes}}),error=>error.code==='BUNDLE_TIMEOUT');
});

test('bulk aborts an in-flight download at its deadline',async()=>{
 let aborted=false;
 await assert.rejects(()=>createMediaBundle([sticker],{videoId:'123',timeoutMs:10,download:async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Aborted'))},{once:true}))}),error=>error.code==='BUNDLE_TIMEOUT');
 assert.equal(aborted,true);
});

test('bulk rejects an oversized archive instead of returning a truncated collection',async()=>{
 await assert.rejects(()=>createMediaBundle([sticker],{videoId:'123',maxBytes:1,download:async()=>bytes}),error=>error.code==='BUNDLE_TOO_LARGE');
});
