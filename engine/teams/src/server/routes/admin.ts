/**
 * Admin routes (org-admin only):
 *   GET  /admin/users       — list users
 *   POST /admin/users       — create user
 *   POST /admin/users/:id/disable
 *   POST /admin/users/:id/enable
 *   POST /admin/users/:id/reset-password
 *   GET  /admin/teams       — list + manage teams
 *   POST /admin/teams       — create team
 *   POST /admin/teams/:slug/edit
 *   POST /admin/teams/:slug/members     — add member
 *   POST /admin/teams/:slug/members/:userId/remove
 *   GET  /admin/audit       — audit log viewer
 */

import { randomBytes } from 'node:crypto';
import { hashPassword, validatePasswordPolicy } from '../../auth/password.js';
import { asTeamId, asUserId } from '../../domain/types.js';
import type { Team, TeamRole, User } from '../../domain/types.js';
import { readFilteredAuditLog } from '../../store/audit-store.js';
import {
  addMembership,
  listMemberships,
  listMembershipsForTeam,
  removeMembership,
} from '../../store/memberships-store.js';
import { getSetting } from '../../store/settings-store.js';
import { createTeam, findTeamBySlug, listTeams, updateTeam } from '../../store/teams-store.js';
import { createUser, findUserById, listUsers, updateUser } from '../../store/users-store.js';
import type { Handler } from '../http.js';
import { requireOrgAdmin } from '../middleware.js';
import { csrfField, esc, formRow, layout, table } from '../render.js';

const TEAM_SLUG_RE = /^[a-z0-9-]{2,32}$/;

function orgLayout(title: string, user: User, main: string): string {
  const orgName = getSetting('org_name') ?? 'LazyBrain Teams';
  const demoMode = getSetting('demo_mode') === 'true';
  return layout(title, user, main, { orgName, demoMode });
}

// ---- GET /admin/users ---------------------------------------------------

async function listUsersPage(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const users = listUsers();

  const rows = users.map((u) => ({
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    orgRole: u.orgRole,
    status: u.status,
    actions: `
<form method="POST" action="/admin/users/${esc(u.id)}/${u.status === 'active' ? 'disable' : 'enable'}" style="display:inline">
  ${csrfField(ctx.session!.csrfToken)}
  <button type="submit" class="btn btn--small btn--${u.status === 'active' ? 'danger' : 'secondary'}">${u.status === 'active' ? 'Disable' : 'Enable'}</button>
</form>
<form method="POST" action="/admin/users/${esc(u.id)}/reset-password" style="display:inline">
  ${csrfField(ctx.session!.csrfToken)}
  <button type="submit" class="btn btn--small btn--secondary">Reset PW</button>
</form>`,
  }));

  const body = `
<div class="page-header">
  <h1>Users</h1>
  <a href="/admin/users/new" class="btn btn--primary">Add user</a>
</div>
${table(
  [
    { key: 'username', label: 'Username' },
    { key: 'displayName', label: 'Display Name' },
    { key: 'email', label: 'Email' },
    { key: 'orgRole', label: 'Org Role' },
    { key: 'status', label: 'Status' },
    { key: 'actions', label: 'Actions', trusted: true },
  ],
  rows,
)}`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(orgLayout('Users', user, body));
}

export const getAdminUsers: Handler = requireOrgAdmin(listUsersPage);

// ---- GET /admin/users/new -----------------------------------------------

async function newUserPage(ctx: Parameters<Handler>[0]): Promise<void> {
  const body = `
<div class="page-header">
  <h1>Add user</h1>
  <a href="/admin/users" class="btn btn--secondary">← Back</a>
</div>
<form method="POST" action="/admin/users" class="form-card">
  ${csrfField(ctx.session!.csrfToken)}
  ${formRow({ name: 'username', label: 'Username', required: true })}
  ${formRow({ name: 'displayName', label: 'Display name', required: true })}
  ${formRow({ name: 'email', label: 'Email', type: 'email', required: true })}
  ${formRow({ name: 'tempPassword', label: 'Temporary password', type: 'password', required: true })}
  ${formRow({
    name: 'orgRole',
    label: 'Org role',
    type: 'select',
    options: [
      { value: 'member', label: 'Member' },
      { value: 'admin', label: 'Admin' },
    ],
  })}
  <button type="submit" class="btn btn--primary">Create user</button>
</form>`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(orgLayout('Add user', ctx.user!, body));
}

export const getAdminUserNew: Handler = requireOrgAdmin(newUserPage);

// ---- POST /admin/users --------------------------------------------------

async function createUserAction(ctx: Parameters<Handler>[0]): Promise<void> {
  const {
    username = '',
    displayName = '',
    email = '',
    tempPassword = '',
    orgRole = 'member',
  } = ctx.body;

  if (!username || !displayName || !email || !tempPassword) {
    ctx.res.writeHead(302, { Location: '/admin/users/new?msg=All+fields+required&t=error' });
    ctx.res.end();
    return;
  }

  const policy = validatePasswordPolicy(tempPassword);
  if (!policy.ok) {
    ctx.res.writeHead(302, {
      Location: `/admin/users/new?msg=${encodeURIComponent(policy.error)}&t=error`,
    });
    ctx.res.end();
    return;
  }

  const passwordHash = await hashPassword(tempPassword);
  const id = asUserId(randomBytes(16).toString('hex'));

  const newUser: User = {
    id,
    username,
    displayName,
    email,
    passwordHash,
    orgRole: orgRole === 'admin' ? 'admin' : 'member',
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  createUser(newUser);
  ctx.audit({ userId: ctx.user!.id, action: 'user_create', resource: username, details: '' });

  ctx.res.writeHead(302, { Location: '/admin/users?msg=User+created&t=success' });
  ctx.res.end();
}

export const postAdminUsers: Handler = requireOrgAdmin(createUserAction);

// ---- POST /admin/users/:id/disable | enable ----------------------------

async function toggleUserStatus(
  ctx: Parameters<Handler>[0],
  newStatus: 'active' | 'disabled',
): Promise<void> {
  const target = findUserById(asUserId(ctx.params.id!));
  if (!target) {
    ctx.res.writeHead(404, { 'Content-Type': 'text/plain' });
    ctx.res.end('User not found');
    return;
  }
  updateUser({ ...target, status: newStatus });
  ctx.audit({
    userId: ctx.user!.id,
    action: `user_${newStatus}`,
    resource: target.username,
    details: '',
  });
  ctx.res.writeHead(302, { Location: '/admin/users?msg=Status+updated&t=success' });
  ctx.res.end();
}

export const postAdminUserDisable: Handler = requireOrgAdmin((ctx) =>
  toggleUserStatus(ctx, 'disabled'),
);
export const postAdminUserEnable: Handler = requireOrgAdmin((ctx) =>
  toggleUserStatus(ctx, 'active'),
);

// ---- POST /admin/users/:id/reset-password ------------------------------

async function resetPasswordAction(ctx: Parameters<Handler>[0]): Promise<void> {
  const target = findUserById(asUserId(ctx.params.id!));
  if (!target) {
    ctx.res.writeHead(404, { 'Content-Type': 'text/plain' });
    ctx.res.end('User not found');
    return;
  }

  const tempPw = randomBytes(12).toString('base64url');
  const passwordHash = await hashPassword(tempPw);
  updateUser({ ...target, passwordHash });
  ctx.audit({
    userId: ctx.user!.id,
    action: 'user_reset_password',
    resource: target.username,
    details: '',
  });

  // Show temp password once
  const body = `
<div class="page-header"><h1>Password reset</h1></div>
<div class="info-card">
  <p>Temporary password for <strong>${esc(target.username)}</strong>:</p>
  <pre class="secret-once">${esc(tempPw)}</pre>
  <p><strong>Copy it now.</strong> It will not be shown again.</p>
  <a href="/admin/users" class="btn btn--secondary">Back to users</a>
</div>`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(orgLayout('Password reset', ctx.user!, body));
}

export const postAdminUserResetPw: Handler = requireOrgAdmin(resetPasswordAction);

// ---- GET /admin/teams ---------------------------------------------------

async function listTeamsPage(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const teams = listTeams();
  const allMemberships = listMemberships();

  const rows = teams.map((t) => {
    const memberCount = allMemberships.filter((m) => m.teamId === t.id).length;
    return {
      slug: t.slug,
      name: t.name,
      visibility: t.visibility,
      retentionDays: String(t.retentionDays),
      members: String(memberCount),
      actions: `<a href="/admin/teams/${esc(t.slug)}" class="btn btn--small btn--secondary">Manage</a>`,
    };
  });

  const body = `
<div class="page-header">
  <h1>Teams</h1>
  <a href="/admin/teams/new" class="btn btn--primary">Create team</a>
</div>
${table(
  [
    { key: 'slug', label: 'Slug' },
    { key: 'name', label: 'Name' },
    { key: 'visibility', label: 'Visibility' },
    { key: 'retentionDays', label: 'Retention (days)' },
    { key: 'members', label: 'Members' },
    { key: 'actions', label: '', trusted: true },
  ],
  rows,
)}`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(orgLayout('Teams', user, body));
}

export const getAdminTeams: Handler = requireOrgAdmin(listTeamsPage);

// ---- GET /admin/teams/new -----------------------------------------------

async function newTeamPage(ctx: Parameters<Handler>[0]): Promise<void> {
  const body = `
<div class="page-header">
  <h1>Create team</h1>
  <a href="/admin/teams" class="btn btn--secondary">← Back</a>
</div>
<form method="POST" action="/admin/teams" class="form-card">
  ${csrfField(ctx.session!.csrfToken)}
  ${formRow({ name: 'slug', label: 'Slug (a-z0-9-, 2-32 chars)', required: true, placeholder: 'my-team' })}
  ${formRow({ name: 'name', label: 'Display name', required: true })}
  ${formRow({ name: 'description', label: 'Description' })}
  ${formRow({
    name: 'visibility',
    label: 'Visibility',
    type: 'select',
    options: [
      { value: 'org-readable', label: 'Org-readable' },
      { value: 'private', label: 'Private' },
    ],
  })}
  ${formRow({ name: 'retentionDays', label: 'Retention days', type: 'number', value: '365' })}
  <button type="submit" class="btn btn--primary">Create team</button>
</form>`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(orgLayout('Create team', ctx.user!, body));
}

export const getAdminTeamNew: Handler = requireOrgAdmin(newTeamPage);

// ---- POST /admin/teams --------------------------------------------------

async function createTeamAction(ctx: Parameters<Handler>[0]): Promise<void> {
  const {
    slug = '',
    name = '',
    description = '',
    visibility = 'org-readable',
    retentionDays = '365',
  } = ctx.body;

  if (!TEAM_SLUG_RE.test(slug)) {
    ctx.res.writeHead(302, {
      Location: '/admin/teams/new?msg=Invalid+slug+(a-z0-9-,+2-32+chars)&t=error',
    });
    ctx.res.end();
    return;
  }

  if (findTeamBySlug(slug)) {
    ctx.res.writeHead(302, { Location: '/admin/teams/new?msg=Slug+already+exists&t=error' });
    ctx.res.end();
    return;
  }

  const ret = Number.parseInt(retentionDays, 10);
  const newTeam: Team = {
    id: asTeamId(randomBytes(16).toString('hex')),
    slug,
    name,
    description,
    visibility: visibility === 'private' ? 'private' : 'org-readable',
    retentionDays: Number.isNaN(ret) ? 365 : ret,
    createdAt: new Date().toISOString(),
  };

  createTeam(newTeam);
  await ctx.engine.ensureTeamBrain(slug);
  ctx.audit({ userId: ctx.user!.id, action: 'team_create', resource: slug, details: '' });

  ctx.res.writeHead(302, { Location: '/admin/teams?msg=Team+created&t=success' });
  ctx.res.end();
}

export const postAdminTeams: Handler = requireOrgAdmin(createTeamAction);

// ---- GET /admin/teams/:slug --------------------------------------------

async function manageTeamPage(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const slug = ctx.params.slug!;
  const team = findTeamBySlug(slug);
  if (!team) {
    ctx.res.writeHead(404, { 'Content-Type': 'text/plain' });
    ctx.res.end('Team not found');
    return;
  }

  const memberships = listMembershipsForTeam(team.id);
  const allUsers = listUsers();
  const userById = new Map(allUsers.map((u) => [u.id, u]));

  const memberRows = memberships.map((m) => {
    const u = userById.get(m.userId);
    return {
      username: u?.username ?? m.userId,
      role: m.teamRole,
      actions: `<form method="POST" action="/admin/teams/${esc(slug)}/members/${esc(m.userId)}/remove" style="display:inline">
  ${csrfField(ctx.session!.csrfToken)}
  <button type="submit" class="btn btn--small btn--danger">Remove</button>
</form>`,
    };
  });

  const nonMembers = allUsers.filter(
    (u) => u.status === 'active' && !memberships.find((m) => m.userId === u.id),
  );

  const body = `
<div class="page-header">
  <h1>Team: ${esc(team.name)}</h1>
  <a href="/admin/teams" class="btn btn--secondary">← Back</a>
</div>

<section>
  <h2>Settings</h2>
  <form method="POST" action="/admin/teams/${esc(slug)}/edit" class="form-card">
    ${csrfField(ctx.session!.csrfToken)}
    ${formRow({
      name: 'visibility',
      label: 'Visibility',
      type: 'select',
      value: team.visibility,
      options: [
        { value: 'org-readable', label: 'Org-readable' },
        { value: 'private', label: 'Private' },
      ],
    })}
    ${formRow({ name: 'retentionDays', label: 'Retention days', type: 'number', value: String(team.retentionDays) })}
    <button type="submit" class="btn btn--primary">Save</button>
  </form>
</section>

<section>
  <h2>Members</h2>
  ${table(
    [
      { key: 'username', label: 'Username' },
      { key: 'role', label: 'Role' },
      { key: 'actions', label: '', trusted: true },
    ],
    memberRows,
    'No members yet.',
  )}
</section>

<section>
  <h2>Add member</h2>
  <form method="POST" action="/admin/teams/${esc(slug)}/members" class="form-row-inline">
    ${csrfField(ctx.session!.csrfToken)}
    <select name="userId">
      ${nonMembers.map((u) => `<option value="${esc(u.id)}">${esc(u.username)}</option>`).join('')}
    </select>
    <select name="teamRole">
      ${(['viewer', 'member', 'lead'] as TeamRole[]).map((r) => `<option value="${r}">${r}</option>`).join('')}
    </select>
    <button type="submit" class="btn btn--primary">Add</button>
  </form>
</section>`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(orgLayout(`Team: ${team.name}`, user, body));
}

export const getAdminTeam: Handler = requireOrgAdmin(manageTeamPage);

// ---- POST /admin/teams/:slug/edit --------------------------------------

async function editTeamAction(ctx: Parameters<Handler>[0]): Promise<void> {
  const slug = ctx.params.slug!;
  const team = findTeamBySlug(slug);
  if (!team) {
    ctx.res.writeHead(404, { 'Content-Type': 'text/plain' });
    ctx.res.end('Team not found');
    return;
  }

  const { visibility = team.visibility, retentionDays = String(team.retentionDays) } = ctx.body;
  const ret = Number.parseInt(retentionDays, 10);

  updateTeam({
    ...team,
    visibility: visibility === 'private' ? 'private' : 'org-readable',
    retentionDays: Number.isNaN(ret) ? team.retentionDays : ret,
  });

  ctx.audit({ userId: ctx.user!.id, action: 'team_update', resource: slug, details: '' });
  ctx.res.writeHead(302, {
    Location: `/admin/teams/${encodeURIComponent(slug)}?msg=Team+updated&t=success`,
  });
  ctx.res.end();
}

export const postAdminTeamEdit: Handler = requireOrgAdmin(editTeamAction);

// ---- POST /admin/teams/:slug/members -----------------------------------

async function addMemberAction(ctx: Parameters<Handler>[0]): Promise<void> {
  const slug = ctx.params.slug!;
  const team = findTeamBySlug(slug);
  if (!team) {
    ctx.res.writeHead(404, { 'Content-Type': 'text/plain' });
    ctx.res.end('Team not found');
    return;
  }

  const { userId = '', teamRole = 'viewer' } = ctx.body;
  if (!userId) {
    ctx.res.writeHead(302, {
      Location: `/admin/teams/${encodeURIComponent(slug)}?msg=No+user+selected&t=error`,
    });
    ctx.res.end();
    return;
  }

  addMembership({
    userId: asUserId(userId),
    teamId: team.id,
    teamRole: (['lead', 'member', 'viewer'] as TeamRole[]).includes(teamRole as TeamRole)
      ? (teamRole as TeamRole)
      : 'viewer',
    addedAt: new Date().toISOString(),
  });

  ctx.audit({ userId: ctx.user!.id, action: 'member_add', resource: slug, details: userId });
  ctx.res.writeHead(302, {
    Location: `/admin/teams/${encodeURIComponent(slug)}?msg=Member+added&t=success`,
  });
  ctx.res.end();
}

export const postAdminTeamMember: Handler = requireOrgAdmin(addMemberAction);

// ---- POST /admin/teams/:slug/members/:userId/remove -------------------

async function removeMemberAction(ctx: Parameters<Handler>[0]): Promise<void> {
  const slug = ctx.params.slug!;
  const team = findTeamBySlug(slug);
  if (!team) {
    ctx.res.writeHead(404, { 'Content-Type': 'text/plain' });
    ctx.res.end('Team not found');
    return;
  }

  const userId = asUserId(ctx.params.userId!);
  removeMembership(userId, team.id);
  ctx.audit({ userId: ctx.user!.id, action: 'member_remove', resource: slug, details: userId });
  ctx.res.writeHead(302, {
    Location: `/admin/teams/${encodeURIComponent(slug)}?msg=Member+removed&t=success`,
  });
  ctx.res.end();
}

export const postAdminTeamMemberRemove: Handler = requireOrgAdmin(removeMemberAction);

// ---- GET /admin/audit --------------------------------------------------

async function auditPage(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const { userId: filterUser = '', action: filterAction = '', since = '' } = ctx.query;

  const fromDate = since ? new Date(since) : undefined;

  const entries = readFilteredAuditLog({
    userId: filterUser || undefined,
    action: filterAction || undefined,
    from: fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : undefined,
  })
    .slice(-200)
    .reverse();

  const rows = entries.map((e) => ({
    ts: e.ts.slice(0, 19).replace('T', ' '),
    userId: e.userId,
    action: e.action,
    resource: e.resource,
    details: e.details,
  }));

  const body = `
<div class="page-header">
  <h1>Audit Log</h1>
</div>
<form method="GET" action="/admin/audit" class="filter-form">
  ${formRow({ name: 'userId', label: 'Filter by user', value: filterUser })}
  ${formRow({ name: 'action', label: 'Filter by action', value: filterAction })}
  ${formRow({ name: 'since', label: 'Since (YYYY-MM-DD)', value: since })}
  <button type="submit" class="btn btn--secondary">Filter</button>
  <a href="/admin/audit" class="btn btn--link">Clear</a>
</form>
${table(
  [
    { key: 'ts', label: 'Time' },
    { key: 'userId', label: 'User' },
    { key: 'action', label: 'Action' },
    { key: 'resource', label: 'Resource' },
    { key: 'details', label: 'Details' },
  ],
  rows,
  'No audit entries match.',
)}`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(orgLayout('Audit log', user, body));
}

export const getAdminAudit: Handler = requireOrgAdmin(auditPage);
