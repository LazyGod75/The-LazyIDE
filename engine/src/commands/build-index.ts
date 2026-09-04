/**
 * Regenerate the global brain/_index.html file.
 *
 * Reads all active notes via listAll(), extracts metadata (tags, types, entities),
 * and generates a navigable atlas HTML + JSON-LD graph that LLMs can ingest in a
 * single read operation.
 *
 * Output: <brain_path>/_index.html
 * Format: HTML + JSON-LD (@context schema.org, @graph)
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listEntities } from '../annotator/entities.js';
import { listAll } from '../indexer/fts.js';
import { getConfig } from '../util/config.js';
import { nowIso } from '../util/telemetry.js';

export interface BuildIndexOptions {
  pretty?: boolean;
}

export interface BuildIndexOutput {
  status: 'ok' | 'error';
  path?: string;
  noteCount?: number;
  entityCount?: number;
  tagCount?: number;
  sizeKB?: number;
  activeDecisions?: number;
  error?: string;
}

/**
 * Extract top tags from all notes.
 * Returns array of {tag, count} sorted by frequency DESC.
 */
function extractTopTags(notes: ReturnType<typeof listAll>): Array<{ tag: string; count: number }> {
  const tagCounts = new Map<string, number>();
  for (const note of notes) {
    if (!note.tags) continue;
    for (const tag of note.tags.split(/\s+/).filter(Boolean)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

/**
 * Extract unique working directories from note sources.
 */
function extractCwds(notes: ReturnType<typeof listAll>): string[] {
  const cwds = new Set<string>();
  for (const note of notes) {
    if (note.source) {
      cwds.add(note.source);
    }
  }
  return Array.from(cwds).sort();
}

/**
 * Build the global JSON-LD graph for the brain.
 */
function buildJsonLdGraph(
  _notes: ReturnType<typeof listAll>,
  entities: ReturnType<typeof listEntities>,
): unknown {
  const entityTerms = entities.map((e) => ({
    '@type': 'DefinedTerm',
    '@id': `memory://${e.key}`,
    name: e.surfaces[0] ?? e.key,
    termCode: e.key,
    inDefinedTermSet: 'memory://entities',
  }));

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Dataset',
        '@id': 'memory://lazybrain',
        name: 'LazyBrain Atlas',
        size: _notes.length,
        dateModified: nowIso(),
      },
      {
        '@type': 'DefinedTermSet',
        '@id': 'memory://entities',
        name: 'Entities',
        hasDefinedTerm: entityTerms,
      },
    ],
  };
}

/**
 * Build the HTML/meta header section.
 */
function buildHeader(
  noteCount: number,
  activeDecisionCount: number,
  _entityCount: number,
  topTags: Array<{ tag: string; count: number }>,
  cwds: string[],
): string {
  const tagMetaContent = topTags
    .slice(0, 10)
    .map((t) => t.tag)
    .join(', ');
  const cwdMetaContent = cwds.join(', ') || 'unknown';
  const stubCount = Math.ceil(noteCount * 0.1); // heuristic

  const jsonLdGraph = buildJsonLdGraph(listAll(), listEntities());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>LazyBrain Atlas</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="cerveau-corpus-version" content="0.5.0">
  <meta name="cerveau-note-count" content="${noteCount}">
  <meta name="cerveau-active-decisions" content="${activeDecisionCount}">
  <meta name="cerveau-stub-count" content="${stubCount}">
  <meta name="cerveau-cwds" content="${cwdMetaContent}">
  <meta name="cerveau-top-tags" content="${tagMetaContent}">
  <meta name="cerveau-generated-at" content="${nowIso()}">
  <meta name="description" content="Global atlas of ${noteCount} notes across LazyBrain knowledge base">

  <!-- Canonical entity links -->
  ${listEntities()
    .slice(0, 50)
    .map((e) => `  <link rel="canonical" href="#${e.key}" data-entity="${e.type}:${e.key}">`)
    .join('\n')}

  <!-- Global JSON-LD graph -->
  <script type="application/ld+json">
${JSON.stringify(jsonLdGraph, null, 2)}
  </script>

  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 2rem;
    }
    header {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      margin-bottom: 2rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    h1 { font-size: 2.5rem; margin-bottom: 1rem; }
    .infobox {
      background: #f9f9f9;
      border-left: 4px solid #0066cc;
      padding: 1.5rem;
      margin-top: 1.5rem;
      border-radius: 4px;
    }
    .infobox dl { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .infobox dt { font-weight: bold; color: #0066cc; }
    .infobox dd { color: #666; }
    .atlas {
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .atlas h2 { font-size: 1.3rem; margin-bottom: 1.5rem; border-bottom: 2px solid #0066cc; padding-bottom: 0.5rem; }
    details {
      margin-bottom: 1.5rem;
    }
    summary {
      cursor: pointer;
      font-weight: bold;
      color: #0066cc;
      padding: 0.75rem;
      background: #f0f7ff;
      border-radius: 4px;
      user-select: none;
    }
    summary:hover {
      background: #e0eeff;
    }
    details[open] summary {
      background: #e0eeff;
    }
    ul {
      list-style: none;
      padding-left: 2rem;
      margin-top: 1rem;
    }
    li {
      padding: 0.5rem 0;
    }
    a {
      color: #0066cc;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    time {
      color: #999;
      font-size: 0.9rem;
    }
    .categories {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }
    footer {
      margin-top: 3rem;
      padding: 2rem;
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      text-align: center;
      color: #666;
    }
    dfn {
      font-weight: bold;
      color: #0066cc;
      font-style: normal;
    }
  </style>
</head>
<body>`;
}

/**
 * Build the main content section.
 */
function buildContent(
  notes: ReturnType<typeof listAll>,
  topTags: Array<{ tag: string; count: number }>,
  entities: ReturnType<typeof listEntities>,
): string {
  const activeDecisions = notes.filter((n) => n.type === 'decision');
  const stubs = notes.filter((n) => n.quality === 'stub');
  const recent = notes.filter((n) => {
    if (!n.created) return false;
    const noteDate = new Date(n.created);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return noteDate >= weekAgo;
  });

  const formatNoteLink = (note: ReturnType<typeof listAll>[0]): string => {
    const shortId = note.id.slice(0, 8);
    const title = note.title || note.id;
    const safeTitle = escapeHtml(title);
    const time = note.created
      ? `<time datetime="${note.created}">${new Date(note.created).toLocaleDateString()}</time>`
      : '';
    return `<li><a href="notes/${note.created?.slice(0, 7) ?? 'unknown'}/${note.id}.html">#${shortId} ${safeTitle}</a> ${time}</li>`;
  };

  let html = `
  <header>
    <h1>LazyBrain Atlas</h1>
    <aside class="infobox">
      <dl>
        <dt>Notes</dt><dd>${notes.length} total, ${notes.filter((n) => !n.valid_until).length} active</dd>
        <dt>Decisions (active)</dt><dd>${activeDecisions.length}</dd>
        <dt>Stubs to enrich</dt><dd>${stubs.length}</dd>
        <dt>Entities registered</dt><dd>${entities.length}</dd>
        <dt>Last updated</dt><dd><time datetime="${nowIso()}">${new Date().toLocaleString()}</time></dd>
      </dl>
    </aside>
  </header>

  <nav class="atlas" aria-label="Atlas">
    <h2>Notes by Category</h2>`;

  // Active decisions
  if (activeDecisions.length > 0) {
    html += `
    <details open>
      <summary>Active Decisions (${activeDecisions.length})</summary>
      <ul>
        ${activeDecisions.slice(0, 20).map(formatNoteLink).join('\n        ')}
      </ul>
    </details>`;
  }

  // Top tags
  for (const { tag, count } of topTags) {
    const notesWithTag = notes.filter((n) => n.tags?.includes(tag));
    html += `
    <details>
      <summary>Tag: ${escapeHtml(tag)} (${count} notes)</summary>
      <ul>
        ${notesWithTag.slice(0, 15).map(formatNoteLink).join('\n        ')}
      </ul>
    </details>`;
  }

  // Recent
  if (recent.length > 0) {
    html += `
    <details>
      <summary>Recent (last 7 days)</summary>
      <ul>
        ${recent.slice(0, 15).map(formatNoteLink).join('\n        ')}
      </ul>
    </details>`;
  }

  // Stubs
  if (stubs.length > 0) {
    html += `
    <details>
      <summary>Stubs to Enrich (${stubs.length})</summary>
      <ul>
        ${stubs.slice(0, 15).map(formatNoteLink).join('\n        ')}
      </ul>
    </details>`;
  }

  // Entities
  if (entities.length > 0) {
    html += `
    <details>
      <summary>Entities (${entities.length})</summary>
      <dl>`;
    for (const e of entities.slice(0, 30)) {
      const notes_mentioning = notes.filter((n) => n.entities?.includes(e.key));
      const canonical = notes_mentioning[0];
      const link = canonical
        ? `<a href="notes/${canonical.created?.slice(0, 7) ?? 'unknown'}/${canonical.id}.html">#${canonical.id.slice(0, 8)}</a>`
        : '<em>no notes</em>';
      html += `
        <dt><dfn id="${escapeHtml(e.key)}">${escapeHtml(e.surfaces[0] ?? e.key)}</dfn> <span style="color:#999">(${e.type})</span></dt>
        <dd>${link}</dd>`;
    }
    html += `
      </dl>
    </details>`;
  }

  html += `
  </nav>

  <footer>
    <nav class="categories">
      Categories: ${topTags
        .slice(0, 10)
        .map((t) => `<a href="#tag-${escapeHtml(t.tag)}">${escapeHtml(t.tag)}</a>`)
        .join(' · ')}
    </nav>
    <p style="margin-top: 1rem; font-size: 0.9rem;">Generated by <strong>LazyBrain</strong> • <code>lazybrain build-index</code></p>
  </footer>
</body>
</html>`;

  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function runBuildIndex(_opts: BuildIndexOptions): Promise<BuildIndexOutput> {
  try {
    const cfg = getConfig();
    const notes = listAll({ includeExpired: false });
    const entities = listEntities();
    const topTags = extractTopTags(notes);
    const cwds = extractCwds(notes);
    const activeDecisionCount = notes.filter((n) => n.type === 'decision').length;

    const content = buildContent(notes, topTags, entities);
    const html =
      buildHeader(notes.length, activeDecisionCount, entities.length, topTags, cwds) + content;

    const indexPath = join(cfg.brainPath, '_index.html');
    writeFileSync(indexPath, html, 'utf8');

    const sizeKB = Math.ceil(Buffer.byteLength(html, 'utf8') / 1024);

    return {
      status: 'ok',
      path: indexPath,
      noteCount: notes.length,
      entityCount: entities.length,
      tagCount: topTags.length,
      activeDecisions: activeDecisionCount,
      sizeKB,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      error: msg,
    };
  }
}
