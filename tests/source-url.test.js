import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSourceHash,sourceHash} from '../../frontend/src/source-url.js';

test('shareable fragments round-trip short comment links, video mode and selected comments',()=>{
 const input={url:'https://vt.tiktok.com/example/?share_comment_id=123&x=two words',scope:'video'};
 assert.deepEqual(parseSourceHash(sourceHash(input)),input);
 assert.deepEqual(parseSourceHash(sourceHash({url:input.url})),{url:input.url});
});
test('shareable fragments reject unsafe sources and malformed modes',()=>{
 for(const hash of ['#tiktok=javascript:alert(1)','#tiktok=https://tiktok.com.evil.test/video/1','#tiktok=https://evil.test','#tiktok=https://user:pass@tiktok.com/video/1','#tiktok=https://tiktok.com&scope=invalid','#tiktok=https://tiktok.com&tiktok=https://evil.test','#converter'])assert.equal(parseSourceHash(hash),null);
});
