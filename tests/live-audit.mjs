/** Deliberate network audit; not part of the offline npm test suite. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {discover} from '../src/discovery.js';
import {downloadMedia,inspect,prepareMedia} from '../src/media.js';

const videoUrl=process.argv[2]||'https://www.tiktok.com/@kirstygallagher4/video/7703938702157860118';
const found=await discover(videoUrl,{scope:'video'});
assert.equal(found.scope,'video');assert.ok(found.candidates.length>0,'No media available for the live audit');
const rows=[];let index=0;
await Promise.all(Array.from({length:3},async()=>{
 while(index<found.candidates.length){
  const candidate=found.candidates[index++];
  try{
   assert.equal(candidate.videoId,found.videoId);assert.equal(candidate.available,true);
   const bytes=await downloadMedia(candidate.mediaUrl);const original=await inspect(bytes);
   const prepared=await prepareMedia(bytes,{type:candidate.type});
   if(prepared.bytes)assert.ok(Object.values(prepared.metadata.checks).every(Boolean));
   assert.equal(prepared.metadata.validated,true);
   rows.push({commentId:candidate.commentId,type:candidate.type,author:candidate.author,original,sha256:createHash('sha256').update(bytes).digest('hex'),conversion:prepared.metadata.output||null,conversionUnavailable:prepared.metadata.conversionUnavailable?.code||null,passed:true});
  }catch(error){rows.push({commentId:candidate.commentId,type:candidate.type,passed:false,error:{code:error.code,message:error.message}})}
  if(rows.length%10===0)console.log(`Verified ${rows.length}/${found.candidates.length} source files`);
 }
}));
const report={checkedAt:new Date().toISOString(),videoId:found.videoId,counts:found.counts,coverage:found.coverage,verifiedFiles:rows.length,failures:rows.filter(r=>!r.passed),files:rows};
await mkdir(new URL('../../qa/',import.meta.url),{recursive:true});
await writeFile(new URL('../../qa/live-media-audit.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify({verifiedFiles:report.verifiedFiles,counts:report.counts,failures:report.failures}));
assert.equal(report.failures.length,0,'Some source media failed download or conversion; see qa/live-media-audit.json');
