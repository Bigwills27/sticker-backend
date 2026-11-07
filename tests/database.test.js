import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createTestPool} from './support/pglite-pool.mjs';
import {createStore,migrate,loadBaileysAuth} from '../src/database.js';
import {createVault,digest,randomToken} from '../src/security.js';

test('Postgres store preserves encrypted auth, ownership and single-use delivery contracts',async context=>{
 const pool=createTestPool(),store=createStore(pool,createVault(randomBytes(32).toString('base64')));
 try{
  await migrate(pool);await migrate(pool);
  await context.test('pairing codes never persist; binary keys survive reload and deletion',async()=>{
   assert.equal(await store.acquireLease('owner-a'),true);
   const auth=await loadBaileysAuth(store,{owner:'owner-a'});
   auth.state.creds.registered=true;auth.state.creds.pairingCode='temporary-pairing-code';await auth.saveCreds();
   await auth.state.keys.set({session:{peer:{key:Buffer.from([0,128,255]),counter:5}}});
   const reloaded=await loadBaileysAuth(store,{owner:'owner-a'});
   assert.equal(reloaded.state.creds.registered,true);assert.equal(reloaded.state.creds.pairingCode,undefined);
   assert.deepEqual((await reloaded.state.keys.get('session',['peer'])).peer,{key:Buffer.from([0,128,255]),counter:5});
   assert.ok((await pool.query('SELECT ciphertext FROM ss_whatsapp_auth')).rows.every(row=>row.ciphertext.startsWith('v1.')&&!row.ciphertext.includes('temporary-pairing-code')));
   await auth.state.keys.set({session:{peer:null}});assert.equal((await reloaded.state.keys.get('session',['peer'])).peer,undefined);
   await auth.close();await assert.rejects(()=>auth.saveCreds(),/closed/);await assert.rejects(()=>auth.state.keys.set({session:{late:{key:Buffer.from('late')}}}),/closed/);
   await store.clearAuth('owner-a');assert.equal(await store.hasAuth(),false);await store.releaseLease('owner-a');
  });
  await context.test('expired owners cannot write or clear a newer session',async()=>{
   await store.acquireLease('old-owner');const stale=await loadBaileysAuth(store,{owner:'old-owner'});
   await stale.saveCreds();await pool.query("UPDATE ss_whatsapp_leases SET expires_at=now()-interval '1 second'");
   assert.equal(await store.acquireLease('new-owner'),true);
   const fresh=await loadBaileysAuth(store,{owner:'new-owner'});fresh.state.creds.registered=true;await fresh.saveCreds();
   await assert.rejects(()=>stale.saveCreds(),/ownership/);
   await assert.rejects(()=>store.clearAuth('old-owner'),/ownership/);
   assert.equal((await store.readAuth('creds',['default'])).default.registered,true);
   assert.equal(await store.renewLease('old-owner'),false);
   await store.clearAuth('new-owner');await store.releaseLease('new-owner');
  });
  await context.test('request codes claim atomically and encrypted media expires or is removed after delivery',async()=>{
   const token=randomToken(),request=await store.createRequest(digest(token),Buffer.from('sticker-bytes'));
   const claims=await Promise.all([store.claimRequest(digest(token),'recipient-a'),store.claimRequest(digest(token),'recipient-b')]);assert.equal(claims.filter(Boolean).length,1);
   assert.equal(claims.find(Boolean).sticker.toString(),'sticker-bytes');
   await store.finishRequest(request.id,'delivered','message-id');assert.equal(await store.claimRequest(digest(token),'recipient-a'),null);
   assert.equal((await pool.query('SELECT sticker_ciphertext FROM ss_sticker_requests WHERE id=$1',[request.id])).rows[0].sticker_ciphertext,null);
   const expired=await store.createRequest(digest(randomToken()),Buffer.from('expired'));
   await pool.query("UPDATE ss_sticker_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);await store.cleanup();
   assert.equal((await pool.query('SELECT status FROM ss_sticker_requests WHERE id=$1',[expired.id])).rows[0].status,'expired');
  });
  await context.test('reset atomically removes all credentials and rejects delayed writes from the former session',async()=>{
   await store.acquireLease('reset-old');const old=await loadBaileysAuth(store,{owner:'reset-old'});
   old.state.creds.registered=true;await old.saveCreds();await old.state.keys.set({session:{peer:Buffer.from('old-key')}});
   await store.resetAuth('reset-old','reset-new');assert.equal(await store.hasAuth(),false);
   await assert.rejects(()=>old.saveCreds(),/ownership/);assert.deepEqual(await store.readAuth('session',['peer']),{});
   assert.equal(await store.renewLease('reset-old'),false);assert.equal(await store.renewLease('reset-new'),true);
   await store.releaseLease('reset-new');
  });
  await context.test('recipient limits count claim time even when requests were created earlier',async()=>{
   for(let index=0;index<11;index++){
    const token=randomToken(),request=await store.createRequest(digest(token),Buffer.from('sticker'));
    await pool.query("UPDATE ss_sticker_requests SET created_at=now()-interval '20 minutes' WHERE id=$1",[request.id]);
    const claim=await store.claimRequest(digest(token),'rate-limited-recipient');
    if(index<10){assert.ok(claim);await store.finishRequest(request.id,'delivered');}else assert.equal(claim,null);
   }
  });
  await context.test('database rate limits and admin seed are idempotent',async()=>{
   assert.equal(await store.seedAdmin('test-admin@example.test','original-password-hash'),true);
   assert.equal(await store.seedAdmin('test-admin@example.test','replacement-hash'),false);
   assert.equal((await store.findAdmin('test-admin@example.test')).password_hash,'original-password-hash');
   assert.equal(await store.checkLimit('test-limit',2,60),true);assert.equal(await store.checkLimit('test-limit',2,60),true);assert.equal(await store.checkLimit('test-limit',2,60),false);
  });
 }finally{await pool.end();}
});
