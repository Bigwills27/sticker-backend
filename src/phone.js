import {parsePhoneNumberFromString,isSupportedCountry,parseDigits} from 'libphonenumber-js/max';
import {AppError} from './media.js';

export function normalizePhoneNumber(input,country='NG'){
 const invalid=()=>new AppError('INVALID_PHONE','Enter a valid WhatsApp number and choose its country. You can also paste a full number starting with +.');
 if(typeof input!=='string'||input.length>80||typeof country!=='string'||!isSupportedCountry(country.toUpperCase()))throw invalid();
 let text=input.normalize('NFKC').trim().replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/[٠-٩۰-۹]/g,char=>parseDigits(char));
 if(!/^[+\d\s().-]+$/.test(text))throw invalid();
 text=text.replace(/^00/,'+');
 let parsed=parsePhoneNumberFromString(text,{defaultCountry:country.toUpperCase(),extract:false});
 if(!parsed?.isValid()&&!text.startsWith('+'))parsed=parsePhoneNumberFromString('+'+text,{extract:false});
 if(!parsed?.isValid()||parsed.ext)throw invalid();
 return {number:parsed.number,formatted:parsed.formatInternational(),country:parsed.country||null};
}
