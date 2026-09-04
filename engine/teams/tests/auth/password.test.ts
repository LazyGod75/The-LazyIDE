/**
 * Tests for scrypt password hashing and verification.
 */

import { describe, expect, it } from 'vitest';
import { hashPassword, validatePasswordPolicy, verifyPassword } from '../../src/auth/password.js';

describe('validatePasswordPolicy', () => {
  it('accepts passwords of exactly 10 chars', () => {
    const result = validatePasswordPolicy('abcde12345');
    expect(result.ok).toBe(true);
  });

  it('accepts passwords longer than 10 chars', () => {
    const result = validatePasswordPolicy('a very long passphrase that is definitely valid');
    expect(result.ok).toBe(true);
  });

  it('rejects passwords shorter than 10 chars', () => {
    const result = validatePasswordPolicy('short');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/10/);
    }
  });

  it('rejects empty password', () => {
    const result = validatePasswordPolicy('');
    expect(result.ok).toBe(false);
  });
});

describe('hashPassword + verifyPassword', () => {
  it('verifies a freshly hashed password', async () => {
    const hash = await hashPassword('correctHorse99!');
    const result = await verifyPassword('correctHorse99!', hash);
    expect(result.ok).toBe(true);
  }, 10000);

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correctHorse99!');
    const result = await verifyPassword('wrongPassword!', hash);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/invalid password/i);
    }
  }, 10000);

  it('produces different hashes for the same password (salt randomness)', async () => {
    const h1 = await hashPassword('samePassword!123');
    const h2 = await hashPassword('samePassword!123');
    expect(h1).not.toBe(h2);
  }, 15000);

  it('stored hash format is scrypt:N:r:p:salt:hash', async () => {
    const hash = await hashPassword('validPassword1!');
    const parts = hash.split(':');
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe('16384');
    expect(parts[2]).toBe('8');
    expect(parts[3]).toBe('1');
    expect(parts).toHaveLength(6);
  }, 10000);

  it('rejects malformed hash string', async () => {
    const result = await verifyPassword('password', 'notahash');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/malformed/i);
    }
  });

  it('rejects hash with wrong prefix', async () => {
    const result = await verifyPassword('password', 'bcrypt:16384:8:1:salt:hash');
    expect(result.ok).toBe(false);
  });

  it('rejects hash with non-integer N', async () => {
    const result = await verifyPassword('password', 'scrypt:abc:8:1:c2FsdA==:aGFzaA==');
    expect(result.ok).toBe(false);
  });
});
