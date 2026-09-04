/**
 * Capture token management.
 *
 * Capture tokens allow headless agents/CI to push notes to a team brain
 * without a full interactive session.
 *
 * Security model (same discipline as sessions):
 * - Raw token: 32 random bytes, base64url-encoded, returned once to caller.
 * - Stored: sha256(rawToken) hex — never the raw token.
 * - Revocation is permanent and recorded with a timestamp.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { CaptureToken, CaptureTokenValue, Result, TeamId, UserId } from '../domain/types.js';
import { asCaptureToken, err, ok } from '../domain/types.js';
import {
  findCaptureTokenByHash,
  createCaptureToken as storeCreate,
  revokeCaptureToken as storeRevoke,
} from '../store/capture-tokens-store.js';

export function hashCaptureToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export interface MintedToken {
  readonly rawToken: CaptureTokenValue;
  readonly record: CaptureToken;
}

/**
 * Mint a new capture token for a user/team pair.
 * Returns the raw token (given once to caller) plus the stored record.
 */
export function mintCaptureToken(
  userId: UserId,
  teamId: TeamId,
  label: string,
  now: Date = new Date(),
): MintedToken {
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = hashCaptureToken(rawToken);

  const record: CaptureToken = {
    tokenHash,
    userId,
    teamId,
    label,
    createdAt: now.toISOString(),
    revokedAt: '',
  };

  storeCreate(record);

  return { rawToken: asCaptureToken(rawToken), record };
}

/**
 * Verify a raw capture token.
 * Returns ok(record) if active; err(...) if not found or revoked.
 */
export function verifyCaptureToken(rawToken: string): Result<CaptureToken> {
  const tokenHash = hashCaptureToken(rawToken);
  const record = findCaptureTokenByHash(tokenHash);

  if (!record) {
    return err('Capture token not found.');
  }

  if (record.revokedAt !== '') {
    return err('Capture token has been revoked.');
  }

  return ok(record);
}

/**
 * Revoke a capture token by its raw value.
 * Returns true if found and marked revoked.
 */
export function revokeCaptureTokenByRaw(rawToken: string, now: Date = new Date()): boolean {
  const tokenHash = hashCaptureToken(rawToken);
  return storeRevoke(tokenHash, now.toISOString());
}

/**
 * Revoke a capture token by its stored hash (for admin actions).
 */
export function revokeCaptureTokenByHash(tokenHash: string, now: Date = new Date()): boolean {
  return storeRevoke(tokenHash, now.toISOString());
}
