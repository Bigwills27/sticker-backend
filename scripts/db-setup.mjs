import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createPool,createStore,migrate} from '../src/database.js';
import {createVault,hashPassword} from '../src/security.js';

const envPath=fileURLToPath(new URL('../.env',import.meta.url));
if(existsSync(envPath))process.loadEnvFile(envPath);
const pool=createPool(process.env.DATABASE_URL_UNPOOLED||process.env.DATABASE_URL);
try{
 await migrate(pool);console.log('Database migrations applied.');
 const email=process.env.ADMIN_SEED_EMAIL?.trim().toLowerCase();
 const passwordHash=process.env.ADMIN_SEED_PASSWORD_HASH||(process.env.ADMIN_SEED_PASSWORD?await hashPassword(process.env.ADMIN_SEED_PASSWORD):null);
 if(!email||!passwordHash)throw new Error('Set ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD_HASH before seeding.');
 const store=createStore(pool,createVault(process.env.WHATSAPP_ENCRYPTION_KEY));
 const created=await store.seedAdmin(email,passwordHash);
 console.log(created?'Admin account seeded. Password stored as a scrypt hash.':'Admin already exists. Its password was preserved.');
}catch(error){console.error(error.message.startsWith('Set ')?error.message:'Database setup failed. Verify the database URL and backend secrets.');process.exitCode=1;}finally{await pool.end();}
