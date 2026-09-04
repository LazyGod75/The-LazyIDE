/**
 * Test server helper.
 * Starts the app on an ephemeral port with the stub engine.
 * Exports buildTestServer() for integration tests.
 *
 * IMPORTANT: Must be imported AFTER LBT_DATA_DIR is set in the environment.
 */

import type { AddressInfo } from 'node:net';

import { EngineStub } from '../../src/server/engine-stub.js';
import { Router, createAppServer } from '../../src/server/http.js';
import { resolveAuth } from '../../src/server/middleware.js';
import { logAuditEvent } from '../../src/store/audit-store.js';

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { hashPassword } from '../../src/auth/password.js';
import { asUserId } from '../../src/domain/types.js';
import type { AuditEntry, User } from '../../src/domain/types.js';
// Bootstrap if needed (first run creates admin)
import { createUser, listUsers } from '../../src/store/users-store.js';

import {
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
} from '../../src/server/routes/admin.js';
// Routes
import { getLogin, postLogin, postLogout } from '../../src/server/routes/auth.js';
import { getDashboard } from '../../src/server/routes/dashboard.js';
import {
  getProfile,
  postChangePassword,
  postMintToken,
  postRevokeToken,
} from '../../src/server/routes/profile.js';
import { getSearch, postSearch } from '../../src/server/routes/search.js';
import {
  getTeam,
  getWikiIndex,
  getWikiNote,
  postNoteHandler,
} from '../../src/server/routes/teams.js';

async function bootstrapIfNeeded(): Promise<void> {
  const dataDir = process.env.LBT_DATA_DIR ?? './data';
  mkdirSync(`${dataDir}/db`, { recursive: true });

  const users = listUsers();
  if (users.length > 0) return;

  const tempPw = 'bootstrap-admin-pw-99';
  const passwordHash = await hashPassword(tempPw);
  const admin: User = {
    id: asUserId(randomBytes(16).toString('hex')),
    username: 'admin',
    displayName: 'Administrator',
    email: 'admin@localhost',
    passwordHash,
    orgRole: 'admin',
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  createUser(admin);
  logAuditEvent({
    ts: new Date().toISOString(),
    userId: 'system',
    action: 'bootstrap',
    resource: 'admin',
    details: '',
  });
}

function buildRouter(): Router {
  const router = new Router();

  router.register('GET', '/healthz', async (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
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

  return router;
}

export async function buildTestServer(): Promise<{ srv: import('node:http').Server; url: string }> {
  await bootstrapIfNeeded();

  const engine = new EngineStub();
  const router = buildRouter();

  function audit(entry: Omit<AuditEntry, 'ts'>): void {
    logAuditEvent({ ...entry, ts: new Date().toISOString() });
  }

  const srv = createAppServer(router, {
    stores: { dataDir: process.env.LBT_DATA_DIR ?? './data' },
    engine,
    audit,
    authMiddleware: resolveAuth,
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      resolve({ srv, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}
