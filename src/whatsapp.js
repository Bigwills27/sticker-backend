import makeWASocket, { jidNormalizedUser,makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './media.js';
import './signal-logging.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const quiet = pino({ level: 'silent' });
function stickerPayload(sticker) {
  const payload = { sticker };
  if (!Buffer.isBuffer(sticker) || sticker.toString('ascii', 0, 4) !== 'RIFF' || sticker.toString('ascii', 8, 12) !== 'WEBP') return payload;
  for (let offset = 12; offset + 8 <= sticker.length;) {
    const kind = sticker.toString('ascii', offset, offset + 4), size = sticker.readUInt32LE(offset + 4);
    if (offset + 8 + size > sticker.length) break;
    if (kind === 'ANIM') { payload.isAnimated = true; break; }
    offset += 8 + size + (size % 2);
  }
  return payload;
}

export function createWhatsAppRuntime({store, authFactory, authState, socketFactory = makeWASocket, sampleSticker, recipientHash = hash, timeouts = {}, diagnostics = () => {}}) {
  const limits = {connect:45_000, pairing:60_000, operation:15_000, cleanup:10_000, send:30_000,sendSpacing:1500,leaseSafety:50_000, ...timeouts};
  let sendQueue=Promise.resolve(),nextSendAt=0;
  let active = null, controlQueue = Promise.resolve(), retryTimer, revision = 0, attempts = 0, closed = false;
  let view = {status:'disconnected', phase:null, phoneNumber:null, name:null, qr:null, pairingCode:null, pairingExpiresAt:null, lastConnectedAt:null, error:null, errorCode:null, operationStartedAt:null, operationDeadlineAt:null, nextRetryAt:null, retryAttempt:0, lastDisconnectCode:null, savedSession:false,storageWarning:null};
  const serial = task => {const result = controlQueue.then(task); controlQueue = result.catch(() => {}); return result;};
  const current = ctx => !!ctx && active === ctx && !ctx.stopped && !closed;
  const transition = fields => {view = {...view, ...fields};};
  const noPairing = () => ({qr:null, pairingCode:null, pairingExpiresAt:null});
  const noProgress = () => ({phase:null, operationStartedAt:null, operationDeadlineAt:null, nextRetryAt:null});
  function log(event, code,cause) {try {diagnostics({event, errorCode:code,...(cause?{causeCode:/^[A-Z0-9_]{2,40}$/.test(cause.code||'')?cause.code:'UNCLASSIFIED'}:{}), disconnectCode:view.lastDisconnectCode, retryAttempt:attempts});} catch {}}
  async function bounded(operation, milliseconds = limits.operation) {
    let timer;
    try {return await Promise.race([operation, new Promise((_,reject) => {timer = setTimeout(() => reject(new AppError('OPERATION_TIMEOUT','WhatsApp took too long to respond. Try again or reset the session.',504)), milliseconds); timer.unref?.();})]);}
    finally {clearTimeout(timer);}
  }
  function sendSticker(ctx,jid,sticker){
    const result=sendQueue.then(async()=>{
      const delay=Math.max(0,nextSendAt-Date.now());if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
      if(!current(ctx)||view.status!=='connected')throw new AppError('WHATSAPP_OFFLINE','WhatsApp delivery is reconnecting.',503);
      try{return await bounded(ctx.socket.sendMessage(jid,stickerPayload(sticker)),limits.send);}
      catch(error){
        if(error.code==='OPERATION_TIMEOUT'){
          // A timeout does not cancel sendMessage. Retire its socket before the
          // next queued send can begin; the uncertain sticker is never replayed.
          await fail(ctx,'CONNECTION_FAILED','A sticker delivery timed out. Reconnecting WhatsApp before continuing.',{cause:error});
          throw new AppError('DELIVERY_UNCONFIRMED','Delivery could not be confirmed. Check WhatsApp before trying again.',502);
        }
        throw error;
      }
      finally{nextSendAt=Date.now()+limits.sendSpacing;}
    });
    sendQueue=result.catch(()=>{});return result;
  }
  async function event(type, message) {try {await bounded(store.recordEvent(type,message),limits.cleanup);} catch {log('audit_unavailable','AUDIT_UNAVAILABLE');}}
  function cancelRetries() {revision++; clearTimeout(retryTimer); retryTimer = undefined;}
  function clearTimers(ctx) {clearInterval(ctx.heartbeat); clearTimeout(ctx.deadline);clearTimeout(ctx.leaseDeadline);}
  function confirmLease(ctx,requestedAt){
    if(!current(ctx))return;
    clearTimeout(ctx.leaseDeadline);
    // Count from request start, not response arrival; this is conservative over a slow link.
    ctx.leaseDeadline=setTimeout(()=>{void fail(ctx,'LEASE_RENEWAL_TIMEOUT','The database could not confirm session ownership in time. Reconnect when it is available.',{leaseLost:true});},Math.max(0,limits.leaseSafety-(Date.now()-requestedAt)));ctx.leaseDeadline.unref?.();
    transition({storageWarning:null});
  }
  async function release(ctx) {
    if (!ctx?.ownsLease) return;
    ctx.ownsLease = false;
    await bounded(store.releaseLease(ctx.owner),limits.cleanup);
  }
  async function stop(ctx,{preserveLease=false}={}) {
    if (!ctx) return;
    ctx.stopped = true; clearTimers(ctx);
    if (active === ctx) active = null;
    ctx.socket?.ev.removeAllListeners('connection.update');
    ctx.socket?.ev.removeAllListeners('messages.upsert');
    ctx.socket?.ev.removeAllListeners('creds.update');
    try {
      // Snapshot current creds before sealing: the last creds.update may still be queued
      // when WhatsApp asks for its post-pairing socket restart (515).
      let saving;
      try {saving = ctx.ownsLease ? ctx.auth?.saveCreds?.() : undefined;}
      catch(error) {saving = Promise.reject(error);}
      let draining;
      try {draining = ctx.auth?.close ? ctx.auth.close() : ctx.auth?.flush();}
      finally {ctx.socket?.end(new Error('Connection stopped'));}
      await bounded(Promise.all([saving,draining]),limits.cleanup);
    } finally {if (!preserveLease) await release(ctx);}
  }
  async function fail(ctx,code,message,{leaseLost=false,cause}={}) {
    if (!current(ctx)) return;
    transition({status:'error',errorCode:code,error:message,storageWarning:null,...noPairing(),...noProgress()});
    log('connection_failed',code,cause);
    if (leaseLost) ctx.ownsLease = false;
    let stopped = false;
    try {await stop(ctx);stopped = true;} catch {log('cleanup_failed','CLEANUP_FAILED');}
    // A paired account survives network timeouts. Retry with its saved credentials;
    // storage/ownership failures and expired unpaired QR codes require admin recovery.
    if (stopped && !leaseLost && ctx.auth?.state.creds.registered && ['CONNECTION_TIMEOUT','CONNECTION_FAILED','PAIRING_TIMEOUT'].includes(code) && !active) retry(ctx.options,ctx.revision,null);
    void event('connection_failed',message);
  }
  function arm(ctx,milliseconds,code,message) {
    clearTimeout(ctx.deadline);
    transition({operationStartedAt:new Date().toISOString(),operationDeadlineAt:new Date(Date.now()+milliseconds).toISOString()});
    ctx.deadline = setTimeout(() => {void fail(ctx,code,message);},milliseconds);ctx.deadline.unref?.();
  }
  function guarded(ctx,task,code='CONNECTION_FAILED') {
    Promise.resolve().then(async () => {if (current(ctx)) await task();}).catch(error => fail(ctx,code,code === 'AUTH_STORAGE_FAILED' ? 'The saved WhatsApp session could not be updated. Reconnect when the database is available. Reset only if the saved credentials are rejected.' : 'WhatsApp could not finish connecting. Retry the connection or reset the saved session.',{cause:error}));
  }
  function retry(options,token,code) {
    if (token !== revision || closed) return;
    attempts++;
    if (attempts > 6) {
      transition({status:'error',errorCode:code===440?'SESSION_REPLACED':'RECONNECT_LIMIT',error:'WhatsApp could not reconnect after several attempts. Reset the session to get a new QR code.',...noProgress(),...noPairing()});return;
    }
    const delay = code === 515 ? 500 : Math.min(30_000,1000*2**(attempts-1));
    transition({status:code===440?'busy':'reconnecting',phase:'retry_wait',retryAttempt:attempts,nextRetryAt:new Date(Date.now()+delay).toISOString(),operationDeadlineAt:null,operationStartedAt:null,...noPairing()});
    retryTimer = setTimeout(() => {void serial(async () => {if (token === revision && !closed) await begin(options);});},delay);retryTimer.unref?.();
  }
  async function receive(ctx,update) {
    if (!current(ctx) || view.status !== 'connected' || update.type !== 'notify') return;
    for (const item of (update.messages ?? []).slice(0,20)) {
      if (!current(ctx)) return;
      const jid = item.key?.remoteJid, timestamp = Number(item.messageTimestamp);
      if (item.key?.fromMe || !jid || !/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/.test(jid) || !Number.isFinite(timestamp) || timestamp*1000 < ctx.boot-5000 || timestamp*1000 > Date.now()+60_000) continue;
      const text = item.message?.conversation ?? item.message?.extendedTextMessage?.text;
      const match = typeof text === 'string' && /^STICKER ([a-f0-9]{32})$/.exec(text.trim());
      if (!match) continue;
      const leaseStarted=Date.now();
      if (!await bounded(store.renewLease(ctx.owner))) {await fail(ctx,'SESSION_OWNERSHIP_LOST','The connection moved to another backend. Wait a moment, then reconnect.',{leaseLost:true});return;}
      if (!current(ctx)) return;
      confirmLease(ctx,leaseStarted);
      const request = await bounded(store.claimRequest(hash(match[1]),recipientHash(jidNormalizedUser(jid))));
      if (!request) continue;
      let sent;
      try {
        if (!current(ctx)) throw new Error('Connection changed');
        sent = await sendSticker(ctx,jid,request.sticker);
      } catch {await bounded(store.finishRequest(request.id,'failed'));void event('delivery_failed','Sticker delivery failed');continue;}
      await bounded(store.finishRequest(request.id,'delivered',sent?.key?.id));void event('delivered','Sticker delivered');
    }
  }
  async function connection(ctx,update,options) {
    if (!current(ctx)) return;
    if (update.qr && options.method === 'code' && !ctx.auth.state.creds.registered && !ctx.requestedCode) {
      ctx.requestedCode = true;
      transition({phase:'requesting_code'});
      let code;
      try {code = await bounded(ctx.socket.requestPairingCode(options.phoneNumber));}
      catch {await fail(ctx,'PAIRING_CODE_TIMEOUT','WhatsApp did not return a pairing code. Retry, or reset and use QR pairing.');return;}
      if (!current(ctx)) return;
      const expires = new Date(Date.now()+limits.pairing).toISOString();
      transition({status:'pairing',phase:'waiting_for_scan',...noPairing(),pairingCode:code,pairingExpiresAt:expires});
      arm(ctx,limits.pairing,'PAIRING_EXPIRED','The pairing code expired. Connect again to get a new code.');
    }
    if (update.qr && options.method !== 'code') {
      const qr = await QRCode.toDataURL(update.qr);
      if (!current(ctx)) return;
      const expires = new Date(Date.now()+limits.pairing).toISOString();
      transition({status:'pairing',phase:'waiting_for_scan',...noPairing(),qr,pairingExpiresAt:expires});
      arm(ctx,limits.pairing,'PAIRING_EXPIRED','The QR code expired. Connect again or reset the session for a fresh QR.');
    }
    if (update.isNewLogin) {
      transition({status:'connecting',phase:'finishing_pairing',...noPairing()});
      arm(ctx,limits.connect,'PAIRING_TIMEOUT','WhatsApp did not finish linking this device. Reset the session and try a new QR.');
    }
    if (update.connection === 'open') {
      clearTimeout(ctx.deadline);attempts = 0;
      transition({status:'connected',error:null,errorCode:null,lastDisconnectCode:null,phoneNumber:jidNormalizedUser(ctx.socket.user?.id ?? '').split('@')[0] || null,name:ctx.socket.user?.name ?? null,lastConnectedAt:new Date().toISOString(),savedSession:true,retryAttempt:0,...noPairing(),...noProgress()});
      void event('connected','WhatsApp connected');
    }
    if (update.connection === 'close') {
      const raw = update.lastDisconnect?.error?.output?.statusCode ?? update.lastDisconnect?.error?.statusCode;
      const code = Number.isInteger(Number(raw)) ? Number(raw) : null;
      transition({lastDisconnectCode:code,...noPairing()});log('socket_closed',code ? `WHATSAPP_${code}` : 'CONNECTION_CLOSED');
      if ([401,500,440,411].includes(code)) {
        transition({status:'disconnecting',phase:'clearing_session',operationStartedAt:new Date().toISOString(),operationDeadlineAt:new Date(Date.now()+limits.cleanup).toISOString()});
        let cleared = false, cleanupFailed = false;
        try {
          try {await stop(ctx,{preserveLease:true});}
          finally {if (code !== 440 && ctx.ownsLease && await bounded(store.renewLease(ctx.owner))) {await bounded(store.clearAuth(ctx.owner));cleared = true;}}
        } catch {cleanupFailed = !cleared;log('cleanup_failed','SESSION_CLEANUP_FAILED');
        } finally {
          try {await release(ctx);} catch {cleanupFailed = true;log('cleanup_failed','LEASE_RELEASE_FAILED');}
          if (ctx.revision === revision && !active) transition({status:cleanupFailed?'error':'disconnected',phoneNumber:null,name:null,savedSession:!cleared,errorCode:cleanupFailed?'SESSION_CLEANUP_FAILED':code===440?'SESSION_REPLACED':'SESSION_INVALID',error:cleanupFailed?'The old session could not be cleared. Reset it when the database connection is available.':code===440?'This session is connected elsewhere. Stop the other backend, then reconnect.':'WhatsApp rejected the saved session. Connect again or reset it to get a new QR.',...noPairing(),...noProgress()});
        }
        void event('disconnected','WhatsApp requires a new connection');return;
      }
      transition({status:'reconnecting',phase:'disconnecting',operationStartedAt:new Date().toISOString(),operationDeadlineAt:new Date(Date.now()+limits.cleanup).toISOString()});
      try {await stop(ctx);}
      catch {
        if (ctx.revision === revision && !active) transition({status:'error',errorCode:'SESSION_CLEANUP_FAILED',error:'WhatsApp stopped, but the saved session could not be closed cleanly. Reset the session to start again.',...noProgress(),...noPairing()});
        log('cleanup_failed','SESSION_CLEANUP_FAILED');return;
      }
      if (!active) retry(options,ctx.revision,code);
    }
  }
  async function begin(options={method:'qr'}) {
    if (closed) return;
    const ctx = {owner:randomUUID(),revision,options,stopped:false,ownsLease:false,boot:Date.now(),events:Promise.resolve(),deliveries:Promise.resolve(),pendingDeliveries:0};
    active = ctx;
    transition({status:attempts?'reconnecting':'connecting',phase:'loading_session',error:null,errorCode:null,storageWarning:null,nextRetryAt:null,retryAttempt:attempts,...noPairing()});
    arm(ctx,limits.connect,'CONNECTION_TIMEOUT','WhatsApp did not return a QR code or finish connecting in time. Retry, or reset the session for a new QR.');
    try {
      let acquired;
      const acquireStarted=Date.now();
      const acquiring = Promise.resolve().then(() => store.acquireLease(ctx.owner));
      // A database call can finish after our timeout. Its obsolete owner must not block recovery.
      acquiring.then(acquired => {if (acquired && !current(ctx) && !ctx.ownsLease) void bounded(store.releaseLease(ctx.owner),limits.cleanup).catch(() => log('lease_release_failed','LEASE_RELEASE_FAILED'));}).catch(() => {});
      try {acquired = await bounded(acquiring);}
      catch {await fail(ctx,'DATABASE_UNAVAILABLE','The database could not load the WhatsApp session. Check the connection, then retry or reset.');return;}
      if (!current(ctx)) {if (acquired) await bounded(store.releaseLease(ctx.owner));return;}
      if (!acquired) {
        clearTimers(ctx);active = null;
        transition({status:'busy',phase:null,errorCode:'SESSION_BUSY',error:'Another backend is using this WhatsApp session. Stop it or wait up to 60 seconds before retrying.',...noProgress()});
        retry(options,ctx.revision,440);return;
      }
      ctx.ownsLease = true;
      confirmLease(ctx,acquireStarted);
      try {ctx.auth = await bounded((authFactory ?? authState)(ctx.owner));}
      catch {await fail(ctx,'AUTH_STORAGE_FAILED','The saved WhatsApp session could not be read or updated. Reset the session to pair again.');return;}
      if (!current(ctx)) {await stop(ctx);return;}
      transition({phase:'opening_connection',savedSession:!!ctx.auth.state.creds.registered});
      // Use Baileys' supported default browser identity rather than a fabricated OS/version.
      const persistentKeys={
        get:(...args)=>ctx.auth.state.keys.get(...args),
        async set(data){try{return await ctx.auth.state.keys.set(data);}catch(error){
          // The cache must never let a failed persistence write go unnoticed.
          void fail(ctx,'AUTH_STORAGE_FAILED','Encryption keys could not be saved. Reconnect when the database is available.',{cause:error});throw error;
        }}
      };
      ctx.socket = socketFactory({auth:{creds:ctx.auth.state.creds,keys:makeCacheableSignalKeyStore(persistentKeys,quiet)},logger:quiet,printQRInTerminal:false,syncFullHistory:false,markOnlineOnConnect:false,connectTimeoutMs:20_000,defaultQueryTimeoutMs:30_000,getMessage:async()=>undefined});
      let renewing = false;
      ctx.heartbeat = setInterval(async () => {
        if (!current(ctx) || renewing) return;renewing = true;
        const requestedAt=Date.now();
        try {
          const renewed=await bounded(store.renewLease(ctx.owner),10_000);
          if(!current(ctx))return;
          if (!renewed) await fail(ctx,'SESSION_OWNERSHIP_LOST','The WhatsApp session is no longer owned by this backend. Reconnect to try again.',{leaseLost:true});
          else confirmLease(ctx,requestedAt);
        }
        catch(error){if(current(ctx)){transition({storageWarning:'The database is slow to respond. Retrying session ownership checks.'});log('lease_retry','DATABASE_RETRYING',error);}}
        finally {renewing = false;}
      },15_000);ctx.heartbeat.unref?.();
      ctx.socket.ev.on('creds.update',() => guarded(ctx,async () => {await bounded(ctx.auth.saveCreds());await bounded(ctx.auth.flush());},'AUTH_STORAGE_FAILED'));
      ctx.socket.ev.on('connection.update',update => {ctx.events = ctx.events.then(() => connection(ctx,update,options)).catch(() => fail(ctx,'CONNECTION_FAILED','WhatsApp could not finish connecting. Retry or reset the saved session.'));});
      ctx.socket.ev.on('messages.upsert',update => {
        if (!current(ctx) || ctx.pendingDeliveries >= 20) return;ctx.pendingDeliveries++;
        ctx.deliveries = ctx.deliveries.then(() => receive(ctx,update)).catch(() => fail(ctx,'DELIVERY_CONNECTION_FAILED','WhatsApp delivery stopped. Reconnect to try again.')).finally(() => {ctx.pendingDeliveries--;});
      });
    } catch {await fail(ctx,'CONNECTION_FAILED','WhatsApp could not open a connection. Retry or reset the saved session.');}
  }
  async function cleanupOwner() {
    if (active?.ownsLease) return active;
    const ctx = {owner:randomUUID(),revision,stopped:false,ownsLease:false};
    const acquiring = Promise.resolve().then(() => store.acquireLease(ctx.owner));
    let acquired;
    try {acquired = await bounded(acquiring);}
    catch(error) {acquiring.then(acquired => {if (acquired) return bounded(store.releaseLease(ctx.owner),limits.cleanup);}).catch(() => log('lease_release_failed','LEASE_RELEASE_FAILED'));throw error;}
    if (!acquired) throw new AppError('SESSION_BUSY','Another backend owns this session. Stop it or wait up to 60 seconds, then reset again.',409);
    ctx.ownsLease = true;return ctx;
  }
  return {
    status:() => ({...view}),
    async startSaved() {return serial(async () => {try {if (await bounded(store.hasAuth())) await begin();} catch {transition({status:'error',errorCode:'DATABASE_UNAVAILABLE',error:'The saved session could not be loaded. Check the database, then retry or reset.',...noProgress()});}});},
    async connect({method='qr',phoneNumber}={}) {
      if (!['qr','code'].includes(method)) throw new AppError('INVALID_PAIRING','Choose QR or phone pairing.');
      const normalized = String(phoneNumber ?? '').replace(/[\s+()-]/g,'');
      if (method === 'code' && !/^\d{7,15}$/.test(normalized)) throw new AppError('INVALID_PHONE','Enter a valid international phone number.');
      return serial(async () => {
        if (view.status === 'connected' && current(active)) return {...view};
        cancelRetries();attempts = 0;
        transition({lastDisconnectCode:null});
        if (active) {try {await stop(active);} catch {log('cleanup_failed','CLEANUP_FAILED');}}
        await begin({method,phoneNumber:normalized});return {...view};
      });
    },
    async reset() {return serial(async () => {
      cancelRetries();attempts = 0;
      transition({status:'resetting',phase:'clearing_session',error:null,errorCode:null,lastDisconnectCode:null,...noPairing(),operationStartedAt:new Date().toISOString(),operationDeadlineAt:new Date(Date.now()+30_000).toISOString(),nextRetryAt:null});
      let ctx,fence;
      try {
        ctx = await cleanupOwner();
        try {await stop(ctx,{preserveLease:true});} catch {log('reset_drain_failed','CLEANUP_FAILED');}
        const nextOwner = randomUUID();
        const resetting = Promise.resolve().then(() => store.resetAuth(ctx.owner,nextOwner));
        try {await bounded(resetting);}
        catch(error) {
          // A late commit still has a unique fence owner, which can be released safely.
          resetting.then(() => bounded(store.releaseLease(nextOwner),limits.cleanup)).catch(() => log('reset_cleanup_failed','LEASE_RELEASE_FAILED'));
          throw error;
        }
        ctx.ownsLease = false;
        // Keep the retired context's owner immutable for any already-running cleanup.
        fence = {owner:nextOwner,ownsLease:true};
        await release(fence);transition({savedSession:false,phoneNumber:null,name:null});
        void event('session_reset','Saved WhatsApp credentials and encryption keys deleted');
        await begin({method:'qr'});return {...view};
      } catch (error) {
        if (fence) {try {await release(fence);} catch {}}
        if (ctx) {try {await release(ctx);} catch {}}
        const busy = error.code === 'SESSION_BUSY';
        transition({status:busy?'busy':'error',errorCode:busy?'SESSION_BUSY':'RESET_FAILED',error:busy?error.message:'The session could not be reset. Check the database connection and try again.',...noPairing(),...noProgress()});
        throw new AppError(view.errorCode,view.error,busy?409:503);
      }
    });},
    async disconnect() {return serial(async () => {
      cancelRetries();transition({status:'disconnecting',phase:'disconnecting',error:null,errorCode:null,...noPairing(),operationStartedAt:new Date().toISOString(),operationDeadlineAt:new Date(Date.now()+30_000).toISOString()});
      let ctx,logoutFailed=false,cleared=false,failure;
      try {
        ctx = await cleanupOwner();ctx.stopped = true;clearTimers(ctx);
        try {await bounded(ctx.socket?.logout());} catch {logoutFailed=true;}
        try {await stop(ctx,{preserveLease:true});}
        finally {if (ctx.ownsLease && await bounded(store.renewLease(ctx.owner))) {await bounded(store.clearAuth(ctx.owner));cleared = true;}else throw new Error('Session ownership was lost');}
      } catch(error) {failure = error;
      } finally {
        if (ctx) {try {await release(ctx);} catch(error) {failure ||= error;}}
        if (cleared) transition({status:'disconnected',savedSession:false,phoneNumber:null,name:null,...noPairing(),...noProgress()});
        else transition({status:failure?.code==='SESSION_BUSY'?'busy':'error',errorCode:failure?.code==='SESSION_BUSY'?'SESSION_BUSY':'DISCONNECT_FAILED',error:failure?.code==='SESSION_BUSY'?failure.message:'The saved session could not be cleared. Check the database, then retry or reset.',...noPairing(),...noProgress()});
      }
      if (failure) throw new AppError(cleared?'LOGOUT_UNCONFIRMED':view.errorCode,cleared?'The saved session was cleared. Unlink this device in WhatsApp Linked devices if needed.':view.error,failure.code==='SESSION_BUSY'?409:503);
      if (logoutFailed) throw new AppError('LOGOUT_UNCONFIRMED','The saved session was cleared. Unlink this device in WhatsApp Linked devices if needed.',502);
      void event('disconnected','WhatsApp disconnected by admin');
    });},
    async sendTest() {
      const ctx = active;
      if (view.status !== 'connected' || !ctx?.socket?.user?.id) throw new AppError('WHATSAPP_OFFLINE','Connect WhatsApp before sending a test.');
      if(view.storageWarning)throw new AppError('DATABASE_RETRYING','Session storage is reconnecting. Wait for the database warning to clear before sending a test.',503);
      if (!sampleSticker) throw new Error('Test sticker is unavailable');
      const sticker = typeof sampleSticker === 'function' ? await sampleSticker() : sampleSticker;
      const leaseStarted=Date.now();
      if (!await bounded(store.renewLease(ctx.owner))) {await fail(ctx,'SESSION_OWNERSHIP_LOST','WhatsApp connection was lost.',{leaseLost:true});throw new Error('WhatsApp connection was lost');}
      if (!current(ctx)) throw new Error('WhatsApp connection was lost');
      confirmLease(ctx,leaseStarted);
      const result = await sendSticker(ctx,jidNormalizedUser(ctx.socket.user.id),sticker);
      if (!current(ctx)) throw new Error('WhatsApp connection was lost');
      void event('test_sent','Test sticker sent to the connected account');return {message:'Test sticker sent',messageId:result?.key?.id};
    },
    async sendToNumber({tokenHash,phoneNumber}){
      const ctx=active;
      if(view.status!=='connected'||!current(ctx))throw new AppError('WHATSAPP_OFFLINE','WhatsApp delivery is offline. Please try again shortly.',503);
      if(view.storageWarning)throw new AppError('DATABASE_RETRYING','Session storage is reconnecting. Please try again shortly.',503);
      if(!/^\+\d{7,15}$/.test(phoneNumber||'')||!/^[a-f0-9]{64}$/.test(tokenHash||''))throw new AppError('INVALID_PHONE','Enter a valid international WhatsApp number.');
      const jid=phoneNumber.slice(1)+'@s.whatsapp.net',leaseStarted=Date.now();
      if(!await bounded(store.renewLease(ctx.owner))){await fail(ctx,'SESSION_OWNERSHIP_LOST','WhatsApp connection was lost.',{leaseLost:true});throw new AppError('WHATSAPP_OFFLINE','WhatsApp delivery is reconnecting.',503);}
      if(!current(ctx))throw new AppError('WHATSAPP_OFFLINE','WhatsApp delivery is reconnecting.',503);
      confirmLease(ctx,leaseStarted);
      const request=await bounded(store.claimRequest(tokenHash,recipientHash(jidNormalizedUser(jid))));
      if(!request)throw new AppError('RECIPIENT_LIMIT','This number has reached its sticker limit. Please try again later.',429);
      try{
        const matches=await bounded(ctx.socket.onWhatsApp(phoneNumber.slice(1)));
        if(!Array.isArray(matches))throw new AppError('LOOKUP_UNAVAILABLE','WhatsApp could not verify this number right now. Please try again shortly.',503);
        const registered=matches.find(match=>match.exists===true);
        if(!registered)throw new AppError('NOT_ON_WHATSAPP','This number is not registered on WhatsApp. Check the number and country.',422);
        const target=typeof registered.jid==='string'?jidNormalizedUser(registered.jid):'';
        if(!/^\d{7,20}@(s\.whatsapp\.net|lid)$/.test(target))throw new AppError('LOOKUP_UNAVAILABLE','WhatsApp could not verify this number right now. Please try again shortly.',503);
        if(!current(ctx))throw new AppError('WHATSAPP_OFFLINE','WhatsApp delivery is reconnecting.',503);
        const sent=await sendSticker(ctx,target,request.sticker);
        await bounded(store.finishRequest(request.id,'delivered',sent?.key?.id));
        void event('delivered','Sticker sent to a requested WhatsApp number');
        return {status:'delivered'};
      }catch(error){
        try{await bounded(store.finishRequest(request.id,'failed'));}catch{log('delivery_status_failed','DATABASE_UNAVAILABLE');}
        if(error instanceof AppError&&error.code!=='OPERATION_TIMEOUT')throw error;
        throw new AppError('DELIVERY_UNCONFIRMED','Delivery could not be confirmed. Check WhatsApp before trying again.',502);
      }
    },
    async close() {return serial(async () => {closed = true;cancelRetries();try {await stop(active);} finally {transition({status:'disconnected',...noPairing(),...noProgress()});}});}
  };
}
