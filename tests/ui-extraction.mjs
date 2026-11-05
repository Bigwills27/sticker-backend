/** Isolated browser checks. Pass --live to exercise TikTok and real downloads. */
import {chromium} from 'playwright';
import {createServer} from '../../frontend/node_modules/vite/dist/node/index.js';
import {createStickerServer} from '../src/server.js';
import {systemBrowser} from '../src/browser.js';
import {discover} from '../src/discovery.js';
import {downloadMedia} from '../src/media.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const live=process.argv.includes('--live');
const root=fileURLToPath(new URL('../../',import.meta.url));
const qa=path.join(root,'qa');await mkdir(qa,{recursive:true});
const commentUrl='https://vt.tiktok.com/ZS9ywGjyy6Ngu-zQclv/';
const videoUrl='https://www.tiktok.com/@kirstygallagher4/video/7703938702157860118';
const source={videoId:'7703938702157860118',commentId:'7704357278421992213',author:'oneizi',text:'She’s like',type:'sticker',id:'exact',available:true,mediaUrl:'/samples/transparent.webp'};
const fixture={scope:'video',videoId:source.videoId,commentId:null,exactCommentMatched:false,candidates:[source,{...source,id:'unavailable',commentId:'999',available:false,mediaUrl:null},{...source,id:'photo',commentId:'888',type:'photo'}],counts:{sticker:2,photo:1,unavailable:1},coverage:{scannedComments:3,reportedComments:10,complete:false,stopReason:'comments_not_exposed'}};
const png=await sharp({create:{width:60,height:40,channels:4,background:'#148040'}}).png().toBuffer();
const longAnimation=await sharp(await readFile(new URL('../samples/transparent.webp',import.meta.url)),{animated:true}).webp({delay:[6000,6000]}).toBuffer();
const digest=b=>createHash('sha256').update(b).digest('hex');
const checks=[],errors=[];let browser,vite,app;
try{
 process.env.FRONTEND_ORIGIN='http://127.0.0.1:5193';
 app=createStickerServer(live?{}:{discoverMedia:async(url,options)=>{
  if(options.scope==='video'||url===videoUrl)return fixture;
  if(url.includes('comment_id=666'))return {...fixture,scope:'comment',commentId:'666',candidates:[{...source,commentId:'666',mediaUrl:'/long-animation'}],exactCommentMatched:true,matchStatus:'matched',matchedComment:{id:'666',author:'oneizi',text:'Long animation'}};
  if(url.includes('comment_id=777'))return {...fixture,scope:'comment',commentId:'777',candidates:[],exactCommentMatched:true,matchStatus:'no_media',matchedComment:{id:'777',author:'oneizi',text:'Text only'}};
  if(url.includes('comment_id=404'))return {...fixture,scope:'comment',commentId:'404',candidates:[],counts:{sticker:0,photo:0,unavailable:0},matchStatus:'not_retrieved',matchedComment:null};
  if(url.includes('comment_id=999'))return {...fixture,scope:'comment',commentId:'999',candidates:[fixture.candidates[1]],counts:{sticker:1,photo:0,unavailable:1},exactCommentMatched:true,matchStatus:'media_unavailable',matchedComment:{id:'999',author:'oneizi',text:'[Sticker] She’s like'}};
  return {...fixture,scope:'comment',commentId:source.commentId,candidates:[source],exactCommentMatched:true,matchStatus:'matched',matchedComment:{id:source.commentId,author:'oneizi',text:'She’s like'}};
 },download:async url=>url==='/long-animation'?longAnimation:png});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const target=`http://127.0.0.1:${app.address().port}`;
 vite=await createServer({cacheDir:path.join(root,'frontend','node_modules','.vite-qa-extraction'),root:path.join(root,'frontend'),server:{port:5193,strictPort:true,host:'127.0.0.1',proxy:{'/api':{target,changeOrigin:true},'/files':{target,changeOrigin:true}}}});await vite.listen();
 browser=await chromium.launch({headless:true,executablePath:process.env.QA_CHROME||systemBrowser()});
 const context=await browser.newContext({viewport:{width:1616,height:973},acceptDownloads:true,reducedMotion:'reduce'});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const submit=async url=>{await page.getByLabel('TikTok comment or video link').fill(url);await page.getByRole('button',{name:'Find sticker',exact:true}).click()};
 const checkLayout=async state=>{
  for(const [width,height] of [[1616,973],[1440,900],[1280,800],[1200,800],[1024,900],[820,1000],[768,1000],[390,844],[360,800],[320,700]]){
   await page.setViewportSize({width,height});
   const issue=await page.evaluate(()=>{
    if(document.documentElement.scrollWidth>innerWidth)return 'horizontal document overflow';
    for(const el of document.querySelectorAll('button,input,summary')){
     const r=el.getBoundingClientRect();if(r.width&&r.height&&(r.left< -1||r.right>innerWidth+1))return `${el.textContent||el.getAttribute('aria-label')||el.tagName} extends outside viewport`;
    }
    return null;
   });
   assert.equal(issue,null,`${state} layout at ${width}px`);
  }
  await page.setViewportSize({width:1616,height:973});checks.push(`${state}: responsive controls fit at 10 viewport sizes`);
 };

 await page.goto('http://127.0.0.1:5193');await page.evaluate(()=>document.fonts.ready);await checkLayout('landing');await page.screenshot({path:path.join(qa,'redesign-landing-desktop.png'),fullPage:true});
 await submit(commentUrl);await page.getByRole('heading',{name:'Your sticker is ready.'}).waitFor({timeout:180000});await page.getByText('File details',{exact:true}).click();await page.getByText('Exact comment verified',{exact:true}).waitFor();
 assert.equal(await page.getByText('@oneizi',{exact:true}).isVisible(),true);
 assert.equal(await page.getByText('She’s like',{exact:true}).isVisible(),true);checks.push('exact comment provenance and automatic conversion');await checkLayout('single result');
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download original',exact:true}).click();
 const original=Buffer.from(await readFile(await(await downloading).path()));
 if(live){
  const matched=await discover(commentUrl);assert.equal(matched.candidates.length,1);assert.equal(matched.candidates[0].commentId,source.commentId);
  assert.equal(digest(original),digest(await downloadMedia(matched.candidates[0].mediaUrl)));
  const m=await sharp(original).metadata();assert.equal(m.width,1290);assert.equal(m.height,1246);
  await writeFile(path.join(qa,'exact-comment-original.webp'),original);
 }else assert.deepEqual(original,png);
 checks.push('original download matches exact source bytes');
 await page.getByText('File details',{exact:true}).click();await page.screenshot({path:path.join(qa,live?'live-exact-comment.png':'fixture-exact-comment.png'),fullPage:true});await page.getByText('File details',{exact:true}).click();
 await page.getByRole('button',{name:'Browse this video',exact:true}).click();
 await page.getByRole('tab',{name:/Stickers/}).waitFor({timeout:180000});
 const stickers=page.getByRole('tab',{name:/Stickers/}),photos=page.getByRole('tab',{name:/Photos/});
 assert.equal(await stickers.getAttribute('aria-selected'),'true');assert.equal(await stickers.locator('.count-badge').count(),1);
 assert.equal(await photos.locator('.count-badge').count(),1);
 const stickerCount=Number(await stickers.locator('.count-badge').innerText());
 const photoCount=Number(await photos.locator('.count-badge').innerText());
 if(live){assert.ok(stickerCount>9);assert.ok(photoCount>0)}else{assert.equal(stickerCount,2);assert.equal(photoCount,1)}
 assert.equal(await page.locator('#media-panel-sticker .media-card').count(),stickerCount);checks.push('badge counts reflect all returned stickers and photos');await checkLayout('gallery');await page.waitForFunction(()=>[...document.querySelectorAll('#media-panel-sticker img')].slice(0,4).every(img=>img.complete&&img.naturalWidth>0));await page.screenshot({path:path.join(qa,live?'redesign-gallery-desktop.png':'fixture-gallery-desktop.png')});
 await stickers.focus();await page.keyboard.press('ArrowRight');assert.equal(await photos.getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#media-panel-photo .media-card').count(),photoCount);
 await page.keyboard.press('Home');assert.equal(await stickers.getAttribute('aria-selected'),'true');
 await page.keyboard.press('End');assert.equal(await photos.getAttribute('aria-selected'),'true');checks.push('keyboard tab navigation and filtering');
 await page.locator('#media-panel-photo .candidate-card').first().click();await page.getByRole('heading',{name:'Your photo is ready.'}).waitFor({timeout:60000});assert.equal(await page.getByRole('tab').count(),0);
 const photoDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download original',exact:true}).click();const photoBytes=await readFile(await(await photoDownload).path());
 if(!live)assert.deepEqual(photoBytes,png);assert.ok(photoBytes.length>0);checks.push('original photo download');await page.getByRole('button',{name:'Back to results',exact:true}).click();await photos.waitFor();assert.equal(await photos.getAttribute('aria-selected'),'true');checks.push('photo selection restores gallery and active tab');
 for(const width of [1440,1024,768,390]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
 await page.locator('.candidates').scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>[...document.querySelectorAll('#media-panel-photo img')].every(img=>img.complete&&img.naturalWidth>0));
 await page.locator('.candidates').screenshot({path:path.join(qa,live?'live-mobile-tabs.png':'fixture-mobile-tabs.png')});checks.push('no overflow at desktop, tablet and mobile widths');checks.push('photo thumbnails load successfully');
 if(!live){
  await page.getByRole('button',{name:'Start again',exact:true}).click();await submit(videoUrl+'?comment_id=999');
  await page.getByText('The comment matched, but its file is unavailable.',{exact:true}).waitFor();
  assert.equal(await page.locator('.candidate-card').count(),0);checks.push('unavailable exact match cannot download another sticker');
  await page.getByRole('button',{name:'Start again',exact:true}).click();await submit(videoUrl+'?comment_id=404');
  await page.getByText('We couldn’t retrieve this exact comment.',{exact:true}).waitFor();assert.equal(await page.locator('.candidate-card').count(),0);checks.push('missing exact comment does not silently browse video');
  await page.getByRole('button',{name:'Start again',exact:true}).click();await submit(videoUrl+'?comment_id=777');
  await page.getByText('This comment has no sticker or photo.',{exact:true}).waitFor();assert.equal(await page.locator('.candidate-card').count(),0);checks.push('text-only exact comment is not reported as a sticker');
  await page.getByRole('button',{name:'Start again',exact:true}).click();await submit(videoUrl+'?comment_id=666');
  await page.getByRole('heading',{name:'Your sticker is ready.'}).waitFor();await page.getByText('File details',{exact:true}).click();await page.getByText('Original sticker',{exact:true}).waitFor();assert.equal(await page.getByText('Exact comment verified',{exact:true}).isVisible(),true);
  const originalOnlyDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download original',exact:true}).click();assert.deepEqual(await readFile(await(await originalOnlyDownload).path()),longAnimation);checks.push('conversion limit preserves exact original animation and download');
  await page.waitForSelector('.animation-control');
  await page.evaluate(()=>Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false}));
  let shareRequests=0;
  await page.route('**/files/**',async route=>{shareRequests++;if(shareRequests>1)await route.fulfill({status:404,body:'expired'});else await route.continue();});
  const fallbackDownload=page.waitForEvent('download').catch(()=>null);await page.getByRole('button',{name:'Share',exact:true}).click();
  await page.getByText('File sharing is unavailable in this browser. Your file has been downloaded.',{exact:true}).waitFor();
  assert.equal(shareRequests,1,'Share fallback should download the already-fetched file');assert.ok(await fallbackDownload);await page.unroute('**/files/**');checks.push('share fallback reuses the fetched file and reports real success');

  await page.getByRole('button',{name:'Convert another',exact:true}).click();
  let releaseSlow;const slow=new Promise(resolve=>{releaseSlow=resolve});
  let markReceived;const received=new Promise(resolve=>{markReceived=resolve});
  await page.route('**/api/stickers/extract',async route=>{markReceived();await slow;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Delayed response'}})}).catch(()=>{});});
  await submit(videoUrl+'?slow=1');await received;await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('alert').count(),0);releaseSlow();await page.unroute('**/api/stickers/extract');checks.push('cancelled requests do not restore stale errors');

 }
 assert.deepEqual(errors,[]);
 const report={mode:live?'live TikTok':'deterministic boundary fixtures',checkedAt:new Date().toISOString(),passed:checks,counts:{stickers:stickerCount,photos:photoCount},browserErrors:errors};
 await writeFile(path.join(qa,live?'live-extraction.json':'extraction-ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser?.close();await vite?.close();if(app?.listening)await new Promise(r=>app.close(r));}
