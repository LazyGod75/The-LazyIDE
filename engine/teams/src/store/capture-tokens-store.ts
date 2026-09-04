/**
 * Capture-tokens store — CRUD over data/db/capture_tokens.csv.
 * Capture tokens allow agents/CI to push notes to a team brain without a
 * full user session. Only the sha256 hash is stored at rest.
 */

import { CAPTURE_TOKENS_CSV } from '../config.js';
import type { CaptureToken, TeamId, UserId } from '../domain/types.js';
import { asTeamId, asUserId } from '../domain/types.js';
import { readTable, writeTable } from './csv.js';
import { CAPTURE_TOKENS_SCHEMA } from './schemas.js';

function rowToToken(row: Record<string, string>): CaptureToken {
  return {
    tokenHash: row.tokenHash!,
    userId: asUserId(row.userId!),
    teamId: asTeamId(row.teamId!),
    label: row.label!,
    createdAt: row.createdAt!,
    revokedAt: row.revokedAt!,
  };
}

function tokenToRow(t: CaptureToken): Record<string, string> {
  return {
    tokenHash: t.tokenHash,
    userId: t.userId,
    teamId: t.teamId,
    label: t.label,
    createdAt: t.createdAt,
    revokedAt: t.revokedAt,
  };
}

export function listCaptureTokens(): CaptureToken[] {
  return readTable(CAPTURE_TOKENS_CSV, CAPTURE_TOKENS_SCHEMA).map(rowToToken);
}

export function findCaptureTokenByHash(tokenHash: string): CaptureToken | undefined {
  return listCaptureTokens().find((t) => t.tokenHash === tokenHash);
}

export function listActiveTokensForTeam(teamId: TeamId): CaptureToken[] {
  return listCaptureTokens().filter((t) => t.teamId === teamId && t.revokedAt === '');
}

export function createCaptureToken(token: CaptureToken): CaptureToken {
  const existing = listCaptureTokens();
  const updated = [...existing, token];
  writeTable(CAPTURE_TOKENS_CSV, CAPTURE_TOKENS_SCHEMA, updated.map(tokenToRow));
  return token;
}

export function revokeCaptureToken(tokenHash: string, revokedAt: string): boolean {
  const all = listCaptureTokens();
  const idx = all.findIndex((t) => t.tokenHash === tokenHash);
  if (idx === -1) {
    return false;
  }
  const revoked: CaptureToken = { ...all[idx]!, revokedAt };
  const newList = [...all.slice(0, idx), revoked, ...all.slice(idx + 1)];
  writeTable(CAPTURE_TOKENS_CSV, CAPTURE_TOKENS_SCHEMA, newList.map(tokenToRow));
  return true;
}

export function revokeAllTokensForUser(userId: UserId, revokedAt: string): number {
  const all = listCaptureTokens();
  const updated = all.map((t) =>
    t.userId === userId && t.revokedAt === '' ? { ...t, revokedAt } : t,
  );
  const count = updated.filter((t, i) => t !== all[i]).length;
  if (count > 0) {
    writeTable(CAPTURE_TOKENS_CSV, CAPTURE_TOKENS_SCHEMA, updated.map(tokenToRow));
  }
  return count;
}
