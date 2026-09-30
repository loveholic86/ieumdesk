import { runtimePath } from './runtime-config.ts';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { databaseConfig } from './config.ts';
import { ApiError } from './errors.ts';
import { openLegacyVault, type LegacyVault, type LegacyVaultEnvelope } from './legacy-vault.ts';
import { authEmailLookup, encodeAuthIdentity, decodeAuthIdentity, type StoredAuthIdentity } from './auth-identity.ts';
import { DemoPrivateFile } from './demo-private-file.ts';

export type UserRole = 'admin' | 'editor' | 'viewer';
export type UserStatus = 'pending' | 'active' | 'disabled';
export interface User { id: string; email: string; name: string; role: UserRole; status: UserStatus; createdAt: string; updatedAt: string }
export interface AuthUser extends User { passwordHash: string }
export interface Session { tokenHash: string; userId: string; expiresAt: string; createdAt: string }
export interface Registration { email: string; name: string; passwordHash: string }
export type ProfilePatch = { name?: string; email?: string };
export type AccessPatch = { role?: UserRole; status?: UserStatus };
export interface PasswordReset { tokenHash: string; createdAt: string; expiresAt: string }
export interface PasswordResetRequest { userId: string; requestedAt: string }
export interface AdminCredential { id: string; tokenHash: string; passwordHash: string; email: string }
export interface AuthStore {
  health(): Promise<void>;
  hasUsers(): Promise<boolean>;
  register(input: Registration): Promise<AuthUser>;
  findUserByEmail(email: string): Promise<AuthUser | undefined>;
  createSession(userId: string, tokenHash: string, expiresAt: string, now: string, expected: { passwordHash: string; email: string }): Promise<void>;
  getSession(tokenHash: string, now: string): Promise<AuthUser | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;
  updateProfile(userId: string, patch: ProfilePatch, expectedPasswordHash?: string, expectedEmail?: string): Promise<AuthUser>;
  updatePassword(userId: string, expectedPasswordHash: string, passwordHash: string): Promise<void>;
  listUsers(): Promise<User[]>;
  updateAccess(actorId: string, userId: string, patch: AccessPatch): Promise<User>;
  requestPasswordReset(email: string, now: string): Promise<void>;
  listPasswordResetRequests(): Promise<PasswordResetRequest[]>;
  createAdminPasswordReset(actor: AdminCredential, userId: string, reset: PasswordReset): Promise<User>;
  consumePasswordReset(tokenHash: string, passwordHash: string, now: string): Promise<void>;
  deletePasswordReset(tokenHash: string): Promise<void>;
  close?(): Promise<void>;
}

export function publicUser(user: AuthUser | User): User {
  const { id, email, name, role, status, createdAt, updatedAt } = user;
  return { id, email, name, role, status, createdAt, updatedAt };
}
const noUser = () => new ApiError(404, 'USER_NOT_FOUND', '사용자를 찾을 수 없습니다.');
const forbidden = () => new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
const duplicateEmail = () => new ApiError(409, 'EMAIL_UNAVAILABLE', '해당 이메일로 계정을 등록하거나 변경할 수 없습니다.');
const accountChanged = () => new ApiError(409, 'ACCOUNT_CHANGED', '계정 정보가 변경되었습니다. 다시 로그인한 뒤 시도해 주세요.');
const lastAdmin = () => new ApiError(409, 'LAST_ACTIVE_ADMIN', '활성 관리자는 최소 한 명 이상 있어야 합니다.');
const authStorageUnavailable = () => new ApiError(503, 'AUTH_STORAGE_UNAVAILABLE', '계정 저장소를 확인하지 못했습니다.');
const invalidReset = () => new ApiError(400, 'INVALID_PASSWORD_RESET', '재설정 링크가 만료되었거나 유효하지 않습니다. 관리자에게 새 링크를 요청해 주세요.');
const disabledReset = () => new ApiError(409, 'ACCOUNT_DISABLED', '이용 중지 계정은 비밀번호를 초기화할 수 없습니다. 계정 상태를 먼저 확인해 주세요.');
const adminChanged = () => new ApiError(401, 'ADMIN_REAUTHENTICATION_REQUIRED', '관리자 인증 정보가 변경되었습니다. 다시 로그인한 뒤 시도해 주세요.');

interface AuthData { version: 1; users: AuthUser[]; sessions: Session[]; passwordResets?: (PasswordReset & { userId: string })[]; resetRequests?: PasswordResetRequest[] }
interface EncryptedAuthData { version: 2; document: LegacyVaultEnvelope }
const demoAuthContext = { source: 'crm-auth-demo', table: 'auth_data', primaryKey: 'local', batchId: 'auth-v2' };

// All instances in this local process serialize on the canonical auth-file path.
const queues = new Map<string, Promise<unknown>>();
export class DemoAuthStore implements AuthStore {
  private file: string;
  private vault?: Promise<LegacyVault>;
  private readonly keyFile: string;
  private readonly storage: DemoPrivateFile;
  constructor(file = runtimePath('crm-auth-demo.json'), options: { keyFile?: string } = {}) {
    this.file = path.resolve(file);
    this.keyFile = options.keyFile ?? path.join(path.dirname(this.file), '.keys', 'crm-auth.key');
    this.storage = new DemoPrivateFile(this.file, authStorageUnavailable);
  }
  private openVault(createIfMissing = false) {
    return (this.vault ??= openLegacyVault({ keyFile: this.keyFile, createIfMissing }));
  }
  private async serialize(data: AuthData): Promise<string> {
    return JSON.stringify({ version: 2, document: (await this.openVault()).encrypt(JSON.stringify(data), demoAuthContext) } satisfies EncryptedAuthData);
  }
  private async read(): Promise<AuthData> {
    let raw = await this.storage.read();
    if (raw === undefined) {
      await this.storage.ensureDirectory();
      await this.openVault(true);
      await this.storage.write(await this.serialize({ version: 1, users: [], sessions: [] }), true);
      raw = await this.storage.read();
      if (raw === undefined) throw authStorageUnavailable();
    }
    const stored = JSON.parse(raw) as AuthData | EncryptedAuthData;
    let data: AuthData;
    if (stored.version === 2) {
      data = JSON.parse((await this.openVault()).decrypt(stored.document, demoAuthContext)) as AuthData;
    } else {
      // One-time local upgrade is completed by startup health() or the next mutation.
      // Existing ciphertext never permits automatic replacement of a missing key.
      data = stored;
      if (data.version !== 1 || !Array.isArray(data.users) || !Array.isArray(data.sessions)) throw new Error('INVALID_AUTH_STORE');
      await this.openVault(true);
    }
    if (data.version !== 1 || !Array.isArray(data.users) || !Array.isArray(data.sessions)) throw new Error('INVALID_AUTH_STORE');
    if ((data.passwordResets !== undefined && !Array.isArray(data.passwordResets)) ||
        (data.resetRequests !== undefined && !Array.isArray(data.resetRequests))) throw new Error('INVALID_AUTH_STORE');
    return data;
  }
  private async mutate<T>(operation: (data: AuthData) => T): Promise<T> {
    const result = (queues.get(this.file) ?? Promise.resolve()).then(async () => {
      const data = await this.read(); const value = operation(data);
      await this.storage.write(await this.serialize(data), false);
      return value;
    });
    const settled = result.catch(() => undefined);
    queues.set(this.file, settled);
    void settled.then(() => { if (queues.get(this.file) === settled) queues.delete(this.file); });
    return result;
  }
  async health() { await this.mutate(() => undefined); }
  async hasUsers() { return (await this.read()).users.length > 0; }
  async register(input: Registration) {
    return this.mutate(data => {
      if (data.users.some(user => user.email === input.email)) throw duplicateEmail();
      const first = data.users.length === 0; const now = new Date().toISOString();
      const user: AuthUser = { ...input, id: randomUUID(), role: first ? 'admin' : 'viewer', status: first ? 'active' : 'pending', createdAt: now, updatedAt: now };
      data.users.push(user); return user;
    });
  }
  async findUserByEmail(email: string) { return (await this.read()).users.find(user => user.email === email); }
  async createSession(userId: string, tokenHash: string, expiresAt: string, now: string, expected: { passwordHash: string; email: string }) {
    await this.mutate(data => {
      const user = data.users.find(user => user.id === userId && user.status !== 'disabled'); if (!user) throw accountChanged();
      if (user.passwordHash !== expected.passwordHash || user.email !== expected.email) throw accountChanged();
      data.sessions = data.sessions.filter(session => session.expiresAt > now);
      data.sessions.push({ userId, tokenHash, expiresAt, createdAt: now });
    });
  }
  async getSession(tokenHash: string, now: string) {
    const data = await this.read(); const session = data.sessions.find(item => item.tokenHash === tokenHash && item.expiresAt > now);
    return session ? data.users.find(user => user.id === session.userId && user.status !== 'disabled') : undefined;
  }
  async deleteSession(tokenHash: string) { await this.mutate(data => { data.sessions = data.sessions.filter(session => session.tokenHash !== tokenHash); }); }
  async revokeUserSessions(userId: string) { await this.mutate(data => { data.sessions = data.sessions.filter(session => session.userId !== userId); }); }
  async updateProfile(userId: string, patch: ProfilePatch, expectedPasswordHash?: string, expectedEmail?: string) {
    return this.mutate(data => {
      const user = data.users.find(item => item.id === userId); if (!user) throw noUser();
      if (expectedPasswordHash && user.passwordHash !== expectedPasswordHash) throw accountChanged();
      if (expectedEmail !== undefined && user.email !== expectedEmail) throw accountChanged();
      if (patch.email && data.users.some(item => item.id !== userId && item.email === patch.email)) throw duplicateEmail();
      if (patch.email && patch.email !== user.email) {
        data.sessions = data.sessions.filter(session => session.userId !== userId);
        this.clearResets(data, userId);
      }
      Object.assign(user, patch, { updatedAt: new Date().toISOString() }); return user;
    });
  }
  async updatePassword(userId: string, expectedPasswordHash: string, passwordHash: string) {
    await this.mutate(data => {
      const user = data.users.find(item => item.id === userId); if (!user) throw noUser();
      if (user.passwordHash !== expectedPasswordHash) throw accountChanged();
      user.passwordHash = passwordHash; user.updatedAt = new Date().toISOString();
      data.sessions = data.sessions.filter(session => session.userId !== userId);
      this.clearResets(data, userId);
    });
  }
  async listUsers() { return (await this.read()).users.map(publicUser).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); }
  async updateAccess(actorId: string, userId: string, patch: AccessPatch) {
    return this.mutate(data => {
      const actor = data.users.find(user => user.id === actorId); if (actor?.role !== 'admin' || actor.status !== 'active') throw forbidden();
      const user = data.users.find(item => item.id === userId); if (!user) throw noUser();
      const next = { ...user, ...patch };
      if (user.role === 'admin' && user.status === 'active' && (next.role !== 'admin' || next.status !== 'active') && data.users.filter(item => item.role === 'admin' && item.status === 'active').length <= 1) throw lastAdmin();
      if (next.role !== user.role || next.status !== user.status) {
        data.sessions = data.sessions.filter(session => session.userId !== userId);
        this.clearResets(data, userId);
      }
      Object.assign(user, patch, { updatedAt: new Date().toISOString() }); return publicUser(user);
    });
  }
  private clearResets(data: AuthData, userId: string) {
    data.passwordResets = (data.passwordResets ?? []).filter(reset => reset.userId !== userId);
    data.resetRequests = (data.resetRequests ?? []).filter(request => request.userId !== userId);
  }
  async requestPasswordReset(email: string, now: string) {
    await this.mutate(data => {
      const user = data.users.find(item => item.email === email && item.status !== 'disabled');
      if (!user) return;
      data.resetRequests ??= [];
      if (!data.resetRequests.some(request => request.userId === user.id))
        data.resetRequests.push({ userId: user.id, requestedAt: now });
    });
  }
  async listPasswordResetRequests() { return (await this.read()).resetRequests ?? []; }
  async createAdminPasswordReset(actor: AdminCredential, userId: string, reset: PasswordReset) {
    return this.mutate(data => {
      const current = data.users.find(user => user.id === actor.id);
      if (current?.role !== 'admin' || current.status !== 'active') throw forbidden();
      if (current.passwordHash !== actor.passwordHash || current.email !== actor.email ||
          !data.sessions.some(session => session.userId === actor.id && session.tokenHash === actor.tokenHash && session.expiresAt > reset.createdAt)) throw adminChanged();
      const user = data.users.find(item => item.id === userId);
      if (!user) throw noUser();
      if (user.status === 'disabled') throw disabledReset();
      this.clearResets(data, userId);
      data.passwordResets!.push({ ...reset, userId });
      return publicUser(user);
    });
  }
  async consumePasswordReset(tokenHash: string, passwordHash: string, now: string) {
    await this.mutate(data => {
      const reset = data.passwordResets?.find(item => item.tokenHash === tokenHash && item.expiresAt > now);
      const user = reset && data.users.find(item => item.id === reset.userId && item.status !== 'disabled');
      if (!user) throw invalidReset();
      user.passwordHash = passwordHash; user.updatedAt = now;
      data.sessions = data.sessions.filter(session => session.userId !== user.id);
      this.clearResets(data, user.id);
    });
  }
  async deletePasswordReset(tokenHash: string) {
    await this.mutate(data => { data.passwordResets = (data.passwordResets ?? []).filter(reset => reset.tokenHash !== tokenHash); });
  }
}

const userSelect = `id,email,name,identity_cipher AS "identityCipher",role,status,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"`;
const authSelect = `${userSelect},password_hash AS "passwordHash"`;
export class PostgresAuthStore implements AuthStore {
  constructor(private pool: pg.Pool, private vault: LegacyVault) {}
  static async connect() {
    const pool = new pg.Pool(await databaseConfig());
    pool.on('error', () => { /* Deliberately omit connection details. Requests fail closed. */ });
    try {
      const store = new PostgresAuthStore(pool, await openLegacyVault());
      await store.health();
      return store;
    } catch (error) { await pool.end(); throw error; }
  }
  async health() {
    const result = await this.pool.query("SELECT to_regclass('yeta_crm.auth_users') IS NOT NULL AND to_regclass('yeta_crm.auth_sessions') IS NOT NULL AS ready");
    if (!result.rows[0]?.ready) throw new ApiError(503, 'AUTH_SCHEMA_MISSING', '계정 저장소가 준비되지 않았습니다. 인증 스키마 적용 상태를 확인해 주세요.');
    const resets = await this.pool.query("SELECT to_regclass('yeta_crm.auth_password_resets') IS NOT NULL AND to_regclass('yeta_crm.auth_password_reset_requests') IS NOT NULL AS ready");
    if (!resets.rows[0]?.ready) throw new ApiError(503, 'PASSWORD_RESET_SCHEMA_MISSING', '비밀번호 재설정 스키마 적용이 필요합니다.');
    const encrypted = await this.pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='yeta_crm' AND table_name='auth_users' AND column_name='identity_cipher') AS ready");
    if (!encrypted.rows[0]?.ready) throw new ApiError(503, 'AUTH_ENCRYPTION_REQUIRED', '계정 정보 암호화 전환이 필요합니다.');
    const legacy = await this.pool.query("SELECT EXISTS (SELECT 1 FROM yeta_crm.auth_users WHERE identity_cipher IS NULL OR name <> '[보호됨]' OR email !~ '^lookup:[a-f0-9]{64}$') AS present");
    if (legacy.rows[0]?.present) throw new ApiError(503, 'AUTH_ENCRYPTION_REQUIRED', '계정 정보 암호화 전환이 필요합니다.');
    const users = await this.pool.query<User & StoredAuthIdentity>(`SELECT ${userSelect} FROM yeta_crm.auth_users`);
    for (const user of users.rows) decodeAuthIdentity(this.vault, user);
  }
  async hasUsers() { return (await this.pool.query('SELECT EXISTS (SELECT 1 FROM yeta_crm.auth_users) AS present')).rows[0].present as boolean; }
  private async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>, accessLock = false): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (accessLock) await client.query('SELECT pg_advisory_xact_lock(761904261)');
      const value = await operation(client); await client.query('COMMIT'); return value;
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') throw duplicateEmail();
      throw error;
    } finally { client.release(); }
  }
  async register(input: Registration) {
    return this.transaction(async client => {
      const first = !(await client.query('SELECT EXISTS (SELECT 1 FROM yeta_crm.auth_users) AS present')).rows[0].present;
      const id = randomUUID(); const stored = encodeAuthIdentity(this.vault, id, input);
      const row = (await client.query<AuthUser & StoredAuthIdentity>(`INSERT INTO yeta_crm.auth_users (id,email,name,password_hash,role,status,identity_cipher) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING ${authSelect}`,
        [id, stored.email, stored.name, input.passwordHash, first ? 'admin' : 'viewer', first ? 'active' : 'pending', JSON.stringify(stored.identityCipher)])).rows[0];
      return decodeAuthIdentity(this.vault, row);
    }, true);
  }
  async findUserByEmail(email: string) {
    const row = (await this.pool.query<AuthUser & StoredAuthIdentity>(`SELECT ${authSelect} FROM yeta_crm.auth_users WHERE email=$1`, [authEmailLookup(this.vault, email)])).rows[0];
    return row ? decodeAuthIdentity(this.vault, row) : undefined;
  }
  async createSession(userId: string, tokenHash: string, expiresAt: string, now: string, expected: { passwordHash: string; email: string }) {
    await this.transaction(async client => {
      const row = (await client.query<AuthUser & StoredAuthIdentity>(`SELECT ${authSelect} FROM yeta_crm.auth_users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
      const user = row ? decodeAuthIdentity(this.vault, row) : undefined;
      if (!user || user.status === 'disabled' || user.passwordHash !== expected.passwordHash || user.email !== expected.email) throw accountChanged();
      await client.query('DELETE FROM yeta_crm.auth_sessions WHERE expires_at <= $1::timestamptz', [now]);
      const result = await client.query(`INSERT INTO yeta_crm.auth_sessions (token_hash,user_id,expires_at,created_at) SELECT $1,id,$3::timestamptz,$4::timestamptz FROM yeta_crm.auth_users WHERE id=$2 AND status<>'disabled' RETURNING token_hash`, [tokenHash, userId, expiresAt, now]);
      if (!result.rowCount) throw accountChanged();
    });
  }
  async getSession(tokenHash: string, now: string) {
    const row = (await this.pool.query<AuthUser & StoredAuthIdentity>(`SELECT ${authSelect} FROM yeta_crm.auth_users WHERE id=(SELECT user_id FROM yeta_crm.auth_sessions WHERE token_hash=$1 AND expires_at>$2::timestamptz) AND status<>'disabled'`, [tokenHash, now])).rows[0];
    return row ? decodeAuthIdentity(this.vault, row) : undefined;
  }
  async deleteSession(tokenHash: string) { await this.pool.query('DELETE FROM yeta_crm.auth_sessions WHERE token_hash=$1', [tokenHash]); }
  async revokeUserSessions(userId: string) { await this.pool.query('DELETE FROM yeta_crm.auth_sessions WHERE user_id=$1', [userId]); }
  async updateProfile(userId: string, patch: ProfilePatch, expectedPasswordHash?: string, expectedEmail?: string) {
    return this.transaction(async client => {
      const row = (await client.query<AuthUser & StoredAuthIdentity>(`SELECT ${authSelect} FROM yeta_crm.auth_users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
      const current = row ? decodeAuthIdentity(this.vault, row) : undefined;
      if (!current) throw noUser();
      if (expectedPasswordHash && current.passwordHash !== expectedPasswordHash) throw accountChanged();
      if (expectedEmail !== undefined && current.email !== expectedEmail) throw accountChanged();
      if (patch.email && patch.email !== current.email) {
        await client.query('DELETE FROM yeta_crm.auth_sessions WHERE user_id=$1', [userId]);
        await this.clearResets(client, userId);
      }
      const stored = encodeAuthIdentity(this.vault, userId, { name: patch.name ?? current.name, email: patch.email ?? current.email });
      const updated = (await client.query<AuthUser & StoredAuthIdentity>(`UPDATE yeta_crm.auth_users SET name=$2,email=$3,identity_cipher=$4::jsonb,updated_at=now() WHERE id=$1 RETURNING ${authSelect}`, [userId, stored.name, stored.email, JSON.stringify(stored.identityCipher)])).rows[0];
      return decodeAuthIdentity(this.vault, updated);
    });
  }
  async updatePassword(userId: string, expectedPasswordHash: string, passwordHash: string) {
    await this.transaction(async client => {
      const updated = await client.query('UPDATE yeta_crm.auth_users SET password_hash=$3,updated_at=now() WHERE id=$1 AND password_hash=$2 RETURNING id', [userId, expectedPasswordHash, passwordHash]);
      if (!updated.rowCount) throw accountChanged();
      await client.query('DELETE FROM yeta_crm.auth_sessions WHERE user_id=$1', [userId]);
      await this.clearResets(client, userId);
    });
  }
  async listUsers() { return (await this.pool.query<User & StoredAuthIdentity>(`SELECT ${userSelect} FROM yeta_crm.auth_users ORDER BY created_at,id`)).rows.map(row => decodeAuthIdentity(this.vault, row)); }
  async updateAccess(actorId: string, userId: string, patch: AccessPatch) {
    return this.transaction(async client => {
      const actor = (await client.query<Pick<User, 'role' | 'status'>>('SELECT role,status FROM yeta_crm.auth_users WHERE id=$1', [actorId])).rows[0];
      if (actor?.role !== 'admin' || actor.status !== 'active') throw forbidden();
      const row = (await client.query<AuthUser & StoredAuthIdentity>(`SELECT ${authSelect} FROM yeta_crm.auth_users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
      const current = row ? decodeAuthIdentity(this.vault, row) : undefined;
      if (!current) throw noUser();
      const next = { ...current, ...patch };
      if (current.role === 'admin' && current.status === 'active' && (next.role !== 'admin' || next.status !== 'active')) {
        const admins = (await client.query("SELECT count(*)::integer AS total FROM yeta_crm.auth_users WHERE role='admin' AND status='active'")).rows[0].total as number;
        if (admins <= 1) throw lastAdmin();
      }
      if (next.role !== current.role || next.status !== current.status) {
        await client.query('DELETE FROM yeta_crm.auth_sessions WHERE user_id=$1', [userId]);
        await this.clearResets(client, userId);
      }
      const updated = (await client.query<User & StoredAuthIdentity>(`UPDATE yeta_crm.auth_users SET role=$2,status=$3,updated_at=now() WHERE id=$1 RETURNING ${userSelect}`, [userId, next.role, next.status])).rows[0];
      return decodeAuthIdentity(this.vault, updated);
    }, true);
  }
  private async clearResets(client: pg.PoolClient, userId: string) {
    await client.query('DELETE FROM yeta_crm.auth_password_resets WHERE user_id=$1', [userId]);
    await client.query('DELETE FROM yeta_crm.auth_password_reset_requests WHERE user_id=$1', [userId]);
  }
  async requestPasswordReset(email: string, now: string) {
    await this.transaction(async client => {
      // The same statement/round trips run for existing and unknown addresses.
      await client.query(`WITH eligible AS (
        SELECT id FROM yeta_crm.auth_users WHERE email=$1 AND status<>'disabled' FOR UPDATE
      ) INSERT INTO yeta_crm.auth_password_reset_requests (user_id,requested_at)
        SELECT id,$2::timestamptz FROM eligible ON CONFLICT (user_id) DO NOTHING`,
        [authEmailLookup(this.vault, email), now]);
    });
  }
  async listPasswordResetRequests() {
    return (await this.pool.query<PasswordResetRequest>(`SELECT user_id AS "userId",to_char(requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "requestedAt" FROM yeta_crm.auth_password_reset_requests ORDER BY requested_at,user_id`)).rows;
  }
  async createAdminPasswordReset(actor: AdminCredential, userId: string, reset: PasswordReset) {
    return this.transaction(async client => {
      // Lock both accounts in a stable order; recheck the administrator inside the write transaction.
      const rows = (await client.query<AuthUser & StoredAuthIdentity>(
        `SELECT ${authSelect} FROM yeta_crm.auth_users WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`, [[actor.id, userId]],
      )).rows.map(row => decodeAuthIdentity(this.vault, row));
      const current = rows.find(user => user.id === actor.id);
      if (current?.role !== 'admin' || current.status !== 'active') throw forbidden();
      if (current.passwordHash !== actor.passwordHash || current.email !== actor.email) throw adminChanged();
      const session = await client.query('SELECT token_hash FROM yeta_crm.auth_sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>$3::timestamptz', [actor.id, actor.tokenHash, reset.createdAt]);
      if (!session.rows.length) throw adminChanged();
      const user = rows.find(item => item.id === userId);
      if (!user) throw noUser();
      if (user.status === 'disabled') throw disabledReset();
      await this.clearResets(client, userId);
      await client.query('INSERT INTO yeta_crm.auth_password_resets (user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3::timestamptz,$4::timestamptz)', [userId, reset.tokenHash, reset.createdAt, reset.expiresAt]);
      return publicUser(user);
    }, true);
  }
  async consumePasswordReset(tokenHash: string, passwordHash: string, now: string) {
    await this.transaction(async client => {
      const candidate = (await client.query<{ userId: string }>('SELECT user_id AS "userId" FROM yeta_crm.auth_password_resets WHERE token_hash=$1', [tokenHash])).rows[0];
      if (!candidate) throw invalidReset();
      // Always lock the user before the token, matching issuance and account mutations.
      const user = (await client.query<{ status: UserStatus }>('SELECT status FROM yeta_crm.auth_users WHERE id=$1 FOR UPDATE', [candidate.userId])).rows[0];
      if (!user || user.status === 'disabled') throw invalidReset();
      const reset = await client.query('SELECT token_hash FROM yeta_crm.auth_password_resets WHERE user_id=$1 AND token_hash=$2 AND expires_at>$3::timestamptz FOR UPDATE', [candidate.userId, tokenHash, now]);
      if (!reset.rows.length) throw invalidReset();
      await client.query('UPDATE yeta_crm.auth_users SET password_hash=$2,updated_at=$3::timestamptz WHERE id=$1', [candidate.userId, passwordHash, now]);
      await client.query('DELETE FROM yeta_crm.auth_sessions WHERE user_id=$1', [candidate.userId]);
      await this.clearResets(client, candidate.userId);
    });
  }
  async deletePasswordReset(tokenHash: string) { await this.pool.query('DELETE FROM yeta_crm.auth_password_resets WHERE token_hash=$1', [tokenHash]); }
  async close() { await this.pool.end(); }
}
