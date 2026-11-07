import {AppError} from './media.js';
import {clientAddress} from './admin.js';
import {digest,randomToken} from './security.js';
import {normalizePhoneNumber} from './phone.js';

export function createWhatsAppApi({store,auth,runtime,origins,batches}){
 return async function handle(req,res,pathname,{json,body,readStickerJob,readBatchCandidates}){
  if(pathname==='/api/whatsapp/status'&&req.method==='GET'){
   const connection=runtime.status();json(res,200,{available:connection.status==='connected'&&!connection.storageWarning});return true;
  }
  if(pathname==='/api/whatsapp/batches'&&req.method==='POST'){
   if(!origins.has(req.headers.origin))throw new AppError('ORIGIN_DENIED','Use the Sticker Studio app to send stickers.',403);
   if(!batches)throw new AppError('WHATSAPP_OFFLINE','Bulk delivery is not available yet.',503);
   const address=clientAddress(req);
   if(!await store.checkLimit(`whatsapp-batch-create:${digest(address)}`,20,60))throw new AppError('SEND_LIMIT','Too many queue requests. Please try again shortly.',429);
   json(res,202,await batches.create(await body(req),address,readBatchCandidates));return true;
  }
  const batchRoute=pathname.match(/^\/api\/whatsapp\/batches\/([a-f0-9-]{36})(?:\/(stop|resume))?$/);
  if(batchRoute&&batches){
   const [,id,action]=batchRoute;
   if((req.method==='POST'&&!origins.has(req.headers.origin))||(req.headers.origin&&!origins.has(req.headers.origin)))throw new AppError('ORIGIN_DENIED','Use the Sticker Studio app to view this queue.',403);
   if(!await store.checkLimit(`whatsapp-batch-check:${digest(clientAddress(req))}:${id}`,90,60))throw new AppError('SEND_LIMIT','Too many queue requests. Please wait a moment.',429);
   if(req.method==='GET'&&!action){json(res,200,await batches.status(id));return true;}
   if(req.method==='POST'&&action==='stop'){await body(req);json(res,200,await batches.stop(id));return true;}
   if(req.method==='POST'&&action==='resume'){json(res,200,await batches.resume(id,await body(req)));return true;}
  }
  if(pathname==='/api/whatsapp/send'&&req.method==='POST'){
   if(!origins.has(req.headers.origin))throw new AppError('ORIGIN_DENIED','Use the Sticker Studio app to send a sticker.',403);
   if(!await store.checkLimit(`whatsapp-check:${digest(clientAddress(req))}`,60,60))throw new AppError('SEND_LIMIT','Too many requests. Please try again shortly.',429);
   const input=await body(req);
   if(!/^[a-f0-9]{32}$/.test(input?.jobId||'')||!/^[a-f0-9]{32}$/.test(input?.requestId||''))throw new AppError('INVALID_JOB','Open a converted sticker to send it to WhatsApp.');
   const phone=normalizePhoneNumber(input.phoneNumber,input.country??'NG');
   const tokenHash=digest(`direct:${input.requestId}:${input.jobId}:${phone.number}`),recipientHash=store.hashRecipient(phone.number.slice(1)+'@s.whatsapp.net');
   const respond=delivery=>{const status=delivery.status==='pending'?'sending':delivery.status;json(res,['pending','sending'].includes(delivery.status)?202:200,{status,phoneNumber:phone.formatted});};
   const existing=await store.getDirectRequest(tokenHash,recipientHash);
   if(existing){respond(existing);return true;}
   const connection=runtime.status();
   if(connection.status!=='connected')throw new AppError('WHATSAPP_OFFLINE','WhatsApp delivery is offline. Please try again shortly.',503);
   if(connection.storageWarning)throw new AppError('DATABASE_RETRYING','WhatsApp session storage is reconnecting. Please try again shortly.',503);
   if(!await store.checkLimit(`whatsapp-ip:${digest(clientAddress(req))}`,10,600)||!await store.checkLimit('whatsapp-global',200,3600))throw new AppError('SEND_LIMIT','Too many sticker requests. Please try again later.',429);
   const sticker=await readStickerJob(input.jobId);
   const delivery=await store.prepareDirectRequest(tokenHash,recipientHash,sticker);
   if(!delivery.created){respond(delivery);return true;}
   try{await runtime.sendToNumber({tokenHash,phoneNumber:phone.number});respond({status:'delivered'});}
   catch(error){try{await store.finishRequest(delivery.id,'failed');}catch{}throw error;}
   return true;
  }
  if(pathname==='/api/whatsapp/requests'&&req.method==='POST'){
   if(req.headers.origin&&!origins.has(req.headers.origin))throw new AppError('ORIGIN_DENIED','Use the Sticker Studio app to send a sticker.',403);
   const connection=runtime.status();
   if(connection.status!=='connected'||!/^\d{7,15}$/.test(connection.phoneNumber||''))throw new AppError('WHATSAPP_OFFLINE','WhatsApp delivery is offline. You can still download your sticker.',503);
   if(connection.storageWarning)throw new AppError('DATABASE_RETRYING','WhatsApp session storage is reconnecting. Please try again shortly.',503);
   if(!await store.checkLimit(`whatsapp-ip:${digest(clientAddress(req))}`,10,600)||!await store.checkLimit('whatsapp-global',200,3600))throw new AppError('SEND_LIMIT','Too many sticker requests. Please try again later.',429);
   const input=await body(req);
   if(!/^[a-f0-9]{32}$/.test(input?.jobId||''))throw new AppError('INVALID_JOB','Open a converted sticker to send it to WhatsApp.');
   const sticker=await readStickerJob(input.jobId);
   const token=randomToken(),request=await store.createRequest(digest(token),sticker);
   json(res,201,{url:`https://wa.me/${connection.phoneNumber}?text=${encodeURIComponent(`STICKER ${token}`)}`,expiresAt:request.expiresAt});return true;
  }
  if(!pathname.startsWith('/api/admin/'))return false;
  res.setHeader('X-Frame-Options','DENY');
  if(pathname==='/api/admin/login'&&req.method==='POST'){
   const result=await auth.login(req,await body(req));res.setHeader('Set-Cookie',result.cookie);json(res,200,result.body);return true;
  }
  const session=await auth.requireSession(req);
  if(req.method==='GET'&&pathname==='/api/admin/me'){
   json(res,200,{admin:{email:session.admin.email},csrfToken:session.csrfToken});return true;
  }
  if(req.method==='GET'&&pathname==='/api/admin/dashboard'){
   const data=await store.dashboard();
   json(res,200,{...data,whatsapp:runtime.status(),database:{connected:true},updatedAt:new Date().toISOString()});return true;
  }
  if(req.method==='POST'){
   auth.requireMutation(req,session);
   if(pathname==='/api/admin/logout'){
    res.setHeader('Set-Cookie',await auth.logout(req,session));json(res,200,{ok:true});return true;
   }
   if(!await store.checkLimit(`admin-action:${session.admin.id}`,30,60))throw new AppError('ACTION_LIMIT','Please wait a moment before trying again.',429);
   if(pathname==='/api/admin/whatsapp/connect'){
    const input=await body(req),method=input?.method||'qr';
    if(!['qr','code'].includes(method))throw new AppError('INVALID_PAIRING','Choose QR code or phone number pairing.');
    if(method==='code'&&(typeof input.phoneNumber!=='string'||!/^\d{7,15}$/.test(input.phoneNumber)))throw new AppError('INVALID_PHONE','Enter your phone number with its country code, using digits only.');
    json(res,200,{whatsapp:await runtime.connect({method,phoneNumber:input.phoneNumber})});return true;
   }
   if(pathname==='/api/admin/whatsapp/disconnect'){
    await runtime.disconnect();json(res,200,{whatsapp:runtime.status()});return true;
   }
   if(pathname==='/api/admin/whatsapp/reset'){
    await body(req);
    json(res,200,{whatsapp:await runtime.reset(),message:'Saved WhatsApp credentials cleared. Starting a fresh QR connection.'});return true;
   }
   if(pathname==='/api/admin/whatsapp/test'){
    if(runtime.status().status!=='connected')throw new AppError('WHATSAPP_OFFLINE','Connect WhatsApp before sending a test sticker.',409);
    await runtime.sendTest();json(res,200,{ok:true,message:'Test sticker sent to your connected account.'});return true;
   }
  }
  throw new AppError('NOT_FOUND','This admin endpoint does not exist.',404);
 };
}
