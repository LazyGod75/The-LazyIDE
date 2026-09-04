/**
 * orgContext.test.ts
 *
 * Tests the pure buildOrgContext mapper (contract mapping) and verifies
 * that sync functions are no-ops outside Tauri (routing / solo path).
 */

import { describe, it, expect } from 'vitest';
import {
  buildOrgContext,
  syncOrgContext,
  resyncOrgContext,
  type OrgContextJson,
  type OrgContextTeam,
} from '../lib/teams/orgContext';

// ── Fixtures ──────────────────────────────────────────────────

const USER_ID = 'user-uuid-123';

const MEMBER_BASE = {
  org_id: 'org-uuid-456',
  role: 'member',
  dept_id: 'dept-eng',
};

const ORG = { id: 'org-uuid-456', name: 'Acme Corp' };

const DEPTS = [
  { id: 'dept-eng',    slug: 'engineering', name: 'Engineering', org_id: 'org-uuid-456' },
  { id: 'dept-design', slug: 'design',      name: 'Design',      org_id: 'org-uuid-456' },
];

// ── buildOrgContext — contract mapping ────────────────────────

describe('buildOrgContext', () => {
  it('sets userId from argument', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    expect(ctx.userId).toBe(USER_ID);
  });

  it('sets orgId from member.org_id', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    expect(ctx.orgId).toBe('org-uuid-456');
  });

  it('generates orgSlug by slugifying org name', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    expect(ctx.orgSlug).toBe('acme-corp');
  });

  it('isOrgAdmin = false for member role', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    expect(ctx.isOrgAdmin).toBe(false);
  });

  it('isOrgAdmin = true for org-admin role', () => {
    const admin = { ...MEMBER_BASE, role: 'org-admin' };
    const ctx = buildOrgContext(USER_ID, admin, ORG, DEPTS);
    expect(ctx.isOrgAdmin).toBe(true);
  });

  it('depts[] contains id + slug for all departments', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    expect(ctx.depts).toHaveLength(2);
    expect(ctx.depts[0]).toStrictEqual({ id: 'dept-eng',    slug: 'engineering' });
    expect(ctx.depts[1]).toStrictEqual({ id: 'dept-design', slug: 'design' });
  });

  it('teams[] length equals depts length', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    expect(ctx.teams).toHaveLength(DEPTS.length);
  });

  it('all teams have visibility = org-readable (Phase 0 default)', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    ctx.teams.forEach((t) => expect(t.visibility).toBe('org-readable'));
  });

  it('user dept → role = member (from member role)', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    const eng = ctx.teams.find((t) => t.slug === 'engineering');
    expect(eng?.role).toBe('member');
  });

  it('non-user dept → role = null', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    const design = ctx.teams.find((t) => t.slug === 'design');
    expect(design?.role).toBeNull();
  });

  it('team-lead role in user dept → role = lead', () => {
    const lead = { ...MEMBER_BASE, role: 'team-lead' };
    const ctx = buildOrgContext(USER_ID, lead, ORG, DEPTS);
    const eng = ctx.teams.find((t) => t.slug === 'engineering');
    expect(eng?.role).toBe('lead');
  });

  it('viewer role in user dept → role = viewer', () => {
    const viewer = { ...MEMBER_BASE, role: 'viewer' };
    const ctx = buildOrgContext(USER_ID, viewer, ORG, DEPTS);
    const eng = ctx.teams.find((t) => t.slug === 'engineering');
    expect(eng?.role).toBe('viewer');
  });

  it('org-admin → lead in ALL teams regardless of dept', () => {
    const admin = { ...MEMBER_BASE, role: 'org-admin', dept_id: null };
    const ctx = buildOrgContext(USER_ID, admin, ORG, DEPTS);
    ctx.teams.forEach((t: OrgContextTeam) => expect(t.role).toBe('lead'));
  });

  it('each team carries deptId', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    expect(ctx.teams[0].deptId).toBe('dept-eng');
    expect(ctx.teams[1].deptId).toBe('dept-design');
  });

  it('null dept_id on member → role = null in all teams', () => {
    const noTeam = { ...MEMBER_BASE, dept_id: null };
    const ctx = buildOrgContext(USER_ID, noTeam, ORG, DEPTS);
    ctx.teams.forEach((t) => expect(t.role).toBeNull());
  });

  it('empty depts → teams=[] and depts=[]', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, []);
    expect(ctx.teams).toHaveLength(0);
    expect(ctx.depts).toHaveLength(0);
  });

  it('slugifies org name with spaces', () => {
    const org = { id: 'o', name: 'My Big Company' };
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, org, []);
    expect(ctx.orgSlug).toBe('my-big-company');
  });

  it('slugifies org name with special chars', () => {
    const org = { id: 'o', name: 'Acme & Co. 2026!' };
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, org, []);
    expect(ctx.orgSlug).toBe('acme-co-2026');
  });

  it('contract: all required top-level fields are present', () => {
    const ctx = buildOrgContext(USER_ID, MEMBER_BASE, ORG, DEPTS);
    const keys: (keyof OrgContextJson)[] = [
      'userId', 'orgId', 'orgSlug', 'isOrgAdmin', 'teams', 'depts',
    ];
    keys.forEach((k) => expect(ctx).toHaveProperty(k));
  });
});

// ── Routing: solo mode vs team mode ──────────────────────────
//
// In the test env: isTauri() returns false (setup.ts removes __TAURI_INTERNALS__).
// syncOrgContext / resyncOrgContext must be no-ops (no Tauri invoke called).

describe('syncOrgContext routing', () => {
  const CONTEXT: OrgContextJson = {
    userId: 'u', orgId: 'o', orgSlug: 's',
    isOrgAdmin: false, teams: [], depts: [],
  };

  it('syncOrgContext resolves without error outside Tauri (solo path)', async () => {
    await expect(syncOrgContext(CONTEXT)).resolves.toBeUndefined();
  });

  it('resyncOrgContext resolves without error outside Tauri (solo path)', async () => {
    await expect(resyncOrgContext(CONTEXT)).resolves.toBeUndefined();
  });
});
