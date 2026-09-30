import path from 'node:path';
import { lstat } from 'node:fs/promises';

export function runtimePath(...parts: string[]): string {
  return path.resolve(process.env.CRM_RUNTIME_DIR || '.local', ...parts);
}

export function backupSchedulerEnabled(value = process.env.CRM_BACKUP_SCHEDULER_ENABLED): boolean {
  if (value === undefined || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('BACKUP_SCHEDULER_CONFIGURATION_INVALID');
}

export function productionSettings(env: NodeJS.ProcessEnv = process.env) {
  backupSchedulerEnabled(env.CRM_BACKUP_SCHEDULER_ENABLED);
  if (env.NODE_ENV !== 'production') return undefined;
  try {
    const origin = new URL(env.APP_ORIGIN || '');
    if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN || origin.username || origin.password)
      throw new Error();
    if (env.CRM_DATA_MODE !== 'postgres') throw new Error();
    if (!env.CRM_RUNTIME_DIR || !path.isAbsolute(env.CRM_RUNTIME_DIR)) throw new Error();
    if (!env.LEGACY_VAULT_KEY_FILE || !path.isAbsolute(env.LEGACY_VAULT_KEY_FILE)) throw new Error();
    if (!env.DATABASE_URL && (!env.DB_INFO_FILE || !path.isAbsolute(env.DB_INFO_FILE))) throw new Error();
    return { origin: origin.origin, authority: origin.host };
  } catch {
    // Never include environment values, URLs or credentials in startup errors.
    throw new Error('PRODUCTION_CONFIGURATION_REQUIRED');
  }
}

export async function validateRuntimeStorage() {
  if (!productionSettings()) return;
  const directory = await lstat(runtimePath());
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.())
    throw new Error('RUNTIME_DIRECTORY_UNSAFE');
  const { openLegacyVault } = await import('./legacy-vault.ts');
  await openLegacyVault({ createIfMissing: false });
  const schema = await lstat(runtimePath('migration/source-schema.json'));
  if (!schema.isFile() || schema.isSymbolicLink() || schema.uid !== process.getuid?.() ||
      (schema.mode & 0o077) !== 0) throw new Error('MIGRATION_SCHEMA_UNSAFE');
}
