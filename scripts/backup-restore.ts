import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { BackupService, PostgresBackupControl, safeBackupCode } from '../server/backup.ts';
import { PostgresBackupSnapshotProvider } from '../server/backup-snapshot.ts';

export function parseBackupRestoreArguments(args: string[]) {
  let backup: string | undefined,
    expectedFingerprint: string | undefined,
    apply = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--backup' && backup === undefined) backup = args[++index];
    else if (argument === '--expected-fingerprint' && expectedFingerprint === undefined)
      expectedFingerprint = args[++index];
    else if (argument === '--apply' && !apply) apply = true;
    else throw new Error('BACKUP_ARGUMENT_INVALID');
  }
  if (!z.uuid().safeParse(backup).success) throw new Error('BACKUP_ID_REQUIRED');
  if (
    (expectedFingerprint !== undefined && !/^[a-f\d]{64}$/.test(expectedFingerprint)) ||
    (apply && !expectedFingerprint)
  )
    throw new Error('BACKUP_FINGERPRINT_REQUIRED');
  return { backup: backup!, expectedFingerprint, apply };
}
async function main() {
  const args = parseBackupRestoreArguments(process.argv.slice(2));
  const service = new BackupService(new PostgresBackupSnapshotProvider(), new PostgresBackupControl());
  try {
    console.log(
      JSON.stringify(
        args.apply
          ? await service.restore(args.backup, args.expectedFingerprint!)
          : await service.preview(args.backup),
        null,
        2,
      ),
    );
  } finally {
    await service.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'failed', code: safeBackupCode(error) }));
    process.exitCode = 1;
  });
}
