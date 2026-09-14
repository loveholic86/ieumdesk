import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

/** Trust this machine's LAN addresses, never an entire private subnet or arbitrary DNS names. */
export function localHostnames(interfaces = networkInterfaces()): Set<string> {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const addresses of Object.values(interfaces)) {
    for (const { address, family, internal } of addresses ?? []) {
      if (internal || family !== 'IPv4' || !isIPv4(address)) continue;
      const [first, second] = address.split('.').map(Number);
      if (
        first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168)
      )
        hosts.add(address);
    }
  }
  return hosts;
}

/** Host is an HTTP authority, never a URL with credentials, path, fragments or escapes. */
export function validLocalAuthority(value: string, hosts = localHostnames()): boolean {
  if (!value || /[\s/@?#\\%]/u.test(value)) return false;
  try {
    const url = new URL(`http://${value}`);
    return hosts.has(url.hostname) && url.pathname === '/' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validDevelopmentOrigin(value: string, hosts = localHostnames()): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      url.protocol === 'http:' &&
      hosts.has(url.hostname) &&
      ['5173', '4173', '3001'].includes(url.port)
    );
  } catch {
    return false;
  }
}
