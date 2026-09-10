import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export interface LegacyVaultContext {
  source: string;
  table: string;
  primaryKey: string;
  batchId: string;
}

// All five fields use canonical, padded base64. The raw key is never returned.
export interface LegacyVaultEnvelope {
  ciphertext: string;
  nonce: string;
  tag: string;
  keyId: string;
  sha256: string;
}

export interface LegacyVault {
  readonly keyId: string;
  encrypt(plaintext: string, context: LegacyVaultContext): LegacyVaultEnvelope;
  decrypt(envelope: LegacyVaultEnvelope, context: LegacyVaultContext): string;
  /** Purpose-separated keyed lookup. Never use an unkeyed hash for low-entropy private data. */
  blindIndex?(purpose: string, value: string): string;
}

class VaultError extends Error {}
const failure = (code: string) => new VaultError(code);
const digest = (value: Buffer) => createHash('sha256').update(value).digest();
const contextFields = ['source', 'table', 'primaryKey', 'batchId'] as const;
const envelopeFields = ['ciphertext', 'nonce', 'tag', 'keyId', 'sha256'] as const;

function aad(context: LegacyVaultContext, keyId: string, sha256: string): Buffer {
  if (
    !context ||
    typeof context !== 'object' ||
    contextFields.some((field) => typeof context[field] !== 'string' || !context[field].length)
  ) {
    throw failure('LEGACY_VAULT_CONTEXT_INVALID');
  }
  // A fixed tuple order preserves exact strings without delimiter ambiguity.
  return Buffer.from(
    JSON.stringify([
      'yeta-crm-legacy-vault',
      1,
      ...contextFields.map((field) => context[field]),
      keyId,
      sha256,
    ]),
    'utf8',
  );
}

function base64(value: unknown, bytes?: number): Buffer {
  if (typeof value !== 'string') throw failure('LEGACY_VAULT_DECRYPT_FAILED');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (bytes !== undefined && decoded.length !== bytes))
    throw failure('LEGACY_VAULT_DECRYPT_FAILED');
  return decoded;
}

class FileLegacyVault implements LegacyVault {
  readonly keyId: string;
  #key: KeyObject;

  constructor(key: Buffer) {
    this.keyId = createHash('sha256').update('yeta-crm-legacy-vault-key-v1\0').update(key).digest('base64');
    this.#key = createSecretKey(key);
    Object.freeze(this);
  }

  private keyedDigest(purpose: string, value: Buffer): Buffer {
    const derived = createHmac('sha256', this.#key)
      .update(JSON.stringify(['yeta-crm-derived-key-v1', purpose]))
      .digest();
    try {
      return createHmac('sha256', derived).update(value).digest();
    } finally {
      derived.fill(0);
    }
  }

  blindIndex(purpose: string, value: string): string {
    if (!purpose || typeof purpose !== 'string' || typeof value !== 'string')
      throw failure('LEGACY_VAULT_INDEX_INVALID');
    return this.keyedDigest(`lookup:${purpose}`, Buffer.from(value, 'utf8')).toString('hex');
  }

  encrypt(plaintext: string, context: LegacyVaultContext): LegacyVaultEnvelope {
    if (typeof plaintext !== 'string') throw failure('LEGACY_VAULT_PLAINTEXT_INVALID');
    const raw = Buffer.from(plaintext, 'utf8');
    try {
      // Reject unpaired UTF-16 surrogates instead of silently replacing bytes.
      if (raw.toString('utf8') !== plaintext) throw failure('LEGACY_VAULT_PLAINTEXT_INVALID');
      // Keep the envelope shape compatible without exposing a guessable plaintext fingerprint.
      const sha256 = this.keyedDigest('document-digest', Buffer.concat([aad(context, this.keyId, ''), raw])).toString('base64');
      const additionalData = aad(context, this.keyId, sha256);
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#key, nonce, { authTagLength: 16 });
      cipher.setAAD(additionalData);
      const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
      return {
        ciphertext: ciphertext.toString('base64'),
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        keyId: this.keyId,
        sha256,
      };
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw failure('LEGACY_VAULT_ENCRYPT_FAILED');
    } finally {
      raw.fill(0);
    }
  }

  decrypt(envelope: LegacyVaultEnvelope, context: LegacyVaultContext): string {
    let raw: Buffer | undefined;
    let unverified: Buffer | undefined;
    try {
      if (
        !envelope ||
        typeof envelope !== 'object' ||
        Object.keys(envelope).length !== envelopeFields.length ||
        envelopeFields.some((field) => !Object.hasOwn(envelope, field))
      )
        throw new Error();
      const keyId = base64(envelope.keyId, 32);
      if (!timingSafeEqual(keyId, base64(this.keyId, 32))) throw new Error();
      const expectedHash = base64(envelope.sha256, 32);
      const nonce = base64(envelope.nonce, 12);
      const tag = base64(envelope.tag, 16);
      const ciphertext = base64(envelope.ciphertext);
      const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce, { authTagLength: 16 });
      decipher.setAAD(aad(context, envelope.keyId, envelope.sha256));
      decipher.setAuthTag(tag);
      unverified = decipher.update(ciphertext);
      raw = Buffer.concat([unverified, decipher.final()]);
      const keyed = this.keyedDigest('document-digest', Buffer.concat([aad(context, this.keyId, ''), raw]));
      // Legacy archives used SHA-256. GCM authenticates both formats before this compatibility check.
      if (!timingSafeEqual(keyed, expectedHash) && !timingSafeEqual(digest(raw), expectedHash))
        throw new Error();
      const plaintext = raw.toString('utf8');
      if (!Buffer.from(plaintext, 'utf8').equals(raw)) throw new Error();
      return plaintext;
    } catch {
      // Do not expose plaintext, credentials, paths, or cryptographic diagnostics.
      throw failure('LEGACY_VAULT_DECRYPT_FAILED');
    } finally {
      unverified?.fill(0);
      raw?.fill(0);
    }
  }
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
function isExisting(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

async function privateDirectory(directory: string, create: boolean) {
  try {
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) throw failure('LEGACY_VAULT_KEY_MISSING');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      metadata = await lstat(directory);
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o7777) !== 0o700 ||
      metadata.uid !== process.getuid!()
    )
      throw failure('LEGACY_VAULT_KEY_DIRECTORY_UNSAFE');
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw failure('LEGACY_VAULT_KEY_DIRECTORY_UNSAFE');
  }
}

async function validateKeyFile(file: FileHandle) {
  const metadata = await file.stat();
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o7777) !== 0o600 ||
    metadata.uid !== process.getuid!()
  )
    throw failure('LEGACY_VAULT_KEY_FILE_UNSAFE');
  if (metadata.size !== 32) throw failure('LEGACY_VAULT_KEY_INVALID');
}

async function readKey(keyFile: string): Promise<Buffer> {
  const file = await open(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const buffer = Buffer.alloc(33);
  try {
    await validateKeyFile(file);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== 32) throw failure('LEGACY_VAULT_KEY_INVALID');
    await validateKeyFile(file);
    return Buffer.from(buffer.subarray(0, 32));
  } finally {
    buffer.fill(0);
    await file.close();
  }
}

async function readOrCreateKey(keyFile: string, create: boolean): Promise<Buffer> {
  await privateDirectory(path.dirname(keyFile), create);
  try {
    return await readKey(keyFile);
  } catch (error) {
    if (!isMissing(error)) throw error;
    if (!create) throw failure('LEGACY_VAULT_KEY_MISSING');
  }
  let file: FileHandle;
  try {
    // O_CREAT | O_EXCL is wx: never truncate or replace an existing key.
    file = await open(
      keyFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (isExisting(error)) return readKey(keyFile);
    throw error;
  }
  const key = randomBytes(32);
  try {
    await file.writeFile(key);
    await file.sync();
    await validateKeyFile(file);
    // Persist the new directory entry before any caller commits encrypted rows.
    const directory = await open(
      path.dirname(keyFile),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return Buffer.from(key);
  } finally {
    key.fill(0);
    await file.close();
  }
}

const keyOperations = new Map<string, Promise<void>>();

// Importing this module performs no file access. Missing keys are created only
// by an explicit createIfMissing=true call from the authorized migration.
export async function openLegacyVault(
  options: { keyFile?: string; createIfMissing?: boolean } = {},
): Promise<LegacyVault> {
  if (typeof process.getuid !== 'function' || typeof constants.O_NOFOLLOW !== 'number')
    throw failure('LEGACY_VAULT_PLATFORM_UNSUPPORTED');
  const keyFile = path.resolve(
    options.keyFile ?? process.env.LEGACY_VAULT_KEY_FILE ?? '.local/keys/crm-legacy.key',
  );
  const previous = keyOperations.get(keyFile);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  keyOperations.set(keyFile, pending);
  await previous;
  let key: Buffer | undefined;
  try {
    key = await readOrCreateKey(keyFile, options.createIfMissing === true);
    return new FileLegacyVault(key);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw failure('LEGACY_VAULT_KEY_UNAVAILABLE');
  } finally {
    key?.fill(0);
    release();
    if (keyOperations.get(keyFile) === pending) keyOperations.delete(keyFile);
  }
}
