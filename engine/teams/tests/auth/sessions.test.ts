/**
 * Tests for session lifecycle:
 * - createSession returns raw token + stored session
 * - hash-at-rest (raw token never in store)
 * - validateSessionToken success / expiry
 * - revokeSessionByToken
 * - purgeExpiredSessions with fake clock
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDataDir: string;

beforeEach(() => {
  vi.resetModules();
  testDataDir = join(tmpdir(), `lbt-sessions-${process.pid}-${Date.now()}`);
  mkdirSync(join(testDataDir, 'db'), { recursive: true });
  process.env.LBT_DATA_DIR = testDataDir;
});

afterEach(() => {
  rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.LBT_DATA_DIR;
});

describe('sessions', () => {
  it('createSession returns a raw token and stores only its hash', async () => {
    const { createSession, hashToken } = await import('../../src/auth/sessions.js');
    const { asUserId } = await import('../../src/domain/types.js');
    const { listSessions } = await import('../../src/store/sessions-store.js');

    const { rawToken, session } = createSession(asUserId('u1'));

    expect(typeof rawToken).toBe('string');
    expect(rawToken.length).toBeGreaterThan(10);

    const stored = listSessions();
    expect(stored).toHaveLength(1);

    // Raw token must NOT appear in the store
    expect(stored[0]!.tokenHash).not.toBe(rawToken);
    // But hash of raw token must match stored hash
    expect(stored[0]!.tokenHash).toBe(hashToken(rawToken));
    expect(session.tokenHash).toBe(hashToken(rawToken));
  });

  it('validateSessionToken succeeds for a valid session', async () => {
    const { createSession, validateSessionToken } = await import('../../src/auth/sessions.js');
    const { asUserId } = await import('../../src/domain/types.js');

    const now = new Date('2024-06-01T10:00:00Z');
    const { rawToken } = createSession(asUserId('u1'), now);

    const result = validateSessionToken(rawToken, now);
    expect(result.ok).toBe(true);
  });

  it('validateSessionToken fails for an expired session', async () => {
    const { createSession, validateSessionToken } = await import('../../src/auth/sessions.js');
    const { asUserId } = await import('../../src/domain/types.js');

    const createdAt = new Date('2024-06-01T00:00:00Z');
    const { rawToken } = createSession(asUserId('u1'), createdAt);

    // Advance time past the 7-day expiry
    const future = new Date('2024-06-09T00:00:01Z');
    const result = validateSessionToken(rawToken, future);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/expired/i);
    }
  });

  it('validateSessionToken fails for an unknown token', async () => {
    const { validateSessionToken } = await import('../../src/auth/sessions.js');
    const result = validateSessionToken('completely-unknown-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it('revokeSessionByToken removes the session', async () => {
    const { createSession, revokeSessionByToken, validateSessionToken } = await import(
      '../../src/auth/sessions.js'
    );
    const { asUserId } = await import('../../src/domain/types.js');

    const now = new Date('2024-06-01T10:00:00Z');
    const { rawToken } = createSession(asUserId('u1'), now);

    const revoked = revokeSessionByToken(rawToken);
    expect(revoked).toBe(true);

    const result = validateSessionToken(rawToken, now);
    expect(result.ok).toBe(false);
  });

  it('purgeExpiredSessions removes expired but keeps active', async () => {
    const { createSession, purgeExpiredSessions } = await import('../../src/auth/sessions.js');
    const { listSessions } = await import('../../src/store/sessions-store.js');
    const { asUserId } = await import('../../src/domain/types.js');

    const old = new Date('2024-01-01T00:00:00Z');
    const recent = new Date('2026-01-01T00:00:00Z');

    createSession(asUserId('u1'), old); // expires 2024-01-08
    createSession(asUserId('u2'), recent); // expires 2026-01-08

    const swept = purgeExpiredSessions(new Date('2025-01-01T00:00:00Z'));
    expect(swept).toBe(1);
    expect(listSessions()).toHaveLength(1);
  });

  it('each session has a unique CSRF token', async () => {
    const { createSession } = await import('../../src/auth/sessions.js');
    const { asUserId } = await import('../../src/domain/types.js');

    const uid = asUserId('u1');
    const s1 = createSession(uid);
    const s2 = createSession(uid);

    expect(s1.session.csrfToken).not.toBe(s2.session.csrfToken);
  });
});
