/**
 * Server middleware: session auth, RBAC guards, CSRF, security headers.
 *
 * Session auth:
 *  - Parses lbt_session cookie; validates via sessions-store (sweep expired lazily).
 *  - Loads user + memberships; attaches to context.
 *  - Disabled users → 403.
 *
 * RBAC guards:
 *  - requireAuth: must be logged in.
 *  - requireOrgAdmin: must have orgRole === 'admin'.
 *  - requireTeamAccess(slugParam, minRole): resolves team by :slug param;
 *    org-readable teams are readable by any active member;
 *    private teams: only members or org-admin.
 *    Role hierarchy: lead > member > viewer.
 *
 * CSRF:
 *  - All mutating methods (POST/PUT/PATCH/DELETE) require session's csrfToken
 *    in _csrf form field or x-csrf-token header.
 *
 * Security headers applied to every response:
 *  - Content-Security-Policy (strict, no unsafe-inline/eval)
 *  - X-Content-Type-Options: nosniff
 *  - Referrer-Policy: no-referrer
 *  - Cache-Control: no-store on authed pages
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateSessionToken } from '../auth/sessions.js';
import type { Session } from '../domain/types.js';
import type { Membership, Team, TeamRole, User, UserId } from '../domain/types.js';
import { findMembership, listMembershipsForUser } from '../store/memberships-store.js';
import { findTeamBySlug, listTeams } from '../store/teams-store.js';
import { findUserById } from '../store/users-store.js';
import type { Handler, HandlerContext } from './http.js';

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

export function applySecurityHeaders(res: ServerResponse, authed: boolean): void {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'self'",
      "script-src 'self'",
      "img-src 'self' data:",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (authed) {
    res.setHeader('Cache-Control', 'no-store');
  }
}

// ---------------------------------------------------------------------------
// Cookie parsing
// ---------------------------------------------------------------------------

function parseCookie(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').flatMap((pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) return [];
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      return [[k, decodeURIComponent(v)]];
    }),
  );
}

// ---------------------------------------------------------------------------
// Auth middleware factory (used by createAppServer)
// ---------------------------------------------------------------------------

export async function resolveAuth(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ user?: User; session?: Session }> {
  applySecurityHeaders(res, false);

  const cookies = parseCookie(req.headers.cookie);
  const rawToken = cookies.lbt_session;
  if (!rawToken) return {};

  const result = validateSessionToken(rawToken);
  if (!result.ok) return {};

  const session = result.value;
  const user = findUserById(session.userId);
  if (!user || user.status === 'disabled') return {};

  applySecurityHeaders(res, true);
  return { user, session };
}

// ---------------------------------------------------------------------------
// CSRF check
// ---------------------------------------------------------------------------

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function checkCsrf(ctx: HandlerContext): boolean {
  if (!MUTATING_METHODS.has(ctx.req.method ?? '')) return true;
  if (!ctx.session) return false;

  const fromBody = ctx.body._csrf;
  const fromHeader = ctx.req.headers['x-csrf-token'];
  const provided = fromBody ?? (typeof fromHeader === 'string' ? fromHeader : undefined);
  return provided === ctx.session.csrfToken;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function requireAuth(handler: Handler): Handler {
  return async (ctx) => {
    if (!ctx.user || !ctx.session) {
      const dest = encodeURIComponent(ctx.req.url ?? '/');
      ctx.res.writeHead(302, { Location: `/login?next=${dest}` });
      ctx.res.end();
      return;
    }
    if (!checkCsrf(ctx)) {
      ctx.res.writeHead(403, { 'Content-Type': 'text/plain' });
      ctx.res.end('CSRF token mismatch');
      return;
    }
    await handler(ctx);
  };
}

export function requireOrgAdmin(handler: Handler): Handler {
  return requireAuth(async (ctx) => {
    if (ctx.user!.orgRole !== 'admin') {
      ctx.res.writeHead(403, { 'Content-Type': 'text/plain' });
      ctx.res.end('Forbidden — organisation admin required');
      return;
    }
    await handler(ctx);
  });
}

// Role ordering: lead > member > viewer
const ROLE_ORDER: Record<TeamRole, number> = { viewer: 0, member: 1, lead: 2 };

function roleAtLeast(actual: TeamRole, min: TeamRole): boolean {
  return ROLE_ORDER[actual] >= ROLE_ORDER[min];
}

/**
 * Require team access guard.
 *
 * Usage: router.register('GET', '/t/:slug', requireTeamAccess('slug', 'viewer')(handler))
 *
 * - org-readable teams: any active logged-in user can view at 'viewer' level
 * - private teams: only members (org-admin always passes)
 * - For roles above viewer: membership must satisfy minRole
 */
export function requireTeamAccess(slugParam: string, minRole: TeamRole) {
  return (wrappedHandler: Handler): Handler =>
    requireAuth(async (ctx) => {
      const slug = ctx.params[slugParam];
      if (!slug) {
        ctx.res.writeHead(400, { 'Content-Type': 'text/plain' });
        ctx.res.end('Missing team slug');
        return;
      }

      const team = findTeamBySlug(slug);
      if (!team) {
        ctx.res.writeHead(404, { 'Content-Type': 'text/plain' });
        ctx.res.end('Team not found');
        return;
      }

      const user = ctx.user!;

      // Org admins bypass all team ACLs
      if (user.orgRole === 'admin') {
        await wrappedHandler(ctx);
        return;
      }

      const membership = findMembership(user.id, team.id);

      // org-readable + viewer access: any active user qualifies without membership
      if (team.visibility === 'org-readable' && minRole === 'viewer' && !membership) {
        await wrappedHandler(ctx);
        return;
      }

      if (!membership) {
        ctx.res.writeHead(403, { 'Content-Type': 'text/plain' });
        ctx.res.end('Forbidden — no team membership');
        return;
      }

      if (!roleAtLeast(membership.teamRole, minRole)) {
        ctx.res.writeHead(403, { 'Content-Type': 'text/plain' });
        ctx.res.end(`Forbidden — requires ${minRole} role`);
        return;
      }

      await wrappedHandler(ctx);
    });
}

// ---------------------------------------------------------------------------
// Helpers for page handlers
// ---------------------------------------------------------------------------

export interface UserTeamAccess {
  readonly membership: Membership;
  readonly team: Team;
}

/** Return all teams the given user is a member of, with their membership record. */
export function getMemberTeams(userId: UserId): UserTeamAccess[] {
  const memberships = listMembershipsForUser(userId);
  const allTeams = listTeams();
  const byId = new Map(allTeams.map((t) => [t.id, t]));
  return memberships.flatMap((m) => {
    const team = byId.get(m.teamId);
    return team ? [{ membership: m, team }] : [];
  });
}

/**
 * Return all teams visible to the user:
 * - org-readable teams are visible to everyone
 * - private teams: only members and org-admins
 */
export function getVisibleTeams(user: User): Array<{ team: Team; membership: Membership | null }> {
  const allTeams = listTeams();
  const memberships = listMembershipsForUser(user.id);
  const memberMap = new Map(memberships.map((m) => [m.teamId, m]));

  return allTeams.flatMap((team) => {
    if (user.orgRole === 'admin') {
      return [{ team, membership: memberMap.get(team.id) ?? null }];
    }
    const membership = memberMap.get(team.id);
    if (team.visibility === 'org-readable' || membership) {
      return [{ team, membership: membership ?? null }];
    }
    return [];
  });
}
