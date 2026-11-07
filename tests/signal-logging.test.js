import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {installSignalLogRedaction} from '../src/signal-logging.js';

test('Signal session dumps are redacted without suppressing ordinary diagnostic messages',()=>{
 const logs=[],sink={info:(...args)=>logs.push(args),warn:(...args)=>logs.push(args)};
 installSignalLogRedaction(sink);installSignalLogRedaction(sink);
 for(const prefix of ['Closing session:','Opening session:','Removing old closed session:','Session already closed'])sink.info(prefix,{privateKey:'secret-fixture'});
 sink.warn('ordinary diagnostic',{code:'ETIMEDOUT'});
 assert.doesNotMatch(JSON.stringify(logs),/secret-fixture/);assert.deepEqual(logs.at(-1),['ordinary diagnostic',{code:'ETIMEDOUT'}]);
});
test('real libsignal session lifecycle retains its behavior while its output omits private state',()=>{
 const output=execFileSync(process.execPath,['--input-type=module','-e',`
  import './src/signal-logging.js';import libsignal from 'libsignal';
  const record=new libsignal.SessionRecord();const session={indexInfo:{closed:-1},privateKey:'never-log-this-fixture'};
  record.closeSession(session);if(session.indexInfo.closed===-1)throw new Error('close failed');
  record.openSession(session);if(session.indexInfo.closed!==-1)throw new Error('open failed');
 `],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.match(output,/session details redacted/);assert.doesNotMatch(output,/never-log-this-fixture|privateKey/);
});
