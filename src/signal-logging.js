// libsignal 6 prints whole SessionEntry objects directly through console, bypassing
// Baileys' logger. Redact only these known messages; preserve other diagnostics.
const sensitive=new Set(['Closing session:','Opening session:','Removing old closed session:','Session already closed']);
const installed=new WeakSet();
export function installSignalLogRedaction(target=console){
 if(installed.has(target))return;installed.add(target);
 for(const level of ['info','warn']){
  const original=target[level];
  target[level]=function(...args){return Reflect.apply(original,this,sensitive.has(args[0])?[args[0],'[session details redacted]']:args)};
 }
}
installSignalLogRedaction();
