import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {loadBaileysAuth,migrate} from '../src/database.js';
import {digest,randomToken} from '../src/security.js';
import {inspect} from '../src/media.js';
import {neonFixture,testEmail,testPassword,until} from './support/neon-fixture.mjs';

const checks=[];
const fixture=await neonFixture();
const {services,base,origin,sockets,sent}=fixture,{store,runtime}=services;
const send=(path,{method='GET',data,headers={}}={})=>fetch(`${base}${path}`,{method,headers:{Origin:origin,...(data?{'Content-Type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})});
try{
 await store.health();await migrate(store.pool);checks.push('Neon connected; migration is idempotent');
 assert.equal(await store.seedAdmin(testEmail,'unused-hash'),false);checks.push('Admin seed preserves an existing password');
 assert.equal((await send('/api/admin/dashboard')).status,401);
 assert.equal((await send('/api/admin/login',{method:'POST',data:{email:testEmail,password:'incorrect'}})).status,401);
 assert.equal((await send('/api/admin/login',{method:'POST',data:{email:testEmail,password:testPassword},headers:{Origin:'https://untrusted.example'}})).status,403);
 const login=await send('/api/admin/login',{method:'POST',data:{email:testEmail,password:testPassword}});assert.equal(login.status,200);
 const session=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];assert.match(login.headers.get('set-cookie'),/HttpOnly/);
 const authorized={Cookie:cookie,'X-CSRF-Token':session.csrfToken};
 const me=await send('/api/admin/me',{headers:authorized});assert.equal((await me.json()).admin.email,testEmail);
 assert.equal((await send('/api/admin/whatsapp/connect',{method:'POST',data:{method:'qr'},headers:{Cookie:cookie}})).status,403);
 assert.equal((await send('/api/admin/whatsapp/connect',{method:'POST',data:{method:'code',phoneNumber:'not-a-number'},headers:authorized})).status,400);
 checks.push('HTTP login, HttpOnly cookie, origin checks, CSRF and phone validation');

 let auth=await loadBaileysAuth(store);
 auth.state.creds.registered=true;await auth.saveCreds();
 await auth.state.keys.set({'session':{'integration-peer':{binary:Buffer.from([0,127,255]),counter:7}}});await auth.flush();
 auth=await loadBaileysAuth(store);
 assert.equal(auth.state.creds.registered,true);
 assert.deepEqual((await auth.state.keys.get('session',['integration-peer']))['integration-peer'].binary,Buffer.from([0,127,255]));
 const saved=await store.pool.query('SELECT ciphertext FROM ss_whatsapp_auth');assert.ok(saved.rows.every(row=>row.ciphertext.startsWith('v1.')&&!row.ciphertext.includes('integration-peer')));
 await auth.state.keys.set({'session':{'integration-peer':null}});assert.equal((await auth.state.keys.get('session',['integration-peer']))['integration-peer'],undefined);
 await store.clearAuth();checks.push('Encrypted credentials and binary Signal keys survive adapter reload; deletes persist');

 const leaseA=randomUUID(),leaseB=randomUUID();assert.equal(await store.acquireLease(leaseA),true);assert.equal(await store.acquireLease(leaseB),false);assert.equal(await store.renewLease(leaseB),false);await store.releaseLease(leaseA);
 checks.push('Database lease allows only one WhatsApp runtime');

 const connect=await send('/api/admin/whatsapp/connect',{method:'POST',data:{method:'qr'},headers:authorized});assert.equal(connect.status,200);
 await until(()=>runtime.status().qr);assert.match(runtime.status().qr,/^data:image\/png/);
 assert.equal((await send('/api/admin/dashboard')).status,401);
 sockets.at(-1).ev.emit('connection.update',{connection:'open'});await until(()=>runtime.status().status==='connected');
 assert.equal((await (await send('/api/whatsapp/status')).json()).available,true);
 checks.push('Admin-only QR pairing and public availability status');

 const submitted=await (await send('/api/examples/convert',{method:'POST',data:{}})).json();
 let job;await until(async()=>{job=await(await send(`/api/jobs/${submitted.id}`)).json();return !['queued','running'].includes(job.status)},60000);
 assert.equal(job.status,'succeeded');assert.equal(job.result.output.frames,51);
 const request=await send('/api/whatsapp/requests',{method:'POST',data:{jobId:submitted.id}});assert.equal(request.status,201);
 const handoff=await request.json(),url=new URL(handoff.url);assert.equal(url.hostname,'wa.me');
 const text=url.searchParams.get('text');assert.match(text,/^STICKER [a-f0-9]{32}$/);
 const incoming={type:'notify',messages:[{key:{remoteJid:'2348111111111@s.whatsapp.net',fromMe:false,id:'inbound-fixture'},messageTimestamp:Math.floor(Date.now()/1000),message:{conversation:text}}]};
 sockets.at(-1).ev.emit('messages.upsert',incoming);await until(()=>sent.length===1);
 await until(async()=>((await store.dashboard()).stats.delivered===1));
 const metadata=await inspect(sent[0].payload.sticker);assert.equal(metadata.frames,51);assert.equal(sent[0].payload.isAnimated,true);assert.equal(sent[0].jid,'2348111111111@s.whatsapp.net');
 sockets.at(-1).ev.emit('messages.upsert',incoming);await new Promise(resolve=>setTimeout(resolve,250));assert.equal(sent.length,1);
 checks.push('Full conversion → persisted handoff → sender reply sends 51-frame WebP as sticker; replay is blocked (simulated WhatsApp transport)');

 const sticker=await readFile(new URL('../samples/animated.webp',import.meta.url));
 const token=randomToken();await store.createRequest(digest(token),sticker);
 const raced=await Promise.all([store.claimRequest(digest(token),'recipient-a'),store.claimRequest(digest(token),'recipient-b')]);assert.equal(raced.filter(Boolean).length,1);await store.finishRequest(raced.find(Boolean).id,'failed');
 const expiredToken=randomToken(),expired=await store.createRequest(digest(expiredToken),sticker);await store.pool.query("UPDATE ss_sticker_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);assert.equal(await store.claimRequest(digest(expiredToken),'recipient-c'),null);await store.cleanup();
 const expiredRow=(await store.pool.query('SELECT status,sticker_ciphertext FROM ss_sticker_requests WHERE id=$1',[expired.id])).rows[0];assert.equal(expiredRow.status,'expired');assert.equal(expiredRow.sticker_ciphertext,null);
 checks.push('Concurrent request claim, expired-code rejection and encrypted-media cleanup');

 assert.equal((await send('/api/admin/whatsapp/test',{method:'POST',data:{},headers:authorized})).status,200);
 assert.equal(sent[1].jid,'2348000000000@s.whatsapp.net');assert.equal((await inspect(sent[1].payload.sticker)).width,512);
 assert.equal((await send('/api/admin/whatsapp/disconnect',{method:'POST',data:{},headers:authorized})).status,200);
 assert.equal((await send('/api/admin/logout',{method:'POST',data:{},headers:authorized})).status,200);
 assert.equal((await send('/api/admin/me',{headers:{Cookie:cookie}})).status,401);
 checks.push('Test-to-self, explicit disconnect and server-side logout revocation');
 for(let i=0;i<3;i++)assert.equal(await store.checkLimit('integration-limit',2,60),i<2);
 checks.push('Persistent request rate limiting');
 const report={passed:checks,realNeon:true,whatsappTransport:'simulated',realWhatsAppPaired:false,checkedAt:new Date().toISOString()};
 await mkdir(new URL('../../qa/',import.meta.url),{recursive:true});await writeFile(new URL('../../qa/neon-integration.json',import.meta.url),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}finally{await fixture.close();}
