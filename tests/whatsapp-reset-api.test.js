import test from 'node:test';
import assert from 'node:assert/strict';
import {neonFixture,testEmail,testPassword,until} from './support/neon-fixture.mjs';
import {loadBaileysAuth} from '../src/database.js';

test('reset requires an admin and CSRF, deletes WhatsApp keys and preserves the admin login',async()=>{
 const fixture=await neonFixture({embedded:true});
 const {base,origin,services,sockets}=fixture;
 const post=(route,data={},headers={})=>fetch(base+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 try{
  assert.equal((await post('/api/admin/whatsapp/reset')).status,401);
  const login=await post('/api/admin/login',{email:testEmail,password:testPassword});const session=await login.json();const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/admin/whatsapp/reset',{}, {Cookie:cookie})).status,403);
  const headers={Cookie:cookie,'X-CSRF-Token':session.csrfToken};
  assert.equal((await post('/api/admin/whatsapp/reset',{}, {...headers,Origin:'https://other.example'})).status,403);
  const saved=await loadBaileysAuth(services.store);saved.state.creds.registered=true;await saved.saveCreds();await saved.state.keys.set({session:{old:Buffer.from('old-encryption-key')}});
  await services.runtime.startSaved();assert.equal(sockets.length,1);
  const response=await post('/api/admin/whatsapp/reset',{},headers);assert.equal(response.status,200);
  assert.equal((await response.json()).whatsapp.status,'connecting');assert.equal(sockets.length,2);
  assert.equal(await services.store.hasAuth(),false);assert.deepEqual(await services.store.readAuth('session',['old']),{});
  await until(()=>services.runtime.status().qr);
  assert.equal(services.runtime.status().status,'pairing');assert.equal(services.runtime.status().phase,'waiting_for_scan');
  const me=await fetch(base+'/api/admin/me',{headers:{Origin:origin,Cookie:cookie}});assert.equal(me.status,200);assert.equal((await me.json()).admin.email,testEmail);
 }finally{await fixture.close();}
});
