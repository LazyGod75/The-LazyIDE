/**
 * GET / — org dashboard.
 * Lists visible teams with stats, recent audit activity, quick search.
 */

import { readAuditLog } from '../../store/audit-store.js';
import { getSetting } from '../../store/settings-store.js';
import type { Handler } from '../http.js';
import { requireAuth } from '../middleware.js';
import { getVisibleTeams } from '../middleware.js';
import { esc, layout, roleBadge, visibilityBadge } from '../render.js';

async function dashboardPage(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const orgName = getSetting('org_name') ?? 'LazyBrain Teams';
  const demoMode = getSetting('demo_mode') === 'true';

  const visibleTeams = getVisibleTeams(user);

  // Load stats for each visible team (parallel-ish via sequential await — stub is fast)
  const teamCards: string[] = [];
  for (const { team, membership } of visibleTeams) {
    let statsHtml: string;
    try {
      const stats = await ctx.engine.stats(team.slug);
      statsHtml = `<span class="stat">${stats.notes} notes</span> <span class="stat">${stats.activeDecisions} decisions</span>`;
    } catch {
      statsHtml = '';
    }

    const roleHtml = membership ? roleBadge(membership.teamRole) : roleBadge('viewer');

    teamCards.push(`
<div class="team-card">
  <div class="team-card__header">
    <a href="/t/${esc(team.slug)}" class="team-card__name">${esc(team.name)}</a>
    ${visibilityBadge(team.visibility)} ${roleHtml}
  </div>
  ${team.description ? `<p class="team-card__desc">${esc(team.description)}</p>` : ''}
  <div class="team-card__stats">${statsHtml}</div>
</div>`);
  }

  const recentAudit = readAuditLog()
    .slice(-10)
    .reverse()
    .map(
      (e) =>
        `<tr>
      <td>${esc(e.ts.slice(0, 19).replace('T', ' '))}</td>
      <td>${esc(e.userId)}</td>
      <td>${esc(e.action)}</td>
      <td>${esc(e.resource)}</td>
    </tr>`,
    )
    .join('\n');

  const body = `
<div class="page-header">
  <h1>Welcome, ${esc(user.displayName)}</h1>
  <p class="subtitle">${esc(orgName)}</p>
</div>

<section class="search-quick">
  <form method="GET" action="/search" class="search-form">
    <input type="search" name="q" placeholder="Search across your teams…" class="search-input" autocomplete="off">
    <button type="submit" class="btn btn--primary">Search</button>
  </form>
</section>

<section>
  <h2>Your teams</h2>
  ${visibleTeams.length === 0 ? '<p class="empty">No teams available yet.</p>' : `<div class="team-grid">${teamCards.join('')}</div>`}
</section>

<section>
  <h2>Recent activity</h2>
  ${
    recentAudit.length > 0
      ? `<table class="data-table">
    <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Resource</th></tr></thead>
    <tbody>${recentAudit}</tbody>
  </table>`
      : '<p class="empty">No audit entries yet.</p>'
  }
</section>`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(layout('Dashboard', user, body, { orgName, demoMode }));
}

export const getDashboard: Handler = requireAuth(dashboardPage);
