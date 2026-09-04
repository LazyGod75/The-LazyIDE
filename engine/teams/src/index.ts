/**
 * LazyBrain Teams — composition root.
 *
 * This module wires configuration, stores, and auth modules together.
 * The HTTP server will be added in a subsequent wave (src/server/main.ts).
 *
 * Exports are deliberately narrow: callers should import directly from
 * the sub-modules for full surface area.
 */

// Config
export { DATA_DIR, DB_DIR, BRAINS_DIR } from './config.js';

// Domain types
export type {
  User,
  Team,
  Membership,
  Session,
  CaptureToken,
  AuditEntry,
  Setting,
  OrgRole,
  TeamRole,
  UserStatus,
  TeamVisibility,
  UserId,
  TeamId,
  SessionToken,
  CaptureTokenValue,
  Result,
} from './domain/types.js';
export {
  ok,
  err,
  isOk,
  asUserId,
  asTeamId,
  asSessionToken,
  asCaptureToken,
} from './domain/types.js';

// Stores
export * as usersStore from './store/users-store.js';
export * as teamsStore from './store/teams-store.js';
export * as membershipsStore from './store/memberships-store.js';
export * as sessionsStore from './store/sessions-store.js';
export * as captureTokensStore from './store/capture-tokens-store.js';
export * as auditStore from './store/audit-store.js';
export * as settingsStore from './store/settings-store.js';

// Auth
export * as password from './auth/password.js';
export * as sessions from './auth/sessions.js';
export * as rateLimit from './auth/rate-limit.js';
export * as tokens from './auth/tokens.js';
