import {randomUUID} from 'node:crypto';
import {AppError,downloadMedia,prepareMedia} from './media.js';
import {digest} from './security.js';
import {normalizePhoneNumber} from './phone.js';

export const MAX_BATCH_SIZE=10;
const pending=new Set(['queued','preparing','sending']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function selectBatchCandidates(input,discovery){
 if(!Array.isArray(input?.candidateIds)||!input.candidateIds.length||input.candidateIds.length>MAX_BATCH_SIZE)throw new AppError('BATCH_LIMIT','Choose between 1 and 10 stickers for each send.');
 if(new Set(input.candidateIds).size!==input.candidateIds.length||input.candidateIds.some(id=>typeof id!=='string'))throw new AppError('INVALID_SELECTION','Choose different stickers from these results.');
 if(!discovery||discovery.status!=='needs_selection'||discovery.inputUrl!==input.url)throw new AppError('INVALID_SELECTION','These results expired. Fetch the video again before sending.');
 const available=new Map(discovery.result.candidates.filter(item=>item.type==='sticker'&&item.available&&item.mediaUrl).map(item=>[item.id,item]));
 return input.candidateIds.map(id=>{const candidate=available.get(id);if(!candidate)throw new AppError('INVALID_SELECTION','A selected sticker is unavailable or does not belong to these results.');return candidate;});
}

export function createWhatsAppBatches({store,batchStore,runtime,download=downloadMedia,convert=bytes=>prepareMedia(bytes,{type:'sticker'}),diagnostics=()=>{}}){
 const owner=randomUUID(),recipients=new Map();
 let timer,working=null,closed=false,activeDownload=null;
 const connected=()=>{const state=runtime.status();return state.status==='connected'&&!state.storageWarning;};
 function validateId(id){if(!uuid.test(id||''))throw new AppError('BATCH_EXPIRED','This queue is no longer available.',404);}
 function remember(batch,phone){if(new Date(batch.expires_at)>new Date()&&!batch.cancelled&&batch.items.some(item=>pending.has(item.status)))recipients.set(batch.id,{number:phone.number,expiresAt:new Date(batch.expires_at).getTime()});}
 async function status(id){
  validateId(id);const batch=await batchStore.get(id),expired=new Date(batch.expires_at)<=new Date();
  const waiting=batch.items.some(item=>pending.has(item.status));
  if(expired||!waiting){recipients.delete(id);}
  const inProgress=batch.items.some(item=>['preparing','sending'].includes(item.status));
  const state=expired&&waiting?'expired':batch.cancelled?(inProgress?'stopping':'stopped'):waiting?(inProgress?'sending':'queued'):batch.items.every(item=>item.status==='sent')?'completed':'completed_with_errors';
  return {id:batch.id,status:state,needsNumber:waiting&&!expired&&!batch.cancelled&&!recipients.has(id),waitingForConnection:waiting&&!connected(),expiresAt:new Date(batch.expires_at).toISOString(),items:batch.items.map(item=>({position:item.position,status:expired&&['queued','preparing'].includes(item.status)?'stopped':item.status,error:item.error_message||null}))};
 }
 async function create(input,address,readCandidates){
  if(!/^[a-f0-9]{32}$/.test(input?.requestId||'')||!/^[a-f0-9]{32}$/.test(input?.discoveryJobId||''))throw new AppError('INVALID_SELECTION','Choose stickers from your current results.');
  if(!Array.isArray(input.candidateIds)||!input.candidateIds.length||input.candidateIds.length>MAX_BATCH_SIZE)throw new AppError('BATCH_LIMIT','Choose between 1 and 10 stickers for each send.');
  if(input.candidateIds.some(id=>typeof id!=='string'||id.length>100)||new Set(input.candidateIds).size!==input.candidateIds.length)throw new AppError('INVALID_SELECTION','Choose different stickers from these results.');
  const phone=normalizePhoneNumber(input.phoneNumber,input.country??'NG'),recipientHash=store.hashRecipient(phone.number.slice(1)+'@s.whatsapp.net');
  const tokenHash=digest(`batch:${input.requestId}`),requestHash=digest(JSON.stringify({discoveryJobId:input.discoveryJobId,candidateIds:input.candidateIds,recipientHash}));
  const previous=await batchStore.find(tokenHash);
  if(previous){if(previous.request_hash!==requestHash)throw new AppError('REQUEST_MISMATCH','This request already belongs to a different selection.');remember(await batchStore.get(previous.id),phone);return status(previous.id);}
  if(!connected())throw new AppError('WHATSAPP_OFFLINE','WhatsApp delivery is offline. Please try again shortly.',503);
  const candidates=await readCandidates(input);
  const id=await batchStore.create({tokenHash,requestHash,recipientHash,ipHash:digest(address),candidates});
  remember(await batchStore.get(id),phone);return status(id);
 }
 async function resume(id,input){
  validateId(id);const batch=await batchStore.get(id),phone=normalizePhoneNumber(input.phoneNumber,input.country??'NG');
  if(batch.recipient_hash!==store.hashRecipient(phone.number.slice(1)+'@s.whatsapp.net'))throw new AppError('RECIPIENT_MISMATCH','Use the same WhatsApp number you entered for this queue.');
  if(batch.cancelled||new Date(batch.expires_at)<=new Date())throw new AppError('BATCH_EXPIRED','This queue stopped or expired. Start a new send.',410);
  remember(batch,phone);return status(id);
 }
 async function stop(id){validateId(id);await batchStore.get(id);await batchStore.cancel(id);recipients.delete(id);if(activeDownload?.batchId===id)activeDownload.controller.abort();return status(id);}
 async function processItem(item,number,isLeaseSafe){
  const batch=await batchStore.get(item.batch_id),recipientHash=batch.recipient_hash;
  let request=await store.getDirectRequest(item.delivery_token_hash,recipientHash);
  if(request?.status==='delivered'){await batchStore.setState(item.id,'sent');return;}
  if(request&&['sending','failed','expired'].includes(request.status)){
   await batchStore.setState(item.id,'failed',{code:'DELIVERY_UNCONFIRMED',message:'This delivery could not be confirmed. Check WhatsApp before sending again.'});return;
  }
  if(!request){
   if(!item.sourceUrl)throw new AppError('STICKER_UNAVAILABLE','This sticker is unavailable. Fetch the video again.');
   const controller=new AbortController();activeDownload={batchId:item.batch_id,controller};
   try{
    const original=await download(item.sourceUrl,{signal:controller.signal});
    if(closed||controller.signal.aborted||!isLeaseSafe())return;
    const result=await convert(original);
    if(!result.bytes||result.bytes.length>500*1024)throw new AppError('CONVERSION_LIMIT','This sticker could not fit WhatsApp’s limits while preserving its animation.');
    if(closed||controller.signal.aborted||!isLeaseSafe())return;
    request=await store.prepareDirectRequest(item.delivery_token_hash,recipientHash,result.bytes);
   }finally{activeDownload=null;}
  }
  const current=await batchStore.get(item.batch_id);
  if(current.cancelled||closed||!isLeaseSafe()){if(current.cancelled)await store.finishRequest(request.id,'failed');return;}
  if(!connected()){await batchStore.setState(item.id,'queued');return;}
  if(!await batchStore.acquire(owner))return;
  if(!await batchStore.setState(item.id,'sending')){await store.finishRequest(request.id,'failed');return;}
  await runtime.sendToNumber({tokenHash:item.delivery_token_hash,phoneNumber:number});
  await batchStore.setState(item.id,'sent');
 }
 async function work(){
  for(const [id,recipient] of recipients)if(recipient.expiresAt<=Date.now())recipients.delete(id);
  if(closed||!recipients.size||!connected()||!await batchStore.acquire(owner))return;
  let heartbeat,leaseSafe=true,item;
  try{
   heartbeat=setInterval(()=>{batchStore.acquire(owner).then(ok=>{if(!ok){leaseSafe=false;activeDownload?.controller.abort();}}).catch(()=>{leaseSafe=false;activeDownload?.controller.abort();});},30000);heartbeat.unref?.();
   item=await batchStore.next(owner,[...recipients.keys()]);
   if(!item){for(const id of recipients.keys()){const view=await status(id);if(!['queued','sending'].includes(view.status))recipients.delete(id);}return;}
   const recipient=recipients.get(item.batch_id);if(!recipient)return;
   try{await processItem(item,recipient.number,()=>leaseSafe);}
   catch(error){
    const batch=await batchStore.get(item.batch_id);if(batch.cancelled)return;
    const delivery=await store.getDirectRequest(item.delivery_token_hash,batch.recipient_hash);
    if(['WHATSAPP_OFFLINE','DATABASE_RETRYING'].includes(error.code)&&(!delivery||delivery.status==='pending')){await batchStore.setState(item.id,'queued');return;}
    if(delivery?.status==='delivered'){await batchStore.setState(item.id,'sent');return;}
    const message=error instanceof AppError?error.message:'This sticker could not be sent. Try opening it individually.';
    await batchStore.setState(item.id,'failed',{code:error.code||'DELIVERY_FAILED',message});
    if(delivery?.status==='pending')await store.finishRequest(delivery.id,'failed');
    // Invalid or uncertain destinations must not trigger repeated lookups/sends.
    if(['NOT_ON_WHATSAPP','RECIPIENT_LIMIT','DELIVERY_UNCONFIRMED','LOOKUP_UNAVAILABLE'].includes(error.code)){await batchStore.cancel(item.batch_id);recipients.delete(item.batch_id);}
   }
  }finally{clearInterval(heartbeat);await batchStore.release(owner);}
 }
 function tick(){if(working)return Promise.resolve();working=work().finally(()=>{working=null;});return working;}
 return {create,status,resume,stop,tick,start(){if(timer||closed)return;timer=setInterval(()=>{void tick().catch(()=>diagnostics('Batch queue temporarily unavailable.'));},1000);timer.unref?.();},async close(){closed=true;clearInterval(timer);activeDownload?.controller.abort();await working?.catch(()=>{});recipients.clear();}};
}
