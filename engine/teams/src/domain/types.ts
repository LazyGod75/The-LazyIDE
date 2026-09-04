/**
 * Shared domain model for LazyBrain Teams.
 * All IDs are opaque branded strings to prevent accidental cross-type mixing.
 */

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

declare const _userId: unique symbol;
declare const _teamId: unique symbol;
declare const _sessionToken: unique symbol;
declare const _captureToken: unique symbol;

export type UserId = string & { readonly [_userId]: true };
export type TeamId = string & { readonly [_teamId]: true };
export type SessionToken = string & { readonly [_sessionToken]: true };
export type CaptureTokenValue = string & { readonly [_captureToken]: true };

export function asUserId(s: string): UserId {
  return s as UserId;
}

export function asTeamId(s: string): TeamId {
  return s as TeamId;
}

export function asSessionToken(s: string): SessionToken {
  return s as SessionToken;
}

export function asCaptureToken(s: string): CaptureTokenValue {
  return s as CaptureTokenValue;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type OrgRole = 'admin' | 'member';
export type TeamRole = 'lead' | 'member' | 'viewer';
export type UserStatus = 'active' | 'disabled';
export type TeamVisibility = 'private' | 'org-readable';

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export interface User {
  readonly id: UserId;
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly orgRole: OrgRole;
  readonly status: UserStatus;
  readonly createdAt: string; // ISO-8601
}

export interface Team {
  readonly id: TeamId;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: TeamVisibility;
  readonly retentionDays: number;
  readonly createdAt: string; // ISO-8601
}

export interface Membership {
  readonly userId: UserId;
  readonly teamId: TeamId;
  readonly teamRole: TeamRole;
  readonly addedAt: string; // ISO-8601
}

export interface Session {
  readonly tokenHash: string; // sha256(rawToken) stored only
  readonly userId: UserId;
  readonly createdAt: string; // ISO-8601
  readonly expiresAt: string; // ISO-8601
  readonly csrfToken: string; // per-session random token
}

export interface CaptureToken {
  readonly tokenHash: string; // sha256(rawToken) stored only
  readonly userId: UserId;
  readonly teamId: TeamId;
  readonly label: string;
  readonly createdAt: string; // ISO-8601
  readonly revokedAt: string; // ISO-8601 or '' when active
}

export interface AuditEntry {
  readonly ts: string; // ISO-8601
  readonly userId: string; // UserId or 'system'
  readonly action: string;
  readonly resource: string;
  readonly details: string;
}

// ---------------------------------------------------------------------------
// Result type — explicit error handling without exceptions for business logic
// ---------------------------------------------------------------------------

export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<E = string>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

// ---------------------------------------------------------------------------
// Settings key-value pair
// ---------------------------------------------------------------------------

export interface Setting {
  readonly key: string;
  readonly value: string;
  readonly updatedAt: string; // ISO-8601
}
