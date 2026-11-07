import {EventEmitter} from 'node:events';
import {createServices} from '../../src/services.js';
import {createStickerServer} from '../../src/server.js';
import {createWhatsAppRuntime} from '../../src/whatsapp.js';
import {hashPassword} from '../../src/security.js';
import {randomBytes} from 'node:crypto';

export const testEmail='integration-admin@example.test';
export const testPassword='Integration-only-password-42';

export async function neonFixture({origin='http://127.0.0.1:5197',embedded=false}={}){
 const testUrl=process.env.NEON_TEST_DATABASE_URL;
 if(!embedded&&!testUrl)throw new Error('Set NEON_TEST_DATABASE_URL to an isolated Neon test branch.');
 const host=value=>new URL(value).hostname.replace('-pooler','');
 if(!embedded&&host(testUrl)===host(process.env.DATABASE_URL))throw new Error('Integration checks must use a different database branch from production.');
 const pool=embedded?(await import('./pglite-pool.mjs')).createTestPool():undefined;
 const sockets=[],sent=[];
 const services=await createServices({pool,env:{...process.env,DATABASE_URL:testUrl,ADMIN_JWT_SECRET:process.env.ADMIN_JWT_SECRET||randomBytes(48).toString('base64url'),WHATSAPP_ENCRYPTION_KEY:process.env.WHATSAPP_ENCRYPTION_KEY||randomBytes(32).toString('base64')},origins:new Set([origin]),runtimeFactory:options=>createWhatsAppRuntime({...options,socketFactory:config=>{
  const socket={ev:new EventEmitter(),user:{id:'2348000000000:1@s.whatsapp.net',name:'Integration fixture'},end(){},async logout(){},async requestPairingCode(){return '12345678'},async onWhatsApp(phone){return [{jid:phone+'@s.whatsapp.net',exists:true}]},async sendMessage(jid,payload){sent.push({jid,payload});return {key:{id:`fixture-${sent.length}`}}}};
  sockets.push(socket);
  setTimeout(()=>socket.ev.emit('connection.update',{connection:'connecting',qr:'integration-fixture-only-not-a-real-whatsapp-login'}),20).unref();
  return socket;
 }})});
 // The URL guard above makes these resets exclusive to a user-provisioned test branch.
 for(const table of ['ss_admin_sessions','ss_sticker_requests','ss_admin_events','ss_whatsapp_auth','ss_whatsapp_leases','ss_rate_limits','ss_admins'])await services.store.pool.query(`DELETE FROM ${table}`);
 await services.store.seedAdmin(testEmail,await hashPassword(testPassword));
 const server=createStickerServer({services,frontendOrigins:origin});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 return {services,server,base,sockets,sent,origin,async close(){await new Promise(resolve=>server.close(resolve));await services.close();}};
}

export async function until(predicate,timeout=15000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}
 throw new Error('Timed out waiting for the expected state.');
}
