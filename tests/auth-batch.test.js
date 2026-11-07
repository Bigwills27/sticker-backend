import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createStore,migrate,loadBaileysAuth} from '../src/database.js';
import {createVault} from '../src/security.js';
import {createTestPool} from './support/pglite-pool.mjs';

test('812 initial pairing keys use one encrypted upsert instead of 812 database round trips',async()=>{
 const calls=[],client={async query(sql,args){calls.push({sql,args});return {rows:[{}],rowCount:1}},release(){}};
 const store=createStore({async connect(){return client}},createVault(randomBytes(32).toString('base64')));
 await store.writeAuth(Array.from({length:812},(_,id)=>({type:'pre-key',id:String(id),value:{private:Buffer.from('private-key-fixture')}})),{owner:'batch-owner'});
 const inserts=calls.filter(call=>/INSERT INTO ss_whatsapp_auth/.test(call.sql));
 assert.equal(inserts.length,1);assert.ok(calls.length<=5);
 assert.equal(inserts[0].args[2].length,812);assert.ok(inserts[0].args[2].every(cipher=>cipher.startsWith('v1.')&&!cipher.includes('private-key-fixture')));
});

test('bulk authentication preserves binary keys, last-write semantics, deletion and lease fencing',async()=>{
 const pool=createTestPool(),store=createStore(pool,createVault(randomBytes(32).toString('base64')));
 try{
  await migrate(pool);await store.acquireLease('bulk-owner');
  const auth=await loadBaileysAuth(store,{owner:'bulk-owner'});
  const keys=Object.fromEntries(Array.from({length:812},(_,id)=>[String(id),{private:Buffer.from([0,128,255]),public:Buffer.from([1,2,3])}]));
  await auth.state.keys.set({'pre-key':keys});await auth.saveCreds();
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM ss_whatsapp_auth WHERE key_type='pre-key'")).rows[0].count,812);
  assert.deepEqual((await auth.state.keys.get('pre-key',['0','811']))['811'],keys['811']);
  await store.writeAuth([{type:'pre-key',id:'0',value:null},{type:'pre-key',id:'1',value:{counter:1}},{type:'pre-key',id:'1',value:{counter:2}},{type:'pre-key',id:'2',value:{counter:3}},{type:'pre-key',id:'2',value:null}],{owner:'bulk-owner'});
  assert.deepEqual(await store.readAuth('pre-key',['0','1','2']),{'1':{counter:2}});
  await assert.rejects(()=>store.writeAuth([{type:'pre-key',id:'1',value:null},{type:null,id:'invalid',value:{counter:4}}],{owner:'bulk-owner'}));
  assert.deepEqual(await store.readAuth('pre-key',['1']),{'1':{counter:2}},'a failed bulk insert must roll back its preceding deletion');
  await store.resetAuth('bulk-owner','replacement');
  await assert.rejects(()=>auth.state.keys.set({'pre-key':keys}),/ownership/);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ss_whatsapp_auth')).rows[0].count,0);
 }finally{await pool.end();}
});
