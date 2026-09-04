/**
 * Server entry point.
 *
 * - Loads config/stores.
 * - Engine selection: LBT_ENGINE=stub → force stub; LBT_ENGINE=real (default)
 *   → try dynamic import('../engine/facade.js'); on failure → stub + stderr warning.
 * - First-run bootstrap: if users.csv is empty, creates org-admin 'admin' with
 *   a RANDOM password printed ONCE to stdout.
 * - Binds 127.0.0.1 on LBT_PORT (default 7777).
 * - Graceful shutdown on SIGINT → engine.shutdown().
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '../auth/password.js';
import { asUserId } from '../domain/types.js';
import type { AuditEntry, User } from '../domain/types.js';
import { logAuditEvent } from '../store/audit-store.js';
import { createUser, listUsers } from '../store/users-store.js';
import type { EngineFacade } from './engine-facade.js';
import { engineStub } from './engine-stub.js';
import { Router, createAppServer } from './http.js';
import { resolveAuth } from './middleware.js';

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
} from './routes/admin.js';
// Routes
import { getLogin, postLogin, postLogout } from './routes/auth.js';
import { getDashboard } from './routes/dashboard.js';
import {
  getProfile,
  postChangePassword,
  postMintToken,
  postRevokeToken,
} from './routes/profile.js';
import { getSearch, postSearch } from './routes/search.js';
import { getTeam, getWikiIndex, getWikiNote, postNoteHandler } from './routes/teams.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Engine loader
// ---------------------------------------------------------------------------

async function loadEngine(): Promise<EngineFacade> {
  const mode = process.env.LBT_ENGINE ?? 'real';

  if (mode === 'stub') {
    process.stderr.write('[engine] active=engine:stub (LBT_ENGINE=stub)\n');
    return engineStub;
  }

  try {
    const mod = (await import('../engine/facade.js')) as {
      createEngine?: () => EngineFacade;
    };
    if (typeof mod.createEngine !== 'function') {
      throw new Error('engine/facade.js does not export createEngine');
    }
    const engine = mod.createEngine();
    process.stderr.write('[engine] active=lazybrain-cli\n');
    return engine;
  } catch (err) {
    process.stderr.write(`[engine] active=engine:stub (real engine unavailable: ${String(err)})\n`);
    return engineStub;
  }
}

// ---------------------------------------------------------------------------
// First-run bootstrap
// ---------------------------------------------------------------------------

async function bootstrapAdminIfNeeded(): Promise<void> {
  const users = listUsers();
  if (users.length > 0) return;

  const tempPw = randomBytes(16).toString('base64url');
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
    details: 'Initial admin account created',
  });

  // Print ONCE to stdout — never stored in plain text
  process.stdout.write(
    `\n╔══════════════════════════════════════════════════════╗\n║  First-run bootstrap                                 ║\n║  Username : admin                                    ║\n║  Password : ${tempPw.padEnd(38)}║\n║  Change this password immediately after first login. ║\n╚══════════════════════════════════════════════════════╝\n\n`,
  );
}

// ---------------------------------------------------------------------------
// Static asset handler
// ---------------------------------------------------------------------------

const ASSETS_DIR = join(__dirname, '..', 'assets');

function serveAsset(
  _req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  filePath: string,
): boolean {
  const fullPath = join(ASSETS_DIR, filePath);
  if (!existsSync(fullPath)) return false;

  const ext = filePath.split('.').pop() ?? '';
  const mimeMap: Record<string, string> = {
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    png: 'image/png',
    svg: 'image/svg+xml',
  };

  const content = readFileSync(fullPath);
  res.writeHead(200, {
    'Content-Type': mimeMap[ext] ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(content);
  return true;
}

// ---------------------------------------------------------------------------
// Router setup
// ---------------------------------------------------------------------------

function buildRouter(): Router {
  const router = new Router();

  // Public
  router.register('GET', '/healthz', async (ctx) => {
    ctx.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    ctx.res.end(JSON.stringify({ ok: true }));
  });
  router.register('GET', '/login', getLogin);
  router.register('POST', '/login', postLogin);
  router.register('POST', '/logout', postLogout);

  // Dashboard
  router.register('GET', '/', getDashboard);

  // Search
  router.register('GET', '/search', getSearch);
  router.register('POST', '/search', postSearch);

  // Teams
  router.register('GET', '/t/:slug', getTeam);
  router.register('GET', '/t/:slug/wiki', getWikiIndex);
  router.register('GET', '/t/:slug/wiki/note/:noteId', getWikiNote);
  router.register('POST', '/t/:slug/notes', postNoteHandler);

  // Profile
  router.register('GET', '/me', getProfile);
  router.register('POST', '/me/password', postChangePassword);
  router.register('POST', '/me/tokens', postMintToken);
  router.register('POST', '/me/tokens/:hash/revoke', postRevokeToken);

  // Admin — users
  router.register('GET', '/admin/users', getAdminUsers);
  router.register('GET', '/admin/users/new', getAdminUserNew);
  router.register('POST', '/admin/users', postAdminUsers);
  router.register('POST', '/admin/users/:id/disable', postAdminUserDisable);
  router.register('POST', '/admin/users/:id/enable', postAdminUserEnable);
  router.register('POST', '/admin/users/:id/reset-password', postAdminUserResetPw);

  // Admin — teams
  router.register('GET', '/admin/teams', getAdminTeams);
  router.register('GET', '/admin/teams/new', getAdminTeamNew);
  router.register('POST', '/admin/teams', postAdminTeams);
  router.register('GET', '/admin/teams/:slug', getAdminTeam);
  router.register('POST', '/admin/teams/:slug/edit', postAdminTeamEdit);
  router.register('POST', '/admin/teams/:slug/members', postAdminTeamMember);
  router.register('POST', '/admin/teams/:slug/members/:userId/remove', postAdminTeamMemberRemove);

  // Admin — audit
  router.register('GET', '/admin/audit', getAdminAudit);

  return router;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await bootstrapAdminIfNeeded();

  const engine = await loadEngine();
  const router = buildRouter();

  const PORT = Number.parseInt(process.env.LBT_PORT ?? '7777', 10);
  const HOST = '127.0.0.1';

  function audit(entry: Omit<AuditEntry, 'ts'>): void {
    logAuditEvent({ ...entry, ts: new Date().toISOString() });
  }

  const app = createAppServer(router, {
    stores: { dataDir: process.env.LBT_DATA_DIR ?? './data' },
    engine,
    audit,
    authMiddleware: resolveAuth,
  });

  // Intercept /assets/* before the router
  const originalServer = app;
  const serverWithAssets = createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/assets/')) {
      const filePath = url.slice('/assets/'.length).split('?')[0]!;
      if (serveAsset(req, res, filePath)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Asset not found');
      return;
    }
    originalServer.emit('request', req, res);
  });

  serverWithAssets.listen(PORT, HOST, () => {
    process.stdout.write(`LazyBrain Teams running at http://${HOST}:${PORT} — Ctrl+C to stop.\n`);
  });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write('\n[server] Shutting down…\n');
    await engine.shutdown();
    serverWithAssets.close(() => {
      process.stderr.write('[server] Stopped.\n');
      process.exit(0);
    });
  }

  process.on('SIGINT', () => {
    shutdown().catch(console.error);
  });
  process.on('SIGTERM', () => {
    shutdown().catch(console.error);
  });
}

main().catch((err) => {
  process.stderr.write(`[fatal] ${String(err)}\n`);
  process.exit(1);
});
