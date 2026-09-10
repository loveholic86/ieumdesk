import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { Plugin } from 'vite';

// Vite serves the HTML, so API-only Helmet headers cannot protect the application page.
export const uiSecurityHeaders = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Expires: '0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), clipboard-read=()',
};

export function uiContentSecurityPolicy(nonce?: string, websocketOrigin?: string) {
  return [
    "default-src 'self'",
    `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ''}`,
    "script-src-attr 'none'",
    // React and Radix use style attributes; executable inline scripts remain forbidden.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${websocketOrigin ? ` ${websocketOrigin}` : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

export function uiSecurityPlugin(): Plugin {
  const requestNonce = new AsyncLocalStorage<string>();
  return {
    name: 'ieumdesk-ui-security',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const nonce = randomBytes(24).toString('base64');
        let websocketOrigin: string | undefined;
        try {
          const url = new URL(`http://${request.headers.host || ''}`);
          if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
            url.protocol = 'ws:';
            websocketOrigin = url.origin;
          }
        } catch {
          // Vite's own host guard will reject malformed or untrusted hostnames.
        }
        response.setHeader('Content-Security-Policy', uiContentSecurityPolicy(nonce, websocketOrigin));
        requestNonce.run(nonce, next);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_request, response, next) => {
        response.setHeader('Content-Security-Policy', uiContentSecurityPolicy());
        next();
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const nonce = requestNonce.getStore();
        if (!nonce) return html;
        // This hook sees only trusted application HTML and Vite's React refresh preamble.
        return html.replace(/<script\b([^>]*)>/gi, (_tag, attributes: string) =>
          /\bnonce\s*=/i.test(attributes) ? _tag : `<script nonce="${nonce}"${attributes}>`,
        );
      },
    },
  };
}
