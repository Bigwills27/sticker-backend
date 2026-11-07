import test from 'node:test';
import assert from 'node:assert/strict';
import {loadBaileysAuth} from '../src/database.js';

test('queued credential and key updates share a durable batch behind an in-flight write',async()=>{
 const batches=[];let finish;
 const store={readAuth:async()=>({}),writeAuth:async entries=>{batches.push(entries);if(batches.length===1)await new Promise(resolve=>{finish=resolve})}};
 const auth=await loadBaileysAuth(store,{owner:'owner'});const first=auth.saveCreds();await new Promise(resolve=>setImmediate(resolve));
 auth.state.creds.registered=true;const saves=Array.from({length:20},()=>auth.saveCreds());
 const keys=auth.state.keys.set({session:{peer:Buffer.from('durable-key')}});let done=false;keys.then(()=>{done=true});
 assert.equal(done,false);finish();await Promise.all([first,...saves,keys]);await auth.flush();
 assert.equal(batches.length,2);assert.equal(batches[1].filter(entry=>entry.type==='creds').length,1);assert.equal(batches[1].find(entry=>entry.type==='creds').value.registered,true);
 assert.deepEqual(batches[1].find(entry=>entry.id==='peer').value,Buffer.from('durable-key'));await auth.close();
});

test('failed auth batches reject all queued writers and never acknowledge unwritten keys',async()=>{
 let fail;const store={readAuth:async()=>({}),writeAuth:()=>new Promise((_,reject)=>{fail=reject})};
 const auth=await loadBaileysAuth(store,{owner:'owner'}),first=auth.saveCreds();await new Promise(resolve=>setImmediate(resolve));
 const second=auth.state.keys.set({session:{peer:Buffer.from('unsaved')}});const checks=Promise.all([assert.rejects(first,/storage offline/),assert.rejects(second,/storage offline/)]);
 fail(new Error('storage offline'));await checks;await assert.rejects(()=>auth.flush(),/storage offline/);await assert.rejects(()=>auth.close(),/storage offline/);
});
