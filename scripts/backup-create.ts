import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { BackupService, PostgresBackupControl, safeBackupCode } from '../server/backup.ts';
import { PostgresBackupSnapshotProvider } from '../server/backup-snapshot.ts';
async function main() {
  if (process.argv.length !== 2) throw new Error('BACKUP_ARGUMENT_INVALID');
  const service = new BackupService(new PostgresBackupSnapshotProvider(), new PostgresBackupControl());
  try {
    console.log(JSON.stringify(await service.create('manual'), null, 2));
  } finally {
    await service.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'failed', code: safeBackupCode(error) }));
    process.exitCode = 1;
  });
