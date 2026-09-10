import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.ts';

const N = 2 ** 17;
const r = 8;
const p = 1;
const keyLength = 64;
const maxmem = 256 * 1024 * 1024;
const busy = () =>
  Object.assign(new ApiError(503, 'AUTH_BUSY', '인증 요청이 많습니다. 잠시 후 다시 시도해 주세요.'), {
    retryAfterSeconds: 5,
  });

type WaitingPasswordWork = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Bound both expensive scrypt work and requests retaining a password while waiting. */
export class PasswordWorkQueue {
  private running = 0;
  private waiting: WaitingPasswordWork[] = [];
  constructor(
    private concurrency = 2,
    private maxWaiting = 32,
    private waitTimeoutMs = 15_000,
  ) {
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      !Number.isSafeInteger(maxWaiting) ||
      maxWaiting < 0 ||
      !Number.isSafeInteger(waitTimeoutMs) ||
      waitTimeoutMs < 1
    )
      throw new Error('INVALID_PASSWORD_WORK_QUEUE');
  }
  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(busy());
    return new Promise<void>((resolve, reject) => {
      const pending: WaitingPasswordWork = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(pending);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          pending.reject(busy());
        }, this.waitTimeoutMs),
      };
      this.waiting.push(pending);
    });
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      // Transfer the occupied slot before another caller can enter the queue.
      next.resolve();
    } else this.running -= 1;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }
}

const passwordWork = new PasswordWorkQueue();
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  return passwordWork.run(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        scrypt(password, salt, keyLength, { N, r, p, maxmem }, (error, key) =>
          error ? reject(error) : resolve(key),
        ),
      ),
  );
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export const dummyPasswordHash = `scrypt$${N}$${r}$${p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(keyLength).toString('base64')}`;
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const pieces = encoded.split('$');
  if (
    pieces.length !== 6 ||
    pieces[0] !== 'scrypt' ||
    Number(pieces[1]) !== N ||
    Number(pieces[2]) !== r ||
    Number(pieces[3]) !== p
  )
    return false;
  const salt = Buffer.from(pieces[4], 'base64');
  const expected = Buffer.from(pieces[5], 'base64');
  if (salt.length !== 16 || expected.length !== keyLength) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected);
}
export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}
export function sessionHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
