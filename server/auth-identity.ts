import { ApiError } from './errors.ts';
import type { LegacyVault, LegacyVaultContext, LegacyVaultEnvelope } from './legacy-vault.ts';

export interface AuthIdentity {
  email: string;
  name: string;
}
export interface StoredAuthIdentity {
  id: string;
  email: string;
  name: string;
  identityCipher: LegacyVaultEnvelope;
}

const identityContext = (id: string): LegacyVaultContext => ({
  source: 'crm-auth',
  table: 'auth_users',
  primaryKey: id,
  batchId: 'identity-v1',
});
const invalid = () => new ApiError(503, 'AUTH_IDENTITY_UNAVAILABLE', '계정 보호 정보를 확인할 수 없습니다.');

/** Only normalized email reaches this boundary; keep the original login/uniqueness contract. */
export function authEmailLookup(vault: LegacyVault, email: string): string {
  if (typeof email !== 'string' || email !== email.trim().toLowerCase() || !email.length) throw invalid();
  if (!vault.blindIndex) throw invalid();
  return `lookup:${vault.blindIndex('auth-email-v1', email)}`;
}

/** Used by both transactional migration and subsequent account/profile writes. */
export function encodeAuthIdentity(
  vault: LegacyVault,
  id: string,
  identity: AuthIdentity,
): Omit<StoredAuthIdentity, 'id'> {
  if (!id || typeof identity.name !== 'string' || !identity.name.trim()) throw invalid();
  return {
    email: authEmailLookup(vault, identity.email),
    name: '[보호됨]',
    identityCipher: vault.encrypt(
      JSON.stringify({ email: identity.email, name: identity.name }),
      identityContext(id),
    ),
  };
}

/** Reject missing/tampered ciphertext and never fall back to plaintext account columns. */
export function decodeAuthIdentity<T extends StoredAuthIdentity>(
  vault: LegacyVault,
  row: T,
): Omit<T, 'identityCipher'> {
  try {
    if (!row.identityCipher || row.name !== '[보호됨]') throw invalid();
    const identity = JSON.parse(vault.decrypt(row.identityCipher, identityContext(row.id))) as AuthIdentity;
    if (
      !identity ||
      Object.keys(identity).sort().join(',') !== 'email,name' ||
      typeof identity.name !== 'string' ||
      !identity.name.trim()
    )
      throw invalid();
    if (authEmailLookup(vault, identity.email) !== row.email) throw invalid();
    const { identityCipher: _cipher, ...safe } = row;
    return { ...safe, email: identity.email, name: identity.name };
  } catch {
    throw invalid();
  }
}
