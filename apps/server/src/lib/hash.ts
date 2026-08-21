import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * Salted scrypt, chosen over argon2 because it ships with Node - no native
 * build step, which keeps the free-tier deploy simple. Format: scrypt$salt$hash
 * (both base64url) so the encoding is self-describing if it ever changes.
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(secret, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [scheme, saltPart, hashPart] = stored.split('$');
  if (scheme !== 'scrypt' || !saltPart || !hashPart) return false;

  const salt = Buffer.from(saltPart, 'base64url');
  const expected = Buffer.from(hashPart, 'base64url');
  const derived = await scrypt(secret, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Session tokens are high-entropy already, so a plain SHA-256 lookup key is
 * enough and - unlike scrypt - can be indexed and matched in one query.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
