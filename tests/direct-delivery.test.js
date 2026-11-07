import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createTestPool} from './support/pglite-pool.mjs';
import {createStore,migrate,loadBaileysAuth} from '../src/database.js';
import {createVault} from '../src/security.js';
import {createWhatsAppRuntime} from '../src/whatsapp.js';
import {createWhatsAppApi} from '../src/whatsapp-api.js';

test('direct delivery validates, preserves animation, records delivery and deduplicates retries',async context=>{
 const pool=createTestPool(),store=createStore(pool,createVault(randomBytes(32).toString('base64'))),sent=[],lookups=[];let socket,exists=true,finishSend;
 const sticker=Buffer.concat([Buffer.from('RIFF'),Buffer.from([12,0,0,0]),Buffer.from('WEBPANIM'),Buffer.from([0,0,0,0])]);
 const runtime=createWhatsAppRuntime({store,authFactory:owner=>loadBaileysAuth(store,{owner}),recipientHash:jid=>store.hashRecipient(jid),socketFactory:()=>socket={ev:new EventEmitter(),end(){},onWhatsApp:async phone=>{lookups.push(phone);return [{jid:phone+'@s.whatsapp.net',exists}]},sendMessage:async(jid,payload)=>{sent.push({jid,payload});if(finishSend)await finishSend;return {key:{id:'direct-message'}}}}});
 const origin='https://studio.example',handle=createWhatsAppApi({store,auth:{},runtime,origins:new Set([origin])});
 const call=async(input,requestOrigin=origin)=>{let response;await handle({method:'POST',headers:{origin:requestOrigin},socket:{remoteAddress:'127.0.0.1'}},{},'/api/whatsapp/send',{body:async()=>input,json:(_,status,data)=>{response={status,data}},readStickerJob:async()=>sticker});return response};
 const input={jobId:'a'.repeat(32),requestId:'b'.repeat(32),phoneNumber:'0915 973 9013',country:'NG'};
 try{
  await migrate(pool);await runtime.connect();socket.ev.emit('connection.update',{connection:'open'});await new Promise(resolve=>setImmediate(resolve));
  await context.test('invalid format and foreign origins never send',async()=>{
   await assert.rejects(()=>call({...input,phoneNumber:'123'}),{code:'INVALID_PHONE'});await assert.rejects(()=>call(input,'https://other.example'),{code:'ORIGIN_DENIED'});assert.equal(sent.length,0);
  });
  await context.test('normalized number is checked with WhatsApp and receives an animated sticker without a redirect',async()=>{
   const result=await call(input);assert.equal(result.status,200);assert.equal(result.data.status,'delivered');assert.equal(result.data.url,undefined);
   assert.deepEqual(lookups,['2349159739013']);assert.equal(sent[0].jid,'2349159739013@s.whatsapp.net');assert.equal(sent[0].payload.isAnimated,true);assert.deepEqual(sent[0].payload.sticker,sticker);
   const retry=await call({...input,phoneNumber:'+2349159739013'});assert.equal(retry.data.status,'delivered');assert.equal(sent.length,1);assert.equal(lookups.length,1);
   const row=(await pool.query('SELECT status,sticker_ciphertext,recipient_hash FROM ss_sticker_requests')).rows[0];assert.equal(row.status,'delivered');assert.equal(row.sticker_ciphertext,null);assert.ok(!row.recipient_hash.includes('2349159739013'));
  });
  await context.test('non-WhatsApp numbers fail without sending and failed attempts are not silently replayed',async()=>{
   exists=false;const bad={...input,requestId:'c'.repeat(32),country:'GB',phoneNumber:'020 7946 0018'};
   await assert.rejects(()=>call(bad),{code:'NOT_ON_WHATSAPP'});assert.equal(sent.length,1);
   const retry=await call(bad);assert.equal(retry.data.status,'failed');assert.equal(sent.length,1);exists=true;
  });
  await context.test('concurrent copies of a pending request send at most once',async()=>{
   let finish;finishSend=new Promise(resolve=>{finish=resolve});const concurrent={...input,requestId:'d'.repeat(32)};
   const first=call(concurrent);while(sent.length<2)await new Promise(resolve=>setTimeout(resolve,5));
   const duplicate=await call(concurrent);assert.equal(duplicate.status,202);assert.equal(duplicate.data.status,'sending');assert.equal(sent.length,2);finish();await first;finishSend=null;
   assert.equal((await call(concurrent)).data.status,'delivered');assert.equal(sent.length,2);
  });
  await context.test('foreign local numbers are delivered using their own international calling code',async()=>{
   const result=await call({...input,requestId:'e'.repeat(32),country:'US',phoneNumber:'(202) 555-0123'});
   assert.equal(result.data.status,'delivered');assert.equal(sent.at(-1).jid,'12025550123@s.whatsapp.net');assert.equal(lookups.at(-1),'12025550123');
  });
 }finally{await runtime.close();await pool.end();}
});
