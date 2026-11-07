import {randomUUID} from 'node:crypto';
import {AppError} from './media.js';
import {digest} from './security.js';

export function createBatchStore(pool,vault){
 const query=(sql,args)=>pool.query(sql,args);
 return {
  async find(tokenHash){return (await query('SELECT id,request_hash,recipient_hash FROM ss_whatsapp_batches WHERE token_hash=$1',[tokenHash])).rows[0]||null;},
  async create({tokenHash,requestHash,recipientHash,ipHash,candidates}){
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ss-bulk-admission'))");
    const previous=(await client.query('SELECT id,request_hash FROM ss_whatsapp_batches WHERE token_hash=$1',[tokenHash])).rows[0];
    if(previous){if(previous.request_hash!==requestHash)throw new AppError('REQUEST_MISMATCH','This request already belongs to a different selection.');await client.query('COMMIT');return previous.id;}
    const pending=await client.query("SELECT count(*)::int AS count FROM ss_whatsapp_batch_items i JOIN ss_whatsapp_batches b ON b.id=i.batch_id WHERE i.status IN ('queued','preparing','sending') AND b.expires_at>now()");
    if(pending.rows[0].count+candidates.length>100)throw new AppError('QUEUE_FULL','The WhatsApp queue is full. Please try again shortly.',429);
    for(const [key,limit,seconds] of [[`whatsapp-ip:${ipHash}`,10,600],['whatsapp-global',200,3600],[`whatsapp-recipient:${recipientHash}`,10,600]]){
     const result=await client.query(`INSERT INTO ss_rate_limits(key,count,expires_at) VALUES($1,$2,now()+$3*interval '1 second') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN ss_rate_limits.expires_at<=now() THEN excluded.count ELSE ss_rate_limits.count+excluded.count END,expires_at=CASE WHEN ss_rate_limits.expires_at<=now() THEN excluded.expires_at ELSE ss_rate_limits.expires_at END RETURNING count`,[key,candidates.length,seconds]);
     if(result.rows[0].count>limit)throw new AppError('SEND_LIMIT','This sticker limit has been reached. Try again later or select fewer stickers.',429);
    }
    const id=randomUUID();
    await client.query('INSERT INTO ss_whatsapp_batches(id,token_hash,request_hash,recipient_hash) VALUES($1,$2,$3,$4)',[id,tokenHash,requestHash,recipientHash]);
    for(const [index,candidate] of candidates.entries()){
     const itemId=randomUUID();
     await client.query('INSERT INTO ss_whatsapp_batch_items(id,batch_id,position,source_ciphertext,delivery_token_hash) VALUES($1,$2,$3,$4,$5)',[itemId,id,index+1,vault.seal(candidate.mediaUrl,`batch-source:${itemId}`),digest(`batch-item:${id}:${itemId}`)]);
    }
    await client.query('COMMIT');return id;
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  },
  async get(id){
   const batch=(await query('SELECT id,recipient_hash,cancelled,created_at,expires_at FROM ss_whatsapp_batches WHERE id=$1',[id])).rows[0];
   if(!batch)throw new AppError('BATCH_EXPIRED','This queue is no longer available. Fetch the stickers again.',404);
   const items=(await query('SELECT id,position,status,error_code,error_message FROM ss_whatsapp_batch_items WHERE batch_id=$1 ORDER BY position',[id])).rows;
   return {...batch,items};
  },
  async acquire(owner){return (await query("INSERT INTO ss_whatsapp_batch_lock(id,owner,expires_at) VALUES('default',$1,now()+interval '180 seconds') ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE ss_whatsapp_batch_lock.expires_at<=now() OR ss_whatsapp_batch_lock.owner=excluded.owner RETURNING owner",[owner])).rowCount===1;},
  async release(owner){await query("DELETE FROM ss_whatsapp_batch_lock WHERE id='default' AND owner=$1",[owner]);},
  async next(owner,batchIds){
   if(!batchIds.length)return null;
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const lease=await client.query("SELECT 1 FROM ss_whatsapp_batch_lock WHERE id='default' AND owner=$1 AND expires_at>now() FOR UPDATE",[owner]);
    if(!lease.rowCount){await client.query('COMMIT');return null;}
    const result=await client.query("SELECT i.id,i.batch_id,i.position,i.source_ciphertext,i.delivery_token_hash FROM ss_whatsapp_batch_items i JOIN ss_whatsapp_batches b ON b.id=i.batch_id WHERE b.id=ANY($1::uuid[]) AND NOT b.cancelled AND b.expires_at>now() AND i.status IN ('queued','preparing','sending') ORDER BY b.created_at,i.position LIMIT 1 FOR UPDATE OF i",[batchIds]);
    if(!result.rowCount){await client.query('COMMIT');return null;}
    const item=result.rows[0];await client.query("UPDATE ss_whatsapp_batch_items SET status='preparing',updated_at=now() WHERE id=$1",[item.id]);
    await client.query('COMMIT');return {...item,sourceUrl:item.source_ciphertext?vault.open(item.source_ciphertext,`batch-source:${item.id}`):null};
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  },
  async setState(id,status,{code=null,message=null}={}){
   return (await query("UPDATE ss_whatsapp_batch_items SET status=$2,error_code=$3,error_message=$4,source_ciphertext=CASE WHEN $2 IN ('sent','failed','stopped','sending') THEN NULL ELSE source_ciphertext END,updated_at=now() WHERE id=$1 AND status NOT IN ('sent','failed','stopped') AND ($2<>'sending' OR batch_id IN (SELECT id FROM ss_whatsapp_batches WHERE NOT cancelled AND expires_at>now())) RETURNING id",[id,status,code,message])).rowCount===1;
  },
  async cancel(id){
   const client=await pool.connect();
   try{
    await client.query('BEGIN');await client.query('UPDATE ss_whatsapp_batches SET cancelled=true WHERE id=$1',[id]);
    await client.query("UPDATE ss_whatsapp_batch_items SET status='stopped',source_ciphertext=NULL,updated_at=now() WHERE batch_id=$1 AND status IN ('queued','preparing')",[id]);
    await client.query("UPDATE ss_sticker_requests SET status='failed',sticker_ciphertext=NULL,completed_at=now() WHERE status='pending' AND token_hash IN (SELECT delivery_token_hash FROM ss_whatsapp_batch_items WHERE batch_id=$1 AND status='stopped')",[id]);
    await client.query('COMMIT');
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
 };
}
