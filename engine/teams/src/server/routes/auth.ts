/**
 * Auth routes: GET /login, POST /login, POST /logout.
 */

import { verifyPassword } from '../../auth/password.js';
import { globalRateLimiter } from '../../auth/rate-limit.js';
import { createSession, revokeSessionByToken } from '../../auth/sessions.js';
import { getSetting } from '../../store/settings-store.js';
import { findUserByUsername } from '../../store/users-store.js';
import type { Handler } from '../http.js';
import { applySecurityHeaders } from '../middleware.js';
import { esc, flashFromQuery, formRow, layout } from '../render.js';

function getClientIp(req: import('node:http').IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? '0.0.0.0';
}

// Demo personas listed in the login panel (order matches demo guide)
const DEMO_PERSONAS: ReadonlyArray<{
  readonly username: string;
  readonly role: string;
  readonly demo: string;
}> = [
  { username: 'claire', role: 'org admin', demo: 'Manage users, teams, audit log' },
  { username: 'alice', role: 'platform member', demo: 'Note authorship, wiki, search' },
  { username: 'bob', role: 'firmware lead', demo: 'Private team, RTOS decisions' },
  { username: 'dana', role: 'firmware member', demo: 'Hardware bugs, vendor errata' },
  { username: 'eric', role: 'growth + platform viewer', demo: 'Cross-team search isolation' },
  { username: 'fatima', role: 'growth lead', demo: 'Attribution decisions, brand voice' },
  { username: 'victor', role: 'platform viewer', demo: 'Read-only stakeholder persona' },
];

function buildDemoPanel(): string {
  const rows = DEMO_PERSONAS.map(
    (p) =>
      `<tr>
        <td><a href="/login?u=${esc(p.username)}">${esc(p.username)}</a></td>
        <td>${esc(p.role)}</td>
        <td>${esc(p.demo)}</td>
      </tr>`,
  ).join('\n');

  return `
<div class="demo-panel">
  <h2>Demo personas</h2>
  <p>Password for every persona: <code>123</code></p>
  <table class="data-table">
    <thead>
      <tr><th>Username</th><th>Role</th><th>What they demo</th></tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</div>`;
}

export const getLogin: Handler = async (ctx) => {
  if (ctx.user) {
    ctx.res.writeHead(302, { Location: '/' });
    ctx.res.end();
    return;
  }

  applySecurityHeaders(ctx.res, false);
  const { flash, flashType } = flashFromQuery(ctx.query.msg, ctx.query.t);
  const demoMode = getSetting('demo_mode') === 'true';
  const orgName = getSetting('org_name') ?? 'LazyBrain Teams';

  // Support ?u=alice prefill (no auto-login — password still typed manually)
  const prefillUsername = typeof ctx.query.u === 'string' ? ctx.query.u : '';

  const body = `
<div class="auth-card">
  <h1>Sign in to ${esc(orgName)}</h1>
  ${ctx.query.msg ? `<div class="flash flash--${esc(flashType ?? 'info')}">${esc(flash ?? '')}</div>` : ''}
  <form method="POST" action="/login">
    ${formRow({ name: 'username', label: 'Username', required: true, placeholder: 'your-username', value: prefillUsername })}
    ${formRow({ name: 'password', label: 'Password', type: 'password', required: true })}
    <button type="submit" class="btn btn--primary">Sign in</button>
  </form>
  ${demoMode ? buildDemoPanel() : ''}
</div>`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(layout('Sign in', undefined, body, { demoMode, orgName }));
};

export const postLogin: Handler = async (ctx) => {
  const ip = getClientIp(ctx.req);
  const { username = '', password = '' } = ctx.body;

  if (!globalRateLimiter.isAllowed(username, ip)) {
    applySecurityHeaders(ctx.res, false);
    ctx.audit({
      userId: 'system',
      action: 'login_failed',
      resource: username,
      details: 'rate_limited',
    });
    ctx.res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
    ctx.res.end(
      layout(
        'Sign in',
        undefined,
        `
<div class="auth-card">
  <h1>Too many attempts</h1>
  <p>Too many failed login attempts. Please wait 60 seconds before trying again.</p>
  <a href="/login">Back to sign in</a>
</div>`,
      ),
    );
    return;
  }

  const user = findUserByUsername(username);
  if (!user) {
    globalRateLimiter.recordFailure(username, ip);
    ctx.audit({
      userId: 'system',
      action: 'login_failed',
      resource: username,
      details: 'user_not_found',
    });
    ctx.res.writeHead(302, { Location: '/login?msg=Invalid+username+or+password&t=error' });
    ctx.res.end();
    return;
  }

  if (user.status === 'disabled') {
    globalRateLimiter.recordFailure(username, ip);
    ctx.audit({
      userId: user.id,
      action: 'login_failed',
      resource: username,
      details: 'account_disabled',
    });
    ctx.res.writeHead(302, { Location: '/login?msg=Account+disabled&t=error' });
    ctx.res.end();
    return;
  }

  const verified = await verifyPassword(password, user.passwordHash);
  if (!verified.ok) {
    globalRateLimiter.recordFailure(username, ip);
    ctx.audit({
      userId: user.id,
      action: 'login_failed',
      resource: username,
      details: 'bad_password',
    });
    ctx.res.writeHead(302, { Location: '/login?msg=Invalid+username+or+password&t=error' });
    ctx.res.end();
    return;
  }

  globalRateLimiter.recordSuccess(username, ip);
  const { rawToken } = createSession(user.id);
  ctx.audit({ userId: user.id, action: 'login', resource: username, details: '' });

  const cookieValue = `lbt_session=${encodeURIComponent(rawToken)}; HttpOnly; SameSite=Lax; Path=/`;
  const next = typeof ctx.body.next === 'string' ? ctx.body.next : '/';
  const dest = next.startsWith('/') ? next : '/';

  ctx.res.writeHead(302, {
    'Set-Cookie': cookieValue,
    Location: dest,
  });
  ctx.res.end();
};

export const postLogout: Handler = async (ctx) => {
  const cookies = (ctx.req.headers.cookie ?? '').split(';').reduce(
    (acc, pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) return acc;
      acc[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
      return acc;
    },
    {} as Record<string, string>,
  );

  const rawToken = cookies.lbt_session;
  if (rawToken) {
    revokeSessionByToken(rawToken);
    if (ctx.user) {
      ctx.audit({
        userId: ctx.user.id,
        action: 'logout',
        resource: ctx.user.username,
        details: '',
      });
    }
  }

  ctx.res.writeHead(302, {
    'Set-Cookie': 'lbt_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    Location: '/login?msg=Signed+out&t=success',
  });
  ctx.res.end();
};
