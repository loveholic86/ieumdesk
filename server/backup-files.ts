import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const BACKUP_FILE_ROOTS = ['installation-attachments', 'support-attachments', 'migration'] as const;
export interface BackupFile {
  root: (typeof BACKUP_FILE_ROOTS)[number];
  name: string;
  base64: string;
  sha256: string;
}
export const BACKUP_MAX_BYTES = 256 * 1024 * 1024;
export const backupFailure = (code: string) => new Error(code);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function safeDirectory(directory: string, create = false): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (!missing(error)) throw error;
    if (!create) return false;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    stat = await lstat(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.mode & 0o022)
    throw backupFailure('BACKUP_DIRECTORY_UNSAFE');
  return true;
}
export async function privateFile(file: string, limit = BACKUP_MAX_BYTES * 2): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > limit
    )
      throw backupFailure('BACKUP_FILE_UNSAFE');
    const content = await handle.readFile(),
      after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || content.length !== stat.size)
      throw backupFailure('BACKUP_FILES_CHANGED');
    return content;
  } finally {
    await handle.close();
  }
}
export async function writeExclusive(file: string, content: Buffer | string) {
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function syncTree(directory: string) {
  for (const name of await readdir(directory)) {
    const nested = path.join(directory, name),
      stat = await lstat(nested);
    if (stat.isSymbolicLink()) throw backupFailure('BACKUP_FILE_UNSAFE');
    if (stat.isDirectory()) await syncTree(nested);
  }
  await syncDirectory(directory);
}
export function validateBackupFiles(files: BackupFile[]) {
  if (!Array.isArray(files) || files.length > 100_000) throw backupFailure('BACKUP_PAYLOAD_INVALID');
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (
      !file ||
      typeof file !== 'object' ||
      !BACKUP_FILE_ROOTS.includes(file.root) ||
      typeof file.name !== 'string' ||
      !file.name.length ||
      file.name.length > 1000 ||
      file.name.includes('\\') ||
      file.name
        .split('/')
        .some(
          (part) =>
            !part || part === '.' || part === '..' || part.startsWith('.') || /[\x00-\x1f\x7f]/.test(part),
        ) ||
      typeof file.base64 !== 'string' ||
      file.base64.length > Math.ceil((BACKUP_MAX_BYTES - bytes) / 3) * 4
    )
      throw backupFailure('BACKUP_PAYLOAD_INVALID');
    const key = `${file.root}/${file.name}`;
    if (seen.has(key)) throw backupFailure('BACKUP_PAYLOAD_INVALID');
    seen.add(key);
    const content = Buffer.from(file.base64, 'base64');
    try {
      bytes += content.length;
      if (
        bytes > BACKUP_MAX_BYTES ||
        content.toString('base64') !== file.base64 ||
        sha256(content) !== file.sha256
      )
        throw backupFailure('BACKUP_PAYLOAD_INVALID');
    } finally {
      content.fill(0);
    }
  }
}
/** Hold across a legacy migration including its final report-file publication. */
export async function acquireBackupSourceLock(directory = path.resolve('.local')) {
  await safeDirectory(directory, true);
  const file = path.join(directory, '.backup-source.lock');
  let handle: FileHandle;
  try {
    handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw backupFailure('BACKUP_SOURCE_BUSY');
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await handle.close();
    await unlink(file);
  };
  try {
    if ((await readdir(directory)).some((name) => name.startsWith('.backup-restore-')))
      throw backupFailure('BACKUP_INTERRUPTED_RESTORE');
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

export class BackupFiles {
  constructor(readonly directory = path.resolve('.local')) {}
  /** These global locks interoperate with attachment uploads/deletes. Never steal stale locks. */
  async lock() {
    const releaseSource = await acquireBackupSourceLock(this.directory);
    const held: { file: string; handle: FileHandle }[] = [];
    const release = async () => {
      let failed = false;
      for (const lock of held.splice(0).reverse()) {
        try {
          await lock.handle.close();
          await unlink(lock.file);
        } catch {
          failed = true;
        }
      }
      try {
        await releaseSource();
      } catch {
        failed = true;
      }
      if (failed) throw backupFailure('BACKUP_FILE_LOCK_RELEASE_FAILED');
    };
    try {
      for (const root of BACKUP_FILE_ROOTS.slice(0, 2)) {
        const directory = path.join(this.directory, root);
        await safeDirectory(directory, true);
        const file = path.join(directory, '.recovery.lock');
        try {
          held.push({
            file,
            handle: await open(
              file,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o600,
            ),
          });
        } catch {
          throw backupFailure('BACKUP_FILES_BUSY');
        }
        for (const name of await readdir(directory)) {
          if (name === '.recovery.lock') continue;
          if (!/^[a-f\d]{64}$/.test(name)) throw backupFailure('BACKUP_FILE_UNSAFE');
          await safeDirectory(path.join(directory, name));
          try {
            await lstat(path.join(directory, name, '.lock'));
            throw backupFailure('BACKUP_FILES_BUSY');
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
      }
      return release;
    } catch (error) {
      await release().catch(() => {});
      throw error;
    }
  }
  async capture(): Promise<BackupFile[]> {
    const files: BackupFile[] = [];
    let total = 0;
    const visit = async (root: BackupFile['root'], relative: string) => {
      const directory = path.join(this.directory, root, relative);
      if (!(await safeDirectory(directory))) return;
      for (const name of (await readdir(directory)).sort()) {
        if (name === '.recovery.lock' && !relative) continue;
        // Incomplete publication/deletion and external dotfiles require review.
        if (name.startsWith('.') || /[\\\x00-\x1f\x7f]/.test(name)) throw backupFailure('BACKUP_FILES_BUSY');
        const nested = relative ? `${relative}/${name}` : name,
          file = path.join(directory, name),
          stat = await lstat(file);
        if (stat.isSymbolicLink()) throw backupFailure('BACKUP_FILE_UNSAFE');
        if (stat.isDirectory()) await visit(root, nested);
        else {
          const content = await privateFile(file, BACKUP_MAX_BYTES - total);
          try {
            total += content.length;
            files.push({ root, name: nested, base64: content.toString('base64'), sha256: sha256(content) });
          } finally {
            content.fill(0);
          }
          if (files.length > 100_000) throw backupFailure('BACKUP_TOO_LARGE');
        }
      }
    };
    for (const root of BACKUP_FILE_ROOTS) await visit(root, '');
    return files;
  }
  /** Stage first; swap while PostgreSQL holds its restore transaction. Compensation restores every tree on failure. */
  async stage(files: BackupFile[]) {
    validateBackupFiles(files);
    const staging = path.join(this.directory, `.backup-restore-${randomUUID()}`);
    await safeDirectory(staging, true);
    // This journal contains only the format and root names. Any surviving staging
    // directory blocks later backup/restore until an operator inspects it.
    await writeExclusive(
      path.join(staging, 'journal.json'),
      JSON.stringify({ version: 1, phase: 'staging', roots: BACKUP_FILE_ROOTS }),
    );
    const swapped: { root: string; existed: boolean }[] = [];
    let complete = false;
    try {
      for (const root of BACKUP_FILE_ROOTS) {
        const directory = path.join(staging, 'new', root);
        await safeDirectory(directory, true);
        if (root !== 'migration') await writeExclusive(path.join(directory, '.recovery.lock'), '');
      }
      for (const file of files) {
        const destination = path.join(staging, 'new', file.root, ...file.name.split('/'));
        await safeDirectory(path.dirname(destination), true);
        const content = Buffer.from(file.base64, 'base64');
        try {
          await writeExclusive(destination, content);
        } finally {
          content.fill(0);
        }
      }
      await safeDirectory(path.join(staging, 'old'), true);
      await syncTree(staging);
      await syncDirectory(this.directory);
      return {
        publish: async () => {
          await writeExclusive(
            path.join(staging, 'publication-started.json'),
            JSON.stringify({ version: 1, phase: 'publishing' }),
          );
          await syncDirectory(staging);
          for (const root of BACKUP_FILE_ROOTS) {
            const live = path.join(this.directory, root),
              existed = await safeDirectory(live);
            if (existed) {
              await rename(live, path.join(staging, 'old', root));
              await syncDirectory(path.join(staging, 'old'));
              await syncDirectory(this.directory);
            }
            swapped.push({ root, existed });
            await rename(path.join(staging, 'new', root), live);
            await syncDirectory(path.join(staging, 'new'));
            await syncDirectory(this.directory);
          }
        },
        rollback: async () => {
          if (complete) return;
          for (const { root, existed } of swapped.splice(0).reverse()) {
            const live = path.join(this.directory, root);
            await rm(live, { recursive: true, force: true });
            if (existed) await rename(path.join(staging, 'old', root), live);
            await syncDirectory(this.directory);
            await syncDirectory(path.join(staging, 'old'));
          }
          await rm(staging, { recursive: true, force: true });
          complete = true;
        },
        committed: async () => {
          complete = true;
          await writeExclusive(
            path.join(staging, 'database-committed.json'),
            JSON.stringify({ version: 1, phase: 'committed' }),
          );
          await syncDirectory(staging);
          await rm(staging, { recursive: true, force: true });
          await syncDirectory(this.directory);
        },
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}
