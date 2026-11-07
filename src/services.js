import {readFile} from 'node:fs/promises';
import {createPool,createStore,loadBaileysAuth,migrate} from './database.js';
import {createVault} from './security.js';
import {createAdminAuth} from './admin.js';
import {createWhatsAppRuntime} from './whatsapp.js';
import {createWhatsAppApi} from './whatsapp-api.js';
import {convertMedia} from './media.js';
import {createBatchStore} from './batch-store.js';
import {createWhatsAppBatches} from './whatsapp-batches.js';

export async function createServices({env=process.env,origins,runtimeFactory=createWhatsAppRuntime,batchFactory=createWhatsAppBatches,pool:providedPool}={}){
 const vault=createVault(env.WHATSAPP_ENCRYPTION_KEY);
 const pool=providedPool||createPool(env.DATABASE_URL);
 try{
  await migrate(pool);
  const store=createStore(pool,vault);
  if(env.ADMIN_SEED_EMAIL&&env.ADMIN_SEED_PASSWORD_HASH){
   await store.seedAdmin(env.ADMIN_SEED_EMAIL.trim().toLowerCase(),env.ADMIN_SEED_PASSWORD_HASH);
  }
  const auth=createAdminAuth({store,secret:env.ADMIN_JWT_SECRET,origins,secureCookies:env.NODE_ENV==='production'||env.RENDER==='true'});
  const runtime=runtimeFactory({store,authFactory:owner=>loadBaileysAuth(store,{owner}),diagnostics:entry=>console.warn('[whatsapp]',JSON.stringify(entry)),recipientHash:jid=>vault.recipientHash(jid),sampleSticker:async()=>{
   const sample=await readFile(new URL('../samples/animated.webp',import.meta.url));return (await convertMedia(sample)).bytes;
  }});
  const batches=batchFactory({store,batchStore:createBatchStore(pool,vault),runtime,diagnostics:message=>console.warn('[whatsapp-queue]',message)});
  const handle=createWhatsAppApi({store,auth,runtime,origins,batches});
  const cleanup=setInterval(()=>store.cleanup().catch(()=>console.error('[database] Scheduled cleanup could not complete.')),5*60*1000);cleanup.unref();
  return {store,runtime,handle,batches,async start(){await store.cleanup();await runtime.startSaved();batches.start();},async close(){clearInterval(cleanup);try{await batches.close();await runtime.close()}finally{await pool.end()}}};
 }catch(error){await pool.end();throw error;}
}
