/**
 * Password hashing and verification using Node.js built-in scrypt.
 *
 * Stored format: "scrypt:N:r:p:<saltBase64>:<hashBase64>"
 * Parameters: N=16384, r=8, p=1, keylen=32 bytes.
 * Verification uses timingSafeEqual to prevent timing attacks.
 *
 * Policy: minimum 10 characters (enforced at boundary).
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

import type { Result } from '../domain/types.js';
import { err, ok } from '../domain/types.js';

/** Promisified scrypt with explicit overload to satisfy TypeScript strict mode. */
function scryptAsync(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_BYTES = 32;

const MIN_PASSWORD_LENGTH = 10;

/**
 * Validate a plaintext password against the policy.
 * Call this at the system boundary (registration / password change).
 */
export function validatePasswordPolicy(plaintext: string): Result<true> {
  if (plaintext.length < MIN_PASSWORD_LENGTH) {
    return err(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return ok(true);
}

/**
 * Hash a password and return the stored hash string.
 * Always validate with validatePasswordPolicy before calling.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(plaintext, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

/**
 * Verify a plaintext password against a stored hash string.
 * Returns ok(true) on match, err(...) on mismatch or parse error.
 */
export async function verifyPassword(plaintext: string, stored: string): Promise<Result<true>> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return err('Malformed password hash.');
  }

  const N = Number.parseInt(parts[1]!, 10);
  const r = Number.parseInt(parts[2]!, 10);
  const p = Number.parseInt(parts[3]!, 10);
  const saltB64 = parts[4]!;
  const hashB64 = parts[5]!;

  if (Number.isNaN(N) || Number.isNaN(r) || Number.isNaN(p)) {
    return err('Malformed scrypt parameters.');
  }

  let salt: Buffer;
  let storedHash: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    storedHash = Buffer.from(hashB64, 'base64');
  } catch {
    return err('Malformed base64 in password hash.');
  }

  const keylen = storedHash.length;
  let candidate: Buffer;
  try {
    candidate = await scryptAsync(plaintext, salt, keylen, { N, r, p });
  } catch {
    return err('scrypt computation failed.');
  }

  const match = timingSafeEqual(candidate, storedHash);
  if (!match) {
    return err('Invalid password.');
  }
  return ok(true);
}
