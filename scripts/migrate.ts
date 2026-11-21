import "dotenv/config";
import {readdir,readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {pool} from "../src/lib/db/pool";
async function main(){
 const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../migrations");
 await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations(filename TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 for(const file of (await readdir(dir)).filter(x=>x.endsWith(".sql")).sort()){
  const done=await pool.query("SELECT 1 FROM schema_migrations WHERE filename=$1",[file]); if(done.rowCount)continue;
  const client=await pool.connect();
  try{await client.query("BEGIN");await client.query(await readFile(path.join(dir,file),"utf8"));
   await client.query("INSERT INTO schema_migrations(filename) VALUES($1)",[file]);await client.query("COMMIT");console.log("Applied",file);
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());
