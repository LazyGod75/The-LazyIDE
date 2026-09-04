/**
 * Profile routes:
 *   GET  /me                    — profile + capture tokens
 *   POST /me/password           — change password
 *   POST /me/tokens             — mint capture token (shows raw ONCE)
 *   POST /me/tokens/:hash/revoke — revoke token
 */

import { hashPassword, validatePasswordPolicy, verifyPassword } from '../../auth/password.js';
import { mintCaptureToken } from '../../auth/tokens.js';
import type { TeamRole } from '../../domain/types.js';
import { listCaptureTokens, revokeCaptureToken } from '../../store/capture-tokens-store.js';
import { getSetting } from '../../store/settings-store.js';
import { updateUser } from '../../store/users-store.js';
import type { Handler } from '../http.js';
import { requireAuth } from '../middleware.js';
import { getMemberTeams } from '../middleware.js';
import { csrfField, esc, formRow, layout } from '../render.js';

// ---- GET /me -----------------------------------------------------------

async function profilePage(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const orgName = getSetting('org_name') ?? 'LazyBrain Teams';
  const demoMode = getSetting('demo_mode') === 'true';

  const memberTeams = getMemberTeams(user.id);
  const allTokens = listCaptureTokens().filter((t) => t.userId === user.id);

  const tokenRows = allTokens.map((t) => {
    const teamObj = memberTeams.find(({ team }) => team.id === t.teamId);
    return {
      label: t.label,
      team: teamObj?.team.slug ?? t.teamId,
      created: t.createdAt.slice(0, 10),
      status: t.revokedAt
        ? `<span class="badge badge--disabled">revoked ${esc(t.revokedAt.slice(0, 10))}</span>`
        : '<span class="badge badge--active">active</span>',
      actions: t.revokedAt
        ? ''
        : `<form method="POST" action="/me/tokens/${esc(t.tokenHash)}/revoke" style="display:inline">
  ${csrfField(ctx.session!.csrfToken)}
  <button type="submit" class="btn btn--small btn--danger">Revoke</button>
</form>`,
    };
  });

  const teamOptions = memberTeams
    .filter(({ membership }) => (['lead', 'member'] as TeamRole[]).includes(membership.teamRole))
    .map(({ team }) => `<option value="${esc(team.id)}">${esc(team.name)}</option>`)
    .join('');

  const mintForm = teamOptions
    ? `
<section>
  <h2>Mint capture token</h2>
  <form method="POST" action="/me/tokens" class="form-card">
    ${csrfField(ctx.session!.csrfToken)}
    ${formRow({ name: 'label', label: 'Label', required: true, placeholder: 'my-ci-bot' })}
    <div class="form-row">
      <label for="field-teamId">Team</label>
      <select id="field-teamId" name="teamId" required>${teamOptions}</select>
    </div>
    <button type="submit" class="btn btn--primary">Mint token</button>
  </form>
</section>`
    : '<p class="help-text">Join a team as member or lead to mint capture tokens.</p>';

  const body = `
<div class="page-header">
  <h1>${esc(user.displayName)}</h1>
  <p class="subtitle">${esc(user.username)} · ${esc(user.email)} · ${esc(user.orgRole)}</p>
</div>

<section>
  <h2>Change password</h2>
  <form method="POST" action="/me/password" class="form-card">
    ${csrfField(ctx.session!.csrfToken)}
    ${formRow({ name: 'current', label: 'Current password', type: 'password', required: true })}
    ${formRow({ name: 'newPw', label: 'New password (min 10 chars)', type: 'password', required: true })}
    <button type="submit" class="btn btn--primary">Change password</button>
  </form>
</section>

<section>
  <h2>Capture tokens</h2>
  <p class="help-text">Tokens allow agents and CI pipelines to store notes in team brains without an interactive session.</p>
  ${
    allTokens.length > 0
      ? `<table class="data-table">
    <thead><tr><th>Label</th><th>Team</th><th>Created</th><th>Status</th><th></th></tr></thead>
    <tbody>${tokenRows
      .map(
        (r) =>
          `<tr><td>${esc(r.label)}</td><td>${esc(r.team)}</td><td>${esc(r.created)}</td><td>${r.status}</td><td>${r.actions}</td></tr>`,
      )
      .join('\n')}</tbody>
  </table>`
      : '<p class="empty">No tokens yet.</p>'
  }
</section>

${mintForm}`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(layout('/me', user, body, { orgName, demoMode }));
}

export const getProfile: Handler = requireAuth(profilePage);

// ---- POST /me/password -------------------------------------------------

async function changePassword(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const { current = '', newPw = '' } = ctx.body;

  const verified = await verifyPassword(current, user.passwordHash);
  if (!verified.ok) {
    ctx.res.writeHead(302, { Location: '/me?msg=Current+password+incorrect&t=error' });
    ctx.res.end();
    return;
  }

  const policy = validatePasswordPolicy(newPw);
  if (!policy.ok) {
    ctx.res.writeHead(302, { Location: `/me?msg=${encodeURIComponent(policy.error)}&t=error` });
    ctx.res.end();
    return;
  }

  const passwordHash = await hashPassword(newPw);
  updateUser({ ...user, passwordHash });
  ctx.audit({ userId: user.id, action: 'password_change', resource: user.username, details: '' });

  ctx.res.writeHead(302, { Location: '/me?msg=Password+changed&t=success' });
  ctx.res.end();
}

export const postChangePassword: Handler = requireAuth(changePassword);

// ---- POST /me/tokens ---------------------------------------------------

async function mintToken(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const { label = '', teamId = '' } = ctx.body;
  const orgName = getSetting('org_name') ?? 'LazyBrain Teams';
  const demoMode = getSetting('demo_mode') === 'true';

  if (!label || !teamId) {
    ctx.res.writeHead(302, { Location: '/me?msg=Label+and+team+required&t=error' });
    ctx.res.end();
    return;
  }

  // Verify user is member/lead of that team
  const memberTeams = getMemberTeams(user.id);
  const target = memberTeams.find(
    ({ team, membership }) =>
      team.id === teamId && (['lead', 'member'] as TeamRole[]).includes(membership.teamRole),
  );

  if (!target) {
    ctx.res.writeHead(403, { 'Content-Type': 'text/plain' });
    ctx.res.end('Forbidden — not a member/lead of that team');
    return;
  }

  const { rawToken, record } = mintCaptureToken(user.id, target.team.id, label);
  ctx.audit({ userId: user.id, action: 'token_mint', resource: target.team.slug, details: label });

  // Show raw token ONCE — stored hash is in the DB
  const body = `
<div class="page-header">
  <h1>Capture token created</h1>
</div>
<div class="info-card">
  <p><strong>Label:</strong> ${esc(label)}</p>
  <p><strong>Team:</strong> ${esc(target.team.name)}</p>
  <p>Your token (shown <strong>once only</strong>):</p>
  <pre class="secret-once">${esc(String(rawToken))}</pre>
  <p>Use it as an HTTP header: <code>Authorization: Bearer &lt;token&gt;</code></p>
  <p>Token hash stored: <code>${esc(record.tokenHash.slice(0, 12))}…</code></p>
  <a href="/me" class="btn btn--secondary">Back to profile</a>
</div>`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(layout('Token created', user, body, { orgName, demoMode }));
}

export const postMintToken: Handler = requireAuth(mintToken);

// ---- POST /me/tokens/:hash/revoke -------------------------------------

async function revokeToken(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const tokenHash = ctx.params.hash!;

  // Verify the token belongs to this user
  const all = listCaptureTokens();
  const record = all.find((t) => t.tokenHash === tokenHash && t.userId === user.id);
  if (!record) {
    ctx.res.writeHead(403, { 'Content-Type': 'text/plain' });
    ctx.res.end('Forbidden or not found');
    return;
  }

  revokeCaptureToken(tokenHash, new Date().toISOString());
  ctx.audit({
    userId: user.id,
    action: 'token_revoke',
    resource: record.teamId,
    details: record.label,
  });

  ctx.res.writeHead(302, { Location: '/me?msg=Token+revoked&t=success' });
  ctx.res.end();
}

export const postRevokeToken: Handler = requireAuth(revokeToken);
