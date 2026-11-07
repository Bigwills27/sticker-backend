import {randomUUID,timingSafeEqual} from 'node:crypto';
import {AppError} from './media.js';
import {createTokenService,digest,verifyPassword} from './security.js';

const SESSION_SECONDS=8*60*60;
const DUMMY_HASH=`scrypt$32768$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;

export function clientAddress(req){
 // Render appends the connecting peer; do not trust client-supplied forwarding outside Render.
 const forwarded=process.env.RENDER==='true'&&req.headers['x-forwarded-for'];
 return typeof forwarded==='string'?forwarded.split(',').at(-1).trim():req.socket.remoteAddress||'unknown';
}

export function createAdminAuth({store,secret,origins,secureCookies=false}){
 const tokens=createTokenService(secret);
 const cookieName=secureCookies?'__Host-studio_admin':'studio_admin';
 const cookie=(value,maxAge)=>`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies?'; Secure':''}`;
 function requireOrigin(req){
  if(typeof req.headers.origin!=='string'||!origins.has(req.headers.origin))throw new AppError('ADMIN_ORIGIN_DENIED','Open the admin dashboard from your configured app URL.',403);
 }
 return {
  async login(req,input){
   requireOrigin(req);
   if(!await store.checkLimit(`admin-ip:${digest(clientAddress(req))}`,10,900))throw new AppError('LOGIN_RATE_LIMIT','Too many sign-in attempts. Try again in 15 minutes.',429);
   const email=typeof input?.email==='string'?input.email.trim().toLowerCase():'';
   const password=typeof input?.password==='string'?input.password:'';
   if(email.length>254||!email.includes('@')||!password||password.length>256)throw new AppError('INVALID_CREDENTIALS','Email or password is incorrect.',401);
   if(!await store.checkLimit(`admin-email:${digest(email)}`,20,900))throw new AppError('LOGIN_RATE_LIMIT','Too many sign-in attempts. Try again in 15 minutes.',429);
   const admin=await store.findAdmin(email);
   const valid=await verifyPassword(password,admin?.password_hash||DUMMY_HASH);
   if(!valid||!admin||admin.disabled)throw new AppError('INVALID_CREDENTIALS','Email or password is incorrect.',401);
   const sessionId=randomUUID();
   const token=await tokens.issue({adminId:admin.id,sessionId});
   const claims=await tokens.verify(token);
   await store.createAdminSession(digest(sessionId),admin.id,new Date(claims.exp*1000));
   return {cookie:cookie(token,SESSION_SECONDS),body:{admin:{email:admin.email},csrfToken:claims.csrf}};
  },
  async requireSession(req){
   const value=String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
   if(!value||value.length>4096)throw new AppError('UNAUTHORIZED','Sign in to continue.',401);
   let claims;
   try{claims=await tokens.verify(value)}catch{throw new AppError('UNAUTHORIZED','Your session expired. Sign in again.',401);}
   const admin=await store.getAdminSession(digest(claims.jti));
   if(!admin||admin.id!==claims.sub)throw new AppError('UNAUTHORIZED','Your session expired. Sign in again.',401);
   return {admin:{id:admin.id,email:admin.email},csrfToken:claims.csrf,tokenHash:digest(claims.jti)};
  },
  requireMutation(req,session){
   requireOrigin(req);
   const token=req.headers['x-csrf-token'];
   if(typeof token!=='string'||Buffer.byteLength(token)!==Buffer.byteLength(session.csrfToken)||!timingSafeEqual(Buffer.from(token),Buffer.from(session.csrfToken)))throw new AppError('CSRF_DENIED','Refresh the page and try again.',403);
  },
  async logout(req,session){this.requireMutation(req,session);await store.revokeAdminSession(session.tokenHash);return cookie('',0);}
 };
}
