/**
 * Sleep-time interlink job.
 *
 * Walks all notes, builds a global WikilinkContext, then rewrites each note's
 * HTML to:
 *   (a) inject wikilinks in body text via injectWikilinks()
 *   (b) append a <section data-section="see-also"> with top-3 cosine-nearest notes
 *
 * Idempotent: notes that already have <nav class="see-also"> are skipped.
 * Always refreshes the FTS index entry for touched notes.
 */

import { writeFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { listEntities } from '../annotator/entities.js';
import { buildWikilinkContext, injectWikilinks } from '../annotator/wikilinks.js';
import { embed, topKCosine } from '../indexer/embeddings.js';
import { indexNote, listAll } from '../indexer/fts.js';
import { readAllNotes } from '../store/reader.js';
import { getLogger } from '../util/logger.js';

export interface InterlinkOptions {
  dryRun?: boolean;
  limit?: number;
  pretty?: boolean;
}

const EMBED_CHAR_LIMIT = 1200;

/**
 * Build a plain-text representation for embedding.
 */
function noteToEmbedText(html: string): string {
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
  const root = document.querySelector('article') ?? document.body;
  const text = (root.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, EMBED_CHAR_LIMIT);
}

/**
 * Check whether a note already has a see-also nav.
 */
function hasSeeAlso(html: string): boolean {
  return html.includes('class="see-also"') || html.includes('data-section="see-also"');
}

/**
 * Check whether a note already has an unlinked-mentions aside (idempotent guard).
 */
function hasUnlinkedMentions(html: string): boolean {
  return html.includes('data-cerveau-suggested-links');
}

/**
 * Build map of title → id for all notes, for mention detection.
 * Returns entries with length >= 4 chars to avoid false positives on short tokens.
 */
function buildTitleIndex(
  allFiles: Array<{ id: string; html: string }>,
): Array<{ id: string; title: string; pattern: RegExp }> {
  const entries: Array<{ id: string; title: string; pattern: RegExp }> = [];
  for (const f of allFiles) {
    if (!f.id || f.id.length < 4) continue;
    // Extract h1/h2/h3 title from HTML
    const m = f.html.match(/<h[123][^>]*>([^<]{4,80})<\/h[123]>/i);
    const rawTitle = m ? m[1].trim() : '';
    // Use the note id as fallback surface (last segment without date prefix)
    const idSurface = f.id.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ');
    const candidates = new Set<string>();
    if (rawTitle.length >= 4) candidates.add(rawTitle);
    if (idSurface.length >= 4) candidates.add(idSurface);
    for (const surface of candidates) {
      try {
        const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        entries.push({
          id: f.id,
          title: surface,
          pattern: new RegExp(`\\b${escaped}\\b`, 'gi'),
        });
      } catch {
        // skip invalid patterns
      }
    }
  }
  return entries;
}

/**
 * Find titles mentioned in plain text (not already wikilinked), return top candidates.
 * Cap at 5 to avoid bloat.
 */
function findUnlinkedMentions(
  html: string,
  noteId: string,
  titleIndex: Array<{ id: string; title: string; pattern: RegExp }>,
): Array<{ id: string; title: string }> {
  // Extract text content (strip tags)
  const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // Also extract existing wikilink hrefs to avoid suggesting already-linked notes.
  // Handles both routable "#/note/<id>" and legacy bare "#<id>" formats.
  const existingLinks = new Set<string>();
  for (const m of html.matchAll(/href="#\/note\/([^"]+)"/g)) {
    existingLinks.add(decodeURIComponent(m[1]));
  }
  for (const m of html.matchAll(/href="#(?!\/note\/)([^"]+)"/g)) {
    existingLinks.add(m[1]);
  }

  const found: Array<{ id: string; title: string }> = [];
  const seenIds = new Set<string>([noteId]);

  for (const entry of titleIndex) {
    if (seenIds.has(entry.id)) continue;
    if (existingLinks.has(entry.id)) continue;
    // Reset lastIndex for stateful regex
    entry.pattern.lastIndex = 0;
    if (entry.pattern.test(plainText)) {
      found.push({ id: entry.id, title: entry.title });
      seenIds.add(entry.id);
    }
    if (found.length >= 5) break;
  }
  return found;
}

/**
 * Inject or update the data-cerveau-related attribute on the article root.
 * Idempotent: replaces existing value if present.
 */
function injectRelatedAttr(html: string, ids: string[]): string {
  if (ids.length === 0) return html;
  const value = ids.join(',');
  // Replace existing attribute
  if (/data-cerveau-related="[^"]*"/.test(html)) {
    return html.replace(/data-cerveau-related="[^"]*"/, `data-cerveau-related="${value}"`);
  }
  // Inject after data-cerveau-version attribute or after opening <article tag
  return html.replace(/(<article\b[^>]*?)(>)/, `$1 data-cerveau-related="${value}"$2`);
}

/**
 * Inject (or replace) the unlinked-mentions aside.
 * Placed before </article> or at end of article element.
 */
function injectSuggestedLinks(
  html: string,
  mentions: Array<{ id: string; title: string }>,
): string {
  if (mentions.length === 0) return html;

  const links = mentions
    .map(
      (m) =>
        `<a href="#/note/${encodeURIComponent(m.id)}">${m.title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</a>`,
    )
    .join(', ');
  const aside = `\n  <aside data-cerveau-suggested-links>\n    Mentioned without link: ${links}\n  </aside>`;

  // Remove stale aside if present
  const withoutOld = html.replace(
    /\n?\s*<aside data-cerveau-suggested-links>[\s\S]*?<\/aside>/,
    '',
  );

  if (withoutOld.includes('</article>')) {
    return withoutOld.replace('</article>', `${aside}\n</article>`);
  }
  return withoutOld + aside;
}

/**
 * Check whether a note has a valid-until attribute (invalidated notes are skipped).
 */
function isInvalidated(html: string): boolean {
  const m = html.match(/data-cerveau-valid-until="([^"]*)"/);
  return !!m?.[1];
}

/**
 * Inject see-also section into the article HTML before </article> or before <footer>.
 */
function injectSeeAlso(html: string, ids: string[]): string {
  if (ids.length === 0) return html;
  const links = ids.map((id) => `<a href="#/note/${encodeURIComponent(id)}">${id}</a>`).join(', ');
  const seeAlsoHtml = `\n  <section data-section="see-also">\n    <nav class="see-also">See also: ${links}</nav>\n  </section>`;

  // Insert before </footer> if present, else before </article>
  if (html.includes('<footer>')) {
    return html.replace('<footer>', `${seeAlsoHtml}\n  <footer>`);
  }
  return html.replace('</article>', `${seeAlsoHtml}\n</article>`);
}

/**
 * Build a disambiguation aside for an entity surface that has ≥ 2 distinct
 * registered instances (e.g. "db:postgres-prod" and "db:postgres-dev").
 *
 * Returns the HTML aside string, or empty string when none needed.
 */
function buildDisambigAside(surface: string, instanceIds: string[]): string {
  if (instanceIds.length < 2) return '';
  const links = instanceIds
    .slice(0, 6)
    .map((id) => `<a href="#/note/${encodeURIComponent(id)}">${id}</a>`)
    .join(', ');
  return `\n  <aside class="disambig" data-disambig-term="${surface.replace(/"/g, '&quot;')}">\n    <p>${surface} — multiple instances: ${links}</p>\n  </aside>`;
}

/**
 * Build a map of surface form → list of note ids that carry a registered entity
 * with that surface. Only surfaces with ≥ 2 note ids are ambiguous.
 */
function buildAmbiguousEntities(
  allFiles: Array<{ id: string; html: string }>,
): Map<string, string[]> {
  const entities = listEntities();
  // Map: surface (lowercase) → canonical keys that use it
  const surfaceToKeys = new Map<string, string[]>();
  for (const e of entities) {
    for (const s of e.surfaces) {
      const low = s.toLowerCase();
      const keys = surfaceToKeys.get(low) ?? [];
      keys.push(`${e.type}:${e.key}`);
      surfaceToKeys.set(low, keys);
    }
  }

  // Only keep surfaces that map to ≥ 2 distinct keys (ambiguous)
  const ambig = new Map<string, string[]>();
  for (const [surface, keys] of surfaceToKeys) {
    if (keys.length >= 2) {
      ambig.set(surface, [...new Set(keys)]);
    }
  }

  // Filter to surfaces actually present in note files (noteIds with entity data)
  const result = new Map<string, string[]>();
  for (const f of allFiles) {
    const html = f.html.toLowerCase();
    for (const [surface, keys] of ambig) {
      if (html.includes(surface)) {
        const existing = result.get(surface) ?? [];
        for (const k of keys) {
          if (!existing.includes(k)) existing.push(k);
        }
        result.set(surface, existing);
      }
    }
  }
  return result;
}

/**
 * Main interlink job.
 */
export async function runInterlink(opts: InterlinkOptions): Promise<string> {
  const log = getLogger();
  const start = Date.now();
  const dryRun = opts.dryRun ?? false;
  const limit = opts.limit ?? 200;

  // Load all notes from FTS index to build context
  const allIndexed = listAll({ includeExpired: true });
  const ctx = buildWikilinkContext(
    allIndexed.map((n) => ({
      id: n.id,
      concepts: n.concepts ?? null,
      entities: n.entities ?? null,
      tags: n.tags ?? '',
    })),
  );

  // Load all physical note files
  const allFiles = readAllNotes();

  // Build disambiguation map (surface form → multiple entity keys) once.
  // Used to inject <aside class="disambig"> into the first note mentioning the surface.
  const ambigEntities = buildAmbiguousEntities(allFiles);
  // Track which surfaces have already received a disambig aside
  const disambigInjected = new Set<string>();

  // Build title index for unlinked-mentions detection (all valid notes)
  const titleIndex = buildTitleIndex(allFiles.filter((f) => !isInvalidated(f.html)));

  // Filter: skip already-linked, invalidated, profile, or structureless notes
  const todo = allFiles.filter((f) => {
    if (!f.html || f.html.trim().length < 10) return false;
    if (f.path.endsWith('_user-profile.html')) return false;
    if (isInvalidated(f.html)) return false;
    if (hasSeeAlso(f.html)) return false;
    // Must have an article/section element to be processable
    if (!/<article|<section/i.test(f.html)) return false;
    return true;
  });

  // Notes that already have see-also but may need suggested-links refresh
  const todoSuggest = allFiles.filter((f) => {
    if (!f.html || f.html.trim().length < 10) return false;
    if (f.path.endsWith('_user-profile.html')) return false;
    if (isInvalidated(f.html)) return false;
    if (hasUnlinkedMentions(f.html)) return false; // already fresh
    if (!hasSeeAlso(f.html)) return false; // will be handled in main loop below
    if (!/<article|<section/i.test(f.html)) return false;
    return true;
  });

  const batch = todo.slice(0, limit);
  log.info(
    { total: allFiles.length, todo: todo.length, processing: batch.length },
    'interlink start',
  );

  if (batch.length === 0 && todoSuggest.length === 0) {
    const msg = 'interlink: nothing to do (all notes already linked)';
    return opts.pretty ? msg : JSON.stringify({ status: 'noop', reason: 'all linked' });
  }

  // Build embedding corpus for see-also (all non-expired notes)
  const corpusFiles = allFiles.filter((f) => !isInvalidated(f.html));
  const corpusTexts = corpusFiles.map((f) => noteToEmbedText(f.html) || f.id);
  const corpusVectors = await embed(corpusTexts);

  let touched = 0;
  let failed = 0;

  for (const noteFile of batch) {
    try {
      let html = noteFile.html;

      // (a) Inject wikilinks — operate on article innerHTML only
      const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
      const article = document.querySelector('article');
      if (article) {
        // Only inject wikilinks if context is populated
        if (ctx.knownNoteIds.size > 1) {
          const innerLinked = injectWikilinks(article.innerHTML, ctx);
          // Only update if content changed
          if (innerLinked !== article.innerHTML) {
            article.innerHTML = innerLinked;
          }
        }
        // (a2) Disambiguation: inject <aside class="disambig"> for ambiguous entities
        // on the first note that mentions each ambiguous surface.
        const noteHtmlLower = html.toLowerCase();
        for (const [surface, keys] of ambigEntities) {
          if (disambigInjected.has(surface)) continue;
          if (!noteHtmlLower.includes(surface)) continue;
          // This note is the first to mention this ambiguous surface — inject aside
          const aside = buildDisambigAside(surface, keys);
          if (aside) {
            // Inject at top of article (after opening tag)
            article.innerHTML = aside + article.innerHTML;
            disambigInjected.add(surface);
          }
        }
        html = article.outerHTML;
      }
      // If no article was found, keep original html (shouldn't happen with our filter)

      // (b) Compute see-also top-3 by cosine similarity + data-cerveau-related
      const noteText = noteToEmbedText(html) || noteFile.id;
      const [noteVec] = await embed([noteText]);
      const corpus = corpusFiles
        .filter((f) => f.id !== noteFile.id)
        .map((f, i) => ({ id: f.id, vector: corpusVectors[i] }))
        .filter((c) => c.vector !== undefined);

      const nearest = topKCosine(noteVec, corpus, 3)
        .filter((h) => h.score >= 0.5)
        .map((h) => h.id);

      if (nearest.length > 0) {
        html = injectSeeAlso(html, nearest);
        // Persist top-3 related ids as data-cerveau-related attribute on article root
        html = injectRelatedAttr(html, nearest);
      }

      // (c) Inject unlinked-mentions aside
      const mentions = findUnlinkedMentions(html, noteFile.id, titleIndex);
      if (mentions.length > 0) {
        html = injectSuggestedLinks(html, mentions);
      }

      if (!dryRun) {
        writeFileSync(noteFile.path, html, 'utf8');
        // Refresh FTS index — use updated html
        try {
          indexNote({ ...noteFile, html });
        } catch (indexErr) {
          log.warn(
            { id: noteFile.id, err: (indexErr as Error).message },
            'interlink: FTS index update failed, continuing',
          );
        }
      }
      touched++;
    } catch (err) {
      log.warn({ id: noteFile.id, err: (err as Error).message }, 'interlink: failed note');
      failed++;
    }
  }

  // Second pass: inject suggested-links into notes that already have see-also
  const suggestBatch = todoSuggest.slice(0, limit);
  let suggestTouched = 0;
  for (const noteFile of suggestBatch) {
    try {
      const mentions = findUnlinkedMentions(noteFile.html, noteFile.id, titleIndex);
      if (mentions.length === 0) continue;
      const newHtml = injectSuggestedLinks(noteFile.html, mentions);
      if (!dryRun) {
        writeFileSync(noteFile.path, newHtml, 'utf8');
        try {
          indexNote({ ...noteFile, html: newHtml });
        } catch {
          // best-effort
        }
      }
      suggestTouched++;
    } catch (err) {
      log.warn({ id: noteFile.id, err: (err as Error).message }, 'interlink: suggest pass failed');
    }
  }

  const duration = Date.now() - start;
  const summary = {
    status: dryRun ? 'dry-run' : 'done',
    touched,
    suggest_touched: suggestTouched,
    failed,
    skipped: todo.length - batch.length,
    duration_ms: duration,
  };
  log.info(summary, 'interlink complete');

  if (opts.pretty) {
    return [
      `interlink: ${touched} notes updated (+${suggestTouched} suggest-only), ${failed} failed, ${todo.length - batch.length} skipped`,
      `duration: ${duration}ms`,
    ].join('\n');
  }
  return JSON.stringify(summary);
}
