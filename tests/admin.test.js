import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createAdminAuth} from '../src/admin.js';
import {hashPassword} from '../src/security.js';

const origin='http://localhost:5173';
async function fixture(){
 const admin={id:'admin-1',email:'owner@example.com',password_hash:await hashPassword('test-login-password')};
 const sessions=new Map();
 const auth=createAdminAuth({store:{findAdmin:async email=>email===admin.email?admin:null,checkLimit:async()=>true,createAdminSession:async(hash,id,expires)=>sessions.set(hash,{...admin,expires}),getAdminSession:async hash=>sessions.get(hash),revokeAdminSession:async hash=>sessions.delete(hash)},secret:randomBytes(48).toString('base64url'),origins:new Set([origin]),secureCookies:false});
 return {auth,req:{headers:{origin},socket:{remoteAddress:'127.0.0.1'}}};
}

test('login cookie is HttpOnly and logout revokes a copied JWT',async()=>{
 const {auth,req}=await fixture();
 const login=await auth.login(req,{email:'owner@example.com',password:'test-login-password'});
 assert.match(login.cookie,/HttpOnly/);assert.match(login.cookie,/SameSite=Lax/);
 assert.ok(!JSON.stringify(login.body).includes('password_hash'));
 req.headers.cookie=login.cookie.split(';')[0];
 const session=await auth.requireSession(req);
 assert.equal(session.admin.email,'owner@example.com');
 req.headers['x-csrf-token']=login.body.csrfToken;
 await auth.logout(req,session);
 await assert.rejects(()=>auth.requireSession(req),{status:401});
});

test('admin mutations require both an allowed Origin and the session CSRF token',async()=>{
 const {auth,req}=await fixture();
 const login=await auth.login(req,{email:'owner@example.com',password:'test-login-password'});
 req.headers.cookie=login.cookie.split(';')[0];
 const session=await auth.requireSession(req);
 assert.throws(()=>auth.requireMutation(req,session),{status:403});
 req.headers['x-csrf-token']=login.body.csrfToken;
 assert.doesNotThrow(()=>auth.requireMutation(req,session));
 req.headers['x-csrf-token']='é'.repeat(login.body.csrfToken.length);
 assert.throws(()=>auth.requireMutation(req,session),{status:403});
 req.headers['x-csrf-token']=login.body.csrfToken;
 req.headers.origin='https://other.example';
 assert.throws(()=>auth.requireMutation(req,session),{status:403});
 delete req.headers.origin;
 assert.throws(()=>auth.requireMutation(req,session),{status:403});
});

test('incorrect and unknown logins give the same public error',async()=>{
 const {auth,req}=await fixture();
 const errors=[];
 for(const email of ['owner@example.com','unknown@example.com'])try{await auth.login(req,{email,password:'wrong-password'})}catch(error){errors.push([error.code,error.message,error.status])}
 assert.equal(errors.length,2);assert.deepEqual(errors[0],errors[1]);
});
