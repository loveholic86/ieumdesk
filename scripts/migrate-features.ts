import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { databaseConfig } from '../server/config.ts';

const allowed = new Set(['005_installation_workspace.sql','006_workspace_settings.sql','007_business_extensions.sql','008_catalog.sql','009_support.sql','010_archive.sql','011_company_task_details.sql','012_backups.sql']);
const names = process.argv.slice(2).filter(value=>value!=='--apply');
const apply = process.argv.slice(2).includes('--apply');
let client:Client|undefined;
try {
  if(!names.length||names.some(name=>!allowed.has(name))||new Set(names).size!==names.length)throw new Error('INVALID_MIGRATION');
  client=new Client(await databaseConfig(!apply));await client.connect();
  if((await client.query('SELECT current_database() AS name')).rows[0].name!=='yeta_crm')throw new Error('INVALID_TARGET');
  const count = async()=> (await client!.query(`SELECT
    (SELECT count(*)::int FROM yeta_crm.companies) AS companies,
    (SELECT count(*)::int FROM yeta_crm.activities) AS activities,
    (SELECT count(*)::int FROM yeta_crm.tasks) AS tasks,
    (SELECT count(*)::int FROM yeta_crm.records) AS records,
    (SELECT count(*)::int FROM yeta_crm.auth_users) AS users,
    (SELECT count(*)::int FROM yeta_crm.auth_sessions) AS sessions,
    (SELECT count(*)::int FROM yeta_crm_private.legacy_archive) AS archives`)).rows[0];
  const before=await count();
  for(const name of names){const sql=await readFile(`db/${name}`,'utf8');if(apply)await client.query(sql);}
  const after=await count();
  if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('COUNT_CHANGED');
  console.log(JSON.stringify({mode:apply?'applied':'read-only-plan',migrations:names,before,after}));
}catch{console.error('FEATURE_MIGRATION_FAILED');process.exitCode=1;}finally{await client?.end();}
