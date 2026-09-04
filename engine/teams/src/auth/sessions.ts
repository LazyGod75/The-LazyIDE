/**
 * Session lifecycle management.
 *
 * Security model:
 * - Raw token: 32 random bytes, base64url-encoded, returned once to the caller.
 * - Stored: sha256(rawToken) hex — never the raw token itself.
 * - Per-session CSRF token: 24 random bytes, base64url-encoded.
 * - Expiry: 7 days from creation.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Result, Session, SessionToken, UserId } from '../domain/types.js';
import { asSessionToken, asUserId, err, ok } from '../domain/types.js';
import {
  findSessionByHash,
  createSession as storeCreate,
  revokeSession as storeRevoke,
  sweepExpiredSessions,
} from '../store/sessions-store.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

export interface CreatedSession {
  readonly rawToken: SessionToken;
  readonly session: Session;
}

/**
 * Create a new session for a user.
 * Returns the raw token (given once to caller) plus the stored session record.
 */
export function createSession(userId: UserId, now: Date = new Date()): CreatedSession {
  const rawToken = generateToken(32);
  const csrfToken = generateToken(24);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const session: Session = {
    tokenHash,
    userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    csrfToken,
  };

  storeCreate(session);

  return { rawToken: asSessionToken(rawToken), session };
}

/**
 * Validate a raw session token.
 * Returns ok(session) if valid and not expired; err(...) otherwise.
 */
export function validateSessionToken(rawToken: string, now: Date = new Date()): Result<Session> {
  const tokenHash = hashToken(rawToken);
  const session = findSessionByHash(tokenHash);

  if (!session) {
    return err('Session not found.');
  }

  if (new Date(session.expiresAt) <= now) {
    return err('Session expired.');
  }

  return ok(session);
}

/**
 * Revoke a session by its raw token.
 * Returns true if the session existed and was removed.
 */
export function revokeSessionByToken(rawToken: string): boolean {
  const tokenHash = hashToken(rawToken);
  return storeRevoke(tokenHash);
}

/**
 * Remove all expired sessions from the store.
 * Returns the count of removed sessions.
 */
export function purgeExpiredSessions(now: Date = new Date()): number {
  return sweepExpiredSessions(now);
}

// Re-export UserId helper for callers that only import from auth/sessions
export { asUserId };
