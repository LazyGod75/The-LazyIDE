/**
 * GET/POST /search — federated search across permitted teams.
 *
 * Permission filter: engine.search receives ONLY the slugs the authenticated
 * user may access. The engine does NOT enforce ACLs — we do it here.
 */

import { getSetting } from '../../store/settings-store.js';
import type { Handler } from '../http.js';
import { requireAuth } from '../middleware.js';
import { getVisibleTeams } from '../middleware.js';
import { esc, layout } from '../render.js';

const MAX_RESULTS = 30;

async function searchPage(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const orgName = getSetting('org_name') ?? 'LazyBrain Teams';
  const demoMode = getSetting('demo_mode') === 'true';

  // Support both GET (search box link) and POST (form submit)
  const rawQuery = (ctx.query.q ?? ctx.body.q ?? '').trim();
  const filterSlug = ctx.query.team ?? ctx.body.team ?? '';

  // Determine permitted team slugs (pre-filter before calling engine)
  const visibleTeams = getVisibleTeams(user);
  const permittedSlugs = visibleTeams.map(({ team }) => team.slug);

  // Apply optional team filter
  const targetSlugs =
    filterSlug && permittedSlugs.includes(filterSlug) ? [filterSlug] : permittedSlugs;

  // Team filter dropdown
  const teamOptions = visibleTeams
    .map(
      ({ team }) =>
        `<option value="${esc(team.slug)}"${filterSlug === team.slug ? ' selected' : ''}>${esc(team.name)}</option>`,
    )
    .join('\n');

  let resultsHtml = '';
  if (rawQuery) {
    ctx.audit({
      userId: user.id,
      action: 'search',
      resource: 'federated',
      details: rawQuery.slice(0, 200),
    });

    const hits = await ctx.engine.search({
      query: rawQuery,
      teamSlugs: targetSlugs,
      top: MAX_RESULTS,
    });

    if (hits.length === 0) {
      resultsHtml = '<p class="empty">No results found.</p>';
    } else {
      // Group by team
      const byTeam = new Map<string, typeof hits>();
      for (const hit of hits) {
        const group = byTeam.get(hit.teamSlug) ?? [];
        group.push(hit);
        byTeam.set(hit.teamSlug, group);
      }

      const sections: string[] = [];
      for (const [slug, groupHits] of byTeam) {
        const teamObj = visibleTeams.find(({ team }) => team.slug === slug)?.team;
        const teamName = teamObj?.name ?? slug;

        const rows = groupHits
          .map(
            (h) => `
<div class="search-result">
  <div class="search-result__meta">
    <span class="provenance-badge">${esc(slug)}</span>
    ${h.type ? `<span class="badge badge--type">${esc(h.type)}</span>` : ''}
    ${h.date ? `<span class="result-date">${esc(h.date.slice(0, 10))}</span>` : ''}
    <a href="/t/${esc(slug)}/wiki/note/${esc(h.noteId)}" class="result-link">${esc(h.title)}</a>
  </div>
  <p class="result-snippet">${esc(h.snippet)}</p>
</div>`,
          )
          .join('');

        sections.push(`
<div class="search-team-section">
  <h3><a href="/t/${esc(slug)}">${esc(teamName)}</a> <small>(${groupHits.length} result${groupHits.length !== 1 ? 's' : ''})</small></h3>
  ${rows}
</div>`);
      }
      resultsHtml = sections.join('\n');
    }
  }

  const body = `
<div class="page-header">
  <h1>Search</h1>
</div>

<form method="GET" action="/search" class="search-form search-form--full">
  <div class="search-form__row">
    <input type="search" name="q" value="${esc(rawQuery)}" placeholder="Search notes, decisions, references…" class="search-input" autocomplete="off">
    <select name="team" class="select-input">
      <option value="">All permitted teams</option>
      ${teamOptions}
    </select>
    <button type="submit" class="btn btn--primary">Search</button>
  </div>
</form>

${rawQuery ? `<p class="result-count">Results for <strong>${esc(rawQuery)}</strong>${filterSlug ? ` in team <strong>${esc(filterSlug)}</strong>` : ''}</p>` : '<p class="help-text">Enter a query above to search across your team knowledge bases.</p>'}

${resultsHtml}`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(layout('Search', user, body, { orgName, demoMode }));
}

export const getSearch: Handler = requireAuth(searchPage);
export const postSearch: Handler = requireAuth(searchPage);
