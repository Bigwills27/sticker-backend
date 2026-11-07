import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {BufferJSON,initAuthCreds,proto} from '@whiskeysockets/baileys';

export function createPool(connectionString=process.env.DATABASE_URL){
 if(!connectionString)throw new Error('DATABASE_URL is required for the admin dashboard.');
 const url=new URL(connectionString);
 if(['prefer','require','verify-ca'].includes(url.searchParams.get('sslmode')))url.searchParams.set('sslmode','verify-full');
 const pool=new pg.Pool({connectionString:url.toString(),max:5,idleTimeoutMillis:30000,connectionTimeoutMillis:15000,query_timeout:15000,application_name:'sticker-studio'});
 // Pool errors are surfaced as safe operational events; never log connection strings.
 pool.on('error',()=>console.error('[database] An idle database connection was lost.'));
 return pool;
}

export async function migrate(pool){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('sticker-studio-migrations'))");
  await client.query('CREATE TABLE IF NOT EXISTS ss_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const migrations=(await readdir(new URL('../migrations/',import.meta.url))).filter(name=>/^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  for(const name of migrations){
   const applied=await client.query('SELECT name FROM ss_migrations WHERE name=$1',[name]);
   if(!applied.rowCount){
    await client.query(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
    await client.query('INSERT INTO ss_migrations(name) VALUES($1)',[name]);
   }
  }
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export function createStore(pool,vault){
 const query=(sql,args)=>pool.query(sql,args);
 const context=(type,id)=>`whatsapp:${type}:${id}`;
 return {
  pool,
  hashRecipient:value=>vault.recipientHash(value),
  async health(){await query('SELECT 1');return true;},
  async findAdmin(email){return (await query('SELECT id,email,password_hash,disabled FROM ss_admins WHERE email=$1',[email])).rows[0]||null;},
  async seedAdmin(email,passwordHash){
   const result=await query('INSERT INTO ss_admins(id,email,password_hash) VALUES($1,$2,$3) ON CONFLICT(email) DO NOTHING RETURNING id',[randomUUID(),email,passwordHash]);
   return result.rowCount===1;
  },
  async createAdminSession(tokenHash,adminId,expiresAt){await query('INSERT INTO ss_admin_sessions(token_hash,admin_id,expires_at) VALUES($1,$2,$3)',[tokenHash,adminId,expiresAt]);},
  async getAdminSession(tokenHash){return (await query('SELECT a.id,a.email FROM ss_admin_sessions s JOIN ss_admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND a.disabled=false',[tokenHash])).rows[0]||null;},
  async revokeAdminSession(tokenHash){await query('UPDATE ss_admin_sessions SET revoked_at=now() WHERE token_hash=$1',[tokenHash]);},
  async checkLimit(key,limit,seconds){
   const {rows}=await query(`INSERT INTO ss_rate_limits(key,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN ss_rate_limits.expires_at<=now() THEN 1 ELSE ss_rate_limits.count+1 END,
    expires_at=CASE WHEN ss_rate_limits.expires_at<=now() THEN excluded.expires_at ELSE ss_rate_limits.expires_at END RETURNING count`,[key,seconds]);
   return rows[0].count<=limit;
  },
  async hasAuth(){return (await query("SELECT 1 FROM ss_whatsapp_auth WHERE key_type='creds' AND key_id='default'")).rowCount>0;},
  async readAuth(type,ids){
   if(!ids.length)return {};
   const {rows}=await query('SELECT key_id,ciphertext FROM ss_whatsapp_auth WHERE key_type=$1 AND key_id=ANY($2::text[])',[type,ids]);
   return Object.fromEntries(rows.map(row=>[row.key_id,JSON.parse(vault.open(row.ciphertext,context(type,row.key_id)),BufferJSON.reviver)]));
  },
  async writeAuth(entries,{owner}={}){
   // Pairing generates 812 pre-keys at once. Encrypt before taking the lease lock,
   // then persist each batch in one round trip rather than one INSERT per key.
   // Preserve sequential last-write-wins semantics if a key occurs twice.
   const latest=new Map(entries.map(entry=>[JSON.stringify([entry.type,entry.id]),entry]));
   const upserts=[],deletions=[];
   for(const {type,id,value} of latest.values()){
    if(value==null)deletions.push([type,id]);
    else upserts.push([type,id,vault.seal(JSON.stringify(value,BufferJSON.replacer),context(type,id))]);
   }
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
    if(owner){
     const lease=await client.query("SELECT 1 FROM ss_whatsapp_leases WHERE id='default' AND owner=$1 AND expires_at>now() FOR UPDATE",[owner]);
     if(!lease.rowCount)throw new Error('WhatsApp session ownership was lost.');
    }
    if(deletions.length)await client.query('DELETE FROM ss_whatsapp_auth AS auth USING unnest($1::text[],$2::text[]) AS removed(key_type,key_id) WHERE auth.key_type=removed.key_type AND auth.key_id=removed.key_id',[deletions.map(row=>row[0]),deletions.map(row=>row[1])]);
    if(upserts.length)await client.query('INSERT INTO ss_whatsapp_auth(key_type,key_id,ciphertext) SELECT * FROM unnest($1::text[],$2::text[],$3::text[]) ON CONFLICT(key_type,key_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=now()',[upserts.map(row=>row[0]),upserts.map(row=>row[1]),upserts.map(row=>row[2])]);
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  },
  async clearAuth(owner){
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    if(owner){
     const lease=await client.query("SELECT 1 FROM ss_whatsapp_leases WHERE id='default' AND owner=$1 AND expires_at>now() FOR UPDATE",[owner]);
     if(!lease.rowCount)throw new Error('WhatsApp session ownership was lost.');
    }
    await client.query('DELETE FROM ss_whatsapp_auth');await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  },
  async resetAuth(owner,nextOwner){
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const lease=await client.query("SELECT 1 FROM ss_whatsapp_leases WHERE id='default' AND owner=$1 AND expires_at>now() FOR UPDATE",[owner]);
    if(!lease.rowCount)throw new Error('WhatsApp session ownership was lost.');
    await client.query('DELETE FROM ss_whatsapp_auth');
    // Rotate the owner atomically with deletion, fencing every queued old-auth write.
    await client.query("UPDATE ss_whatsapp_leases SET owner=$2,expires_at=now()+interval '60 seconds' WHERE id='default' AND owner=$1",[owner,nextOwner]);
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  },
  async acquireLease(owner){
   const result=await query("INSERT INTO ss_whatsapp_leases(id,owner,expires_at) VALUES('default',$1,now()+interval '60 seconds') ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE ss_whatsapp_leases.expires_at<=now() OR ss_whatsapp_leases.owner=excluded.owner RETURNING owner",[owner]);
   return result.rowCount===1;
  },
  async renewLease(owner){return (await query("UPDATE ss_whatsapp_leases SET expires_at=now()+interval '60 seconds' WHERE id='default' AND owner=$1 AND expires_at>now() RETURNING owner",[owner])).rowCount===1;},
  async releaseLease(owner){await query("DELETE FROM ss_whatsapp_leases WHERE id='default' AND owner=$1",[owner]);},
  async recordEvent(type,message){await query('INSERT INTO ss_admin_events(id,type,message) VALUES($1,$2,$3)',[randomUUID(),type,message.slice(0,250)]);},
  async createRequest(tokenHash,sticker){
   const id=randomUUID(),expiresAt=new Date(Date.now()+30*60*1000);
   await query('INSERT INTO ss_sticker_requests(id,token_hash,sticker_ciphertext,expires_at) VALUES($1,$2,$3,$4)',[id,tokenHash,vault.seal(sticker.toString('base64'),`sticker:${id}`),expiresAt]);
   return {id,expiresAt:expiresAt.toISOString()};
  },
  async getDirectRequest(tokenHash,recipientHash){
   return (await query("SELECT id,CASE WHEN status='pending' AND expires_at<=now() THEN 'expired' ELSE status END AS status FROM ss_sticker_requests WHERE token_hash=$1 AND recipient_hash=$2",[tokenHash,recipientHash])).rows[0]||null;
  },
  async prepareDirectRequest(tokenHash,recipientHash,sticker){
   const id=randomUUID();
   const result=await query("INSERT INTO ss_sticker_requests(id,token_hash,recipient_hash,sticker_ciphertext,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 minutes') ON CONFLICT(token_hash) DO NOTHING RETURNING id,status",[id,tokenHash,recipientHash,vault.seal(sticker.toString('base64'),`sticker:${id}`)]);
   if(result.rowCount)return {...result.rows[0],created:true};
   const existing=await this.getDirectRequest(tokenHash,recipientHash);
   if(!existing)throw new Error('Delivery request does not match its recipient.');
   return {...existing,created:false};
  },
  async claimRequest(tokenHash,recipientHash){
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    // Serialize claims per recipient, including two different codes arriving at once.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[recipientHash]);
    const recent=await client.query("SELECT count(*)::int AS count FROM ss_sticker_requests WHERE recipient_hash=$1 AND claimed_at>now()-interval '10 minutes' AND status IN ('sending','delivered')",[recipientHash]);
    if(recent.rows[0].count>=10){await client.query('COMMIT');return null;}
    const result=await client.query("UPDATE ss_sticker_requests SET status='sending',recipient_hash=$2,claimed_at=now() WHERE token_hash=$1 AND status='pending' AND expires_at>now() RETURNING id,sticker_ciphertext",[tokenHash,recipientHash]);
    if(!result.rowCount){await client.query('COMMIT');return null;}
    const row=result.rows[0],sticker=Buffer.from(vault.open(row.sticker_ciphertext,`sticker:${row.id}`),'base64');
    await client.query('COMMIT');return {id:row.id,sticker};
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  },
  async finishRequest(id,status,messageId=null){await query("UPDATE ss_sticker_requests SET status=$2,message_id=$3,sticker_ciphertext=NULL,completed_at=now() WHERE id=$1 AND (status='sending' OR (status='pending' AND $2='failed'))",[id,status,messageId]);},
  async dashboard(){
   const [stats,events]=await Promise.all([
    query("SELECT count(*) FILTER(WHERE status='delivered')::int AS delivered,count(*) FILTER(WHERE status IN ('pending','sending') AND expires_at>now())::int AS pending,count(*) FILTER(WHERE status='failed')::int AS failed FROM ss_sticker_requests"),
    query('SELECT id,type,message,created_at AS "createdAt" FROM ss_admin_events ORDER BY created_at DESC LIMIT 12')
   ]);
   return {stats:stats.rows[0],activity:events.rows};
  },
  async cleanup(){
   // A process can stop after recording delivery but before updating its batch.
   // Trust the durable delivery receipt before classifying stale queue items.
   await query("UPDATE ss_whatsapp_batch_items AS item SET status='sent',source_ciphertext=NULL,error_code=NULL,error_message=NULL,updated_at=now() FROM ss_sticker_requests AS delivery WHERE delivery.token_hash=item.delivery_token_hash AND delivery.status='delivered' AND item.status<>'sent'");
   await query("UPDATE ss_whatsapp_batch_items SET status='stopped',source_ciphertext=NULL,error_message='This queue expired. Fetch the stickers again.',updated_at=now() WHERE batch_id IN (SELECT id FROM ss_whatsapp_batches WHERE expires_at<=now()) AND status IN ('queued','preparing')");
   await query("UPDATE ss_whatsapp_batch_items SET status='failed',source_ciphertext=NULL,error_code='DELIVERY_UNCONFIRMED',error_message='Delivery could not be confirmed. Check WhatsApp before sending again.',updated_at=now() WHERE status='sending' AND updated_at<now()-interval '5 minutes'");
   await query("DELETE FROM ss_whatsapp_batches WHERE expires_at<now()-interval '1 day'");
   await query("UPDATE ss_sticker_requests SET status='expired',sticker_ciphertext=NULL WHERE status='pending' AND expires_at<=now()");
   await query("UPDATE ss_sticker_requests SET status='failed',sticker_ciphertext=NULL,completed_at=now() WHERE status='sending' AND expires_at<now()-interval '10 minutes'");
   await query("DELETE FROM ss_sticker_requests WHERE created_at<now()-interval '7 days'");
   await query("DELETE FROM ss_admin_events WHERE created_at<now()-interval '7 days'");
   await query('DELETE FROM ss_admin_sessions WHERE expires_at<=now()');
   await query('DELETE FROM ss_rate_limits WHERE expires_at<=now()');
  }
 };
}

export async function loadBaileysAuth(store,{owner}={}){
 const saved=await store.readAuth('creds',['default']);
 const creds=saved.default||initAuthCreds();
 delete creds.pairingCode;
 let writes=Promise.resolve(),writeError=null,closed=false,pending=null;
 const enqueue=entries=>{
  if(closed)return Promise.reject(new Error('WhatsApp authentication store is closed.'));
  if(writeError)return Promise.reject(writeError);
  // Snapshot mutable buffers before another Baileys event changes them.
  const snapshot=JSON.parse(JSON.stringify(entries,BufferJSON.replacer),BufferJSON.reviver);
  if(!pending){
   const batch={entries:new Map()};pending=batch;
   batch.promise=writes.then(async()=>{
    if(pending===batch)pending=null;
    if(writeError)throw writeError;
    await store.writeAuth([...batch.entries.values()],{owner});
   });
   writes=batch.promise.catch(error=>{writeError=error;});
  }
  for(const entry of snapshot)pending.entries.set(JSON.stringify([entry.type,entry.id]),entry);
  // Every caller waits for its keys to be durable, even when its update is merged.
  return pending.promise;
 };
 return {
  state:{creds,keys:{
   async get(type,ids){
    await writes;if(writeError)throw writeError;
    const result=await store.readAuth(type,ids);
    if(type==='app-state-sync-key')for(const id of ids)if(result[id])result[id]=proto.Message.AppStateSyncKeyData.fromObject(result[id]);
    return result;
   },
   async set(data){return enqueue(Object.entries(data).flatMap(([type,values])=>Object.entries(values).map(([id,value])=>({type,id,value}))));}
  }},
  saveCreds:()=>{
   // Baileys places its temporary pairing code in creds before emitting creds.update.
   const {pairingCode,...persistent}=creds;
   return enqueue([{type:'creds',id:'default',value:persistent}]);
  },
  async flush(){await writes;if(writeError)throw writeError;},
  async close(){closed=true;await writes;if(writeError)throw writeError;}
 };
}
