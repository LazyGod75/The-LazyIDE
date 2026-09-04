/**
 * Team routes:
 *   GET  /t/:slug           — team page
 *   GET  /t/:slug/wiki      — wiki index (trusted engine HTML)
 *   GET  /t/:slug/wiki/note/:noteId — wiki note (trusted engine HTML)
 *   POST /t/:slug/notes     — manual note form (member+)
 */

import { readFilteredAuditLog } from '../../store/audit-store.js';
import { listActiveTokensForTeam } from '../../store/capture-tokens-store.js';
import { findMembership } from '../../store/memberships-store.js';
import { getSetting } from '../../store/settings-store.js';
import { findTeamBySlug } from '../../store/teams-store.js';
import type { Handler } from '../http.js';
import { requireTeamAccess } from '../middleware.js';
import { csrfField, esc, formRow, layout, roleBadge, visibilityBadge } from '../render.js';

// ---- GET /t/:slug --------------------------------------------------------

async function teamPage(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const slug = ctx.params.slug!;
  const team = findTeamBySlug(slug)!;
  const orgName = getSetting('org_name') ?? 'LazyBrain Teams';
  const demoMode = getSetting('demo_mode') === 'true';

  const membership = user.orgRole === 'admin' ? null : findMembership(user.id, team.id);
  const userRole = membership?.teamRole ?? (user.orgRole === 'admin' ? 'lead' : 'viewer');

  let stats: { notes: number; activeDecisions: number; lastCaptureAt?: string } = {
    notes: 0,
    activeDecisions: 0,
  };
  try {
    stats = await ctx.engine.stats(slug);
  } catch {
    // stats unavailable — show zeros
  }

  const recentAudit = readFilteredAuditLog({ resource: slug })
    .slice(-10)
    .reverse()
    .map(
      (e) =>
        `<tr><td>${esc(e.ts.slice(0, 19).replace('T', ' '))}</td><td>${esc(e.userId)}</td><td>${esc(e.action)}</td></tr>`,
    )
    .join('\n');

  const activeTokens = listActiveTokensForTeam(team.id);
  const captureHint =
    activeTokens.length > 0
      ? `<p>This team has <strong>${activeTokens.length}</strong> active capture token(s). Agents can POST notes to <code>/t/${esc(slug)}/notes</code> with <code>Authorization: Bearer &lt;token&gt;</code>.</p>`
      : `<p>No active capture tokens. Go to <a href="/me">My Profile</a> to mint one for this team.</p>`;

  const canWrite = user.orgRole === 'admin' || (membership && membership.teamRole !== 'viewer');

  const noteForm = canWrite
    ? `
<section>
  <h2>Add a note</h2>
  <form method="POST" action="/t/${esc(slug)}/notes">
    ${csrfField(ctx.session!.csrfToken)}
    ${formRow({
      name: 'type',
      label: 'Type',
      type: 'select',
      options: [
        { value: 'decision', label: 'Decision' },
        { value: 'episodic', label: 'Episodic' },
        { value: 'reference', label: 'Reference' },
      ],
    })}
    ${formRow({ name: 'tags', label: 'Tags (comma-separated)', placeholder: 'backend, auth, v2' })}
    ${formRow({ name: 'text', label: 'Content', type: 'textarea', required: true })}
    <button type="submit" class="btn btn--primary">Store note</button>
  </form>
</section>`
    : '';

  const body = `
<div class="page-header">
  <h1>${esc(team.name)} ${visibilityBadge(team.visibility)} ${roleBadge(userRole)}</h1>
  ${team.description ? `<p>${esc(team.description)}</p>` : ''}
</div>

<div class="stats-row">
  <div class="stat-box"><strong>${stats.notes}</strong><span>Notes</span></div>
  <div class="stat-box"><strong>${stats.activeDecisions}</strong><span>Decisions</span></div>
  ${stats.lastCaptureAt ? `<div class="stat-box"><strong>Last capture</strong><span>${esc(stats.lastCaptureAt.slice(0, 10))}</span></div>` : ''}
</div>

<p><a href="/t/${esc(slug)}/wiki" class="btn btn--secondary">Open wiki →</a></p>

<section>
  <h2>Capture tokens</h2>
  ${captureHint}
</section>

<section>
  <h2>Recent team activity</h2>
  ${
    recentAudit
      ? `<table class="data-table"><thead><tr><th>Time</th><th>User</th><th>Action</th></tr></thead><tbody>${recentAudit}</tbody></table>`
      : '<p class="empty">No audit entries for this team yet.</p>'
  }
</section>

${noteForm}`;

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(layout(team.name, user, body, { orgName, demoMode }));
}

export const getTeam: Handler = requireTeamAccess('slug', 'viewer')(teamPage);

// ---- GET /t/:slug/wiki ---------------------------------------------------

async function wikiIndex(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const slug = ctx.params.slug!;
  const orgName = getSetting('org_name') ?? 'LazyBrain Teams';
  const demoMode = getSetting('demo_mode') === 'true';

  await ctx.engine.ensureTeamBrain(slug);

  // TRUST BOUNDARY: bodyHtml from engine is trusted — not re-escaped
  const { title, bodyHtml } = await ctx.engine.renderWikiIndex(slug);

  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(layout(title, user, bodyHtml, { orgName, demoMode }));
}

export const getWikiIndex: Handler = requireTeamAccess('slug', 'viewer')(wikiIndex);

// ---- GET /t/:slug/wiki/note/:noteId -------------------------------------

async function wikiNote(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const slug = ctx.params.slug!;
  const noteId = ctx.params.noteId!;
  const orgName = getSetting('org_name') ?? 'LazyBrain Teams';
  const demoMode = getSetting('demo_mode') === 'true';

  // TRUST BOUNDARY: bodyHtml from engine is trusted — not re-escaped
  const result = await ctx.engine.renderWikiNote(slug, noteId);
  if (!result) {
    ctx.res.writeHead(404, { 'Content-Type': 'text/plain' });
    ctx.res.end('Note not found');
    return;
  }

  const { title, bodyHtml } = result;
  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(layout(title, user, bodyHtml, { orgName, demoMode }));
}

export const getWikiNote: Handler = requireTeamAccess('slug', 'viewer')(wikiNote);

// ---- POST /t/:slug/notes ------------------------------------------------

async function postNote(ctx: Parameters<Handler>[0]): Promise<void> {
  const user = ctx.user!;
  const slug = ctx.params.slug!;

  const text = (ctx.body.text ?? '').trim();
  if (!text) {
    ctx.res.writeHead(302, {
      Location: `/t/${encodeURIComponent(slug)}?msg=Note+text+is+required&t=error`,
    });
    ctx.res.end();
    return;
  }

  const type = ctx.body.type ?? 'reference';
  const tagsRaw = ctx.body.tags ?? '';
  const tags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const { noteId } = await ctx.engine.storeNote({
    teamSlug: slug,
    authorUsername: user.username,
    type,
    tags,
    text,
  });

  ctx.audit({ userId: user.id, action: 'note_store', resource: slug, details: noteId });

  ctx.res.writeHead(302, {
    Location: `/t/${encodeURIComponent(slug)}?msg=Note+stored&t=success`,
  });
  ctx.res.end();
}

export const postNoteHandler: Handler = requireTeamAccess('slug', 'member')(postNote);
