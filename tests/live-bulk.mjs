/** Explicit live video ZIP audit, preserving original source files. */
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createStickerServer} from '../src/server.js';
import {downloadMedia,inspect} from '../src/media.js';

const url=process.argv[2]||'https://www.tiktok.com/@kirstygallagher4/video/7703938702157860118';
const app=createStickerServer();await new Promise(r=>app.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.address().port}`;
const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,202);return response.json()};
const poll=async id=>{const deadline=Date.now()+240000;while(Date.now()<deadline){const job=await(await fetch(base+`/api/jobs/${id}`)).json();if(!['queued','running'].includes(job.status))return job;await new Promise(r=>setTimeout(r,500));}assert.fail('Live job timed out')};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 const found=await poll((await post('/api/stickers/extract',{url})).id);assert.equal(found.status,'needs_selection');
 const available=found.result.candidates.filter(c=>c.available&&c.mediaUrl);assert.ok(available.length>9);
 const all=await poll((await post('/api/stickers/bundle',{url,discoveryJobId:found.id})).id);assert.equal(all.status,'succeeded');assert.equal(all.result.failed.length,0);assert.equal(all.result.files.length,available.length);
 const response=await fetch(base+all.result.archiveFile);assert.equal(response.headers.get('content-type'),'application/zip');const zip=unzipSync(new Uint8Array(await response.arrayBuffer()));
 const files=[];
 for(const file of all.result.files){
  assert.ok(available.some(candidate=>candidate.id===file.id&&candidate.commentId===file.commentId));
  assert.equal(zip[file.name].length,file.bytes);const metadata=await inspect(Buffer.from(zip[file.name]));assert.equal(file.mimeType,`image/${metadata.format}`);
  files.push({id:file.id,commentId:file.commentId,type:file.type,bytes:file.bytes,sha256:hash(zip[file.name])});
 }
 const chosen=['sticker','photo'].map(type=>available.find(candidate=>candidate.type===type));assert.ok(chosen.every(Boolean));
 const selected=await poll((await post('/api/stickers/bundle',{url,discoveryJobId:found.id,candidateIds:chosen.map(c=>c.id)})).id);assert.equal(selected.status,'succeeded');assert.equal(selected.result.files.length,2);
 const selectedZip=unzipSync(new Uint8Array(await(await fetch(base+selected.result.archiveFile)).arrayBuffer()));
 for(const candidate of chosen){const file=selected.result.files.find(file=>file.id===candidate.id);assert.equal(hash(selectedZip[file.name]),hash(await downloadMedia(candidate.mediaUrl)));}
 const report={checkedAt:new Date().toISOString(),videoId:found.result.videoId,downloadedCount:all.result.files.length,stickers:files.filter(f=>f.type==='sticker').length,photos:files.filter(f=>f.type==='photo').length,failures:all.result.failed,selectedOriginalsVerified:2,files};
 await mkdir(new URL('../../qa/',import.meta.url),{recursive:true});await writeFile(new URL('../../qa/live-bulk.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,files:undefined}));
}finally{await new Promise(r=>app.close(r))}
