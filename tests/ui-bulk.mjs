/** Bulk actions against a real local API with controlled original media. */
import {chromium} from 'playwright';
import {createServer} from '../../frontend/node_modules/vite/dist/node/index.js';
import {createStickerServer} from '../src/server.js';
import {systemBrowser} from '../src/browser.js';
import {unzipSync} from 'fflate';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url)),qa=path.join(root,'qa');await mkdir(qa,{recursive:true});
const url='https://www.tiktok.com/@test/video/123';
const sticker=await readFile(new URL('../samples/transparent.webp',import.meta.url));
const photo=await sharp({create:{width:80,height:60,channels:4,background:'#148040'}}).png().toBuffer();
const base={videoId:'123',commentId:'456',author:'oneizi',text:'A reaction',type:'sticker',available:true,mediaUrl:'/samples/transparent.webp'};
const candidates=[{...base,id:'first'},{...base,id:'second',commentId:'789',author:'another'},{...base,id:'photo',commentId:'999',author:'photo_author',type:'photo',mediaUrl:'/samples/animated.webp'},{...base,id:'unavailable',available:false,mediaUrl:null}];
const checks=[],errors=[];let browser,vite,app,failPhoto=false;
try{
 process.env.FRONTEND_ORIGIN='http://127.0.0.1:5195';
 app=createStickerServer({discoverMedia:async()=>({videoId:'123',scope:'video',commentId:null,candidates,counts:{sticker:3,photo:1,unavailable:1},coverage:{scannedComments:4,complete:false}}),download:async mediaUrl=>{if(failPhoto&&mediaUrl===candidates[2].mediaUrl)throw new Error('Expired photo');return mediaUrl===candidates[2].mediaUrl?photo:sticker}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const target=`http://127.0.0.1:${app.address().port}`;
 vite=await createServer({cacheDir:path.join(root,'frontend','node_modules','.vite-qa-bulk'),root:path.join(root,'frontend'),server:{port:5195,strictPort:true,host:'127.0.0.1',proxy:{'/api':{target,changeOrigin:true},'/files':{target,changeOrigin:true}}}});await vite.listen();
 browser=await chromium.launch({headless:true,executablePath:process.env.QA_CHROME||systemBrowser()});
 const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true,reducedMotion:'reduce'});page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5195');await page.getByLabel('TikTok comment or video link').fill(url);await page.getByRole('button',{name:'Find sticker',exact:true}).click();
 await page.getByRole('tab',{name:/Stickers/}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Download all',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Select',exact:true}).count(),1);assert.equal(await page.getByRole('checkbox').count(),0);await page.getByRole('button',{name:'Select',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).count(),1);checks.push('Select reveals custom checkboxes and changes to Cancel');
 const selectedArchive=async()=>{const promise=page.waitForEvent('download');await page.getByRole('button',{name:'Download selected',exact:true}).click();return unzipSync(new Uint8Array(await readFile(await(await promise).path())))};
 await page.getByRole('checkbox',{name:'Select sticker 1 by @oneizi',exact:true}).check();const customColor=await page.locator('.media-card .selection-checkbox input:checked ~ .checkmark').first().evaluate(el=>getComputedStyle(el).backgroundColor);assert.equal(customColor,'rgb(45, 140, 240)');await page.getByRole('checkbox',{name:'Select sticker 1 by @oneizi',exact:true}).focus();await page.keyboard.press('Space');assert.equal(await page.getByRole('checkbox',{name:'Select sticker 1 by @oneizi',exact:true}).isChecked(),false);await page.keyboard.press('Space');checks.push('custom checkboxes retain native keyboard behavior');
 await page.getByRole('tab',{name:/Photos/}).click();await page.getByRole('checkbox',{name:'Select photo 1 by @photo_author',exact:true}).check();
 assert.equal(await page.getByText('2 selected',{exact:true}).isVisible(),true);checks.push('selection persists across both tabs');await page.setViewportSize({width:320,height:900});assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.bulk-actions button')].some(el=>el.getBoundingClientRect().right>innerWidth+1)),false);await page.setViewportSize({width:1440,height:1000});await page.locator('.candidates').screenshot({path:path.join(qa,'bulk-selection-desktop.png')});
 const selected=await selectedArchive();const media=Object.entries(selected).filter(([name])=>name!=='download-report.json');
 assert.equal(media.length,2);assert.ok(media.some(([name,bytes])=>name.startsWith('sticker_')&&Buffer.from(bytes).equals(sticker)));assert.ok(media.some(([name,bytes])=>name.startsWith('photo_')&&Buffer.from(bytes).equals(photo)));checks.push('mixed selected ZIP preserves original bytes');
 await page.getByRole('tab',{name:/Stickers/}).click();assert.equal(await page.getByRole('checkbox',{name:'Select sticker 1 by @oneizi',exact:true}).isChecked(),true);
 await page.getByRole('button',{name:'Open sticker 1 by @oneizi',exact:true}).click();await page.getByRole('heading',{name:'Your sticker is ready.'}).waitFor();await page.getByRole('button',{name:'Back to results',exact:true}).click();assert.equal(await page.getByText('2 selected',{exact:true}).isVisible(),true);checks.push('opening a result preserves selection');
 const unavailable=page.getByRole('checkbox',{name:'Select sticker 3 by @oneizi',exact:true});assert.equal(await unavailable.isDisabled(),true);checks.push('unavailable files cannot be selected');
 await page.getByRole('checkbox',{name:'Select all available media',exact:true}).check();assert.equal(await page.getByText('3 selected',{exact:true}).isVisible(),true);
 const all=await selectedArchive();assert.equal(Object.keys(all).filter(name=>name!=='download-report.json').length,3);checks.push('select all spans both tabs and excludes unavailable files');
 await page.getByRole('button',{name:'Clear selection',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Download selected',exact:true}).isDisabled(),true);await page.getByRole('checkbox',{name:'Select all available media',exact:true}).check();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.getByRole('checkbox').count(),0);assert.equal(await page.getByRole('button',{name:'Download all',exact:true}).isVisible(),true);checks.push('Cancel clears selection and hides checkboxes');
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download all',exact:true}).click();const archive=await readFile(await(await downloading).path());assert.equal(Object.keys(unzipSync(new Uint8Array(archive))).filter(n=>n!=='download-report.json').length,3);checks.push('download all works without manual selection');
 await page.evaluate(()=>{Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});});
 const fallback=page.waitForEvent('download');await page.getByRole('button',{name:'Share all',exact:true}).click();await fallback;checks.push('unsupported sharing downloads the full ZIP');
 await page.evaluate(()=>{
  window.__shared=[];
  Object.defineProperty(navigator,'canShare',{configurable:true,value:({files})=>files.length>0});
  Object.defineProperty(navigator,'share',{configurable:true,value:async({files})=>{window.__shared=await Promise.all(files.map(async f=>({name:f.name,type:f.type,size:f.size,bytes:[...new Uint8Array(await f.arrayBuffer())]})));}});
 });
 await page.getByRole('button',{name:'Share all',exact:true}).click();await page.getByRole('button',{name:'Share 3 files',exact:true}).waitFor();await page.getByRole('button',{name:'Share 3 files',exact:true}).click();
 await page.waitForFunction(()=>window.__shared.length===3);
 const shared=await page.evaluate(()=>window.__shared);assert.equal(shared.length,3);assert.equal(shared.filter(f=>f.type==='image/webp').length,2);assert.equal(shared.filter(f=>f.type==='image/png').length,1);assert.ok(shared.some(f=>Buffer.from(f.bytes).equals(photo)));checks.push('native sharing receives all original media Files');
 let cancelledDownloads=0;const cancelledDownload=()=>{cancelledDownloads++};page.on('download',cancelledDownload);
 await page.evaluate(()=>Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new DOMException('Cancelled','AbortError')}}));
 await page.getByRole('button',{name:'Share 3 files',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.bulk-share').disabled);assert.equal(cancelledDownloads,0);page.off('download',cancelledDownload);checks.push('cancelling native sharing does not force a download');

 for(const width of [1440,1024,768,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);const outside=await page.evaluate(()=>[...document.querySelectorAll('.bulk-actions button,.bulk-actions input')].some(el=>{const r=el.getBoundingClientRect();return r.width&&(r.left<0||r.right>innerWidth+1)}));assert.equal(outside,false);}
 await page.locator('.bulk-actions').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(qa,'bulk-mobile.png')});checks.push('bulk actions fit desktop, tablet and phone layouts');
 await page.getByRole('button',{name:'Start again',exact:true}).click();await page.getByLabel('TikTok comment or video link').fill(url);await page.getByRole('button',{name:'Find sticker',exact:true}).click();await page.getByRole('tab',{name:/Stickers/}).waitFor();assert.equal(await page.getByRole('button',{name:'Download all',exact:true}).count(),1);assert.equal(await page.getByRole('checkbox').count(),0);await page.getByRole('button',{name:'Select',exact:true}).click();assert.equal(await page.getByRole('checkbox',{name:'Select sticker 1 by @oneizi',exact:true}).isChecked(),false);await page.getByRole('button',{name:'Cancel',exact:true}).click();checks.push('a new scan clears selection and prepared files');
 failPhoto=true;const partialDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download all',exact:true}).click();const partial=unzipSync(new Uint8Array(await readFile(await(await partialDownload).path())));assert.equal(Object.keys(partial).filter(n=>n!=='download-report.json').length,2);assert.equal(JSON.parse(new TextDecoder().decode(partial['download-report.json'])).failed.length,1);assert.equal(await page.getByText(/Downloaded 2 of 3 files/).count()>0,true);checks.push('partial downloads clearly report missing files');

 assert.deepEqual(errors,[]);const report={passed:checks,browserErrors:errors,nativeSharing:'simulated API; physical device not tested'};await writeFile(path.join(qa,'bulk-ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser?.close();await vite?.close();if(app?.listening)await new Promise(r=>app.close(r));}
