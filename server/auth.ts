import { trackRequestWork } from './request-limits.ts';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from './errors.ts';
import { type AuthStore, type AuthUser, publicUser } from './auth-store.ts';
import {
  dummyPasswordHash,
  hashPassword,
  newSessionToken,
  sessionHash,
  verifyPassword,
} from './auth-crypto.ts';

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      authTokenHash?: string;
    }
  }
}
export interface AuthOptions {
  now?: () => number;
  sessionTtlMs?: number;
}
const cookieName = 'ieumdesk_session';
// A project rename must not invalidate existing server-side sessions.
const legacyCookieName = 'yeta_crm_session';
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(12).max(128);
const currentPassword = z.string().min(1).max(128);
const name = z.string().trim().min(1).max(100);
const registerSchema = z.object({ email, name, password }).strict();
const loginSchema = z.object({ email, password: currentPassword }).strict();
const profileSchema = z
  .object({ name: name.optional(), email: email.optional(), currentPassword: currentPassword.optional() })
  .strict();
const passwordSchema = z.object({ currentPassword, newPassword: password }).strict();
const adminReauthenticationSchema = z.object({ currentPassword }).strict();
const accessSchema = z
  .object({
    role: z.enum(['admin', 'editor', 'viewer']).optional(),
    status: z.enum(['pending', 'active', 'disabled']).optional(),
  })
  .strict();

const rateLimited = (time: number, until: number) =>
  Object.assign(
    new ApiError(429, 'AUTH_RATE_LIMITED', '시도 횟수가 많습니다. 잠시 후 다시 시도해 주세요.'),
    // Coarse minutes give clients backoff guidance without exposing exact bucket timing.
    { retryAfterSeconds: Math.min(3600, Math.max(60, Math.ceil((until - time) / 60_000) * 60)) },
  );

export class RateLimiter {
  private entries = new Map<string, { count: number; until: number }>();
  constructor(private now: () => number) {}
  private consume(key: string, limit: number, window: number) {
    const time = this.now();
    for (const [entryKey, entry] of this.entries) if (entry.until <= time) this.entries.delete(entryKey);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 2_000)
        throw rateLimited(time, Math.min(...Array.from(this.entries.values(), (item) => item.until)));
      entry = { count: 0, until: time + window };
    }
    if (entry.count >= limit) throw rateLimited(time, entry.until);
    entry.count += 1;
    this.entries.set(key, entry);
  }
  check(kind: 'login' | 'register', request: Request) {
    const identifier =
      typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase().slice(0, 254) : '';
    const address = request.socket.remoteAddress || 'local';
    this.consume(
      `${kind}:ip:${address}`,
      kind === 'login' ? 30 : 10,
      kind === 'login' ? 15 * 60_000 : 60 * 60_000,
    );
    this.consume(`${kind}:email:${identifier}`, 5, 15 * 60_000);
  }
}

export class ReauthenticationLimiter {
  private entries = new Map<string, { failures: number; pending: number; until: number }>();
  constructor(private now: () => number) {}

  reserve(userId: string, address: string): (succeeded: boolean | null) => void {
    const time = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.pending === 0 && entry.until <= time) this.entries.delete(key);
    }
    const limits = [
      { key: `account:${userId}`, maximum: 5 },
      { key: `ip:${address}`, maximum: 20 },
    ];
    const attempts = limits.map(({ key, maximum }) => ({
      key,
      maximum,
      entry: this.entries.get(key) ?? { failures: 0, pending: 0, until: time + 15 * 60_000 },
    }));
    // Reservations count before scrypt starts so concurrent requests cannot bypass
    // the limits. Keep active failure windows instead of evicting them under load.
    const blocked = attempts.filter(({ entry, maximum }) => entry.failures + entry.pending >= maximum);
    if (blocked.length) throw rateLimited(time, Math.max(...blocked.map(({ entry }) => entry.until)));
    if (this.entries.size + attempts.filter(({ key }) => !this.entries.has(key)).length > 2_000)
      throw rateLimited(time, Math.min(...Array.from(this.entries.values(), (entry) => entry.until)));
    for (const { key, entry } of attempts) {
      entry.pending += 1;
      this.entries.set(key, entry);
    }
    let completed = false;
    return (succeeded: boolean | null) => {
      if (completed) return;
      completed = true;
      for (const { key, entry } of attempts) {
        entry.pending -= 1;
        // Resource pressure or another infrastructure failure did not verify a password.
        if (succeeded === false) entry.failures += 1;
        if (entry.pending === 0 && entry.failures === 0) this.entries.delete(key);
      }
    };
  }
}

function tokenFromRequest(request: Request): string | undefined {
  const cookies = (request.headers.cookie || '').split(';').map((value) => value.trim());
  const tokens: string[] = [];
  for (const name of [cookieName, legacyCookieName]) {
    const matching = cookies.filter((value) => value.startsWith(`${name}=`));
    if (matching.length > 1) return undefined;
    if (matching.length) tokens.push(matching[0].slice(name.length + 1));
  }
  // Reject ambiguity between old and new names instead of silently choosing one.
  if (!tokens.length || new Set(tokens).size !== 1) return undefined;
  const token = tokens[0];
  return /^[A-Za-z\d_-]{43}$/.test(token) ? token : undefined;
}
const cookieOptions = (request: Request) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  path: '/',
  secure: request.secure,
});
function clearSessionCookies(request: Request, response: Response) {
  response.clearCookie(cookieName, cookieOptions(request));
  response.clearCookie(legacyCookieName, cookieOptions(request));
}
const unauthenticated = () => new ApiError(401, 'AUTHENTICATION_REQUIRED', '로그인이 필요합니다.');
const invalidCredentials = () =>
  new ApiError(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호를 확인해 주세요.');
const invalidCurrentPassword = () =>
  new ApiError(400, 'INVALID_CURRENT_PASSWORD', '현재 비밀번호를 확인해 주세요.');

export function createAuthentication(authStore: AuthStore, options: AuthOptions = {}) {
  const now = options.now ?? Date.now;
  const ttl = options.sessionTtlMs ?? 12 * 60 * 60_000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 30 * 24 * 60 * 60_000)
    throw new Error('INVALID_SESSION_TTL');
  const limiter = new RateLimiter(now);
  const reauthenticationLimiter = new ReauthenticationLimiter(now);
  const confirmCurrentPassword = async (request: Request, value: string, storedHash: string) => {
    const complete = reauthenticationLimiter.reserve(
      request.authUser!.id,
      request.socket.remoteAddress || 'local',
    );
    let succeeded: boolean | null = null;
    try {
      succeeded = await verifyPassword(value, storedHash);
      if (!succeeded) throw invalidCurrentPassword();
    } finally {
      complete(succeeded);
    }
  };
  const load = async (request: Request) => {
    const token = tokenFromRequest(request);
    if (!token) return undefined;
    const tokenHash = sessionHash(token);
    const user = await authStore.getSession(tokenHash, new Date(now()).toISOString());
    if (user) {
      request.authUser = user;
      request.authTokenHash = tokenHash;
    }
    return user;
  };
  const issueSession = async (request: Request, response: Response, user: AuthUser) => {
    const old = tokenFromRequest(request);
    if (old) await authStore.deleteSession(sessionHash(old));
    const token = newSessionToken();
    await authStore.createSession(
      user.id,
      sessionHash(token),
      new Date(now() + ttl).toISOString(),
      new Date(now()).toISOString(),
      { passwordHash: user.passwordHash, email: user.email },
    );
    response.cookie(cookieName, token, { ...cookieOptions(request), maxAge: ttl });
    response.clearCookie(legacyCookieName, cookieOptions(request));
  };
  const requireSession = async (request: Request, _response: Response, next: NextFunction) => {
    if (!(await load(request))) throw unauthenticated();
    next();
  };
  const requireActive = async (request: Request, _response: Response, next: NextFunction) => {
    const user = request.authUser ?? (await load(request));
    if (!user) throw unauthenticated();
    if (user.status !== 'active')
      throw new ApiError(403, 'ACCOUNT_PENDING', '관리자의 계정 승인이 필요합니다.');
    next();
  };
  const requireEditor = (request: Request, _response: Response, next: NextFunction) => {
    if (!request.authUser) throw unauthenticated();
    if (!['admin', 'editor'].includes(request.authUser.role))
      throw new ApiError(
        403,
        'WRITE_PERMISSION_REQUIRED',
        '등록·수정 권한이 없습니다. 관리자에게 문의해 주세요.',
      );
    next();
  };
  const requireAdmin = (request: Request, _response: Response, next: NextFunction) => {
    if (!request.authUser) throw unauthenticated();
    if (request.authUser.role !== 'admin' || request.authUser.status !== 'active')
      throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
    next();
  };

  const reauthenticateAdmin = async (
    request: Request,
  ): Promise<{ assertStillAuthorized(): Promise<void> }> => {
    const user = request.authUser ?? (await load(request));
    if (!user || !request.authTokenHash) throw unauthenticated();
    if (user.role !== 'admin' || user.status !== 'active')
      throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 권한이 필요합니다.');
    const input = adminReauthenticationSchema.parse(request.body);
    // Copy scalar identity fields before awaiting; a later mutation must never
    // change which credential or session this confirmation authorizes.
    const identity = { id: user.id, passwordHash: user.passwordHash, email: user.email };
    const tokenHash = request.authTokenHash;
    const assertStillAuthorized = async () => {
      const current = await authStore.getSession(tokenHash, new Date(now()).toISOString());
      if (
        !current ||
        current.id !== identity.id ||
        current.role !== 'admin' ||
        current.status !== 'active' ||
        current.passwordHash !== identity.passwordHash ||
        current.email !== identity.email
      ) {
        throw new ApiError(
          401,
          'ADMIN_REAUTHENTICATION_REQUIRED',
          '관리자 인증 정보가 변경되었습니다. 다시 로그인한 뒤 시도해 주세요.',
        );
      }
    };
    await assertStillAuthorized();
    const complete = reauthenticationLimiter.reserve(identity.id, request.socket.remoteAddress || 'local');
    let succeeded: boolean | null = null;
    try {
      succeeded = await verifyPassword(input.currentPassword, identity.passwordHash);
      if (!succeeded) throw invalidCurrentPassword();
      await assertStillAuthorized();
      return { assertStillAuthorized };
    } finally {
      complete(succeeded);
    }
  };

  const router = Router();
  router.get(
    '/session',
    trackRequestWork(async (request, response) => {
      const user = await load(request);
      const setupRequired = !(await authStore.hasUsers());
      if (!user && request.headers.cookie) clearSessionCookies(request, response);
      if (
        user &&
        (request.headers.cookie || '')
          .split(';')
          .some((value) => value.trim().startsWith(`${legacyCookieName}=`))
      ) {
        // Reuse the authenticated token. Its DB expiry is unchanged and no
        // session row is created, refreshed, or revoked by this cookie migration.
        response.cookie(cookieName, tokenFromRequest(request)!, { ...cookieOptions(request), maxAge: ttl });
        response.clearCookie(legacyCookieName, cookieOptions(request));
      }
      response.json({ user: user ? publicUser(user) : null, setupRequired });
    }),
  );
  router.post(
    '/register',
    trackRequestWork(async (request, response) => {
      limiter.check('register', request);
      const input = registerSchema.parse(request.body);
      const user = await authStore.register({
        email: input.email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
      });
      await issueSession(request, response, user);
      response.status(201).json({ user: publicUser(user) });
    }),
  );
  router.post(
    '/login',
    trackRequestWork(async (request, response) => {
      limiter.check('login', request);
      const input = loginSchema.parse(request.body);
      const user = await authStore.findUserByEmail(input.email);
      const valid = await verifyPassword(input.password, user?.passwordHash ?? dummyPasswordHash);
      if (!user || !valid || user.status === 'disabled') throw invalidCredentials();
      await issueSession(request, response, user);
      response.json({ user: publicUser(user) });
    }),
  );
  router.post(
    '/logout',
    trackRequestWork(async (request, response) => {
      const user = await load(request);
      if (user) await authStore.revokeUserSessions(user.id);
      clearSessionCookies(request, response);
      response.json({ ok: true });
    }),
  );
  router.patch(
    '/profile',
    requireSession,
    trackRequestWork(async (request, response) => {
      const input = profileSchema.parse(request.body);
      const user = request.authUser!;
      const changesEmail = input.email !== undefined && input.email !== user.email;
      const patch = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(changesEmail ? { email: input.email } : {}),
      };
      if (!Object.keys(patch).length) throw new ApiError(400, 'EMPTY_PATCH', '변경할 정보를 입력해 주세요.');
      if (changesEmail) {
        if (!input.currentPassword) throw invalidCurrentPassword();
        await confirmCurrentPassword(request, input.currentPassword, user.passwordHash);
      }
      const updated = await authStore.updateProfile(
        user.id,
        patch,
        changesEmail ? user.passwordHash : undefined,
        user.email,
      );
      if (changesEmail) await issueSession(request, response, updated);
      response.json({ user: publicUser(updated) });
    }),
  );
  router.post(
    '/password',
    requireSession,
    trackRequestWork(async (request, response) => {
      const input = passwordSchema.parse(request.body);
      const user = request.authUser!;
      await confirmCurrentPassword(request, input.currentPassword, user.passwordHash);
      await authStore.updatePassword(user.id, user.passwordHash, await hashPassword(input.newPassword));
      clearSessionCookies(request, response);
      response.json({ ok: true });
    }),
  );
  const admin = Router();
  admin.use(requireActive, requireAdmin);
  admin.get(
    '/users',
    trackRequestWork(async (_request, response) => {
      response.json({ items: await authStore.listUsers() });
    }),
  );
  admin.patch(
    '/users/:id',
    trackRequestWork(async (request, response) => {
      const patch = accessSchema.parse(request.body);
      if (!Object.keys(patch).length)
        throw new ApiError(400, 'EMPTY_PATCH', '변경할 권한 또는 상태를 입력해 주세요.');
      response.json({
        user: await authStore.updateAccess(request.authUser!.id, String(request.params.id), patch),
      });
    }),
  );
  return { router, admin, requireActive, requireEditor, requireAdmin, reauthenticateAdmin };
}
