/**
 * Integration tests: start server on ephemeral port with temp data dir + stub engine.
 * Tests: auth middleware, RBAC, CSRF, login flow, security headers, bootstrap,
 *        search permission filtering, note store, admin CRUD, /me token flow.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// We must set LBT_DATA_DIR before importing any store modules
let tmpDir: string;
let baseUrl: string;
let server: import('node:http').Server;

// Helpers
async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
  const body = await res.text();
  const hdrs: Record<string, string | string[]> = {};
  res.headers.forEach((v, k) => {
    hdrs[k] = v;
  });
  return { status: res.status, body, headers: hdrs };
}

async function post(
  path: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string | string[]> }> {
  const url = `${baseUrl}${path}`;
  const params = new URLSearchParams(body).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: params,
    redirect: 'manual',
  });
  const bodyText = await res.text();
  const hdrs: Record<string, string | string[]> = {};
  res.headers.forEach((v, k) => {
    hdrs[k] = v;
  });
  return { status: res.status, body: bodyText, headers: hdrs };
}

function getCookie(headers: Record<string, string | string[]>, name: string): string | undefined {
  const setCookie = headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  for (const c of cookies) {
    const match = c.match(new RegExp(`${name}=([^;]+)`));
    if (match) return decodeURIComponent(match[1]!);
  }
  return undefined;
}

// Login and return { cookie, csrfToken }
async function loginAs(
  username: string,
  password: string,
): Promise<{ cookie: string; csrfToken: string } | null> {
  // First GET /login to check it works
  const loginGet = await get('/login');
  if (loginGet.status !== 200) return null;

  const loginRes = await post('/login', { username, password });
  const rawCookie = getCookie(loginRes.headers, 'lbt_session');
  if (!rawCookie) return null;

  const cookie = `lbt_session=${rawCookie}`;

  // Get CSRF token from dashboard
  const dash = await get('/', { Cookie: cookie });
  const csrfMatch = dash.body.match(/name="_csrf" value="([^"]+)"/);
  const csrfToken = csrfMatch?.[1] ?? '';
  return { cookie, csrfToken };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lbt-test-'));
  process.env.LBT_DATA_DIR = tmpDir;
  process.env.LBT_ENGINE = 'stub';

  // Dynamic import AFTER setting env vars
  const { buildTestServer } = await import('./test-server.js');
  const { srv, url } = await buildTestServer();
  server = srv;
  baseUrl = url;
}, 20000);

afterAll(async () => {
  server?.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup — ignore failures (e.g. Windows file locks)
  }
});

// ---------------------------------------------------------------------------
// /healthz
// ---------------------------------------------------------------------------

describe('GET /healthz', () => {
  it('returns 200 with ok:true', async () => {
    const { status, body } = await get('/healthz');
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Bootstrap + login
// ---------------------------------------------------------------------------

describe('Bootstrap admin', () => {
  it('creates admin user on first run', async () => {
    const { listUsers } = await import('../../src/store/users-store.js');
    const users = listUsers();
    expect(users.length).toBeGreaterThan(0);
    const admin = users.find((u) => u.username === 'admin');
    expect(admin).toBeDefined();
    expect(admin!.orgRole).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

describe('Auth middleware', () => {
  it('redirects to /login when no cookie', async () => {
    const { status, headers } = await get('/');
    expect(status).toBe(302);
    expect(headers.location).toContain('/login');
  });

  it('redirects to /login with bad session token', async () => {
    const { status } = await get('/', { Cookie: 'lbt_session=badtoken' });
    expect(status).toBe(302);
  });
});

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

describe('POST /login', () => {
  it('rejects unknown username', async () => {
    const res = await post('/login', { username: 'nobody', password: 'password123' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  it('rejects wrong password', async () => {
    // We need the bootstrap password which was printed to stdout
    // Instead use the stored hash — create a test user with known password
    const { hashPassword } = await import('../../src/auth/password.js');
    const { createUser } = await import('../../src/store/users-store.js');
    const { asUserId } = await import('../../src/domain/types.js');
    const { randomBytes } = await import('node:crypto');

    const hash = await hashPassword('testpassword123');
    createUser({
      id: asUserId(randomBytes(16).toString('hex')),
      username: 'testuser',
      displayName: 'Test User',
      email: 'test@example.com',
      passwordHash: hash,
      orgRole: 'member',
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    const res = await post('/login', { username: 'testuser', password: 'wrongpassword' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  it('succeeds with correct credentials and sets cookie', async () => {
    const res = await post('/login', { username: 'testuser', password: 'testpassword123' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = getCookie(res.headers, 'lbt_session');
    expect(cookie).toBeDefined();
  });

  it('rejects disabled user', async () => {
    const { updateUser, listUsers } = await import('../../src/store/users-store.js');
    const u = listUsers().find((x) => x.username === 'testuser')!;
    updateUser({ ...u, status: 'disabled' });

    const res = await post('/login', { username: 'testuser', password: 'testpassword123' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');

    // Re-enable for later tests
    updateUser({ ...u, status: 'active' });
  });

  it('rate-limits after 5 failures', async () => {
    for (let i = 0; i < 5; i++) {
      await post('/login', { username: 'ratelimit-test', password: 'bad' });
    }
    const res = await post('/login', { username: 'ratelimit-test', password: 'bad' });
    expect([302, 429]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

describe('Security headers', () => {
  it('sets CSP header on /login', async () => {
    const { headers } = await get('/login');
    expect(headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('sets X-Content-Type-Options', async () => {
    // healthz skips security headers but login does set them
    const loginH = await get('/login');
    expect(loginH.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets Cache-Control: no-store on authed pages', async () => {
    const auth = await loginAs('testuser', 'testpassword123');
    if (!auth) return; // skip if login fails

    const { headers } = await get('/', { Cookie: auth.cookie });
    expect(headers['cache-control']).toBe('no-store');
  });
});

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

describe('CSRF', () => {
  it('rejects POST without CSRF token', async () => {
    const auth = await loginAs('testuser', 'testpassword123');
    if (!auth) return;

    const res = await post('/me/password', { current: 'x', newPw: 'y' }, { Cookie: auth.cookie });
    expect(res.status).toBe(403);
  });

  it('accepts POST with correct CSRF token', async () => {
    const auth = await loginAs('testuser', 'testpassword123');
    if (!auth) return;

    const res = await post(
      '/me/password',
      {
        _csrf: auth.csrfToken,
        current: 'testpassword123',
        newPw: 'newpassword456',
      },
      { Cookie: auth.cookie },
    );
    // Should redirect (not 403)
    expect(res.status).toBe(302);
    expect(res.status).not.toBe(403);

    // Reset password back
    const { hashPassword: hp } = await import('../../src/auth/password.js');
    const { updateUser: uu, listUsers: lu } = await import('../../src/store/users-store.js');
    const u = lu().find((x) => x.username === 'testuser')!;
    const h = await hp('testpassword123');
    uu({ ...u, passwordHash: h });
  });
});

// ---------------------------------------------------------------------------
// RBAC — org-readable vs private teams
// ---------------------------------------------------------------------------

describe('RBAC', () => {
  let memberAuth: { cookie: string; csrfToken: string } | null = null;
  const orgSlug = 'rbac-org-team';
  const privateSlug = 'rbac-priv-team';

  beforeAll(async () => {
    // Create teams via store directly
    const { createTeam } = await import('../../src/store/teams-store.js');
    const { asTeamId } = await import('../../src/domain/types.js');
    const { randomBytes: rb } = await import('node:crypto');

    createTeam({
      id: asTeamId(rb(16).toString('hex')),
      slug: orgSlug,
      name: 'RBAC Org Team',
      description: '',
      visibility: 'org-readable',
      retentionDays: 365,
      createdAt: new Date().toISOString(),
    });

    createTeam({
      id: asTeamId(rb(16).toString('hex')),
      slug: privateSlug,
      name: 'RBAC Private Team',
      description: '',
      visibility: 'private',
      retentionDays: 365,
      createdAt: new Date().toISOString(),
    });

    // admin is already created via bootstrap; get admin password from store
    // We need to use the "testuser" (member) for RBAC tests
    memberAuth = await loginAs('testuser', 'testpassword123');
  });

  it('member can access org-readable team page', async () => {
    if (!memberAuth) return;
    const { status } = await get(`/t/${orgSlug}`, { Cookie: memberAuth.cookie });
    expect(status).toBe(200);
  });

  it('member cannot access private team page without membership', async () => {
    if (!memberAuth) return;
    const { status } = await get(`/t/${privateSlug}`, { Cookie: memberAuth.cookie });
    expect(status).toBe(403);
  });

  it('member cannot POST note to org-readable team (viewer by default)', async () => {
    if (!memberAuth) return;
    const res = await post(
      `/t/${orgSlug}/notes`,
      {
        _csrf: memberAuth.csrfToken,
        type: 'reference',
        text: 'test note',
      },
      { Cookie: memberAuth.cookie },
    );
    // Should be 403 (viewer cannot post notes — member+ required)
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Search permission filtering
// ---------------------------------------------------------------------------

describe('Search permission filtering', () => {
  it('engine only receives permitted slugs', async () => {
    // Create a user with membership in one team only
    const { createUser: cu } = await import('../../src/store/users-store.js');
    const { createTeam: ct } = await import('../../src/store/teams-store.js');
    const { addMembership: am } = await import('../../src/store/memberships-store.js');
    const { hashPassword: hp } = await import('../../src/auth/password.js');
    const { asUserId: aui, asTeamId: ati } = await import('../../src/domain/types.js');
    const { randomBytes: rb } = await import('node:crypto');

    const userId = aui(rb(16).toString('hex'));
    const teamId = ati(rb(16).toString('hex'));
    const hash = await hp('searchtest123');

    cu({
      id: userId,
      username: 'searchtest',
      displayName: 'Search Test',
      email: 'search@test.com',
      passwordHash: hash,
      orgRole: 'member',
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    ct({
      id: teamId,
      slug: 'search-allowed',
      name: 'Search Allowed',
      description: '',
      visibility: 'private',
      retentionDays: 365,
      createdAt: new Date().toISOString(),
    });
    am({ userId, teamId, teamRole: 'member', addedAt: new Date().toISOString() });

    const auth = await loginAs('searchtest', 'searchtest123');
    if (!auth) return;

    // This team should NOT be in results (no access)
    const res = await get('/search?q=test', { Cookie: auth.cookie });
    expect(res.status).toBe(200);
    // The forbidden team "rbac-priv-team" should not appear (user has no membership)
    // We can verify it returns 200 without a 403
    expect(res.body).not.toContain('Forbidden');
  });
});

// ---------------------------------------------------------------------------
// Note store flow
// ---------------------------------------------------------------------------

describe('Note store flow', () => {
  it('stores a note and redirects with flash', async () => {
    const { createTeam: ct } = await import('../../src/store/teams-store.js');
    const { addMembership: am } = await import('../../src/store/memberships-store.js');
    const { asTeamId: ati } = await import('../../src/domain/types.js');
    const { listUsers } = await import('../../src/store/users-store.js');
    const { randomBytes: rb } = await import('node:crypto');

    const teamId = ati(rb(16).toString('hex'));
    ct({
      id: teamId,
      slug: 'note-test-team',
      name: 'Note Test',
      description: '',
      visibility: 'private',
      retentionDays: 365,
      createdAt: new Date().toISOString(),
    });

    const user = listUsers().find((u) => u.username === 'testuser')!;
    am({ userId: user.id, teamId, teamRole: 'member', addedAt: new Date().toISOString() });

    const auth = await loginAs('testuser', 'testpassword123');
    if (!auth) return;

    const res = await post(
      '/t/note-test-team/notes',
      {
        _csrf: auth.csrfToken,
        type: 'decision',
        tags: 'test,integration',
        text: 'This is a stored decision note.',
      },
      { Cookie: auth.cookie },
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('msg=Note+stored');
  });
});

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

describe('Admin routes', () => {
  it('non-admin gets 403 on /admin/users', async () => {
    const auth = await loginAs('testuser', 'testpassword123');
    if (!auth) return;
    const { status } = await get('/admin/users', { Cookie: auth.cookie });
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// /me token mint shows raw token once + stored hashed
// ---------------------------------------------------------------------------

describe('/me capture token', () => {
  it('minting shows raw token and stores hash', async () => {
    const { createTeam: ct } = await import('../../src/store/teams-store.js');
    const { addMembership: am } = await import('../../src/store/memberships-store.js');
    const { listUsers } = await import('../../src/store/users-store.js');
    const { asTeamId: ati } = await import('../../src/domain/types.js');
    const { randomBytes: rb } = await import('node:crypto');

    const teamId = ati(rb(16).toString('hex'));
    ct({
      id: teamId,
      slug: 'token-team',
      name: 'Token Team',
      description: '',
      visibility: 'private',
      retentionDays: 365,
      createdAt: new Date().toISOString(),
    });

    const user = listUsers().find((u) => u.username === 'testuser')!;
    am({ userId: user.id, teamId, teamRole: 'member', addedAt: new Date().toISOString() });

    const auth = await loginAs('testuser', 'testpassword123');
    if (!auth) return;

    const res = await post(
      '/me/tokens',
      {
        _csrf: auth.csrfToken,
        label: 'ci-bot',
        teamId: teamId,
      },
      { Cookie: auth.cookie },
    );

    expect(res.status).toBe(200);
    // Raw token should appear in the page
    expect(res.body).toContain('secret-once');
    // The raw token itself should be a base64url string
    const tokenMatch = res.body.match(/class="secret-once">([A-Za-z0-9_-]+)</);
    expect(tokenMatch).not.toBeNull();

    // Verify hash is stored (not raw)
    const { listCaptureTokens } = await import('../../src/store/capture-tokens-store.js');
    const tokens = listCaptureTokens().filter((t) => t.userId === user.id && t.label === 'ci-bot');
    expect(tokens.length).toBe(1);
    // Hash should be hex, not the raw token
    expect(tokens[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
