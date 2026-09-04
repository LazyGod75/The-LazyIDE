/**
 * Teams store — CRUD over data/db/teams.csv.
 */

import { TEAMS_CSV } from '../config.js';
import type { Team, TeamId } from '../domain/types.js';
import { asTeamId } from '../domain/types.js';
import { readTable, writeTable } from './csv.js';
import { TEAMS_SCHEMA } from './schemas.js';

function rowToTeam(row: Record<string, string>): Team {
  return {
    id: asTeamId(row.id!),
    slug: row.slug!,
    name: row.name!,
    description: row.description!,
    visibility: row.visibility as Team['visibility'],
    retentionDays: Number.parseInt(row.retentionDays!, 10),
    createdAt: row.createdAt!,
  };
}

function teamToRow(team: Team): Record<string, string> {
  return {
    id: team.id,
    slug: team.slug,
    name: team.name,
    description: team.description,
    visibility: team.visibility,
    retentionDays: String(team.retentionDays),
    createdAt: team.createdAt,
  };
}

export function listTeams(): Team[] {
  return readTable(TEAMS_CSV, TEAMS_SCHEMA).map(rowToTeam);
}

export function findTeamById(id: TeamId): Team | undefined {
  return listTeams().find((t) => t.id === id);
}

export function findTeamBySlug(slug: string): Team | undefined {
  return listTeams().find((t) => t.slug === slug);
}

export function createTeam(team: Team): Team {
  const existing = listTeams();
  const updated = [...existing, team];
  writeTable(TEAMS_CSV, TEAMS_SCHEMA, updated.map(teamToRow));
  return team;
}

export function updateTeam(updated: Team): Team | undefined {
  const all = listTeams();
  const idx = all.findIndex((t) => t.id === updated.id);
  if (idx === -1) {
    return undefined;
  }
  const newList = [...all.slice(0, idx), updated, ...all.slice(idx + 1)];
  writeTable(TEAMS_CSV, TEAMS_SCHEMA, newList.map(teamToRow));
  return updated;
}

export function deleteTeam(id: TeamId): boolean {
  const all = listTeams();
  const filtered = all.filter((t) => t.id !== id);
  if (filtered.length === all.length) {
    return false;
  }
  writeTable(TEAMS_CSV, TEAMS_SCHEMA, filtered.map(teamToRow));
  return true;
}
