/**
 * Programmatic server bootstrap for seed scripts.
 *
 * Creates claire as the org admin directly via stores (bypassing HTTP bootstrap),
 * then starts the HTTP server on an ephemeral port against the given dataDir.
 */

import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export interface BootstrappedServer {
  readonly server: Server;
  readonly baseUrl: string;
  readonly shutdown: () => Promise<void>;
}

export async function bootstrapServer(dataDir: string, port = 0): Promise<BootstrappedServer> {
  // Set data dir before any store imports (they read env at import time via config.ts)
  process.env.LBT_DATA_DIR = dataDir;

  mkdirSync(join(dataDir, 'db'), { recursive: true });
  mkdirSync(join(dataDir, 'brains'), { recursive: true });

  // Bootstrap claire as org admin directly via stores
  const { hashPassword } = await import('../../src/auth/password.js');
  const { createUser, listUsers } = await import('../../src/store/users-store.js');
  const { logAuditEvent } = await import('../../src/store/audit-store.js');
  const { asUserId } = await import('../../src/domain/types.js');
  const { randomBytes } = await import('node:crypto');

  const existing = listUsers();
  if (existing.length === 0) {
    // All demo users are seeded directly via store (bypasses HTTP password policy).
    // The real password policy (min 10 chars) remains enforced at HTTP boundaries.
    const DEMO_USERS: Array<{
      username: string;
      displayName: string;
      email: string;
      orgRole: 'admin' | 'member';
    }> = [
      {
        username: 'claire',
        displayName: 'Claire Moreau',
        email: 'claire@borealis-dynamics.dev',
        orgRole: 'admin',
      },
      {
        username: 'alice',
        displayName: 'Alice Tan',
        email: 'alice@borealis-dynamics.dev',
        orgRole: 'member',
      },
      {
        username: 'bob',
        displayName: 'Bob Petrov',
        email: 'bob@borealis-dynamics.dev',
        orgRole: 'member',
      },
      {
        username: 'dana',
        displayName: 'Dana Okafor',
        email: 'dana@borealis-dynamics.dev',
        orgRole: 'member',
      },
      {
        username: 'eric',
        displayName: 'Eric Lindqvist',
        email: 'eric@borealis-dynamics.dev',
        orgRole: 'member',
      },
      {
        username: 'fatima',
        displayName: 'Fatima Benali',
        email: 'fatima@borealis-dynamics.dev',
        orgRole: 'member',
      },
      {
        username: 'victor',
        displayName: 'Victor Haas',
        email: 'victor@borealis-dynamics.dev',
        orgRole: 'member',
      },
    ];

    // Hash "123" once — same password for every demo persona (frictionless demos).
    const demoHash = await hashPassword('123');
    const now = new Date().toISOString();

    for (const u of DEMO_USERS) {
      createUser({
        id: asUserId(randomBytes(16).toString('hex')),
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        passwordHash: demoHash,
        orgRole: u.orgRole,
        status: 'active',
        createdAt: now,
      });

      // Emit a user_create audit entry so /admin/audit still tells the full story.
      logAuditEvent({
        ts: now,
        userId: 'system',
        action: u.orgRole === 'admin' ? 'bootstrap' : 'user_create',
        resource: u.username,
        details: 'Demo user created',
      });
    }
  }

  // Build engine
  const { createEngine } = await import('../../src/engine/facade.js');
  const brainsDir = join(dataDir, 'brains');
  const engine = createEngine({ brainsDir });

  // Build router (same pattern as e2e-flow.test.ts)
  const { Router, createAppServer } = await import('../../src/server/http.js');
  const { resolveAuth } = await import('../../src/server/middleware.js');
  const { getLogin, postLogin, postLogout } = await import('../../src/server/routes/auth.js');
  const { getDashboard } = await import('../../src/server/routes/dashboard.js');
  const { getSearch, postSearch } = await import('../../src/server/routes/search.js');
  const { getTeam, getWikiIndex, getWikiNote, postNoteHandler } = await import(
    '../../src/server/routes/teams.js'
  );
  const { getProfile, postChangePassword, postMintToken, postRevokeToken } = await import(
    '../../src/server/routes/profile.js'
  );
  const {
    getAdminAudit,
    getAdminTeam,
    getAdminTeamNew,
    getAdminTeams,
    getAdminUserNew,
    getAdminUsers,
    postAdminTeamEdit,
    postAdminTeamMember,
    postAdminTeamMemberRemove,
    postAdminTeams,
    postAdminUserDisable,
    postAdminUserEnable,
    postAdminUserResetPw,
    postAdminUsers,
  } = await import('../../src/server/routes/admin.js');

  const router = new Router();
  router.register('GET', '/healthz', async (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ ok: true }));
  });
  router.register('GET', '/login', getLogin);
  router.register('POST', '/login', postLogin);
  router.register('POST', '/logout', postLogout);
  router.register('GET', '/', getDashboard);
  router.register('GET', '/search', getSearch);
  router.register('POST', '/search', postSearch);
  router.register('GET', '/t/:slug', getTeam);
  router.register('GET', '/t/:slug/wiki', getWikiIndex);
  router.register('GET', '/t/:slug/wiki/note/:noteId', getWikiNote);
  router.register('POST', '/t/:slug/notes', postNoteHandler);
  router.register('GET', '/me', getProfile);
  router.register('POST', '/me/password', postChangePassword);
  router.register('POST', '/me/tokens', postMintToken);
  router.register('POST', '/me/tokens/:hash/revoke', postRevokeToken);
  router.register('GET', '/admin/users', getAdminUsers);
  router.register('GET', '/admin/users/new', getAdminUserNew);
  router.register('POST', '/admin/users', postAdminUsers);
  router.register('POST', '/admin/users/:id/disable', postAdminUserDisable);
  router.register('POST', '/admin/users/:id/enable', postAdminUserEnable);
  router.register('POST', '/admin/users/:id/reset-password', postAdminUserResetPw);
  router.register('GET', '/admin/teams', getAdminTeams);
  router.register('GET', '/admin/teams/new', getAdminTeamNew);
  router.register('POST', '/admin/teams', postAdminTeams);
  router.register('GET', '/admin/teams/:slug', getAdminTeam);
  router.register('POST', '/admin/teams/:slug/edit', postAdminTeamEdit);
  router.register('POST', '/admin/teams/:slug/members', postAdminTeamMember);
  router.register('POST', '/admin/teams/:slug/members/:userId/remove', postAdminTeamMemberRemove);
  router.register('GET', '/admin/audit', getAdminAudit);

  const auditModule = await import('../../src/store/audit-store.js');

  function audit(entry: Omit<import('../../src/domain/types.js').AuditEntry, 'ts'>): void {
    auditModule.logAuditEvent({ ...entry, ts: new Date().toISOString() });
  }

  const app = createAppServer(router, {
    stores: { dataDir },
    engine,
    audit,
    authMiddleware: resolveAuth,
  });

  const server = await new Promise<Server>((resolve) => {
    app.listen(port, '127.0.0.1', () => resolve(app));
  });

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const shutdown = async (): Promise<void> => {
    await engine.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, baseUrl, shutdown };
}
