/**
 * Central configuration module.
 * All paths derived from a single DATA_DIR root.
 * Read once at import time; tests can override via LBT_DATA_DIR env var.
 */

import { join } from 'node:path';

function resolveDataDir(): string {
  const fromEnv = process.env.LBT_DATA_DIR;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return './data';
}

export const DATA_DIR = resolveDataDir();
export const DB_DIR = join(DATA_DIR, 'db');
export const BRAINS_DIR = join(DATA_DIR, 'brains');

// CSV file paths — one per entity type
export const USERS_CSV = join(DB_DIR, 'users.csv');
export const TEAMS_CSV = join(DB_DIR, 'teams.csv');
export const MEMBERSHIPS_CSV = join(DB_DIR, 'memberships.csv');
export const SESSIONS_CSV = join(DB_DIR, 'sessions.csv');
export const CAPTURE_TOKENS_CSV = join(DB_DIR, 'capture_tokens.csv');
export const AUDIT_CSV = join(DB_DIR, 'audit.csv');
export const SETTINGS_CSV = join(DB_DIR, 'settings.csv');
