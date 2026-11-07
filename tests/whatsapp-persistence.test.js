import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {createTestPool} from './support/pglite-pool.mjs';
import {createStore,loadBaileysAuth,migrate} from '../src/database.js';
import {createVault} from '../src/security.js';
import {createWhatsAppRuntime} from '../src/whatsapp.js';

test('a new runtime restores encrypted paired credentials and Signal keys after shutdown without a new QR',async()=>{
 const pool=createTestPool(),store=createStore(pool,createVault(randomBytes(32).toString('base64'))),sockets=[];
 const create=()=>createWhatsAppRuntime({store,authFactory:owner=>loadBaileysAuth(store,{owner}),socketFactory:config=>{
  const socket={ev:new EventEmitter(),auth:config.auth,user:{id:'2348000000000:1@s.whatsapp.net'},end(){}};sockets.push(socket);return socket;
 }});
 let first,second;
 try{
  await migrate(pool);first=create();await first.connect();
  const auth=sockets[0].auth;auth.creds.registered=true;auth.creds.me={id:'2348000000000:1@s.whatsapp.net'};
  await auth.keys.set({session:{peer:{key:Buffer.from([0,128,255]),counter:7}}});
  // No creds.update is emitted: graceful shutdown must snapshot the current creds too.
  await first.close();first=null;
  const stored=await pool.query('SELECT ciphertext FROM ss_whatsapp_auth');assert.ok(stored.rows.every(row=>row.ciphertext.startsWith('v1.')));
  second=create();await second.startSaved();assert.equal(sockets.length,2);
  assert.equal(sockets[1].auth.creds.registered,true);assert.deepEqual(sockets[1].auth.creds.me,auth.creds.me);
  assert.deepEqual(sockets[1].auth.creds.noiseKey,auth.creds.noiseKey);
  assert.deepEqual((await sockets[1].auth.keys.get('session',['peer'])).peer,{key:Buffer.from([0,128,255]),counter:7});
  assert.equal(second.status().savedSession,true);assert.equal(second.status().qr,null);
  sockets[1].ev.emit('connection.update',{connection:'open'});await new Promise(resolve=>setImmediate(resolve));assert.equal(second.status().status,'connected');
 }finally{await first?.close();await second?.close();await pool.end();}
});
