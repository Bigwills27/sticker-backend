import {randomBytes,scrypt as scryptCallback,timingSafeEqual,createCipheriv,createDecipheriv,createHash,createHmac} from 'node:crypto';
import {promisify} from 'node:util';
import {SignJWT,jwtVerify} from 'jose';

const scrypt=promisify(scryptCallback);
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const randomToken=()=>randomBytes(16).toString('hex');

export async function hashPassword(password){
 const salt=randomBytes(16).toString('hex');
 const derived=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 return `scrypt$32768$8$1$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password,encoded){
 const [scheme,n,r,p,salt,hash,...extra]=String(encoded).split('$');
 if(scheme!=='scrypt'||n!=='32768'||r!=='8'||p!=='1'||!/^[a-f0-9]{32}$/.test(salt)||!/^[a-f0-9]{128}$/.test(hash)||extra.length)return false;
 const actual=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 return timingSafeEqual(actual,Buffer.from(hash,'hex'));
}

export function createVault(encodedKey){
 const key=Buffer.from(encodedKey||'','base64');
 if(key.length!==32)throw new Error('WHATSAPP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
 return {
  seal(value,context){
   const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
   cipher.setAAD(Buffer.from(context));
   const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
   return ['v1',iv.toString('base64url'),encrypted.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
  },
  open(value,context){
   const [version,iv,encrypted,tag,...rest]=value.split('.');
   if(version!=='v1'||rest.length||!iv||!encrypted||!tag)throw new Error('Invalid encrypted record.');
   const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));
   decipher.setAAD(Buffer.from(context));decipher.setAuthTag(Buffer.from(tag,'base64url'));
   return Buffer.concat([decipher.update(Buffer.from(encrypted,'base64url')),decipher.final()]).toString('utf8');
  },
  recipientHash(value){return createHmac('sha256',key).update(value).digest('hex');}
 };
}

export function createTokenService(secret){
 if(typeof secret!=='string'||secret.length<43)throw new Error('ADMIN_JWT_SECRET must contain at least 32 random bytes encoded as base64url.');
 const key=new TextEncoder().encode(secret);
 return {
  async issue({adminId,sessionId,expiresIn=8*60*60}){
   const now=Math.floor(Date.now()/1000);
   return new SignJWT({csrf:randomBytes(24).toString('base64url')}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setSubject(adminId).setJti(sessionId).setIssuer('sticker-studio').setAudience('sticker-studio-admin').setIssuedAt(now).setExpirationTime(now+expiresIn).sign(key);
  },
  async verify(token){
   const {payload}=await jwtVerify(token,key,{algorithms:['HS256'],issuer:'sticker-studio',audience:'sticker-studio-admin',requiredClaims:['sub','jti','csrf','iat','exp'],maxTokenAge:'8h'});
   if(typeof payload.csrf!=='string'||typeof payload.jti!=='string'||typeof payload.sub!=='string')throw new Error('Invalid admin session.');
   return payload;
  }
 };
}
