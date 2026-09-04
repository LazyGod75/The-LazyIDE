/**
 * health-score.ts — Brain health scoring command.
 *
 * Computes a [0..100] health score and detailed diagnostics for the brain:
 *   - orphans:      notes with no inbound or outbound backlinks
 *   - brokenLinks:  backlinks pointing to non-existent notes
 *   - stale:        notes older than 90 days with pagerank < 0.01
 *   - dupes:        notes with identical titles (case-insensitive)
 *
 * Ported from the LazyBrain sibling repo's WIP `src/commands/health-score.ts`.
 * All of its dependencies (indexer/fts.ts listAll, graph/backlinks.ts
 * loadBacklinks, graph/pagerank.ts computePageRank, util/logger.ts getLogger)
 * already exist byte-identical in this engine, so the scoring logic below is
 * ported verbatim. Only `writeHealthMeta` was adapted (see its doc comment).
 *
 * Writes <meta name="cerveau-health" content="..."> into brain/_index.html.
 * The command is non-fatal by design: brain_rebuild_graph (Rust capture.rs)
 * runs it as step 3, after index-rebuild + build-index, and tolerates
 * failure so a health-score bug never blocks a graph rebuild.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBacklinks } from '../graph/backlinks.js';
import { computePageRank } from '../graph/pagerank.js';
import { listAll } from '../indexer/fts.js';
import { getLogger } from '../util/logger.js';

const DAY_MS = 86_400_000;
const STALE_DAYS = 90;
const STALE_PAGERANK_THRESHOLD = 0.01;

export interface HealthScoreResult {
  score: number;
  orphans: number;
  brokenLinks: number;
  stale: number;
  dupes: number;
  /**
   * Denominators for the counts above — added so callers (Settings > Memory)
   * can render a proportion ("3047 of 53268 links") instead of a bare,
   * uninterpretable integer. Optional on the READ side only (src-tauri's
   * `brain_fetch_health` treats any field absent from an older cached
   * `_index.html` meta tag as "unknown, not zero" — see health.rs) — always
   * populated on the WRITE side below.
   */
  totalNotes: number;
  /** Total outbound backlink edges in the corpus — the denominator for `brokenLinks`. */
  totalLinks: number;
}

function daysSince(isoDate: string | null | undefined): number {
  if (!isoDate) return 0;
  const t = Date.parse(isoDate);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / DAY_MS);
}

/**
 * Inject or update <meta name="cerveau-health" content="..."> in _index.html.
 * Silently no-ops if the file does not exist yet — `build-index` is the only
 * command that creates `_index.html` from scratch; this only ever patches an
 * existing file, matching the pipeline order the IDE runs
 * (index-rebuild -> graph -> build-index -> health-score).
 *
 * ADAPTATION vs the ported reference: the reference wrote only the bare score
 * number (`content="<score>"`). This engine's Rust consumer
 * (brain_fetch_health in src-tauri/src/commands/brain/config.rs) and the IDE
 * frontend's `BrainHealth` type (score, orphans, brokenLinks, stale, dupes —
 * see src/lib/platform/types.ts and the MemoryPanel/BrainSpace components
 * that render all five fields, not just the score) both expect the full
 * result. So here the *entire* HealthScoreResult is serialized as JSON and
 * HTML-attribute-escaped (double quotes -> &quot;) into the content
 * attribute, which is what brain_fetch_health's "JSON object" parsing branch
 * is structured to consume.
 */
function writeHealthMeta(brainPath: string, result: HealthScoreResult): void {
  const indexPath = join(brainPath, '_index.html');
  if (!existsSync(indexPath)) return;

  try {
    let html = readFileSync(indexPath, 'utf8');
    const escapedContent = JSON.stringify(result).replace(/"/g, '&quot;');
    const metaTag = `<meta name="cerveau-health" content="${escapedContent}">`;

    if (/name="cerveau-health"/.test(html)) {
      html = html.replace(/<meta name="cerveau-health"[^>]*>/, metaTag);
    } else {
      // Inject just before </head>
      html = html.replace('</head>', `  ${metaTag}\n</head>`);
    }

    writeFileSync(indexPath, html, 'utf8');
  } catch (err) {
    getLogger().warn(
      { err: (err as Error).message },
      'computeHealthScore: could not write health meta to _index.html',
    );
  }
}

/**
 * Compute a [0..100] health score for the brain.
 *
 * Scoring formula:
 *   base = 100
 *   - up to 25 pts if orphan rate is high
 *   - up to 25 pts if broken link rate is high
 *   - up to 25 pts if stale rate is high
 *   - up to 25 pts if dupe rate is high
 *   (partial deductions proportional to severity)
 *
 * Also writes the health meta tag to _index.html.
 */
export async function computeHealthScore(brainPath: string): Promise<HealthScoreResult> {
  const log = getLogger();

  const notes = listAll({ includeExpired: false });
  const totalNotes = notes.length;

  if (totalNotes === 0) {
    const result: HealthScoreResult = {
      score: 100,
      orphans: 0,
      brokenLinks: 0,
      stale: 0,
      dupes: 0,
      totalNotes: 0,
      totalLinks: 0,
    };
    writeHealthMeta(brainPath, result);
    return result;
  }

  const noteIds = new Set(notes.map((n) => n.id));
  const backlinks = loadBacklinks();
  const pr = computePageRank({ cacheKey: 'global' });
  const prScores = pr.scores;

  // -- Orphans: notes with no inbound AND no outbound edges --------------
  const hasInbound = new Set<string>(Object.keys(backlinks?.incoming ?? {}));
  const hasOutbound = new Set<string>(Object.keys(backlinks?.outgoing ?? {}));

  let orphans = 0;
  for (const note of notes) {
    if (!hasInbound.has(note.id) && !hasOutbound.has(note.id)) {
      orphans += 1;
    }
  }

  // -- Broken links: backlink edges pointing to notes not in the corpus --
  let brokenLinks = 0;
  for (const edges of Object.values(backlinks?.outgoing ?? {})) {
    for (const edge of edges) {
      if (!noteIds.has(edge.to)) {
        brokenLinks += 1;
      }
    }
  }

  // -- Stale notes: pagerank < threshold AND older than STALE_DAYS -------
  let stale = 0;
  for (const note of notes) {
    const days = daysSince(note.created);
    const prScore = prScores[note.id] ?? 0;
    if (prScore < STALE_PAGERANK_THRESHOLD && days > STALE_DAYS) {
      stale += 1;
    }
  }

  // -- Duplicates: notes sharing the same title (case-insensitive) -------
  const titleCount = new Map<string, number>();
  for (const note of notes) {
    const title = (note.title ?? '').trim().toLowerCase();
    if (title.length < 5) continue; // skip very short/empty titles
    titleCount.set(title, (titleCount.get(title) ?? 0) + 1);
  }
  let dupes = 0;
  for (const count of titleCount.values()) {
    if (count > 1) dupes += count - 1; // count extra copies
  }

  // -- Score computation ---------------------------------------------------
  const orphanRate = orphans / totalNotes;
  const totalEdges = Object.values(backlinks?.outgoing ?? {}).reduce(
    (sum, edges) => sum + edges.length,
    0,
  );
  const brokenRate = totalEdges > 0 ? brokenLinks / totalEdges : 0;
  const staleRate = stale / totalNotes;
  const dupeRate = dupes / totalNotes;

  // Each dimension contributes up to 25 pts of penalty
  const orphanPenalty = Math.min(25, Math.round(orphanRate * 80));
  const brokenPenalty = Math.min(25, Math.round(brokenRate * 200));
  const stalePenalty = Math.min(25, Math.round(staleRate * 60));
  const dupePenalty = Math.min(25, Math.round(dupeRate * 200));

  const score = Math.max(0, 100 - orphanPenalty - brokenPenalty - stalePenalty - dupePenalty);

  const result: HealthScoreResult = {
    score,
    orphans,
    brokenLinks,
    stale,
    dupes,
    totalNotes,
    totalLinks: totalEdges,
  };

  writeHealthMeta(brainPath, result);

  log.info(
    { score, orphans, brokenLinks, stale, dupes, totalNotes, totalLinks: totalEdges },
    'computeHealthScore: done',
  );

  return result;
}
