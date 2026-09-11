import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SnapshotCache } from '../indexer/corpus-cache.js';
import { type IndexedNote, getDb, listAllWithText } from '../indexer/fts.js';
import { readAllNotes } from '../store/reader.js';
import { getConfig } from '../util/config.js';
import { loadBacklinks } from './backlinks.js';

export interface PageRankResult {
  /** node id → score in [0, 1] (sums to ~1) */
  scores: Record<string, number>;
  /** parameters used */
  alpha: number;
  iterations: number;
  /** what seeded the personalization vector */
  seeded_by: string;
  /** ISO timestamp */
  generated: string;
}

export interface PageRankOptions {
  /** Notes to bias toward; their personalization weight is amplified */
  seeds?: string[];
  /** Damping factor (typically 0.85) */
  alpha?: number;
  /** Maximum iterations */
  maxIters?: number;
  /** Convergence threshold (L1 delta between iterations) */
  tol?: number;
  /** Cache key (e.g. cwd or 'global'); allows storing multiple variants. */
  cacheKey?: string;
  /** Force fresh computation even if a cached value exists. */
  noCache?: boolean;
}

const CACHE_FILENAME = 'pagerank.json';

/**
 * Compute Personalized PageRank over the brain graph.
 *
 *   - Edges come from backlinks (outgoing).
 *   - Personalization vector = uniform over seeds (or all nodes if no seeds).
 *   - When the user is in a specific working directory (cwd), seed with notes
 *     whose data-cerveau-cwd matches → those nodes bubble up in retrieval.
 */
export function computePageRank(opts: PageRankOptions = {}): PageRankResult {
  const alpha = opts.alpha ?? 0.85;
  const maxIters = opts.maxIters ?? 30;
  const tol = opts.tol ?? 1e-4;
  const cacheKey = opts.cacheKey ?? 'global';

  // Try cache first
  if (!opts.noCache) {
    const cached = loadCached(cacheKey);
    if (cached) return cached;
  }

  // Speed fix: listAllWithText({includeExpired:false}) is the exact same
  // corpus fetch runL3/runL2L3Hybrid already ran moments earlier in this same
  // query (see indexer/note-read.ts's withTextCache) — by the time
  // computePageRank() runs (called only from applyPageRank(), itself gated to
  // finalLevel L3/L4), that cache entry is warm, so this resolves from memory
  // instead of re-running `SELECT * FROM notes`. Using the WithText variant
  // instead of a bespoke listAll() call means this ride-shares that cache
  // instead of missing it by one filter-shape mismatch.
  const notes = listAllWithText({ includeExpired: false });
  if (notes.length === 0) {
    return {
      scores: {},
      alpha,
      iterations: 0,
      seeded_by: cacheKey,
      generated: new Date().toISOString(),
    };
  }
  const ids = notes.map((n) => n.id);
  const n = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));

  // Build outgoing adjacency from backlinks
  const backlinks = loadBacklinks();
  const outDeg = new Array<number>(n).fill(0);
  const outList: number[][] = Array.from({ length: n }, () => []);
  if (backlinks) {
    for (const edges of Object.values(backlinks.outgoing ?? {})) {
      for (const e of edges) {
        const a = idx.get(e.from);
        const b = idx.get(e.to);
        if (a === undefined || b === undefined) continue;
        outList[a].push(b);
        outDeg[a] += 1;
      }
    }
  }

  // Personalization vector
  const seedsRaw = opts.seeds ?? ids;
  const seedIdx = seedsRaw.map((id) => idx.get(id)).filter((i): i is number => i !== undefined);
  const personalization = new Array<number>(n).fill(0);
  const seedWeight = 1 / Math.max(1, seedIdx.length);
  for (const i of seedIdx) personalization[i] += seedWeight;

  // Power iteration
  let r = new Array<number>(n).fill(1 / n);
  let iterations = 0;
  for (let it = 0; it < maxIters; it++) {
    iterations += 1;
    const rNext = new Array<number>(n).fill(0);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      if (outDeg[i] === 0) {
        danglingMass += r[i];
      } else {
        const share = r[i] / outDeg[i];
        for (const j of outList[i]) rNext[j] += share;
      }
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const teleport =
        (1 - alpha) * personalization[i] + alpha * (danglingMass * personalization[i]);
      rNext[i] = teleport + alpha * rNext[i];
      delta += Math.abs(rNext[i] - r[i]);
    }
    // Normalise to sum=1 (numerical safety)
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rNext[i];
    if (sum > 0) {
      for (let i = 0; i < n; i++) rNext[i] /= sum;
    }
    r = rNext;
    if (delta < tol) break;
  }

  const scores: Record<string, number> = {};
  for (let i = 0; i < n; i++) scores[ids[i]] = r[i];

  const result: PageRankResult = {
    scores,
    alpha,
    iterations,
    seeded_by: cacheKey,
    generated: new Date().toISOString(),
  };
  saveCached(cacheKey, result);
  return result;
}

/**
 * Freshness-gated cache of note id -> raw data-cerveau-cwd attribute value,
 * used by notesForCwd() below. See corpus-cache.ts's module doc for the
 * design this mirrors.
 *
 * Problem measured: notesForCwd() used to call readAllNotes() — a recursive
 * directory walk that reads and fully parses EVERY note .html file on disk —
 * on every single call. notesForCwd() is called from applyPageRank()
 * (retrieval/rankers.ts), which runs on every L3/L4 query. On a realistic
 * 5488-note/6138-file brain this cost 670ms-4s PER CALL (cold-cache runs
 * measured up to ~4s; warm OS file-cache runs ~700ms-1.4s), entirely to
 * extract one attribute per file. Since the `notes` table (kept in sync with
 * the file corpus by indexNote()/bumpLocalWriteVersion()) already tells us
 * whether the corpus changed, we can build this id->cwd map once per
 * freshness epoch and reuse it, exactly like withTextCache in note-read.ts.
 *
 * cwd is NOT stored as its own indexed column (unlike source/tags/topic —
 * see note-index.ts): adding one would require a schema migration AND a
 * backfill pass over every existing note to populate historical rows, which
 * is a bigger, riskier change than this task's scope. This cache keeps the
 * exact same extraction logic (same regex, same normalization, same
 * bidirectional-prefix match) so results are byte-identical to before —
 * only the redundant re-reads are removed.
 */
const cwdIndexCache = new SnapshotCache<Map<string, string>>();

function buildCwdIndex(): Map<string, string> {
  const map = new Map<string, string>();
  for (const note of readAllNotes()) {
    const m = note.html.match(/data-cerveau-cwd\s*=\s*"([^"]+)"/);
    if (m) map.set(note.id, m[1]);
  }
  return map;
}

/**
 * Find notes whose data-cerveau-cwd attribute matches the given path
 * (or any of its prefixes). Used as PPR seeds when the user is in a
 * specific working directory.
 */
export function notesForCwd(cwd: string | undefined | null): string[] {
  if (!cwd) return [];
  const normalized = cwd.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  if (!normalized) return [];
  const cwdIndex = cwdIndexCache.resolve(getDb(), 'notes', 'cwd-index', buildCwdIndex);
  const ids: string[] = [];
  for (const [id, rawCwd] of cwdIndex) {
    const candidate = rawCwd.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    if (
      candidate === normalized ||
      normalized.startsWith(`${candidate}/`) ||
      candidate.startsWith(`${normalized}/`)
    ) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Find notes created within the last N days. Used as PPR seeds for recency bias.
 */
export function recentNotes(notes: IndexedNote[], days: number): string[] {
  const cutoff = Date.now() - days * 86_400_000;
  return notes
    .filter((n) => {
      if (!n.created) return false;
      const t = new Date(n.created).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .map((n) => n.id);
}

function cachePath(key: string): string {
  const cfg = getConfig();
  if (!existsSync(cfg.cachePath)) mkdirSync(cfg.cachePath, { recursive: true });
  const safeKey = key.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60) || 'global';
  return join(cfg.cachePath, `${CACHE_FILENAME.replace('.json', '')}-${safeKey}.json`);
}

function loadCached(key: string): PageRankResult | null {
  const path = cachePath(key);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as PageRankResult;
    // Invalidate cache older than 6 hours
    if (Date.now() - new Date(data.generated).getTime() > 6 * 3600_000) return null;
    return data;
  } catch {
    return null;
  }
}

function saveCached(key: string, result: PageRankResult): void {
  writeFileSync(cachePath(key), JSON.stringify(result, null, 2), 'utf8');
}
