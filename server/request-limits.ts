import { createServer, type RequestListener } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Request, RequestHandler, Response } from 'express';

export const DEFAULT_REQUEST_LIMITS = Object.freeze({
  windowMs: 60_000,
  requestsPerWindow: 600,
  expensiveRequestsPerWindow: 60,
  maxConcurrentPerIp: 32,
  maxExpensiveConcurrentPerIp: 4,
  maxConcurrentTotal: 96,
  maxExpensiveConcurrentTotal: 8,
  maxTrackedIps: 1024,
});
export type RequestLimitOptions = { [Key in keyof typeof DEFAULT_REQUEST_LIMITS]?: number } & {
  now?: () => number;
};
type Bucket = {
  start: number;
  requests: number;
  expensiveRequests: number;
  active: number;
  expensiveActive: number;
};
type WorkLease = { pending: number; terminal: boolean; releaseIfDone: () => void };
const workLeases = new WeakMap<Request, WorkLease>();

/**
 * Keep the admitted request's capacity until both its response is terminal and
 * every wrapped handler Promise settles. Disconnecting cannot free still-running
 * DB/decryption/backup work. Nested middleware/handlers share the same lease.
 */
export function trackRequestWork(handler: RequestHandler): RequestHandler {
  return async (request, response, next) => {
    const lease = workLeases.get(request);
    if (lease?.terminal || request.aborted || response.destroyed || response.writableEnded) return;
    if (lease) lease.pending += 1;
    try {
      return await handler(request, response, next);
    } finally {
      if (lease) {
        lease.pending -= 1;
        lease.releaseIfDone();
      }
    }
  };
}

/** Classify before body parsing. Never use the query string or a client-supplied cost header. */
export function isExpensiveApiPath(url: string): boolean {
  let pathname = url.split('?', 1)[0];
  // Node also accepts absolute-form targets. Express routes their pathname, so
  // an absolute URL must consume the same expensive quota as the origin form.
  try {
    pathname = new URL(url, 'http://localhost').pathname;
  } catch {
    /* Keep malformed targets bounded by the ordinary quota. */
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* Invalid paths still consume the ordinary quota. */
  }
  return /^\/(?:api\/)?(?:backups(?:\/|$)|records\/installations\/[^/]+\/(?:details|attachments|configuration)(?:\/|$)|support\/[^/]+\/attachments(?:\/|$))/i.test(
    pathname,
  );
}

function deny(response: Response, busy: boolean, retryAfter: number) {
  response.set({
    'Retry-After': String(Math.max(1, Math.ceil(retryAfter))),
    'Cache-Control': 'no-store',
    // A rejected upload must not keep a connection open while its body is unread.
    Connection: 'close',
  });
  response.status(busy ? 503 : 429).json({
    error: {
      code: busy ? 'API_BUSY' : 'API_RATE_LIMITED',
      message: busy
        ? '서버가 다른 요청을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.'
        : '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    },
  });
}

/**
 * Mount on /api after security headers, before JSON parsing, auth or data I/O.
 * Limits belong to this process. Vite/proxies share their socket address; forwarded
 * headers must not create new identities. No waiting queue or background timer.
 */
export function createRequestLimits(options: RequestLimitOptions = {}): RequestHandler {
  const { now = () => performance.now(), ...configured } = options;
  const limits = { ...DEFAULT_REQUEST_LIMITS, ...configured };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1))
    throw new Error('INVALID_REQUEST_LIMITS');
  const buckets = new Map<string, Bucket>();
  let active = 0,
    expensiveActive = 0,
    nextSweep = 0;
  const sweep = (time: number) => {
    for (const [address, bucket] of buckets) {
      // An active request holds this exact counter even across window boundaries.
      // Never evict it to make room for a different identity.
      if (bucket.active === 0 && time - bucket.start >= limits.windowMs) buckets.delete(address);
    }
    nextSweep = time + limits.windowMs;
  };
  return (request, response, next) => {
    const time = now();
    if (!Number.isFinite(time)) {
      deny(response, true, 1);
      return;
    }
    // remoteAddress is supplied by the socket, unlike req.ip or X-Forwarded-For.
    const remote = request.socket.remoteAddress?.toLowerCase();
    const address = remote?.startsWith('::ffff:') ? remote.slice(7) : remote || 'unknown-socket';
    if (time >= nextSweep) sweep(time);
    let bucket = buckets.get(address);
    if (!bucket) {
      if (buckets.size >= limits.maxTrackedIps) sweep(time);
      if (buckets.size >= limits.maxTrackedIps) {
        deny(response, true, limits.windowMs / 1000);
        return;
      }
      bucket = { start: time, requests: 0, expensiveRequests: 0, active: 0, expensiveActive: 0 };
      buckets.set(address, bucket);
    } else if (time - bucket.start >= limits.windowMs) {
      bucket.start = time;
      bucket.requests = 0;
      bucket.expensiveRequests = 0;
    }
    const expensive = isExpensiveApiPath(request.originalUrl || request.url);
    const retryAfter = (bucket.start + limits.windowMs - time) / 1000;
    if (bucket.requests >= limits.requestsPerWindow) {
      deny(response, false, retryAfter);
      return;
    }
    bucket.requests += 1;
    if (expensive) {
      if (bucket.expensiveRequests >= limits.expensiveRequestsPerWindow) {
        deny(response, false, retryAfter);
        return;
      }
      bucket.expensiveRequests += 1;
    }
    if (
      bucket.active >= limits.maxConcurrentPerIp ||
      (expensive && bucket.expensiveActive >= limits.maxExpensiveConcurrentPerIp)
    ) {
      deny(response, false, 1);
      return;
    }
    if (
      active >= limits.maxConcurrentTotal ||
      (expensive && expensiveActive >= limits.maxExpensiveConcurrentTotal)
    ) {
      deny(response, true, 1);
      return;
    }
    bucket.active += 1;
    active += 1;
    if (expensive) {
      bucket.expensiveActive += 1;
      expensiveActive += 1;
    }
    let released = false;
    const lease: WorkLease = {
      pending: 0,
      terminal: false,
      releaseIfDone() {
        if (released || !lease.terminal || lease.pending !== 0) return;
        released = true;
        bucket.active -= 1;
        active -= 1;
        if (expensive) {
          bucket.expensiveActive -= 1;
          expensiveActive -= 1;
        }
      },
    };
    workLeases.set(request, lease);
    const terminate = () => {
      lease.terminal = true;
      response.removeListener('finish', terminate);
      response.removeListener('close', terminate);
      request.removeListener('aborted', terminate);
      lease.releaseIfDone();
    };
    response.once('finish', terminate);
    response.once('close', terminate);
    request.once('aborted', terminate);
    // IncomingMessage 'close' also fires after a successfully received body, so
    // it must not release a slot while a long backup is still being processed.
    if (request.aborted || response.destroyed) {
      terminate();
      return;
    }
    try {
      next();
    } catch (error) {
      terminate();
      throw error;
    }
  };
}

export const DEFAULT_HTTP_INGRESS_LIMITS = Object.freeze({
  headersTimeout: 15_000,
  requestTimeout: 120_000,
  keepAliveTimeout: 5_000,
  connectionsCheckingInterval: 1000,
  maxHeaderSize: 16 * 1024,
  maxHeadersCount: 64,
  maxRequestsPerSocket: 200,
  maxConnections: 128,
});

/** Receive timeouts protect incomplete requests; completed long backups have no processing deadline. */
export function createApiHttpServer(
  listener: RequestListener,
  options: { [Key in keyof typeof DEFAULT_HTTP_INGRESS_LIMITS]?: number } = {},
) {
  const limits = { ...DEFAULT_HTTP_INGRESS_LIMITS, ...options };
  if (
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1) ||
    limits.headersTimeout > limits.requestTimeout
  )
    throw new Error('INVALID_HTTP_INGRESS_LIMITS');
  const server = createServer(
    {
      headersTimeout: limits.headersTimeout,
      requestTimeout: limits.requestTimeout,
      keepAliveTimeout: limits.keepAliveTimeout,
      connectionsCheckingInterval: limits.connectionsCheckingInterval,
      maxHeaderSize: limits.maxHeaderSize,
      insecureHTTPParser: false,
      requireHostHeader: true,
    },
    listener,
  );
  server.maxHeadersCount = limits.maxHeadersCount;
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket;
  server.maxConnections = limits.maxConnections;
  // Socket inactivity is not a safe deadline for valid CPU/DB/backup work.
  server.timeout = 0;
  return server;
}
