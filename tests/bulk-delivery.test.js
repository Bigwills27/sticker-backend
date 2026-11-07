import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createTestPool} from './support/pglite-pool.mjs';
import {createStore,migrate} from '../src/database.js';
import {createVault} from '../src/security.js';
import {createBatchStore} from '../src/batch-store.js';
import {createWhatsAppBatches,selectBatchCandidates} from '../src/whatsapp-batches.js';

const source='https://www.tiktok.com/@example/video/123';
const candidates=Array.from({length:11},(_,index)=>({id:index.toString(16).padStart(24,'0'),type:'sticker',available:true,mediaUrl:`https://p16.tiktokcdn.com/${index}.webp`}));
const discovery={status:'needs_selection',inputUrl:source,result:{candidates}};
const selection={url:source,candidateIds:candidates.slice(0,2).map(item=>item.id)};

test('bulk selection enforces the cap and validates every selected sticker against its discovery',()=>{
 assert.equal(selectBatchCandidates(selection,discovery).length,2);
 assert.throws(()=>selectBatchCandidates({...selection,candidateIds:candidates.map(item=>item.id)},discovery),{code:'BATCH_LIMIT'});
 assert.throws(()=>selectBatchCandidates({...selection,candidateIds:['foreign']},discovery),{code:'INVALID_SELECTION'});
 assert.throws(()=>selectBatchCandidates({...selection,url:'https://www.tiktok.com/@other/video/9'},discovery),{code:'INVALID_SELECTION'});
 assert.throws(()=>selectBatchCandidates(selection,{...discovery,result:{candidates:[{...candidates[0],type:'photo'},candidates[1]]}}),{code:'INVALID_SELECTION'});
 assert.throws(()=>selectBatchCandidates(selection,{...discovery,result:{candidates:[{...candidates[0],available:false},candidates[1]]}}),{code:'INVALID_SELECTION'});
});

test('persistent batch queue delivers in order, deduplicates submission and stores no phone number',async()=>{
 const pool=createTestPool(),vault=createVault(randomBytes(32).toString('base64')),store=createStore(pool,vault),batchStore=createBatchStore(pool,vault);
 const sent=[],downloaded=[];let release,gate=null;
 const runtime={status:()=>({status:'connected'}),async sendToNumber({tokenHash,phoneNumber}){
  const request=await store.claimRequest(tokenHash,store.hashRecipient(phoneNumber.slice(1)+'@s.whatsapp.net'));
  assert.ok(request);sent.push(request.sticker.toString());if(gate)await gate;
  await store.finishRequest(request.id,'delivered','fixture');return {status:'delivered'};
 }};
 const options={store,batchStore,runtime,download:async url=>{downloaded.push(url);return Buffer.from(url)},convert:async bytes=>({bytes}),};
 const queue=createWhatsAppBatches(options);
 const input={...selection,discoveryJobId:'a'.repeat(32),requestId:'b'.repeat(32),phoneNumber:'202 555 0123',country:'US'};
 const create=()=>queue.create(input,'fixture-ip',async()=>selectBatchCandidates(input,discovery));
 try{
  await migrate(pool);const batch=await create();assert.equal(batch.items.length,2);assert.equal((await create()).id,batch.id);
  assert.ok((await pool.query('SELECT source_ciphertext FROM ss_whatsapp_batch_items')).rows.every(row=>row.source_ciphertext.startsWith('v1.')&&!row.source_ciphertext.includes('tiktokcdn')));
  await assert.rejects(()=>queue.create({...input,candidateIds:[candidates[0].id]},'fixture-ip',async()=>[candidates[0]]),{code:'REQUEST_MISMATCH'});
  gate=new Promise(resolve=>{release=resolve});const working=queue.tick();
  while(sent.length<1)await new Promise(resolve=>setTimeout(resolve,5));
  await queue.tick();assert.equal(sent.length,1,'a second tick cannot start another delivery');
  release();gate=null;await working;await queue.tick();
  const finished=await queue.status(batch.id);assert.equal(finished.status,'completed');assert.deepEqual(finished.items.map(item=>item.status),['sent','sent']);
  assert.deepEqual(downloaded,candidates.slice(0,2).map(item=>item.mediaUrl));assert.deepEqual(sent,downloaded);
  const records=await pool.query('SELECT * FROM ss_whatsapp_batches');
  assert.ok(!JSON.stringify(records.rows).includes('2025550123'));assert.ok(!JSON.stringify(records.rows).includes('202 555'));
  assert.equal((await pool.query('SELECT source_ciphertext FROM ss_whatsapp_batch_items')).rows.every(row=>row.source_ciphertext===null),true);
  assert.equal((await create()).id,batch.id);await queue.tick();assert.equal(sent.length,2);
 }finally{release?.();await queue.close();await pool.end();}
});

test('cancelled items do not send and resuming after restart requires the original number',async()=>{
 const pool=createTestPool(),vault=createVault(randomBytes(32).toString('base64')),store=createStore(pool,vault),batchStore=createBatchStore(pool,vault);
 const runtime={status:()=>({status:'connected'}),sendToNumber:async()=>assert.fail('cancelled queue must never send')};
 const queue=createWhatsAppBatches({store,batchStore,runtime}),input={...selection,discoveryJobId:'a'.repeat(32),requestId:'c'.repeat(32),phoneNumber:'+12025550123',country:'US'};
 let restarted;
 try{
  await migrate(pool);const batch=await queue.create(input,'fixture-ip',async()=>selectBatchCandidates(input,discovery));await queue.close();
  restarted=createWhatsAppBatches({store,batchStore,runtime});assert.equal((await restarted.status(batch.id)).needsNumber,true);
  await assert.rejects(()=>restarted.resume(batch.id,{phoneNumber:'+442079460018',country:'GB'}),{code:'RECIPIENT_MISMATCH'});
  await restarted.resume(batch.id,{phoneNumber:'+12025550123',country:'US'});assert.equal((await restarted.status(batch.id)).needsNumber,false);
  const stopped=await restarted.stop(batch.id);assert.equal(stopped.status,'stopped');assert.ok(stopped.items.every(item=>item.status==='stopped'));
  await restarted.tick();assert.equal((await pool.query('SELECT count(*)::int AS count FROM ss_sticker_requests')).rows[0].count,0);
 }finally{await restarted?.close();await pool.end();}
});

test('an exclusive database lease prevents two batch workers claiming simultaneously',async()=>{
 const pool=createTestPool(),vault=createVault(randomBytes(32).toString('base64')),batchStore=createBatchStore(pool,vault);
 try{await migrate(pool);assert.equal(await batchStore.acquire('one'),true);assert.equal(await batchStore.acquire('two'),false);await batchStore.release('one');assert.equal(await batchStore.acquire('two'),true);await batchStore.release('two');}finally{await pool.end();}
});
test('restart cleanup reconciles a confirmed delivery before failing stale batch items',async()=>{
 const pool=createTestPool(),vault=createVault(randomBytes(32).toString('base64')),store=createStore(pool,vault),batchStore=createBatchStore(pool,vault);
 const queue=createWhatsAppBatches({store,batchStore,runtime:{status:()=>({status:'connected'})}});
 try{
  await migrate(pool);const input={...selection,discoveryJobId:'a'.repeat(32),requestId:'d'.repeat(32),phoneNumber:'+12025550123',country:'US'};
  const batch=await queue.create(input,'fixture-ip',async()=>selectBatchCandidates(input,discovery));
  await batchStore.acquire('crashed-worker');const item=await batchStore.next('crashed-worker',[batch.id]),recipientHash=store.hashRecipient('12025550123@s.whatsapp.net');
  const delivery=await store.prepareDirectRequest(item.delivery_token_hash,recipientHash,Buffer.from('sticker'));
  await store.claimRequest(item.delivery_token_hash,recipientHash);await store.finishRequest(delivery.id,'delivered','confirmed-before-crash');
  await batchStore.setState(item.id,'sending');await pool.query("UPDATE ss_whatsapp_batch_items SET updated_at=now()-interval '6 minutes' WHERE id=$1",[item.id]);
  await store.cleanup();assert.equal((await queue.status(batch.id)).items[0].status,'sent');
 }finally{await queue.close();await pool.end();}
});
test('batch admission reserves per-sticker quotas atomically and retries do not spend them twice',async()=>{
 const pool=createTestPool(),vault=createVault(randomBytes(32).toString('base64')),store=createStore(pool,vault),batchStore=createBatchStore(pool,vault);
 const queue=createWhatsAppBatches({store,batchStore,runtime:{status:()=>({status:'connected'})}});
 try{
  await migrate(pool);const input={url:source,discoveryJobId:'a'.repeat(32),requestId:'e'.repeat(32),candidateIds:candidates.slice(0,10).map(item=>item.id),phoneNumber:'+12025550123',country:'US'};
  const first=await queue.create(input,'fixture-ip',async()=>selectBatchCandidates(input,discovery));assert.equal((await queue.create(input,'fixture-ip',async()=>assert.fail('idempotent retry must not refetch'))).id,first.id);
  await assert.rejects(()=>queue.create({...input,requestId:'f'.repeat(32),candidateIds:[candidates[0].id]},'fixture-ip',async()=>[candidates[0]]),{code:'SEND_LIMIT'});
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ss_whatsapp_batches')).rows[0].count,1);
  assert.equal((await pool.query("SELECT count FROM ss_rate_limits WHERE key='whatsapp-global'")).rows[0].count,10);
 }finally{await queue.close();await pool.end();}
});
