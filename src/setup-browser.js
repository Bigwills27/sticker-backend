import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {createRequire} from 'node:module';
import {systemBrowser} from './browser.js';
try{process.loadEnvFile('.env')}catch{}
if(systemBrowser()){console.log('Using the installed Chrome browser for comment discovery.');}
else{try{const require=createRequire(import.meta.url);const cli=path.join(path.dirname(require.resolve('playwright/package.json')),'cli.js');execFileSync(process.execPath,[cli,'install','chromium'],{stdio:'inherit',timeout:180000});}catch{console.warn('\nBrowser setup could not finish. Conversion and the saved example still work. Run npm run setup:browser before fetching new TikTok comments, or set BROWSER_EXECUTABLE_PATH in .env to your installed Chrome.');}}
