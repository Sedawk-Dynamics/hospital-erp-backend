import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Encryption at rest for the hospital's GST portal logins (gap #266).
//
// AES-256-GCM. The key is GST_PORTAL_CREDENTIALS_KEY — 32 bytes, base64 or
// hex — and lives only in the server's environment, never in the database
// next to the ciphertext. The tenant and portal are bound in as associated
// data, so a ciphertext copied onto another hospital's row does not decrypt.
//
// Outside production a missing key falls back to one derived from the JWT
// access secret, so a developer can exercise the flow; production refuses to
// store anything without an explicit key.
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

export interface CredentialKeyInfo {
  available: boolean;
  /** 'env' | 'development-fallback' | null */
  source: 'env' | 'development-fallback' | null;
  reason: string | null;
}

function decodeKey(raw: string): Buffer | null {
  const t = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return Buffer.from(t, 'hex');
  try {
    const b = Buffer.from(t, 'base64');
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

function resolveKey(env: Env): { key: Buffer | null; info: CredentialKeyInfo } {
  const raw = env.GST_PORTAL_CREDENTIALS_KEY;
  if (raw && raw.trim()) {
    const key = decodeKey(raw);
    if (!key) {
      return {
        key: null,
        info: { available: false, source: null, reason: 'GST_PORTAL_CREDENTIALS_KEY must be 32 bytes, base64 or 64 hex characters' },
      };
    }
    return { key, info: { available: true, source: 'env', reason: null } };
  }
  if (env.NODE_ENV === 'production') {
    return {
      key: null,
      info: { available: false, source: null, reason: 'GST_PORTAL_CREDENTIALS_KEY is not set on the server' },
    };
  }
  const seed = env.JWT_ACCESS_SECRET;
  if (!seed) return { key: null, info: { available: false, source: null, reason: 'GST_PORTAL_CREDENTIALS_KEY is not set on the server' } };
  return {
    key: createHash('sha256').update(`gst-portal-credentials:v1:${seed}`).digest(),
    info: { available: true, source: 'development-fallback', reason: null },
  };
}

export function credentialKeyInfo(env: Env = process.env): CredentialKeyInfo {
  return resolveKey(env).info;
}

export class CredentialCryptoError extends Error {}

export function encryptCredentials(plain: unknown, aad: string, env: Env = process.env): string {
  const { key, info } = resolveKey(env);
  if (!key) throw new CredentialCryptoError(info.reason ?? 'No credential encryption key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Throws CredentialCryptoError when the key is missing or the ciphertext does not match it. */
export function decryptCredentials<T = unknown>(blob: string, aad: string, env: Env = process.env): T {
  const { key, info } = resolveKey(env);
  if (!key) throw new CredentialCryptoError(info.reason ?? 'No credential encryption key');
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new CredentialCryptoError('Stored credentials are in an unknown format');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    const pt = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  } catch {
    // Never echo the blob or the key.
    throw new CredentialCryptoError('Stored credentials cannot be decrypted with the current key — enter them again');
  }
}

/** "hospital01" → "ho******01". Short names show only the first character. */
export function maskUsername(u: string): string {
  const s = u.trim();
  if (s.length <= 4) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(6, s.length - 4))}${s.slice(-2)}`.slice(0, 40);
}
