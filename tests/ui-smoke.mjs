/** Run after npm install in both folders. QA_CHROME may point to an existing Chromium. */
import {chromium} from 'playwright';
import {createServer} from '../../frontend/node_modules/vite/dist/node/index.js';
import {createStickerServer} from '../src/server.js';
import {systemBrowser} from '../src/browser.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const qa=path.join(root,'qa');await mkdir(qa,{recursive:true});
let vite,browser,server;const errors=[];
try{
 process.env.FRONTEND_ORIGIN='http://127.0.0.1:5194';server=createStickerServer();
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const target=`http://127.0.0.1:${server.address().port}`;
 vite=await createServer({cacheDir:path.join(root,'frontend','node_modules','.vite-qa-smoke'),root:path.join(root,'frontend'),server:{port:5194,strictPort:true,host:'127.0.0.1',proxy:{'/api':{target,changeOrigin:true},'/files':{target,changeOrigin:true}}}});await vite.listen();
 browser=await chromium.launch({headless:true,executablePath:process.env.QA_CHROME||systemBrowser()});
 const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true,reducedMotion:'reduce'});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5194');await page.locator('main').waitFor();assert.equal(await page.getByRole('heading',{name:'Good stickers deserve to escape.'}).count(),1);
 assert.equal(await page.getByRole('button',{name:'Find sticker',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'How it works',exact:true}).click();assert.equal(await page.getByRole('dialog').isVisible(),true);await page.getByRole('button',{name:'Close instructions'}).click();
 await page.getByRole('button',{name:'Try saved example',exact:true}).click();await page.getByRole('heading',{name:'Your sticker is ready.'}).waitFor({timeout:60000});await page.getByText('File details',{exact:true}).click();
 assert.equal(await page.getByText(/512 × 512/).isVisible(),true);
 await page.screenshot({path:path.join(qa,'desktop-result.png'),fullPage:true});
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Download sticker',exact:true}).click();const download=await downloading;const downloadedPath=await download.path();const bytes=await readFile(downloadedPath);assert.equal(bytes.toString('ascii',8,12),'WEBP');
 // Desktop Chromium normally has no native file-share support; this exercises the documented fallback.
 if(!await page.evaluate(()=>!!navigator.canShare)){
  const shared=page.waitForEvent('download');await page.getByRole('button',{name:'Share',exact:true}).click();await shared;
 }
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(qa,'mobile-result.png'),fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Convert another',exact:true}).click();await page.getByLabel('TikTok comment or video link').fill('http://invalid.test');await page.getByRole('button',{name:'Find sticker',exact:true}).click();assert.equal(await page.getByText('Paste a complete link beginning with https://.').isVisible(),true);
 assert.deepEqual(errors,[]);
 const summary={passed:['initial disabled state','help dialog','real example conversion through frontend and API','metadata preview','WebP file download','share download fallback where native share unavailable','mobile no overflow','invalid link error','no uncaught React/browser errors'],nativeShareDeviceTested:false};
 await writeFile(path.join(qa,'ui-smoke.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{await browser?.close();await vite?.close();if(server?.listening)await new Promise(r=>server.close(r));}
