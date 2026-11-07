import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePhoneNumber} from '../src/phone.js';

test('Nigerian numbers accept local, international, pasted and spaced formats',()=>{
 for(const input of ['0915 973 9013','9159739013','2349159739013','+234 (915) 973-9013','00234 9159739013','+234 (0) 9159739013','０９１５９７３９０１３','٠٩١٥٩٧٣٩٠١٣'])assert.equal(normalizePhoneNumber(input,'NG').number,'+2349159739013',input);
});
test('foreign local and international numbers use country metadata rather than a Nigerian prefix',()=>{
 assert.equal(normalizePhoneNumber('020 7946 0018','GB').number,'+442079460018');
 assert.equal(normalizePhoneNumber('(202) 555-0123','US').number,'+12025550123');
 assert.equal(normalizePhoneNumber('+44 20 7946 0018','NG').number,'+442079460018');
 assert.equal(normalizePhoneNumber('442079460018','NG').number,'+442079460018');
});
test('invalid, ambiguous text, extensions and unsupported countries fail before lookup',()=>{
 for(const [input,country] of [['123','NG'],['hello +2349159739013','NG'],['09159739013 ext 1','NG'],['+2349159739013','XX'],[{},'NG']])assert.throws(()=>normalizePhoneNumber(input,country),{code:'INVALID_PHONE'});
});
