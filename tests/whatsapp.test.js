import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createWhatsAppRuntime } from '../src/whatsapp.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate){const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw new Error('Timed out waiting for fixture state');await new Promise(resolve=>setTimeout(resolve,10));}}
function setup(options = {}) {
  const sent = [], finished = [], claims = [], sockets = [];
  let saved = true, available = true;
  const store = { hasAuth: async()=>saved, clearAuth:async()=>{saved=false}, resetAuth:async()=>{saved=false}, acquireLease:async()=>available, renewLease:async()=>true, releaseLease:async()=>{}, recordEvent:async()=>{}, claimRequest:async(token,recipient)=>{claims.push([token,recipient]); if(!available)return null; available=false; return {id:'r1',sticker:Buffer.from('webp')}}, finishRequest:async(...args)=>finished.push(args) };
  const runtime = createWhatsAppRuntime({store, authFactory:async()=>({state:{creds:{registered:true},keys:{}},saveCreds:async()=>{},flush:async()=>{}}), socketFactory:config=>{const socket={ev:new EventEmitter(),authState:config.auth,user:{id:'123:4@s.whatsapp.net',name:'Studio'},sendMessage:async(...args)=>{sent.push(args);return {key:{id:'sent1'}}},end:()=>{},logout:async()=>{}};sockets.push(socket);return socket}, sampleSticker:Buffer.from('sample'), ...options});
  return {runtime,store,sockets,sent,finished,claims};
}
const message = (jid='456@s.whatsapp.net',extra={})=>({key:{remoteJid:jid,id:Math.random().toString(),fromMe:false},messageTimestamp:Math.floor(Date.now()/1000),message:{conversation:'STICKER 0123456789abcdef0123456789abcdef'},...extra});
test('one transient heartbeat failure retains a valid connection and the next heartbeat recovers',async context=>{
 context.mock.timers.enable({apis:['setInterval']});const diagnostics=[],t=setup({diagnostics:entry=>diagnostics.push(entry)});
 await t.runtime.startSaved();t.sockets[0].ev.emit('connection.update',{connection:'open'});await tick();
 t.store.renewLease=async()=>{throw Object.assign(new Error('private database detail'),{code:'ETIMEDOUT'})};
 context.mock.timers.tick(15000);await tick();assert.equal(t.runtime.status().status,'connected');assert.ok(t.runtime.status().storageWarning);
 await assert.rejects(()=>t.runtime.sendTest(),{code:'DATABASE_RETRYING'});
 assert.ok(diagnostics.some(entry=>entry.event==='lease_retry'&&entry.causeCode==='ETIMEDOUT'));assert.ok(diagnostics.every(entry=>!JSON.stringify(entry).includes('private database detail')));
 t.store.renewLease=async()=>true;context.mock.timers.tick(15000);await tick();assert.equal(t.runtime.status().storageWarning,null);await t.runtime.close();
});
test('a timed-out send retires its socket before another sticker can start',async()=>{
 const t=setup({timeouts:{send:20,sendSpacing:1},authFactory:async()=>({state:{creds:{registered:false},keys:{}},saveCreds:async()=>{},flush:async()=>{}})});
 let ended=false,calls=0,finish;
 try{
  await t.runtime.connect();const socket=t.sockets[0];socket.end=()=>{ended=true;};socket.sendMessage=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};socket.ev.emit('connection.update',{connection:'open'});await tick();
  await Promise.all([assert.rejects(()=>t.runtime.sendTest()),new Promise(resolve=>setTimeout(resolve,40))]);
  assert.equal(ended,true,'a timeout must end the old socket instead of advancing a live send queue');
  await assert.rejects(()=>t.runtime.sendTest(),{code:'WHATSAPP_OFFLINE'});assert.equal(calls,1);
 }finally{finish?.({key:{id:'late'}});await t.runtime.close();}
});
test('a stalled heartbeat cannot keep a socket alive beyond its lease safety deadline',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const t=setup({timeouts:{leaseSafety:40}});await t.runtime.startSaved();t.sockets[0].ev.emit('connection.update',{connection:'open'});await tick();
 context.mock.timers.tick(40);await tick();assert.equal(t.runtime.status().status,'error');assert.equal(t.runtime.status().errorCode,'LEASE_RENEWAL_TIMEOUT');await t.runtime.close();
});
test('a test send survives a transient heartbeat error while ownership is still valid',async context=>{
 context.mock.timers.enable({apis:['setInterval']});const t=setup();await t.runtime.startSaved();const socket=t.sockets[0];socket.ev.emit('connection.update',{connection:'open'});await tick();
 let finishSend,ended=false;socket.end=()=>{ended=true};socket.sendMessage=()=>new Promise(resolve=>{finishSend=resolve});
 const sending=t.runtime.sendTest();await tick();t.store.renewLease=async()=>{throw Object.assign(new Error('temporary network issue'),{code:'ECONNRESET'})};context.mock.timers.tick(15000);await tick();
 assert.equal(ended,false);assert.equal(t.runtime.status().status,'connected');finishSend({key:{id:'confirmed-test'}});assert.equal((await sending).messageId,'confirmed-test');await t.runtime.close();
});
test('Signal reads use a per-socket cache and key writes still await durable storage',async()=>{
 let reads=0,value=Buffer.from('first'),finishWrite;
 const t=setup({authFactory:async()=>({state:{creds:{registered:true},keys:{get:async()=>{reads++;return {peer:value}},set:async data=>{await new Promise(resolve=>{finishWrite=resolve});value=data.session.peer}}},saveCreds:async()=>{},flush:async()=>{}})});
 await t.runtime.connect();const keys=t.sockets[0].authState.keys;
 await keys.get('session',['peer']);await keys.get('session',['peer']);assert.equal(reads,1);
 let durable=false;const writing=keys.set({session:{peer:Buffer.from('second')}}).then(()=>{durable=true});await tick();assert.equal(durable,false);finishWrite();await writing;
 assert.deepEqual((await keys.get('session',['peer'])).peer,Buffer.from('second'));assert.equal(reads,1);
 await t.runtime.connect();await t.sockets[1].authState.keys.get('session',['peer']);assert.equal(reads,2);await t.runtime.close();
});
test('a failed encryption-key write closes the socket instead of continuing with cached unsaved keys',async()=>{
 const t=setup({authFactory:async()=>({state:{creds:{registered:true},keys:{get:async()=>({}),set:async()=>{throw Object.assign(new Error('private storage detail'),{code:'ECONNRESET'})}}},saveCreds:async()=>{},flush:async()=>{}})});
 await t.runtime.connect();const socket=t.sockets[0];let ended=false;socket.end=()=>{ended=true};socket.ev.emit('connection.update',{connection:'open'});await tick();
 await assert.rejects(()=>socket.authState.keys.set({session:{peer:Buffer.from('not-saved')}}));await tick();
 assert.equal(ended,true);assert.equal(t.runtime.status().status,'error');assert.equal(t.runtime.status().errorCode,'AUTH_STORAGE_FAILED');assert.doesNotMatch(t.runtime.status().error,/private storage detail/);await t.runtime.close();
});
test('only live direct commands claim a single-use request and send its sticker to the sender',async()=>{
 const t=setup();await t.runtime.startSaved();const s=t.sockets[0];
 s.ev.emit('connection.update',{connection:'open'});await tick();
 for(const [type,m] of [['append',message()],['notify',message('1@g.us')],['notify',message('status@broadcast')],['notify',message(undefined,{messageTimestamp:1})],['notify',message(undefined,{key:{remoteJid:'1@s.whatsapp.net',fromMe:true}})]])s.ev.emit('messages.upsert',{type,messages:[m]});
 await tick();assert.equal(t.claims.length,0);
 s.ev.emit('messages.upsert',{type:'notify',messages:[message('456@lid')]});await tick();
 assert.equal(t.claims[0][0],createHash('sha256').update('0123456789abcdef0123456789abcdef').digest('hex'));
 assert.equal(t.sent[0][0],'456@lid');assert.deepEqual(t.sent[0][1],{sticker:Buffer.from('webp')});assert.deepEqual(t.finished,[['r1','delivered','sent1']]);
 s.ev.emit('messages.upsert',{type:'notify',messages:[message()]});await tick();assert.equal(t.sent.length,1);await t.runtime.close();
});
test('startup without saved auth does not create a socket',async()=>{const t=setup();t.store.hasAuth=async()=>false;await t.runtime.startSaved();assert.equal(t.sockets.length,0);assert.equal(t.runtime.status().status,'disconnected');await t.runtime.close()});
test('lease contention prevents pairing and connected test sends to normalized own JID',async()=>{const t=setup();t.store.acquireLease=async()=>false;await t.runtime.connect({method:'qr'});assert.equal(t.runtime.status().status,'busy');assert.equal(t.sockets.length,0);t.store.acquireLease=async()=>true;await t.runtime.connect({method:'qr'});t.sockets[0].ev.emit('connection.update',{connection:'open'});await tick();await t.runtime.sendTest();assert.equal(t.sent[0][0],'123@s.whatsapp.net');await t.runtime.disconnect();assert.equal(t.runtime.status().status,'disconnected');});
test('logged out connection clears auth and requires manual pairing',async()=>{const t=setup();await t.runtime.startSaved();t.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});await tick();assert.equal(t.runtime.status().status,'disconnected');assert.equal(await t.store.hasAuth(),false);await t.runtime.close()});
test('QR material is cleared when connection opens and phone pairing validates input',async()=>{const t=setup();await assert.rejects(t.runtime.connect({method:'code',phoneNumber:'bad'}),/international/);await t.runtime.connect({method:'qr'});t.sockets[0].ev.emit('connection.update',{qr:'private-qr'});await waitFor(()=>t.runtime.status().qr);assert.match(t.runtime.status().qr,/^data:image\/png/);assert.ok(t.runtime.status().pairingExpiresAt);t.sockets[0].ev.emit('connection.update',{connection:'open'});await tick();assert.equal(t.runtime.status().qr,null);await t.runtime.close()});
test('send failure consumes the request and records failure without retrying the sticker',async()=>{const t=setup();await t.runtime.startSaved();const s=t.sockets[0];s.sendMessage=async()=>{throw new Error('private transport detail')};s.ev.emit('connection.update',{connection:'open'});await tick();s.ev.emit('messages.upsert',{type:'notify',messages:[message()]});await tick();assert.deepEqual(t.finished,[['r1','failed']]);assert.equal(t.runtime.status().error,null);await t.runtime.close()});
test('credential persistence failures stop the connection with a generic error',async()=>{const t=setup({authFactory:async()=>({state:{creds:{},keys:{}},saveCreds:async()=>{throw new Error('secret')},flush:async()=>{}})});await t.runtime.startSaved();t.sockets[0].ev.emit('creds.update',{});await tick();assert.equal(t.runtime.status().status,'error');assert.doesNotMatch(t.runtime.status().error,/secret/);await t.runtime.close()});
test('animated WebP is sent with animation metadata intact',async()=>{const t=setup();const bytes=Buffer.concat([Buffer.from('RIFF'),Buffer.from([12,0,0,0]),Buffer.from('WEBPANIM'),Buffer.from([0,0,0,0])]);t.store.claimRequest=async()=>({id:'animated',sticker:bytes});await t.runtime.startSaved();const s=t.sockets[0];s.ev.emit('connection.update',{connection:'open'});await tick();s.ev.emit('messages.upsert',{type:'notify',messages:[message()]});await tick();assert.equal(t.sent[0][1].isAnimated,true);assert.equal(t.sent[0][1].sticker,bytes);await t.runtime.close()});
test('admin restart replaces an unregistered pairing socket but keeps connected socket',async()=>{const t=setup({authFactory:async()=>({state:{creds:{registered:false},keys:{}},saveCreds:async()=>{},flush:async()=>{}})});await t.runtime.connect({method:'qr'});const old=t.sockets[0];await t.runtime.connect({method:'code',phoneNumber:'2348123456789'});assert.equal(t.sockets.length,2);old.ev.emit('connection.update',{connection:'open'});await tick();assert.notEqual(t.runtime.status().status,'connected');t.sockets[1].ev.emit('connection.update',{connection:'open'});await tick();await t.runtime.connect({method:'qr'});assert.equal(t.sockets.length,2);await t.runtime.close()});
test('disconnect cannot erase credentials owned by another runtime',async()=>{const t=setup();t.store.acquireLease=async()=>false;await t.runtime.connect({method:'qr'});await assert.rejects(t.runtime.disconnect(),{code:'SESSION_BUSY'});assert.equal(await t.store.hasAuth(),true);await t.runtime.close()});
test('shutdown releases its lease even when auth flush fails',async()=>{let released=0;const t=setup({authFactory:async()=>({state:{creds:{registered:true},keys:{}},saveCreds:async()=>{},flush:async()=>{throw new Error('database error')}})});t.store.releaseLease=async()=>{released++};await t.runtime.startSaved();await assert.rejects(t.runtime.close());assert.equal(released,1)});
test('concurrent connect and disconnect finishes disconnected without stale socket resurrection',async()=>{const t=setup();await Promise.all([t.runtime.connect({method:'qr'}),t.runtime.disconnect()]);assert.equal(t.runtime.status().status,'disconnected');assert.equal(await t.store.hasAuth(),false);await t.runtime.close()});
test('lease loss stops its socket and discards late message events',async context=>{context.mock.timers.enable({apis:['setInterval']});const t=setup();t.store.renewLease=async()=>false;await t.runtime.startSaved();const s=t.sockets[0];s.ev.emit('connection.update',{connection:'open'});await tick();context.mock.timers.tick(15000);await tick();assert.equal(t.runtime.status().status,'error');s.ev.emit('messages.upsert',{type:'notify',messages:[message()]});await tick();assert.equal(t.claims.length,0);await t.runtime.close()});
test('expired pairing material can be restarted without reconnecting an old socket',async context=>{context.mock.timers.enable({apis:['setTimeout']});const t=setup();await t.runtime.connect({method:'qr'});t.sockets[0].ev.emit('connection.update',{qr:'expired-qr'});for(let i=0;i<20 && !t.runtime.status().qr;i++)await tick();assert.ok(t.runtime.status().qr);context.mock.timers.tick(60000);assert.equal(t.runtime.status().qr,null);await t.runtime.connect({method:'qr'});assert.equal(t.sockets.length,2);await t.runtime.close()});
test('heartbeat stops socket during a pending outbound send',async context=>{context.mock.timers.enable({apis:['setInterval']});const t=setup();let finishSend,ended=false;t.store.renewLease=async()=>true;await t.runtime.startSaved();const s=t.sockets[0];s.end=()=>{ended=true};s.sendMessage=()=>new Promise(resolve=>{finishSend=resolve});s.ev.emit('connection.update',{connection:'open'});await tick();const send=t.runtime.sendTest();await tick();t.store.renewLease=async()=>false;context.mock.timers.tick(15000);await tick();assert.equal(ended,true);assert.equal(t.runtime.status().status,'error');finishSend({key:{id:'late'}});await assert.rejects(send,/lost/);await t.runtime.close()});
test('logout rejection still seals pending auth and clears it while ownership is held',async()=>{const order=[];const t=setup({authFactory:async owner=>({state:{creds:{registered:true},keys:{}},saveCreds:async()=>{},close:async()=>{order.push('close')},flush:async()=>{order.push('flush')}})});t.store.clearAuth=async owner=>{assert.equal(typeof owner,'string');order.push('clear')};t.store.releaseLease=async()=>{order.push('release')};await t.runtime.startSaved();t.sockets[0].logout=async()=>{throw new Error('private detail')};await assert.rejects(t.runtime.disconnect(),/unlink|disconnect/i);assert.ok(order.indexOf('close')<order.indexOf('clear'));assert.ok(order.indexOf('clear')<order.indexOf('release'));assert.equal(t.runtime.status().status,'disconnected')});
test('audit event failure never changes a delivered request into failed',async()=>{const t=setup();t.store.recordEvent=async type=>{if(type==='delivered')throw new Error('db audit unavailable')};await t.runtime.startSaved();const s=t.sockets[0];s.ev.emit('connection.update',{connection:'open'});await tick();s.ev.emit('messages.upsert',{type:'notify',messages:[message()]});await tick();assert.deepEqual(t.finished,[['r1','delivered','sent1']]);await t.runtime.close()});
test('terminal logout clears sealed auth and releases ownership even when pending auth writes reject',async()=>{const order=[];const t=setup({authFactory:async()=>({state:{creds:{registered:true},keys:{}},saveCreds:async()=>{},close:async()=>{order.push('sealed');throw new Error('latched auth write error')},flush:async()=>{throw new Error('flush error')}})});t.store.clearAuth=async owner=>{assert.equal(typeof owner,'string');order.push('clear')};t.store.releaseLease=async()=>{order.push('release')};await t.runtime.startSaved();t.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});await tick();assert.deepEqual(order,['sealed','clear','release']);assert.ok(['disconnected','error'].includes(t.runtime.status().status));assert.doesNotMatch(t.runtime.status().error??'',/latched|flush error/);await t.runtime.close()});

test('a silent unpaired connection times out with a recoverable error instead of connecting forever',async()=>{
 const t=setup({timeouts:{connect:20},authFactory:async()=>({state:{creds:{registered:false},keys:{}},saveCreds:async()=>{},flush:async()=>{}})});await t.runtime.connect({method:'qr'});
 assert.ok(t.runtime.status().operationDeadlineAt);
 await new Promise(resolve=>setTimeout(resolve,45));
 assert.equal(t.runtime.status().status,'error');assert.equal(t.runtime.status().errorCode,'CONNECTION_TIMEOUT');
 assert.equal(t.runtime.status().qr,null);await t.runtime.close();
});

test('reconnect snapshots current credentials before sealing and reloading auth after pairing restart',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 let saved={registered:false},sealed=false;const order=[];
 const t=setup({authFactory:async()=>{sealed=false;const state={creds:{...saved},keys:{}};return {state,saveCreds:async()=>{assert.equal(sealed,false);saved={...state.creds};order.push('save')},close:async()=>{sealed=true;order.push('seal')},flush:async()=>{}}}});
 await t.runtime.connect({method:'qr'});t.sockets[0].authState.creds.registered=true;
 t.sockets[0].ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:515}}}});await tick();
 assert.deepEqual(order,['save','seal']);assert.equal(await t.store.hasAuth(),true);
 context.mock.timers.tick(500);await tick();assert.equal(t.sockets.length,2);assert.equal(t.sockets[1].authState.creds.registered,true);
 t.sockets[1].ev.emit('connection.update',{connection:'open'});await tick();assert.equal(t.runtime.status().status,'connected');await t.runtime.close();
});

test('a silent saved-session connection retries without deleting credentials and reset cancels that retry',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const t=setup();await t.runtime.startSaved();context.mock.timers.tick(45000);await tick();
 assert.equal(t.runtime.status().status,'reconnecting');assert.equal(t.runtime.status().retryAttempt,1);assert.ok(t.runtime.status().nextRetryAt);assert.equal(await t.store.hasAuth(),true);
 await t.runtime.reset();assert.equal(t.sockets.length,2);context.mock.timers.tick(1000);await tick();assert.equal(t.sockets.length,2);await t.runtime.close();
});

test('saved-session timeout retries are bounded and never erase the paired account',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 const t=setup();await t.runtime.startSaved();
 for(let attempt=1;attempt<=7;attempt++){
  context.mock.timers.tick(45000);await tick();
  if(attempt<=6){assert.equal(t.runtime.status().retryAttempt,attempt);context.mock.timers.tick(Math.min(30000,1000*2**(attempt-1)));await tick();}
 }
 assert.equal(t.sockets.length,7);assert.equal(t.runtime.status().status,'error');assert.equal(t.runtime.status().errorCode,'RECONNECT_LIMIT');assert.equal(await t.store.hasAuth(),true);await t.runtime.close();
});

test('phone pairing waits for QR readiness and only requests one code per socket',async()=>{
 const t=setup({authFactory:async()=>({state:{creds:{registered:false},keys:{}},saveCreds:async()=>{},flush:async()=>{}})});
 await t.runtime.connect({method:'code',phoneNumber:'2348123456789'});const socket=t.sockets[0];let requested=0;
 socket.requestPairingCode=async phone=>{assert.equal(phone,'2348123456789');requested++;return '12345678'};
 socket.ev.emit('connection.update',{connection:'connecting'});await tick();assert.equal(requested,0);
 socket.ev.emit('connection.update',{qr:'ready'});socket.ev.emit('connection.update',{qr:'refreshed'});await tick();
 assert.equal(requested,1);assert.equal(t.runtime.status().status,'pairing');assert.equal(t.runtime.status().pairingCode,'12345678');assert.equal(t.runtime.status().qr,null);assert.ok(t.runtime.status().pairingExpiresAt);await t.runtime.close();
});

test('reset deletes the saved session, rotates ownership and creates fresh pairing credentials',async()=>{
 const t=setup({authFactory:async()=>({state:{creds:{registered:await t.store.hasAuth()},keys:{}},saveCreds:async()=>{},flush:async()=>{}})});
 let owners;t.store.resetAuth=async(oldOwner,newOwner)=>{owners=[oldOwner,newOwner];await t.store.clearAuth(oldOwner)};
 await t.runtime.connect({method:'qr'});assert.equal(t.sockets[0].authState.creds.registered,true);
 await t.runtime.reset();assert.equal(t.sockets.length,2);assert.equal(t.sockets[1].authState.creds.registered,false);
 assert.notEqual(owners[0],owners[1]);assert.equal(t.runtime.status().status,'connecting');
 t.sockets[0].ev.emit('connection.update',{connection:'open'});await tick();assert.notEqual(t.runtime.status().status,'connected');
 t.sockets[1].ev.emit('connection.update',{qr:'fresh-session-qr'});await waitFor(()=>t.runtime.status().qr);assert.match(t.runtime.status().qr,/^data:image\/png/);await t.runtime.close();
});

test('reset can interrupt an unresolved pairing-code request and ignores its late result',async()=>{
 const t=setup({timeouts:{operation:50},authFactory:async()=>({state:{creds:{registered:false},keys:{}},saveCreds:async()=>{},flush:async()=>{}})});
 await t.runtime.connect({method:'code',phoneNumber:'2348123456789'});let finishCode;
 t.sockets[0].requestPairingCode=()=>new Promise(resolve=>{finishCode=resolve});
 t.sockets[0].ev.emit('connection.update',{qr:'old-code-trigger'});await tick();
 await t.runtime.reset();assert.equal(t.sockets.length,2);
 finishCode('STALE-CODE');await tick();assert.equal(t.runtime.status().pairingCode,null);
 assert.equal(t.runtime.status().status,'connecting');await t.runtime.close();
});

test('reset refuses to erase credentials owned by another running backend',async()=>{
 const t=setup();t.store.acquireLease=async()=>false;let cleared=false;t.store.resetAuth=async()=>{cleared=true};
 await assert.rejects(()=>t.runtime.reset(),{code:'SESSION_BUSY'});assert.equal(cleared,false);assert.equal(await t.store.hasAuth(),true);await t.runtime.close();
});

test('failed credential deletion never reports a successful disconnect',async()=>{
 const t=setup();await t.runtime.connect({method:'qr'});t.store.clearAuth=async()=>{throw new Error('database unavailable')};
 await assert.rejects(()=>t.runtime.disconnect());assert.equal(await t.store.hasAuth(),true);
 assert.equal(t.runtime.status().status,'error');assert.equal(t.runtime.status().errorCode,'DISCONNECT_FAILED');await t.runtime.close();
});

test('a transient socket close with failed cleanup cannot leave a connected badge or an endless spinner',async()=>{
 for(const failure of ['auth','lease']){
  const t=setup({authFactory:async()=>({state:{creds:{registered:true},keys:{}},saveCreds:async()=>{},close:async()=>{if(failure==='auth')throw new Error('drain failed')},flush:async()=>{}})});
  await t.runtime.connect({method:'qr'});const socket=t.sockets[0];
  socket.ev.emit('connection.update',{connection:'open'});await tick();assert.equal(t.runtime.status().status,'connected');
  if(failure==='lease')t.store.releaseLease=async()=>{throw new Error('release failed')};
  socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:408}}}});await tick();
  assert.equal(t.runtime.status().status,'error');assert.equal(t.runtime.status().errorCode,'SESSION_CLEANUP_FAILED');assert.equal(t.runtime.status().operationDeadlineAt,null);await t.runtime.close();
 }
});

test('a reset that times out acquiring its lease releases a late successful acquisition',async()=>{
 const t=setup({timeouts:{operation:10}});let acquire,released=0;
 t.store.acquireLease=()=>new Promise(resolve=>{acquire=resolve});t.store.releaseLease=async()=>{released++};
 const resetting=t.runtime.reset();const keepAlive=setTimeout(()=>{},1000);
 try{await assert.rejects(resetting,{code:'RESET_FAILED'});acquire(true);await tick();assert.equal(released,1);assert.equal(t.runtime.status().status,'error');}finally{clearTimeout(keepAlive);await t.runtime.close();}
});
