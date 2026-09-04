/**
 * Wiki rendering — native file-based, no CLI spawn for reads.
 *
 * renderWikiIndex: list team notes grouped by type, sorted recent-first.
 * renderWikiNote:  extract + sanitize a single note HTML, rewrite internal links.
 *
 * Both functions read HTML files directly from the brain's notes/ directory.
 * This is intentional: fast, no daemon, auth wraps the HTTP layer above us.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NoteMetadata {
  readonly id: string;
  readonly type: string;
  readonly date: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly filePath: string;
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Enumerate all note .html files under <brainPath>/notes/YYYY-MM/.
 * Returns them sorted by file mtime descending (newest first).
 */
function listNoteFiles(brainPath: string): string[] {
  const notesDir = join(brainPath, 'notes');

  try {
    const months = readdirSync(notesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}$/.test(d.name))
      .map((d) => join(notesDir, d.name));

    const files: Array<{ path: string; mtime: number }> = [];

    for (const monthDir of months) {
      const entries = readdirSync(monthDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.endsWith('.html')) continue;
        const fullPath = join(monthDir, entry.name);
        const mtime = statSync(fullPath).mtimeMs;
        files.push({ path: fullPath, mtime });
      }
    }

    files.sort((a, b) => b.mtime - a.mtime);
    return files.map((f) => f.path);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Metadata extraction from HTML article
// ---------------------------------------------------------------------------

const ATTR_RE = /data-cerveau-(\w+(?:-\w+)*)="([^"]*)"/g;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const TAG_RE = /<[^>]+>/g;

function extractMeta(html: string, filePath: string): NoteMetadata | null {
  const attrMatch = html.match(/<article([^>]*)>/i);
  if (!attrMatch) return null;

  const attrs = attrMatch[1] ?? '';
  const meta: Record<string, string> = {};

  // Extract id attribute
  const idMatch = attrs.match(/\bid="([^"]*)"/);
  meta.id = idMatch?.[1] ?? '';

  // Extract all data-cerveau-* attrs
  ATTR_RE.lastIndex = 0;
  let m = ATTR_RE.exec(attrs);
  while (m !== null) {
    meta[m[1]!] = m[2]!;
    m = ATTR_RE.exec(attrs);
  }
  ATTR_RE.lastIndex = 0;

  if (!meta.id) return null;

  const h1Match = html.match(H1_RE);
  const rawTitle = h1Match ? h1Match[1]!.replace(TAG_RE, '').trim() : meta.id!;

  const tagsRaw = meta.tags ?? '';
  const tags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return {
    id: meta.id,
    type: meta.type ?? 'note',
    date: meta.created ?? meta.date ?? '',
    title: rawTitle,
    tags,
    filePath,
  };
}

// ---------------------------------------------------------------------------
// HTML sanitisation
// ---------------------------------------------------------------------------

const SCRIPT_RE = /<script[\s\S]*?<\/script>/gi;
const ON_ATTR_RE = /\s+on\w+="[^"]*"/gi;
const ON_ATTR_SINGLE_RE = /\s+on\w+='[^']*'/gi;
const HREF_JS_RE = /href="javascript:[^"]*"/gi;

function sanitizeHtml(html: string): string {
  return html
    .replace(SCRIPT_RE, '')
    .replace(ON_ATTR_RE, '')
    .replace(ON_ATTR_SINGLE_RE, '')
    .replace(HREF_JS_RE, 'href="#"');
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite internal brain links href="#/note/<id>" to the Teams wiki URL.
 */
function rewriteLinks(html: string, teamSlug: string): string {
  return html.replace(/href="#\/note\/([^"]+)"/g, (_match, noteId: string) => {
    return `href="/t/${encodeURIComponent(teamSlug)}/wiki/note/${encodeURIComponent(noteId)}"`;
  });
}

// ---------------------------------------------------------------------------
// renderWikiIndex
// ---------------------------------------------------------------------------

export function renderWikiIndex(
  brainPath: string,
  teamSlug: string,
): { title: string; bodyHtml: string } {
  const files = listNoteFiles(brainPath);
  const notes: NoteMetadata[] = [];

  for (const filePath of files) {
    try {
      const html = readFileSync(filePath, 'utf-8');
      const meta = extractMeta(html, filePath);
      if (meta) notes.push(meta);
    } catch {
      // Skip unreadable files
    }
  }

  // Group by type
  const groups = new Map<string, NoteMetadata[]>();
  for (const note of notes) {
    const group = groups.get(note.type) ?? [];
    group.push(note);
    groups.set(note.type, group);
  }

  const title = `${escapeHtml(teamSlug)} — Brain Index`;

  const lines: string[] = [
    `<h1>${title}</h1>`,
    `<p>${notes.length} note${notes.length !== 1 ? 's' : ''}</p>`,
  ];

  const sortedTypes = [...groups.keys()].sort();

  for (const type of sortedTypes) {
    const group = groups.get(type)!;
    lines.push(`<h2>${escapeHtml(type)} <small>(${group.length})</small></h2>`);
    lines.push('<ul>');

    for (const note of group) {
      const href = `/t/${encodeURIComponent(teamSlug)}/wiki/note/${encodeURIComponent(note.id)}`;
      const dateStr = note.date ? ` <time>${escapeHtml(note.date.slice(0, 10))}</time>` : '';
      lines.push(`  <li><a href="${href}">${escapeHtml(note.title)}</a>${dateStr}</li>`);
    }

    lines.push('</ul>');
  }

  return { title, bodyHtml: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// renderWikiNote
// ---------------------------------------------------------------------------

/**
 * Find a note file by id (scans notes/YYYY-MM/<id>.html).
 * Returns null if not found.
 */
function findNoteFile(brainPath: string, noteId: string): string | null {
  const notesDir = join(brainPath, 'notes');

  try {
    const months = readdirSync(notesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(notesDir, d.name));

    for (const monthDir of months) {
      const candidate = join(monthDir, `${noteId}.html`);
      try {
        statSync(candidate);
        return candidate;
      } catch {
        // Not in this month, continue
      }
    }
  } catch {
    // notes dir missing
  }

  return null;
}

export function renderWikiNote(
  brainPath: string,
  teamSlug: string,
  noteId: string,
): { title: string; bodyHtml: string } | null {
  const filePath = findNoteFile(brainPath, noteId);
  if (!filePath) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  // Extract <article>…</article> content
  const articleMatch = raw.match(/<article([^>]*)>([\s\S]*)<\/article>/i);
  if (!articleMatch) return null;

  const innerHtml = articleMatch[2] ?? '';
  const meta = extractMeta(raw, filePath);
  const title = meta?.title ?? noteId;

  const sanitized = sanitizeHtml(innerHtml);
  const rewritten = rewriteLinks(sanitized, teamSlug);

  return { title, bodyHtml: rewritten };
}
