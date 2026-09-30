import { isIP } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { productionSettings } from './runtime-config.ts';

// Only this middleware can assign an address from the configured local Apache proxy.
const verifiedAddresses = new WeakMap<Request, string>();
const normalize = (value: string) => value.toLowerCase().replace(/^::ffff:/, '');
export function requestClientAddress(request: Request): string {
  return verifiedAddresses.get(request) || normalize(request.socket.remoteAddress || 'unknown-socket');
}

export function productionProxyGuard(settings: NonNullable<ReturnType<typeof productionSettings>>): RequestHandler {
  return (request, response, next) => {
    const client = request.get('x-forwarded-for') || '';
    const origin = request.get('origin');
    if (normalize(request.socket.remoteAddress || '') !== '127.0.0.1' ||
        request.headers.host !== settings.authority || request.get('x-forwarded-proto') !== 'https' ||
        !isIP(client) || request.get('forwarded') || request.get('x-forwarded-host') ||
        (origin !== undefined && origin !== settings.origin)) {
      response.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: '허용되지 않은 접속 주소입니다.' } });
      return;
    }
    verifiedAddresses.set(request, normalize(client));
    next();
  };
}
