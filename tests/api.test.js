import test from 'node:test';import assert from 'node:assert/strict';
import {server} from '../src/server.js';
test('HTTP: health, origin rejection, validation, example conversion and file download',async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  assert.equal((await fetch(base+'/api/health')).status,200);
  assert.equal((await fetch(base+'/api/health',{headers:{Origin:'https://evil.com'}})).status,403);
  assert.equal((await fetch(base+'/api/stickers/extract',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:'https://evil.com'})})).status,400);
  const submitted=await fetch(base+'/api/examples/convert',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(submitted.status,202);const j=await submitted.json();
  let result;const deadline=Date.now()+60000;
  do{result=await(await fetch(base+`/api/jobs/${j.id}`)).json();if(!['queued','running'].includes(result.status))break;await new Promise(r=>setTimeout(r,50))}while(Date.now()<deadline);
  assert.equal(result.status,'succeeded');assert.equal(result.result.sourceMode,'saved_example');assert.equal(result.result.output.frames,51);
  const download=await fetch(base+result.result.stickerFile);const bytes=Buffer.from(await download.arrayBuffer());assert.equal(download.status,200);assert.equal(bytes.toString('ascii',8,12),'WEBP');
  assert.equal((await fetch(base+'/files/../../.env')).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
