import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { privateFile, syncDirectory } from './backup-files.ts';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const ioQueues = new Map<string, Promise<unknown>>();

/** Private local JSON files use the same ownership and link checks as encrypted backups. */
export class DemoPrivateFile {
  constructor(
    private file: string,
    private unavailable: () => Error,
  ) {
    this.file = path.resolve(file);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (ioQueues.get(this.file) ?? Promise.resolve()).then(operation);
    const settled = pending.catch(() => undefined);
    ioQueues.set(this.file, settled);
    void settled.then(() => {
      if (ioQueues.get(this.file) === settled) ioQueues.delete(this.file);
    });
    return pending;
  }

  private async directory(create: boolean): Promise<boolean> {
    const directory = path.dirname(this.file);
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (!missing(error)) throw error;
      if (!create) return false;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      metadata = await lstat(directory);
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o7777) !== 0o700
    )
      throw this.unavailable();
    return true;
  }

  ensureDirectory(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.directory(true);
      } catch {
        throw this.unavailable();
      }
    });
  }

  read(): Promise<string | undefined> {
    return this.enqueue(() => this.readUnlocked());
  }

  private async readUnlocked(): Promise<string | undefined> {
    try {
      if (!(await this.directory(false))) return undefined;
      try {
        const content = await privateFile(this.file);
        try {
          return content.toString('utf8');
        } finally {
          content.fill(0);
        }
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      }
    } catch {
      throw this.unavailable();
    }
  }

  /** Returns false only when another complete file wins a create-only race. */
  write(content: string, createOnly: boolean): Promise<boolean> {
    // The outer stores serialize their read-modify-write transactions. This inner
    // queue only guards filesystem IO so a reader never observes a replaced inode.
    return this.enqueue(() => this.writeUnlocked(content, createOnly));
  }

  private async writeUnlocked(content: string, createOnly: boolean): Promise<boolean> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    let ownedTemporary = false;
    try {
      await this.directory(true);
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      ownedTemporary = true;
      await handle.writeFile(content);
      await handle.sync();
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.uid !== process.getuid?.() ||
        (metadata.mode & 0o7777) !== 0o600
      )
        throw this.unavailable();
      await handle.close();
      handle = undefined;
      await this.directory(false);
      if (createOnly) {
        // Linking publishes a complete private file without replacing a raced path.
        try {
          await link(temporary, this.file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
          throw error;
        }
        await unlink(temporary);
        ownedTemporary = false;
      } else {
        // Refuse a target replaced by a link or made public since the original read.
        const previous = await privateFile(this.file);
        previous.fill(0);
        await rename(temporary, this.file);
        ownedTemporary = false;
      }
      await syncDirectory(path.dirname(this.file));
      return true;
    } catch {
      throw this.unavailable();
    } finally {
      await handle?.close().catch(() => {
        throw this.unavailable();
      });
      if (ownedTemporary)
        await unlink(temporary).catch((error) => {
          if (!missing(error)) throw this.unavailable();
        });
    }
  }
}
