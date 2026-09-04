/**
 * Sessions store — CRUD over data/db/sessions.csv.
 * Only the sha256 hash of the raw token is ever persisted.
 */

import { SESSIONS_CSV } from '../config.js';
import type { Session, UserId } from '../domain/types.js';
import { asUserId } from '../domain/types.js';
import { readTable, writeTable } from './csv.js';
import { SESSIONS_SCHEMA } from './schemas.js';

function rowToSession(row: Record<string, string>): Session {
  return {
    tokenHash: row.tokenHash!,
    userId: asUserId(row.userId!),
    createdAt: row.createdAt!,
    expiresAt: row.expiresAt!,
    csrfToken: row.csrfToken!,
  };
}

function sessionToRow(s: Session): Record<string, string> {
  return {
    tokenHash: s.tokenHash,
    userId: s.userId,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    csrfToken: s.csrfToken,
  };
}

export function listSessions(): Session[] {
  return readTable(SESSIONS_CSV, SESSIONS_SCHEMA).map(rowToSession);
}

export function findSessionByHash(tokenHash: string): Session | undefined {
  return listSessions().find((s) => s.tokenHash === tokenHash);
}

export function listSessionsForUser(userId: UserId): Session[] {
  return listSessions().filter((s) => s.userId === userId);
}

export function createSession(session: Session): Session {
  const existing = listSessions();
  const updated = [...existing, session];
  writeTable(SESSIONS_CSV, SESSIONS_SCHEMA, updated.map(sessionToRow));
  return session;
}

export function revokeSession(tokenHash: string): boolean {
  const all = listSessions();
  const filtered = all.filter((s) => s.tokenHash !== tokenHash);
  if (filtered.length === all.length) {
    return false;
  }
  writeTable(SESSIONS_CSV, SESSIONS_SCHEMA, filtered.map(sessionToRow));
  return true;
}

export function revokeAllSessionsForUser(userId: UserId): number {
  const all = listSessions();
  const filtered = all.filter((s) => s.userId !== userId);
  const count = all.length - filtered.length;
  if (count > 0) {
    writeTable(SESSIONS_CSV, SESSIONS_SCHEMA, filtered.map(sessionToRow));
  }
  return count;
}

/**
 * Remove all sessions whose expiresAt is in the past.
 * Returns the count of removed sessions.
 */
export function sweepExpiredSessions(now: Date = new Date()): number {
  const all = listSessions();
  const active = all.filter((s) => new Date(s.expiresAt) > now);
  const count = all.length - active.length;
  if (count > 0) {
    writeTable(SESSIONS_CSV, SESSIONS_SCHEMA, active.map(sessionToRow));
  }
  return count;
}
