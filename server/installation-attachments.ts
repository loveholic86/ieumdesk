import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ApiError, notFound } from './errors.ts';
import { openLegacyVault, type LegacyVault, type LegacyVaultEnvelope } from './legacy-vault.ts';
import type { InstallationAttachment } from '../src/installation-types.ts';

export const INSTALLATION_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const INSTALLATION_ATTACHMENT_EXTENSIONS = ['.txt', '.properties', '.xml', '.json', '.yaml', '.yml', '.ini', '.conf', '.cfg', '.csv', '.pdf', '.png', '.jpg', '.jpeg', '.zip', '.docx', '.xlsx', '.pptx', '.hwpx', '.doc', '.xls', '.ppt', '.hwp'];
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
const MAX_ENVELOPE = 10 * 1024 * 1024;
const unavailable = () => new ApiError(503, 'INSTALLATION_ATTACHMENT_UNAVAILABLE', '첨부파일을 안전하게 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
const invalid = () => new ApiError(400, 'INSTALLATION_ATTACHMENT_INVALID', '파일 이름, 확장자와 파일 내용을 확인해 주세요.');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const own = (uid: number) => typeof process.getuid === 'function' && uid === process.getuid();
const installationHash = (id: string) => {
  if (!id || id.length > 200) throw notFound();
  return createHash('sha256').update(id).digest('hex');
};
const aad = (installation: string, attachment: string, metadata: boolean) => ({ source: 'yeta-crm-workspace:v1', table: metadata ? 'installation_attachment_metadata' : 'installation_attachment_content', primaryKey: attachment, batchId: installation });
const metadataSchema = z.object({ id: z.string().regex(UUID), name: z.string(), mime: z.string(), size: z.number().int().min(1).max(INSTALLATION_ATTACHMENT_MAX_BYTES), createdAt: z.iso.datetime() }).strict();

export interface InstallationAttachmentStore {
  list(installationId: string): Promise<InstallationAttachment[]>;
  upload(installationId: string, input: { name: string; contentBase64: string }, guard?: () => Promise<void>): Promise<InstallationAttachment>;
  download(installationId: string, attachmentId: string): Promise<{ name: string; mime: string; content: Buffer }>;
  remove(installationId: string, attachmentId: string, guard?: () => Promise<void>): Promise<void>;
}

function filename(value: unknown) {
  if (typeof value !== 'string' || value.length > 180 || !value.length || value !== value.trim() || value.includes('..') || /[\x00-\x1f\x7f/\\:]/.test(value) || value.startsWith('.')) throw invalid();
  // Bidi controls can disguise the displayed extension; isolated surrogates break download headers.
  if (/[\u202a-\u202e\u2066-\u2069]/.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) throw invalid();
  const extension = path.extname(value).toLowerCase();
  if (!INSTALLATION_ATTACHMENT_EXTENSIONS.includes(extension)) throw invalid();
  return extension;
}
function decode(value: unknown) {
  if (typeof value !== 'string') throw invalid();
  if (value.length > Math.ceil(INSTALLATION_ATTACHMENT_MAX_BYTES / 3) * 4) throw new ApiError(413, 'INSTALLATION_ATTACHMENT_TOO_LARGE', '첨부파일은 5 MiB 이하만 등록할 수 있습니다.');
  const content = Buffer.from(value, 'base64');
  if (content.toString('base64') !== value || !content.length) throw invalid();
  if (content.length > INSTALLATION_ATTACHMENT_MAX_BYTES) throw new ApiError(413, 'INSTALLATION_ATTACHMENT_TOO_LARGE', '첨부파일은 5 MiB 이하만 등록할 수 있습니다.');
  return content;
}
function mime(extension: string, content: Buffer) {
  const starts = (bytes: number[]) => bytes.every((value, index) => content[index] === value);
  if (extension === '.pdf') { if (!content.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw invalid(); return 'application/pdf'; }
  if (extension === '.png') { if (!starts([137, 80, 78, 71, 13, 10, 26, 10])) throw invalid(); return 'image/png'; }
  if (extension === '.jpg' || extension === '.jpeg') { if (!starts([255, 216, 255])) throw invalid(); return 'image/jpeg'; }
  if (['.zip','.docx','.xlsx','.pptx','.hwpx'].includes(extension)) {
    if (!starts([80, 75, 3, 4]) && !starts([80, 75, 5, 6]) && !starts([80, 75, 7, 8])) throw invalid();
    return ({'.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'} as Record<string,string>)[extension] ?? 'application/zip';
  }
  if (['.doc','.xls','.ppt','.hwp'].includes(extension)) {
    if (!starts([208,207,17,224,161,177,26,225])) throw invalid();
    return ({'.doc':'application/msword','.xls':'application/vnd.ms-excel','.ppt':'application/vnd.ms-powerpoint'} as Record<string,string>)[extension] ?? 'application/octet-stream';
  }
  const text = content.toString('utf8');
  if (!Buffer.from(text).equals(content) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw invalid();
  return extension === '.json' ? 'application/json' : extension === '.xml' ? 'application/xml' : extension === '.csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8';
}

class LocalInstallationAttachmentStore implements InstallationAttachmentStore {
  private directory: string;
  constructor(private options: { directory?: string; vault?: () => Promise<LegacyVault>; now?: () => number } = {}) { this.directory = path.resolve(options.directory ?? path.join(process.cwd(), '.local/installation-attachments')); }
  private async vault() { try { return await (this.options.vault ?? (() => openLegacyVault({ createIfMissing: false })))(); } catch { throw unavailable(); } }
  private async privateDirectory(directory: string, create: boolean) {
    let metadata;
    try { metadata = await lstat(directory); }
    catch (error) {
      if (!missing(error)) throw unavailable();
      if (!create) return false;
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable(); }
      metadata = await lstat(directory);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !own(metadata.uid) || (metadata.mode & 0o7777) !== 0o700) throw unavailable();
    return true;
  }
  private async root(create: boolean) {
    const parent = path.dirname(this.directory);
    try {
      let metadata;
      try { metadata = await lstat(parent); }
      catch (error) { if (!missing(error) || !create) { if (missing(error)) return false; throw error; } await mkdir(parent, { mode: 0o700 }); metadata = await lstat(parent); }
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || !own(metadata.uid)) throw unavailable();
      // Resolve trusted ancestors, but never accept a symlink for the controlled parent/root.
      this.directory = path.join(await realpath(parent), path.basename(this.directory));
      return await this.privateDirectory(this.directory, create);
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
  }
  private async directoryFor(id: string, create: boolean) {
    const hash = installationHash(id);
    if (!await this.root(create)) return undefined;
    const directory = path.join(this.directory, hash);
    if (!await this.privateDirectory(directory, create)) return undefined;
    return { directory, hash };
  }
  private async file(file: string, maximum = MAX_ENVELOPE) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || !own(metadata.uid) || (metadata.mode & 0o7777) !== 0o600 || metadata.size > maximum) throw unavailable();
      return JSON.parse(await handle.readFile('utf8')) as LegacyVaultEnvelope;
    } catch { throw unavailable(); }
    finally { await handle?.close(); }
  }
  private async metadata(directory: string, hash: string, id: string, vault: LegacyVault) {
    if (!UUID.test(id)) throw notFound();
    const folder = path.join(directory, id);
    if (!await this.privateDirectory(folder, false)) throw notFound();
    try {
      const value = metadataSchema.parse(JSON.parse(vault.decrypt(await this.file(path.join(folder, 'metadata.json'), 16_384), aad(hash, id, true))));
      if (value.id !== id) throw unavailable(); filename(value.name);
      return value;
    } catch { throw unavailable(); }
  }
  private async entries(directory: string) { return (await readdir(directory)).filter(name => UUID.test(name)); }
  async list(id: string) {
    const location = await this.directoryFor(id, false);
    if (!location) return [];
    const vault = await this.vault();
    const items = await Promise.all((await this.entries(location.directory)).map(item => this.metadata(location.directory, location.hash, item, vault)));
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  private async locked<T>(directory: string, action: () => Promise<T>) {
    let handle: FileHandle;
    const lock = path.join(directory, '.lock');
    const recoveryBusy = async () => {
      try { await lstat(path.join(this.directory, '.recovery.lock')); }
      catch (error) { if (missing(error)) return; throw unavailable(); }
      throw new ApiError(409, 'INSTALLATION_ATTACHMENT_BUSY', '설치 자료 복구 점검이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    };
    await recoveryBusy();
    try { handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ApiError(409, 'INSTALLATION_ATTACHMENT_BUSY', '다른 첨부 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.'); throw unavailable(); }
    try { await recoveryBusy(); return await action(); }
    finally { await handle.close(); await unlink(lock); }
  }
  /** Recovery holds these locks through its database commit; no plaintext/key reads. */
  async recovery(installationIds: string[], lock: boolean, all = false) {
    let hashes = [...new Set(installationIds.map(installationHash))].sort();
    const held: { file: string; handle: FileHandle }[] = [];
    const release = async () => {
      let failed = false;
      for (const item of held.splice(0).reverse()) {
        try { await item.handle.close(); await unlink(item.file); } catch { failed = true; }
      }
      if (failed) throw unavailable();
    };
    if ((!hashes.length && !all) || !await this.root(lock)) return { installationsWithFiles: 0, release };
    const hold = async (file: string) => {
      try { held.push({ file, handle: await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ApiError(409, 'INSTALLATION_ATTACHMENT_BUSY', '다른 설치 첨부 작업이 진행 중입니다.'); throw unavailable(); }
    };
    try {
      if (lock) await hold(path.join(this.directory, '.recovery.lock'));
      if (all) {
        const entries = await readdir(this.directory);
        if (entries.some(name=>name!=='.recovery.lock'&&!/^[a-f\d]{64}$/.test(name))) throw unavailable();
        hashes=entries.filter(name=>/^[a-f\d]{64}$/.test(name)).sort();
      }
      let installationsWithFiles = 0;
      for (const hash of hashes) {
        const directory = path.join(this.directory, hash);
        if (!await this.privateDirectory(directory, false)) continue;
        if (lock) await hold(path.join(directory, '.lock'));
        // Pending/deleted remnants are dependencies too; never silently discard them.
        if ((await readdir(directory)).some(name => !lock || name !== '.lock')) installationsWithFiles += 1;
      }
      return { installationsWithFiles, release };
    } catch (error) { await release().catch(() => {}); throw error; }
  }
  private async write(file: string, envelope: LegacyVaultEnvelope) {
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(envelope), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  }
  async upload(installationId: string, input: { name: string; contentBase64: string }, guard?: () => Promise<void>) {
    const extension = filename(input?.name), content = decode(input?.contentBase64);
    try {
      const mediaType = mime(extension, content);
      const vault = await this.vault(); // A missing canonical key must not create a replacement.
      const location = (await this.directoryFor(installationId, true))!;
      return await this.locked(location.directory, async () => {
        if ((await this.entries(location.directory)).length >= 50) throw new ApiError(409, 'INSTALLATION_ATTACHMENT_LIMIT', '설치별 첨부파일은 최대 50개까지 등록할 수 있습니다.');
        const id = randomUUID(), folder = path.join(location.directory, `.pending-${id}`);
        const metadata: InstallationAttachment = { id, name: input.name, mime: mediaType, size: content.length, createdAt: new Date((this.options.now ?? Date.now)()).toISOString() };
        await mkdir(folder, { mode: 0o700 });
        try {
          await this.write(path.join(folder, 'metadata.json'), vault.encrypt(JSON.stringify(metadata), aad(location.hash, id, true)));
          await this.write(path.join(folder, 'content.json'), vault.encrypt(content.toString('base64'), aad(location.hash, id, false)));
          await guard?.();
          await rename(folder, path.join(location.directory, id));
          const directory = await open(location.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await directory.sync(); } finally { await directory.close(); }
          return metadata;
        } catch (error) {
          await unlink(path.join(folder, 'metadata.json')).catch(() => {}); await unlink(path.join(folder, 'content.json')).catch(() => {}); await rmdir(folder).catch(() => {});
          if (error instanceof ApiError) throw error; throw unavailable();
        }
      });
    } finally { content.fill(0); }
  }
  async download(installationId: string, attachmentId: string) {
    const location = await this.directoryFor(installationId, false); if (!location) throw notFound();
    const vault = await this.vault(), metadata = await this.metadata(location.directory, location.hash, attachmentId, vault);
    try {
      const content = decode(vault.decrypt(await this.file(path.join(location.directory, attachmentId, 'content.json')), aad(location.hash, attachmentId, false)));
      if (content.length !== metadata.size || mime(filename(metadata.name), content) !== metadata.mime) { content.fill(0); throw unavailable(); }
      return { name: metadata.name, mime: metadata.mime, content };
    } catch { throw unavailable(); }
  }
  async remove(installationId: string, attachmentId: string, guard?: () => Promise<void>) {
    const location = await this.directoryFor(installationId, false); if (!location) throw notFound();
    const vault = await this.vault();
    await this.locked(location.directory, async () => {
      await this.metadata(location.directory, location.hash, attachmentId, vault);
      const folder = path.join(location.directory, attachmentId);
      const names = (await readdir(folder)).sort();
      if (JSON.stringify(names) !== JSON.stringify(['content.json', 'metadata.json'])) throw unavailable();
      // Validate both controlled files before unlinking either one.
      await this.file(path.join(folder, 'content.json'));
      await this.file(path.join(folder, 'metadata.json'), 16_384);
      const deleted = path.join(location.directory, `.deleted-${attachmentId}`);
      await guard?.();
      await rename(folder, deleted);
      await unlink(path.join(deleted, 'content.json')); await unlink(path.join(deleted, 'metadata.json')); await rmdir(deleted);
    });
  }
}

export function createInstallationAttachmentStore(options: { directory?: string; vault?: () => Promise<LegacyVault>; now?: () => number } = {}): InstallationAttachmentStore { return new LocalInstallationAttachmentStore(options); }
export async function inspectInstallationAttachmentDependencies(installationIds: string[], options: { directory?: string; lock?: boolean } = {}) {
  return new LocalInstallationAttachmentStore({ directory: options.directory }).recovery(installationIds, options.lock === true);
}
export async function inspectAllInstallationAttachmentDependencies(options: { directory?: string; lock?: boolean } = {}) {
  return new LocalInstallationAttachmentStore({ directory: options.directory }).recovery([], options.lock === true, true);
}
