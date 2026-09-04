/**
 * Tests for capture token mint / verify / revoke.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDataDir: string;

beforeEach(() => {
  vi.resetModules();
  testDataDir = join(tmpdir(), `lbt-tokens-${process.pid}-${Date.now()}`);
  mkdirSync(join(testDataDir, 'db'), { recursive: true });
  process.env.LBT_DATA_DIR = testDataDir;
});

afterEach(() => {
  rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.LBT_DATA_DIR;
});

describe('captureTokens', () => {
  it('mintCaptureToken returns a raw token and stores only its hash', async () => {
    const { mintCaptureToken, hashCaptureToken } = await import('../../src/auth/tokens.js');
    const { listCaptureTokens } = await import('../../src/store/capture-tokens-store.js');
    const { asUserId, asTeamId } = await import('../../src/domain/types.js');

    const { rawToken, record } = mintCaptureToken(asUserId('u1'), asTeamId('t1'), 'CI bot');

    expect(typeof rawToken).toBe('string');
    expect(rawToken.length).toBeGreaterThan(10);

    const stored = listCaptureTokens();
    expect(stored).toHaveLength(1);

    // Raw token must NOT be stored
    expect(stored[0]!.tokenHash).not.toBe(rawToken);
    // Hash must match
    expect(stored[0]!.tokenHash).toBe(hashCaptureToken(rawToken));
    expect(record.tokenHash).toBe(hashCaptureToken(rawToken));
    expect(record.revokedAt).toBe('');
  });

  it('verifyCaptureToken succeeds for active token', async () => {
    const { mintCaptureToken, verifyCaptureToken } = await import('../../src/auth/tokens.js');
    const { asUserId, asTeamId } = await import('../../src/domain/types.js');

    const { rawToken } = mintCaptureToken(asUserId('u1'), asTeamId('t1'), 'test');
    const result = verifyCaptureToken(rawToken);
    expect(result.ok).toBe(true);
  });

  it('verifyCaptureToken fails for unknown token', async () => {
    const { verifyCaptureToken } = await import('../../src/auth/tokens.js');
    const result = verifyCaptureToken('totally-unknown');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it('revokeCaptureTokenByRaw marks the token as revoked', async () => {
    const { mintCaptureToken, verifyCaptureToken, revokeCaptureTokenByRaw } = await import(
      '../../src/auth/tokens.js'
    );
    const { asUserId, asTeamId } = await import('../../src/domain/types.js');

    const { rawToken } = mintCaptureToken(asUserId('u1'), asTeamId('t1'), 'dep-bot');
    const revoked = revokeCaptureTokenByRaw(rawToken);
    expect(revoked).toBe(true);

    const result = verifyCaptureToken(rawToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/revoked/i);
    }
  });

  it('revocation is idempotent via revokeCaptureTokenByHash', async () => {
    const { mintCaptureToken, revokeCaptureTokenByHash, hashCaptureToken } = await import(
      '../../src/auth/tokens.js'
    );
    const { asUserId, asTeamId } = await import('../../src/domain/types.js');

    const { rawToken } = mintCaptureToken(asUserId('u1'), asTeamId('t1'), 'once');
    const tokenHash = hashCaptureToken(rawToken);

    expect(revokeCaptureTokenByHash(tokenHash)).toBe(true);
    // Second revoke returns true (record exists with revokedAt set, update is a no-op in effect)
    // The store updates the revokedAt timestamp again — still returns true
    expect(revokeCaptureTokenByHash(tokenHash)).toBe(true);
  });

  it('multiple tokens can be minted for the same user/team', async () => {
    const { mintCaptureToken } = await import('../../src/auth/tokens.js');
    const { listCaptureTokens } = await import('../../src/store/capture-tokens-store.js');
    const { asUserId, asTeamId } = await import('../../src/domain/types.js');

    mintCaptureToken(asUserId('u1'), asTeamId('t1'), 'token-a');
    mintCaptureToken(asUserId('u1'), asTeamId('t1'), 'token-b');

    expect(listCaptureTokens()).toHaveLength(2);
  });
});
