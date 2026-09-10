import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.ts';
import type { LegacyVaultEnvelope } from './legacy-vault.ts';
import type {
  InstallationWorkspaceRepository,
  InstallationWorkspaceAction,
} from './installation-workspace.ts';

const unavailable = () =>
  new ApiError(
    503,
    'INSTALLATION_WORKSPACE_UNAVAILABLE',
    '설치 작업본을 안전하게 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  );
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const owner = (uid: number) => typeof process.getuid === 'function' && uid === process.getuid();
/** Demo persistence keeps only the encrypted envelope and non-secret change metadata. */
export class FileInstallationWorkspaceRepository implements InstallationWorkspaceRepository {
  private directory: string;
  constructor(directory = path.join(process.cwd(), '.local/installation-workspaces')) {
    this.directory = path.resolve(directory);
  }
  private async root(create: boolean) {
    try {
      const parent = path.dirname(this.directory);
      let parentStat;
      try {
        parentStat = await lstat(parent);
      } catch (error) {
        if (!missing(error)) throw error;
        if (!create) return false;
        await mkdir(parent, { mode: 0o700 });
        parentStat = await lstat(parent);
      }
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !owner(parentStat.uid))
        throw unavailable();
      this.directory = path.join(await realpath(parent), path.basename(this.directory));
      let metadata;
      try {
        metadata = await lstat(this.directory);
      } catch (error) {
        if (!missing(error)) throw error;
        if (!create) return false;
        try {
          await mkdir(this.directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        metadata = await lstat(this.directory);
      }
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        !owner(metadata.uid) ||
        (metadata.mode & 0o7777) !== 0o700
      )
        throw unavailable();
      return true;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    }
  }
  private filename(id: string) {
    if (!id || id.length > 200) throw unavailable();
    return path.join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`);
  }
  private async read(file: string) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        !owner(metadata.uid) ||
        (metadata.mode & 0o7777) !== 0o600 ||
        metadata.size > 12 * 1024 * 1024
      )
        throw unavailable();
      const value = JSON.parse(await handle.readFile('utf8'));
      if (
        !Number.isInteger(value.revision) ||
        value.revision < 1 ||
        !value.envelope ||
        typeof value.envelope !== 'object'
      )
        throw unavailable();
      return { revision: value.revision as number, envelope: value.envelope as LegacyVaultEnvelope };
    } catch (error) {
      if (missing(error)) return undefined;
      if (error instanceof ApiError) throw error;
      throw unavailable();
    } finally {
      await handle?.close();
    }
  }
  async get(id: string) {
    if (!(await this.root(false))) return undefined;
    return this.read(this.filename(id));
  }
  async save(
    id: string,
    expected: number,
    envelope: LegacyVaultEnvelope,
    actorUserId: string,
    action: InstallationWorkspaceAction,
  ) {
    await this.root(true);
    const file = this.filename(id),
      lockFile = `${file}.lock`,
      temporary = `${file}.${randomUUID()}.tmp`;
    let lock: FileHandle;
    try {
      lock = await open(
        lockFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new ApiError(
          409,
          'INSTALLATION_REVISION_CONFLICT',
          '다른 작업에서 설치 정보를 변경 중입니다. 새로고침한 뒤 다시 저장해 주세요.',
        );
      throw unavailable();
    }
    try {
      if (((await this.read(file))?.revision ?? 0) !== expected)
        throw new ApiError(
          409,
          'INSTALLATION_REVISION_CONFLICT',
          '다른 작업에서 설치 정보가 변경되었습니다. 새로고침한 뒤 다시 저장해 주세요.',
        );
      const output = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await output.writeFile(
          JSON.stringify({
            revision: expected + 1,
            envelope,
            updatedBy: actorUserId,
            action,
            updatedAt: new Date().toISOString(),
          }),
          'utf8',
        );
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temporary, file);
      const directory = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return expected + 1;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw unavailable();
    } finally {
      await unlink(temporary).catch(() => {});
      await lock.close();
      await unlink(lockFile);
    }
  }
}
