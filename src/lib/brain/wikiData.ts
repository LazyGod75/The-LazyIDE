/* wikiData.ts — pure parsers for the Brain Wiki view.

   Turns the engine's /_api/tree JSON and /_api/synthesis/index HTML into the
   typed shapes the Wiki UI consumes (see src/lib/platform/types.ts). Kept
   free of DOM/React so both platform impls (tauri.ts and web.ts HTTP
   fetches) can reuse them and they stay unit-testable from a fixture.

   Route shapes confirmed against:
   - tree:      engine/src/server/routes/tree.ts  (buildTree → { projects })
   - synthesis: engine/src/server/routes/synthesis.ts (brain-index article)
   - links:     engine/src/annotator/blocks/composers/brain-index.ts +
                see-also.ts — every wiki nav link is `<a href="#/{slug}">`.
*/

import type { BrainTree, BrainTreeNode, BrainSynthesisPageRef } from '../platform/types.js';

/**
 * Defensively normalize a /_api/tree JSON payload into a BrainTree. Never
 * throws — unknown or malformed input yields { projects: [] } so the Wiki
 * sidebar degrades to empty rather than crashing.
 */
export function parseTree(raw: unknown): BrainTree {
  if (!raw || typeof raw !== 'object') return { projects: [] };
  const projects = (raw as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return { projects: [] };
  return {
    projects: projects
      .map(normalizeNode)
      .filter((n): n is BrainTreeNode => n !== null),
  };
}

function normalizeNode(raw: unknown): BrainTreeNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : null;
  if (id === null) return null;
  const label = typeof r.label === 'string' && r.label.length > 0 ? r.label : id;
  const noteId = typeof r.noteId === 'string' ? r.noteId : null;
  const type = typeof r.type === 'string' ? r.type : null;
  const childrenRaw = Array.isArray(r.children) ? r.children : [];
  const children = childrenRaw
    .map(normalizeNode)
    .filter((n): n is BrainTreeNode => n !== null);
  return { id, label, noteId, type, children };
}

/**
 * Extract the topic pages linked from a synthesized page — its
 * `<a href="#/{slug}" ...>Title</a>` wiki-section / see-also links. Deduped
 * by slug, order preserved.
 */
export function parseSynthesisPages(html: string): BrainSynthesisPageRef[] {
  const out: BrainSynthesisPageRef[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href="#\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const slug = m[1].trim();
    if (!slug || seen.has(slug)) continue;
    const title = stripTags(m[2]) || slug;
    seen.add(slug);
    out.push({ slug, title });
  }
  return out;
}

/** First `<h1>` text of a synthesized page, or `fallback` when none. */
export function extractPageTitle(html: string, fallback: string): string {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = m ? stripTags(m[1]) : '';
  return title || fallback;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
