import { getPlatform } from '../platform/index.js';
import { isTauri } from '../platform/index.js';

export interface DedupCandidate {
  newItem: { kind: string; about?: string; text: string; title: string };
  existingNoteId: string;
  existingAuthor?: string;
  similarity: number;
  reason: 'same-kind-about' | 'similar-text' | 'same-title';
}

interface ParsedQueryHit {
  id: string;
  text: string;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): Set<string> {
  return new Set(normalizeText(text).split(' ').filter((w) => w.length > 2));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function parseQueryCssOutput(output: string): ParsedQueryHit[] {
  const hits: ParsedQueryHit[] = [];
  const blocks = output.split(/^#/m).filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split('\n');
    const id = lines[0].trim();
    if (!id) continue;
    const text = lines.slice(1).join('\n').trim();
    hits.push({ id, text });
  }
  return hits;
}

/**
 * Build the CSS selector for "an existing note of this kind, about this
 * target". `data-cerveau-kind` on the note's <article> is never written by
 * any capture path (CaptureEvent.itemKind has no TS caller that sets it —
 * see engine/src/commands/recompose-all.ts's deriveAuthoredKind() doc
 * comment for the full trace), so a selector that only checks it always
 * returns zero hits against real data.
 *
 * Two fields genuinely ARE populated for every capture (capture.rs's
 * event_to_html): `data-cerveau-type` (decision|procedural|episodic|learning
 * — only "decision" overlaps the itemKind vocabulary used here) and
 * `data-cerveau-tags` (whole-word tags such as "bug"/"warning"/"rule").
 * Mirrors the fallback systemPrompts.ts already teaches agents to use
 * manually via BRAIN_QUERY_CSS.
 *
 * The selector list ORs three alternatives so a hit on ANY of them counts:
 * the (currently always-empty) explicit kind attribute, for forward
 * compatibility if a future capture path starts writing itemKind directly;
 * then whichever of type/tags actually matches this kind.
 */
export function buildKindAboutSelector(kind: string, about: string): string {
  const aboutSel = `[data-cerveau-about="${about}"]`;
  const explicit = `article[data-cerveau-kind="${kind}"]${aboutSel}`;
  const fallback =
    kind === 'decision'
      ? `article[data-cerveau-type="decision"]${aboutSel}`
      : `article[data-cerveau-tags~="${kind}"]${aboutSel}`;
  return `${explicit}, ${fallback}`;
}

async function queryByKindAbout(kind: string, about: string): Promise<ParsedQueryHit[]> {
  const selector = buildKindAboutSelector(kind, about);
  try {
    const result = await getPlatform().brain.queryCss(selector, 50);
    if (result.startsWith('Structural brain query is not available')) return [];
    return parseQueryCssOutput(result);
  } catch {
    return [];
  }
}

async function queryByTitle(title: string): Promise<ParsedQueryHit[]> {
  try {
    const results = await getPlatform().brain.search(title, 10);
    return results.map((r) => ({ id: r.id, text: r.snippet }));
  } catch {
    return [];
  }
}

export async function findDuplicates(
  items: Array<{ kind: string; about?: string; text: string; title: string }>,
): Promise<DedupCandidate[]> {
  if (!isTauri()) return [];
  const candidates: DedupCandidate[] = [];

  for (const newItem of items) {
    const newTextTokens = tokenize(newItem.text + ' ' + newItem.title);

    let hits: ParsedQueryHit[] = [];
    let reason: DedupCandidate['reason'] = 'similar-text';

    if (newItem.about) {
      hits = await queryByKindAbout(newItem.kind, newItem.about);
      reason = 'same-kind-about';
    }
    if (hits.length === 0) {
      hits = await queryByTitle(newItem.title);
      reason = 'similar-text';
    }

    for (const hit of hits) {
      const hitTokens = tokenize(hit.text);
      const sim = jaccardSimilarity(newTextTokens, hitTokens);

      if (reason === 'same-kind-about' && sim >= 0.5) {
        candidates.push({
          newItem,
          existingNoteId: hit.id,
          similarity: Math.max(sim, 0.5),
          reason,
        });
      } else if (sim >= 0.7) {
        candidates.push({
          newItem,
          existingNoteId: hit.id,
          similarity: sim,
          reason: 'similar-text',
        });
      } else if (reason === 'same-kind-about' && normalizeText(newItem.title) === normalizeText(hit.text.split('\n')[0] ?? '')) {
        candidates.push({
          newItem,
          existingNoteId: hit.id,
          similarity: Math.max(sim, 0.6),
          reason: 'same-title',
        });
      }
    }
  }

  return candidates.sort((a, b) => b.similarity - a.similarity);
}
