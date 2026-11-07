import {PGlite} from '@electric-sql/pglite';

// Real embedded Postgres, with a one-connection pool interface for store tests.
export function createTestPool(){
 const database=new PGlite();let queue=Promise.resolve();
 async function connect(){
  const previous=queue;let release;
  queue=new Promise(resolve=>{release=resolve});await previous;
  return {async query(sql,args){const result=args?await database.query(sql,args):(await database.exec(sql)).at(-1)||{rows:[],affectedRows:0};return {...result,rowCount:result.rows.length||result.affectedRows||0};},release};
 }
 return {connect,async query(sql,args){const client=await connect();try{return await client.query(sql,args)}finally{client.release()}},async end(){await queue;await database.close()}};
}
