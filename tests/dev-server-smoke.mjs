/** Check the actual running development app, including during isolated QA runs. */
import {chromium} from 'playwright';
import {systemBrowser} from '../src/browser.js';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,executablePath:process.env.QA_CHROME||systemBrowser()});
const errors=[];
try{
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 for(let attempt=0;attempt<3;attempt++){
  await page.goto('http://127.0.0.1:5173');await page.getByRole('heading',{name:'Good stickers deserve to escape.'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Find sticker',exact:true}).isVisible(),true);
  await page.waitForTimeout(1000);
 }
 assert.deepEqual(errors,[]);
 const report={url:'http://127.0.0.1:5173',rendered:true,reloads:3,browserErrors:errors};
 await writeFile(new URL('../../qa/dev-server-smoke.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close()}
