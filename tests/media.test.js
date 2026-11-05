import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {classifyUrl,convertMedia,inspect,identifiers} from '../src/media.js';
import * as media from '../src/media.js';

test('accepts the regional TikTok US CDN returned to Render',()=>{
 assert.equal(classifyUrl('https://p16-tiktok-dm-sticker-sign.tiktokcdn-us.com/sticker.awebp'),'media');
});

test('regional CDN support rejects lookalikes, credentials and insecure URLs',()=>{
 for(const url of [
  'https://tiktokcdn-us.com.evil.test/sticker.webp',
  'https://evil-tiktokcdn-us.com/sticker.webp',
  'http://p16-tiktok-dm-sticker-sign.tiktokcdn-us.com/sticker.webp',
  'https://user:pass@p16-tiktok-dm-sticker-sign.tiktokcdn-us.com/sticker.webp',
  'https://p16-tiktok-dm-sticker-sign.tiktokcdn-us.com:444/sticker.webp',
 ])assert.throws(()=>classifyUrl(url));
});

test('rejects unrelated hosts, insecure URLs and credentials',()=>{for(const u of ['https://evil.com/a','http://www.tiktok.com/a','https://www.tiktok.com.evil.com/a','https://u:p@www.tiktok.com/a','https://www.tiktok.com:444/a'])assert.throws(()=>classifyUrl(u));});
test('parses video and exact comment identifiers',()=>{assert.deepEqual(identifiers('https://www.tiktok.com/@user/video/123?share_comment_id=456'),{videoId:'123',commentId:'456'});});
test('converts static PNG to a static transparent WebP',async()=>{const input=await sharp({create:{width:120,height:230,channels:4,background:{r:50,g:140,b:30,alpha:.5}}}).png().toBuffer();const r=await convertMedia(input);assert.equal(r.metadata.output.frames,1);assert.equal(r.metadata.output.width,512);assert.equal(r.metadata.output.height,512);assert.ok(Object.values(r.metadata.checks).every(Boolean));});
test('preserves the real 51-frame TikTok animation',async()=>{const r=await convertMedia(await readFile(new URL('../samples/animated.webp',import.meta.url)));assert.equal(r.metadata.output.frames,51);assert.equal(r.metadata.output.durationMs,1710);assert.deepEqual(r.metadata.output.frameDurationsMs,r.metadata.original.frameDurationsMs);assert.ok(r.metadata.output.bytes<=512000);});
test('preserves transparent two-frame TikTok sticker',async()=>{const r=await convertMedia(await readFile(new URL('../samples/transparent.webp',import.meta.url)));assert.equal(r.metadata.output.frames,2);assert.deepEqual(r.metadata.output.frameDurationsMs,[1000,1000]);assert.ok(r.metadata.output.hasAlpha);});
test('rejects HTML disguised as sticker media',async()=>{await assert.rejects(()=>inspect(Buffer.from('<html>Oops</html>')),e=>e.code==='INVALID_MEDIA');});

test('a valid original remains downloadable when conversion cannot preserve timing',async()=>{
 assert.equal(typeof media.prepareMedia,'function');
 const original=await sharp(await readFile(new URL('../samples/transparent.webp',import.meta.url)),{animated:true}).webp({delay:[6000,6000]}).toBuffer();
 const result=await media.prepareMedia(original);
 assert.equal(result.bytes,null);assert.equal(result.metadata.original.durationMs,12000);assert.equal(result.metadata.conversionUnavailable.code,'UNSUPPORTED_TIMING');assert.equal(result.metadata.validated,true);
});

test('original-only preparation does not accept invalid media',async()=>{
 assert.equal(typeof media.prepareMedia,'function');
 await assert.rejects(()=>media.prepareMedia(Buffer.from('<html>blocked</html>')),e=>e.code==='INVALID_MEDIA');
});
