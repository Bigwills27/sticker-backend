import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import {hashPassword,verifyPassword,createVault,createTokenService} from '../src/security.js';

test('admin passwords are salted and verified without retaining plaintext',async()=>{
 const password='example-password-for-test';
 const first=await hashPassword(password),second=await hashPassword(password);
 assert.notEqual(first,second);
 assert.ok(!first.includes(password));
 assert.equal(await verifyPassword(password,first),true);
 assert.equal(await verifyPassword('incorrect',first),false);
 assert.equal(await verifyPassword(password,'invalid-hash'),false);
});

test('encrypted session records detect tampering, swapped records and the wrong key',()=>{
 const vault=createVault(randomBytes(32).toString('base64'));
 const ciphertext=vault.seal('session-secret','keys:signal:42');
 assert.ok(!ciphertext.includes('session-secret'));
 assert.equal(vault.open(ciphertext,'keys:signal:42'),'session-secret');
 assert.throws(()=>vault.open(ciphertext,'keys:signal:43'));
 assert.throws(()=>createVault(randomBytes(32).toString('base64')).open(ciphertext,'keys:signal:42'));
 const parts=ciphertext.split('.');parts[2]=Buffer.from('tampered').toString('base64url');
 assert.throws(()=>vault.open(parts.join('.'),'keys:signal:42'));
 assert.throws(()=>createVault('weak'));
});

test('admin JWTs enforce expiry, signature, issuer and intended audience',async()=>{
 const secret=randomBytes(48).toString('base64url');
 const tokens=createTokenService(secret);
 const token=await tokens.issue({adminId:'admin-1',sessionId:'session-1'});
 const claims=await tokens.verify(token);
 assert.equal(claims.sub,'admin-1');assert.equal(claims.jti,'session-1');
 assert.ok(claims.exp>claims.iat);assert.equal(typeof claims.csrf,'string');
 await assert.rejects(()=>tokens.verify(token+'broken'));
 await assert.rejects(()=>createTokenService(randomBytes(48).toString('base64url')).verify(token));
 const expired=await tokens.issue({adminId:'admin-1',sessionId:'old',expiresIn:-1});
 await assert.rejects(()=>tokens.verify(expired));
 for(const [issuer,audience] of [['untrusted-issuer','sticker-studio-admin'],['sticker-studio','untrusted-audience']]){
  const forged=await new SignJWT({csrf:'csrf'}).setProtectedHeader({alg:'HS256'}).setSubject('admin-1').setJti('session-1').setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await assert.rejects(()=>tokens.verify(forged));
 }
 assert.throws(()=>createTokenService('weak'));
});
