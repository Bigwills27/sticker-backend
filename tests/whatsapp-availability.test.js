import test from 'node:test';
import assert from 'node:assert/strict';
import {createWhatsAppApi} from '../src/whatsapp-api.js';

test('public delivery pauses during a storage warning and becomes available after recovery',async()=>{
 let warning='Retrying session storage',response;
 const handle=createWhatsAppApi({store:{},auth:{},runtime:{status:()=>({status:'connected',phoneNumber:'2348000000000',storageWarning:warning})},origins:new Set(['https://studio.example'])});
 const helpers={json:(_,status,data)=>{response={status,data}}};
 await handle({method:'GET'}, {},'/api/whatsapp/status',helpers);assert.equal(response.data.available,false);
 await assert.rejects(()=>handle({method:'POST',headers:{origin:'https://studio.example'}},{},'/api/whatsapp/requests',helpers),{code:'DATABASE_RETRYING'});
 warning=null;await handle({method:'GET'}, {},'/api/whatsapp/status',helpers);assert.equal(response.data.available,true);
});
