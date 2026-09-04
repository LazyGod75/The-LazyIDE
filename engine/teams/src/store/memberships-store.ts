/**
 * Memberships store — CRUD over data/db/memberships.csv.
 * Composite key: (userId, teamId).
 */

import { MEMBERSHIPS_CSV } from '../config.js';
import type { Membership, TeamId, UserId } from '../domain/types.js';
import { asTeamId, asUserId } from '../domain/types.js';
import { readTable, writeTable } from './csv.js';
import { MEMBERSHIPS_SCHEMA } from './schemas.js';

function rowToMembership(row: Record<string, string>): Membership {
  return {
    userId: asUserId(row.userId!),
    teamId: asTeamId(row.teamId!),
    teamRole: row.teamRole as Membership['teamRole'],
    addedAt: row.addedAt!,
  };
}

function membershipToRow(m: Membership): Record<string, string> {
  return {
    userId: m.userId,
    teamId: m.teamId,
    teamRole: m.teamRole,
    addedAt: m.addedAt,
  };
}

export function listMemberships(): Membership[] {
  return readTable(MEMBERSHIPS_CSV, MEMBERSHIPS_SCHEMA).map(rowToMembership);
}

export function findMembership(userId: UserId, teamId: TeamId): Membership | undefined {
  return listMemberships().find((m) => m.userId === userId && m.teamId === teamId);
}

export function listMembershipsForUser(userId: UserId): Membership[] {
  return listMemberships().filter((m) => m.userId === userId);
}

export function listMembershipsForTeam(teamId: TeamId): Membership[] {
  return listMemberships().filter((m) => m.teamId === teamId);
}

export function addMembership(membership: Membership): Membership {
  const existing = listMemberships();
  // Upsert: replace if already exists
  const filtered = existing.filter(
    (m) => !(m.userId === membership.userId && m.teamId === membership.teamId),
  );
  const updated = [...filtered, membership];
  writeTable(MEMBERSHIPS_CSV, MEMBERSHIPS_SCHEMA, updated.map(membershipToRow));
  return membership;
}

export function updateMembershipRole(
  userId: UserId,
  teamId: TeamId,
  teamRole: Membership['teamRole'],
): Membership | undefined {
  const all = listMemberships();
  const idx = all.findIndex((m) => m.userId === userId && m.teamId === teamId);
  if (idx === -1) {
    return undefined;
  }
  const updated: Membership = { ...all[idx]!, teamRole };
  const newList = [...all.slice(0, idx), updated, ...all.slice(idx + 1)];
  writeTable(MEMBERSHIPS_CSV, MEMBERSHIPS_SCHEMA, newList.map(membershipToRow));
  return updated;
}

export function removeMembership(userId: UserId, teamId: TeamId): boolean {
  const all = listMemberships();
  const filtered = all.filter((m) => !(m.userId === userId && m.teamId === teamId));
  if (filtered.length === all.length) {
    return false;
  }
  writeTable(MEMBERSHIPS_CSV, MEMBERSHIPS_SCHEMA, filtered.map(membershipToRow));
  return true;
}
