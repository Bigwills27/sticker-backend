import {readFile,writeFile,chmod} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {hashPassword} from '../src/security.js';

const file=new URL('../.env',import.meta.url);
let source=await readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
const current=parseEnv(source);
const rootEnv=await readFile(new URL('../../.env.local',import.meta.url),'utf8').then(parseEnv).catch(error=>{if(error.code==='ENOENT')return {};throw error;});
const values={
 ADMIN_JWT_SECRET:current.ADMIN_JWT_SECRET||randomBytes(48).toString('base64url'),
 WHATSAPP_ENCRYPTION_KEY:current.WHATSAPP_ENCRYPTION_KEY||randomBytes(32).toString('base64'),
 WHATSAPP_ENABLED:current.WHATSAPP_ENABLED||'1'
};
for(const key of ['DATABASE_URL','DATABASE_URL_UNPOOLED'])if(!current[key]&&rootEnv[key])values[key]=rootEnv[key];
if(process.env.ADMIN_SEED_EMAIL&&!current.ADMIN_SEED_EMAIL)values.ADMIN_SEED_EMAIL=process.env.ADMIN_SEED_EMAIL.trim().toLowerCase();
if(process.env.ADMIN_SEED_PASSWORD&&!current.ADMIN_SEED_PASSWORD_HASH)values.ADMIN_SEED_PASSWORD_HASH=await hashPassword(process.env.ADMIN_SEED_PASSWORD);
for(const [key,value] of Object.entries(values)){
 const entry=`${key}=${JSON.stringify(value)}`,pattern=new RegExp(`^${key}=.*$`,'m');
 source=pattern.test(source)?source.replace(pattern,()=>entry):`${source.trimEnd()}\n${entry}\n`;
}
await writeFile(file,source,{mode:0o600});await chmod(file,0o600);
console.log('Backend .env prepared. Existing secrets preserved; values omitted.');
