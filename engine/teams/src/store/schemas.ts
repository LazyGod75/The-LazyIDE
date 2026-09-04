/**
 * Canonical CSV table schemas.
 * Each schema defines the exact header row order + field types.
 * These are the single source of truth for both read and write operations.
 */

import type { TableSchema } from './csv.js';

export const USERS_SCHEMA: TableSchema = [
  { name: 'id', type: 'string' },
  { name: 'username', type: 'string' },
  { name: 'displayName', type: 'string' },
  { name: 'email', type: 'string' },
  { name: 'passwordHash', type: 'string' },
  { name: 'orgRole', type: 'enum', enumValues: ['admin', 'member'] },
  { name: 'status', type: 'enum', enumValues: ['active', 'disabled'] },
  { name: 'createdAt', type: 'isodate' },
];

export const TEAMS_SCHEMA: TableSchema = [
  { name: 'id', type: 'string' },
  { name: 'slug', type: 'string' },
  { name: 'name', type: 'string' },
  { name: 'description', type: 'optionalString' },
  { name: 'visibility', type: 'enum', enumValues: ['private', 'org-readable'] },
  { name: 'retentionDays', type: 'integer' },
  { name: 'createdAt', type: 'isodate' },
];

export const MEMBERSHIPS_SCHEMA: TableSchema = [
  { name: 'userId', type: 'string' },
  { name: 'teamId', type: 'string' },
  { name: 'teamRole', type: 'enum', enumValues: ['lead', 'member', 'viewer'] },
  { name: 'addedAt', type: 'isodate' },
];

export const SESSIONS_SCHEMA: TableSchema = [
  { name: 'tokenHash', type: 'string' },
  { name: 'userId', type: 'string' },
  { name: 'createdAt', type: 'isodate' },
  { name: 'expiresAt', type: 'isodate' },
  { name: 'csrfToken', type: 'string' },
];

export const CAPTURE_TOKENS_SCHEMA: TableSchema = [
  { name: 'tokenHash', type: 'string' },
  { name: 'userId', type: 'string' },
  { name: 'teamId', type: 'string' },
  { name: 'label', type: 'optionalString' },
  { name: 'createdAt', type: 'isodate' },
  { name: 'revokedAt', type: 'isodate' }, // empty string = active
];

export const AUDIT_SCHEMA: TableSchema = [
  { name: 'ts', type: 'isodate' },
  { name: 'userId', type: 'string' },
  { name: 'action', type: 'string' },
  { name: 'resource', type: 'string' },
  { name: 'details', type: 'optionalString' },
];

export const SETTINGS_SCHEMA: TableSchema = [
  { name: 'key', type: 'string' },
  { name: 'value', type: 'optionalString' },
  { name: 'updatedAt', type: 'isodate' },
];
