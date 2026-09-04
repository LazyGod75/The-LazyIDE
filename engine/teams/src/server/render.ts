/**
 * HTML rendering helpers.
 *
 * ESCAPE-BY-DEFAULT: all user-supplied strings must go through esc().
 *
 * TRUST BOUNDARY: bodyHtml returned by engine.renderWikiIndex / renderWikiNote
 * is produced by the trusted engine layer and is embedded without escaping.
 * This is the ONLY case where raw HTML is accepted. All other interpolations
 * must use esc().
 */

import type { User } from '../domain/types.js';

// ---------------------------------------------------------------------------
// HTML escaping — use everywhere except trusted engine output
// ---------------------------------------------------------------------------

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Layout options
// ---------------------------------------------------------------------------

export interface LayoutOpts {
  readonly orgName?: string;
  readonly demoMode?: boolean;
  readonly flash?: string;
  readonly flashType?: 'success' | 'error' | 'info';
}

// ---------------------------------------------------------------------------
// Full page layout
// ---------------------------------------------------------------------------

export function layout(
  title: string,
  user: User | undefined,
  mainHtml: string,
  opts: LayoutOpts = {},
): string {
  const orgName = opts.orgName ?? 'LazyBrain Teams';
  const demoBanner =
    opts.demoMode === true
      ? `<div class="demo-banner">Demo mode — data is ephemeral and may be reset at any time.</div>`
      : '';

  const flashHtml = opts.flash
    ? `<div class="flash flash--${esc(opts.flashType ?? 'info')}">${esc(opts.flash)}</div>`
    : '';

  const nav = user
    ? `
<nav class="site-nav">
  <a href="/" class="nav-brand">${esc(orgName)}</a>
  <div class="nav-links">
    <a href="/">Dashboard</a>
    <a href="/search">Search</a>
    ${user.orgRole === 'admin' ? '<a href="/admin/users">Admin</a>' : ''}
    <a href="/me">Profile</a>
    <form method="POST" action="/logout" class="logout-form">
      <input type="hidden" name="_csrf" value="">
      <button type="submit" class="btn-link">Logout</button>
    </form>
  </div>
</nav>`
    : `<nav class="site-nav"><a href="/" class="nav-brand">${esc(orgName)}</a></nav>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — ${esc(orgName)}</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
${demoBanner}
${nav}
<main class="container">
${flashHtml}
${mainHtml}
</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------

export interface TableColumn {
  readonly key: string;
  readonly label: string;
  readonly trusted?: boolean; // if true, value is NOT escaped (use sparingly)
}

export function table(
  columns: TableColumn[],
  rows: Array<Record<string, string>>,
  emptyMsg = 'No records.',
): string {
  if (rows.length === 0) {
    return `<p class="empty">${esc(emptyMsg)}</p>`;
  }

  const thead = `<tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>`;
  const tbody = rows
    .map(
      (row) =>
        `<tr>${columns
          .map((c) => {
            const val = row[c.key] ?? '';
            return `<td>${c.trusted === true ? val : esc(val)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('\n');

  return `<table class="data-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

export interface FormField {
  readonly name: string;
  readonly label: string;
  readonly type?: string;
  readonly value?: string;
  readonly required?: boolean;
  readonly options?: Array<{ value: string; label: string }>;
  readonly placeholder?: string;
}

export function formRow(field: FormField): string {
  const id = `field-${esc(field.name)}`;
  const required = field.required === true ? ' required' : '';

  if (field.type === 'select' && field.options) {
    const opts = field.options
      .map(
        (o) =>
          `<option value="${esc(o.value)}"${field.value === o.value ? ' selected' : ''}>${esc(o.label)}</option>`,
      )
      .join('');
    return `<div class="form-row">
  <label for="${id}">${esc(field.label)}</label>
  <select id="${id}" name="${esc(field.name)}"${required}>${opts}</select>
</div>`;
  }

  if (field.type === 'textarea') {
    return `<div class="form-row">
  <label for="${id}">${esc(field.label)}</label>
  <textarea id="${id}" name="${esc(field.name)}"${required} rows="6">${esc(field.value ?? '')}</textarea>
</div>`;
  }

  return `<div class="form-row">
  <label for="${id}">${esc(field.label)}</label>
  <input id="${id}" type="${esc(field.type ?? 'text')}" name="${esc(field.name)}" value="${esc(field.value ?? '')}"${field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : ''}${required}>
</div>`;
}

export function csrfField(csrfToken: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(csrfToken)}">`;
}

export function flashFromQuery(msg: string | undefined, type?: string): LayoutOpts {
  if (!msg) return {};
  const flashType = type === 'error' ? 'error' : type === 'success' ? 'success' : 'info';
  return { flash: msg, flashType };
}

// ---------------------------------------------------------------------------
// Role badge
// ---------------------------------------------------------------------------

export function roleBadge(role: string): string {
  return `<span class="badge badge--${esc(role)}">${esc(role)}</span>`;
}

// ---------------------------------------------------------------------------
// Visibility badge
// ---------------------------------------------------------------------------

export function visibilityBadge(visibility: string): string {
  const label = visibility === 'org-readable' ? 'org-visible' : visibility;
  return `<span class="badge badge--vis-${esc(visibility)}">${esc(label)}</span>`;
}
