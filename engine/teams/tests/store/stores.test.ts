/**
 * Integration tests for all typed stores.
 * Each test gets an isolated temp directory via LBT_DATA_DIR.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module isolation strategy:
// vi.resetModules() forces vitest to re-evaluate all modules on the next
// dynamic import, so config.ts picks up the new LBT_DATA_DIR env var.
// ---------------------------------------------------------------------------

let testDataDir: string;

beforeEach(() => {
  vi.resetModules();
  testDataDir = join(tmpdir(), `lbt-stores-${process.pid}-${Date.now()}`);
  mkdirSync(join(testDataDir, 'db'), { recursive: true });
  process.env.LBT_DATA_DIR = testDataDir;
});

afterEach(() => {
  rmSync(testDataDir, { recursive: true, force: true });
  delete process.env.LBT_DATA_DIR;
});

// ---------------------------------------------------------------------------
// Users store
// ---------------------------------------------------------------------------

describe('usersStore', () => {
  async function getStore() {
    const { listUsers, createUser, findUserById, findUserByUsername, updateUser, deleteUser } =
      await import('../../src/store/users-store.js');

    return { listUsers, createUser, findUserById, findUserByUsername, updateUser, deleteUser };
  }

  it('starts empty', async () => {
    const { listUsers } = await getStore();
    expect(listUsers()).toEqual([]);
  });

  it('creates and retrieves a user', async () => {
    const { createUser, findUserById } = await getStore();
    const { asUserId } = await import('../../src/domain/types.js');
    const user = {
      id: asUserId('u1'),
      username: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
      passwordHash: 'scrypt:16384:8:1:saltB64:hashB64',
      orgRole: 'admin' as const,
      status: 'active' as const,
      createdAt: '2024-06-01T10:00:00Z',
    };
    createUser(user);
    const found = findUserById(asUserId('u1'));
    expect(found?.username).toBe('alice');
    expect(found?.orgRole).toBe('admin');
  });

  it('updates a user immutably', async () => {
    const { createUser, updateUser, findUserById } = await getStore();
    const { asUserId } = await import('../../src/domain/types.js');
    const id = asUserId('u2');
    const user = {
      id,
      username: 'bob',
      displayName: 'Bob',
      email: 'bob@example.com',
      passwordHash: 'hash',
      orgRole: 'member' as const,
      status: 'active' as const,
      createdAt: '2024-06-01T10:00:00Z',
    };
    createUser(user);
    const updated = { ...user, status: 'disabled' as const };
    updateUser(updated);
    const found = findUserById(id);
    expect(found?.status).toBe('disabled');
  });

  it('deletes a user', async () => {
    const { createUser, deleteUser, findUserById } = await getStore();
    const { asUserId } = await import('../../src/domain/types.js');
    const id = asUserId('u3');
    const user = {
      id,
      username: 'carol',
      displayName: 'Carol',
      email: 'carol@example.com',
      passwordHash: 'hash',
      orgRole: 'member' as const,
      status: 'active' as const,
      createdAt: '2024-06-01T10:00:00Z',
    };
    createUser(user);
    const deleted = deleteUser(id);
    expect(deleted).toBe(true);
    expect(findUserById(id)).toBeUndefined();
  });

  it('returns false when deleting non-existent user', async () => {
    const { deleteUser } = await getStore();
    const { asUserId } = await import('../../src/domain/types.js');
    expect(deleteUser(asUserId('ghost'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Teams store
// ---------------------------------------------------------------------------

describe('teamsStore', () => {
  it('creates, finds by slug, updates, deletes', async () => {
    const { createTeam, findTeamBySlug, updateTeam, deleteTeam } = await import(
      '../../src/store/teams-store.js'
    );
    const { asTeamId } = await import('../../src/domain/types.js');

    const team = {
      id: asTeamId('t1'),
      slug: 'engineering',
      name: 'Engineering',
      description: 'Core eng team',
      visibility: 'org-readable' as const,
      retentionDays: 90,
      createdAt: '2024-06-01T00:00:00Z',
    };

    createTeam(team);
    const found = findTeamBySlug('engineering');
    expect(found?.name).toBe('Engineering');
    expect(found?.retentionDays).toBe(90);

    const updated = { ...team, retentionDays: 180 };
    updateTeam(updated);
    expect(findTeamBySlug('engineering')?.retentionDays).toBe(180);

    deleteTeam(asTeamId('t1'));
    expect(findTeamBySlug('engineering')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Memberships store
// ---------------------------------------------------------------------------

describe('membershipsStore', () => {
  it('add, find, update role, remove membership', async () => {
    const {
      addMembership,
      findMembership,
      updateMembershipRole,
      removeMembership,
      listMembershipsForTeam,
    } = await import('../../src/store/memberships-store.js');
    const { asUserId, asTeamId } = await import('../../src/domain/types.js');

    const uid = asUserId('u1');
    const tid = asTeamId('t1');

    addMembership({ userId: uid, teamId: tid, teamRole: 'lead', addedAt: '2024-06-01T00:00:00Z' });
    const m = findMembership(uid, tid);
    expect(m?.teamRole).toBe('lead');

    updateMembershipRole(uid, tid, 'viewer');
    expect(findMembership(uid, tid)?.teamRole).toBe('viewer');

    expect(listMembershipsForTeam(tid)).toHaveLength(1);
    removeMembership(uid, tid);
    expect(findMembership(uid, tid)).toBeUndefined();
  });

  it('upserts on addMembership when already exists', async () => {
    const { addMembership, findMembership, listMembershipsForTeam } = await import(
      '../../src/store/memberships-store.js'
    );
    const { asUserId, asTeamId } = await import('../../src/domain/types.js');

    const uid = asUserId('u99');
    const tid = asTeamId('t99');

    addMembership({
      userId: uid,
      teamId: tid,
      teamRole: 'member',
      addedAt: '2024-06-01T00:00:00Z',
    });
    addMembership({ userId: uid, teamId: tid, teamRole: 'lead', addedAt: '2024-06-02T00:00:00Z' });

    expect(listMembershipsForTeam(tid)).toHaveLength(1);
    expect(findMembership(uid, tid)?.teamRole).toBe('lead');
  });
});

// ---------------------------------------------------------------------------
// Sessions store
// ---------------------------------------------------------------------------

describe('sessionsStore', () => {
  it('create, find by hash, revoke', async () => {
    const { createSession, findSessionByHash, revokeSession } = await import(
      '../../src/store/sessions-store.js'
    );
    const { asUserId } = await import('../../src/domain/types.js');

    const session = {
      tokenHash: 'abc123hash',
      userId: asUserId('u1'),
      createdAt: '2024-06-01T00:00:00Z',
      expiresAt: '2024-06-08T00:00:00Z',
      csrfToken: 'csrf-abc',
    };

    createSession(session);
    expect(findSessionByHash('abc123hash')?.csrfToken).toBe('csrf-abc');

    revokeSession('abc123hash');
    expect(findSessionByHash('abc123hash')).toBeUndefined();
  });

  it('sweepExpiredSessions removes only expired', async () => {
    const { createSession, sweepExpiredSessions, listSessions } = await import(
      '../../src/store/sessions-store.js'
    );
    const { asUserId } = await import('../../src/domain/types.js');

    const uid = asUserId('u1');
    createSession({
      tokenHash: 'exp1',
      userId: uid,
      createdAt: '2024-01-01T00:00:00Z',
      expiresAt: '2024-01-02T00:00:00Z',
      csrfToken: 'c1',
    });
    createSession({
      tokenHash: 'active1',
      userId: uid,
      createdAt: '2024-06-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      csrfToken: 'c2',
    });

    const swept = sweepExpiredSessions(new Date('2025-01-01T00:00:00Z'));
    expect(swept).toBe(1);
    expect(listSessions()).toHaveLength(1);
    expect(listSessions()[0]!.tokenHash).toBe('active1');
  });
});

// ---------------------------------------------------------------------------
// Capture tokens store
// ---------------------------------------------------------------------------

describe('captureTokensStore', () => {
  it('create, find by hash, revoke', async () => {
    const { createCaptureToken, findCaptureTokenByHash, revokeCaptureToken } = await import(
      '../../src/store/capture-tokens-store.js'
    );
    const { asUserId, asTeamId } = await import('../../src/domain/types.js');

    const tok = {
      tokenHash: 'tok-hash-1',
      userId: asUserId('u1'),
      teamId: asTeamId('t1'),
      label: 'CI token',
      createdAt: '2024-06-01T00:00:00Z',
      revokedAt: '',
    };

    createCaptureToken(tok);
    const found = findCaptureTokenByHash('tok-hash-1');
    expect(found?.label).toBe('CI token');
    expect(found?.revokedAt).toBe('');

    revokeCaptureToken('tok-hash-1', '2024-06-10T00:00:00Z');
    const revoked = findCaptureTokenByHash('tok-hash-1');
    expect(revoked?.revokedAt).toBe('2024-06-10T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// Audit store
// ---------------------------------------------------------------------------

describe('auditStore', () => {
  it('appends entries and reads them back', async () => {
    const { logAuditEvent, readAuditLog } = await import('../../src/store/audit-store.js');

    logAuditEvent({
      ts: '2024-06-01T10:00:00Z',
      userId: 'u1',
      action: 'login',
      resource: 'session',
      details: '',
    });
    logAuditEvent({
      ts: '2024-06-01T11:00:00Z',
      userId: 'u2',
      action: 'create_team',
      resource: 'team:t1',
      details: 'slug=eng',
    });

    const log = readAuditLog();
    expect(log).toHaveLength(2);
    expect(log[0]!.action).toBe('login');
    expect(log[1]!.details).toBe('slug=eng');
  });

  it('readFilteredAuditLog filters by userId', async () => {
    const { logAuditEvent, readFilteredAuditLog } = await import('../../src/store/audit-store.js');

    logAuditEvent({
      ts: '2024-06-01T10:00:00Z',
      userId: 'u1',
      action: 'login',
      resource: 'session',
      details: '',
    });
    logAuditEvent({
      ts: '2024-06-01T11:00:00Z',
      userId: 'u2',
      action: 'login',
      resource: 'session',
      details: '',
    });

    const filtered = readFilteredAuditLog({ userId: 'u1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.userId).toBe('u1');
  });
});

// ---------------------------------------------------------------------------
// Settings store
// ---------------------------------------------------------------------------

describe('settingsStore', () => {
  it('set, get, update, delete', async () => {
    const { setSetting, getSetting, deleteSetting } = await import(
      '../../src/store/settings-store.js'
    );

    setSetting('max_teams', '50', '2024-06-01T00:00:00Z');
    expect(getSetting('max_teams')).toBe('50');

    setSetting('max_teams', '100', '2024-06-02T00:00:00Z');
    expect(getSetting('max_teams')).toBe('100');

    deleteSetting('max_teams');
    expect(getSetting('max_teams')).toBeUndefined();
  });
});
