/**
 * session-inject.ts — Session-mode inject builder and feature-map helper.
 *
 * Owns: runSessionInject, tryCompressFileNeuron, renderFull, tryFeatureMapInject,
 *       and the session scoring/pagination logic.
 *
 * Extracted from sections.ts for size reduction.
 */

import { loadBacklinks } from '../../graph/backlinks.js';
import { loadClusters } from '../../graph/clusters.js';
import { parseFileNeuronHtml } from '../../graph/file-neuron-parse.js';
import { computePageRank, notesForCwd } from '../../graph/pagerank.js';
import { type IndexedNote, listAll } from '../../indexer/fts.js';
import { compressFileNeuron } from '../../retrieval/compress-file-neuron.js';
import { retentionScore } from '../../retrieval/decay.js';
import { type StrippedNote, stripNote, stripNoteToPrompt } from '../../retrieval/strip.js';
import { profileTextForInjection } from '../../store/profile.js';
import { readNote } from '../../store/reader.js';
import { logTelemetry, nowIso } from '../../util/telemetry.js';
import { estimateTokenCount } from '../../util/tokenize.js';
import type { InjectContextCliOptions } from '../inject-context.js';
import { compactLine } from './sections.js';

// ---------------------------------------------------------------------------
// Constants (shared between session and marker modes)
// ---------------------------------------------------------------------------

export const DEFAULT_TURN_MAX_TOKENS = 150;

// L2 (BM25) scores are small floating-point values (~0.01–0.05) normalized
// by SQLite FTS5. Using 0.5 as a floor filters ALL valid BM25 results.
// 0.01 retains well-matched notes while excluding random noise (score < 0.005).
// L2_L3_HYBRID falls back to L2 when ONNX models are unavailable; it must
// use the same low floor as L2 so BM25-only results are not discarded.
export const MIN_SCORE_BY_LEVEL: Record<string, number> = {
  L1: 0.5,
  L2: 0.01,
  L2_L3_HYBRID: 0.01,
  L3: 0.45,
  L4: 0.0,
};

const COMPACT_LEGEND =
  'Brain idx [MM-DD T #id title (tags)] D=decision E=episodic R=reference S=semantic P=procedural · `lazybrain query #id` for full.';

const SKELETON_PAGERANK_PERCENTILE = 0.4;
const PAGERANK_BLEND_WEIGHT = 0.5;
const CWD_AFFINITY_BOOST = 1.5;

// ---------------------------------------------------------------------------
// tryCompressFileNeuron / renderFull
// ---------------------------------------------------------------------------

export function tryCompressFileNeuron(
  notePath: string,
  normalizedPr: number,
  skeletonThreshold: number,
): string | null {
  try {
    const file = readNote(notePath);
    const codeNode = parseFileNeuronHtml(file.html);
    if (!codeNode) return null;
    const skeletonOnly = normalizedPr < skeletonThreshold;
    return compressFileNeuron(codeNode, { skeletonOnly });
  } catch {
    return null;
  }
}

export function renderFull(
  n: IndexedNote,
  backlinks: ReturnType<typeof loadBacklinks>,
  clusters: ReturnType<typeof loadClusters>,
): string | null {
  try {
    const file = readNote(n.path);
    const stripped = stripNote(file.html) as StrippedNote;
    let prompt = stripNoteToPrompt(stripped);
    const inbound = backlinks?.incoming[n.id]?.length ?? 0;
    const outbound = backlinks?.outgoing[n.id]?.length ?? 0;
    const links = inbound + outbound;
    const cluster = clusters?.members[n.id];
    const clusterLabel = cluster !== undefined ? clusters?.labels[cluster] : undefined;
    if (links >= 2 || (links >= 1 && clusterLabel)) {
      const parts: string[] = [];
      if (clusterLabel) parts.push(`c=${clusterLabel}`);
      parts.push(`l:${inbound}/${outbound}`);
      prompt += ` · ${parts.join(' ')}`;
    }
    return prompt;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// runSessionInject
// ---------------------------------------------------------------------------

export function runSessionInject(opts: InjectContextCliOptions): string {
  const start = Date.now();
  const budget = opts.maxTokens ?? 3000;
  const format = opts.format ?? 'full';
  const all = listAll({ includeExpired: false });

  const batches = all.filter((n) => n.path.includes('batches')).slice(0, 5);
  const notes = all
    .filter((n) => !n.path.includes('batches'))
    .filter((n) => !n.path.endsWith('_user-profile.html'));

  const { normalizedPr, cwdMatchSet } = buildPrScores(notes, opts.cwd);

  // Q6: Ebbinghaus retention scoring blended with PageRank.
  const now = Date.now();
  const scored = notes.map((n) => {
    const retention = retentionScore(n, now);
    const pr = normalizedPr.get(n.id) ?? 0;
    const base = retention * (1 + PAGERANK_BLEND_WEIGHT * pr);
    const combined = cwdMatchSet.has(n.id) ? base * CWD_AFFINITY_BOOST : base;
    return { note: n, score: combined, pr };
  });
  scored.sort((a, b) => b.score - a.score);

  // Compute PageRank percentile threshold for skeleton-only mode on file-neurons.
  const skeletonPrThreshold = computeSkeletonThreshold(scored);

  const sections: string[] = [];
  let tokens = 0;

  const profile = profileTextForInjection();
  if (profile) {
    const profileBlock = `[USER PROFILE]\n${profile}`;
    sections.push(profileBlock);
    tokens += estimateTokenCount(profileBlock);
  }

  const headlineLimit = format === 'compact' ? 3 : scored.length;
  const headlineSet = new Set(scored.slice(0, headlineLimit).map((s) => s.note.id));
  const backlinks = loadBacklinks();
  const clusters = loadClusters();

  // 1) Batches first
  for (const b of batches) {
    if (tokens >= budget) break;
    const piece = renderFull(b, backlinks, clusters);
    if (!piece) continue;
    const estimated = estimateTokenCount(piece);
    if (tokens + estimated > budget && sections.length > 0) continue;
    sections.push(`[BATCH]\n${piece}`);
    tokens += estimated;
  }

  // 2) Headline notes
  const headlineNotes = notes.filter((n) => headlineSet.has(n.id));
  headlineNotes.sort((a, b) => a.id.localeCompare(b.id));
  for (const n of headlineNotes) {
    if (tokens >= budget) break;
    const compressed = tryCompressFileNeuron(
      n.path,
      normalizedPr.get(n.id) ?? 0,
      skeletonPrThreshold,
    );
    if (compressed !== null) {
      const estimated = estimateTokenCount(compressed);
      if (tokens + estimated > budget && sections.length > 0) continue;
      sections.push(`[FILE]\n${compressed}`);
      tokens += estimated;
      continue;
    }
    const piece = renderFull(n, backlinks, clusters);
    if (!piece) continue;
    const estimated = estimateTokenCount(piece);
    if (tokens + estimated > budget && sections.length > 0) continue;
    sections.push(`[NOTE]\n${piece}`);
    tokens += estimated;
  }

  // 3) Tail in compact mode
  if (format === 'compact') {
    const tail = notes.filter((n) => !headlineSet.has(n.id));
    tail.sort((a, b) => a.id.localeCompare(b.id));
    const lines = tail.map(compactLine).filter(Boolean);
    if (lines.length > 0) {
      const indexBlock = `[INDEX]\n${COMPACT_LEGEND}\n${lines.join('\n')}`;
      const estimated = estimateTokenCount(indexBlock);
      if (tokens + estimated <= budget || sections.length === 0) {
        sections.push(indexBlock);
        tokens += estimated;
      }
    }
  }

  const output = sections.join('\n\n').trim();
  const duration = Date.now() - start;
  logTelemetry({
    event: 'inject',
    ts: nowIso(),
    tokens,
    sections: sections.length,
    duration_ms: duration,
  });

  if (opts.pretty) {
    return `# Brain context — ${sections.length} blocks, ~${tokens} tokens (${duration}ms, format=${format})\n\n${output}`;
  }
  return output;
}

function buildPrScores(
  notes: IndexedNote[],
  cwd: string | undefined,
): { normalizedPr: Map<string, number>; cwdMatchSet: Set<string> } {
  let pagerankScores: Record<string, number> = {};
  try {
    const pr = computePageRank({ noCache: false });
    pagerankScores = pr.scores;
  } catch {
    // best-effort
  }
  const prValues = notes.map((n) => pagerankScores[n.id] ?? 0);
  const prMax = Math.max(...prValues, 1e-9);
  const normalizedPr = new Map<string, number>(
    notes.map((n, i) => [n.id, (prValues[i] ?? 0) / prMax]),
  );
  const cwdMatchSet = new Set<string>(cwd ? notesForCwd(cwd) : []);
  return { normalizedPr, cwdMatchSet };
}

function computeSkeletonThreshold(scored: Array<{ note: IndexedNote; pr: number }>): number {
  const fileNeuronPrValues = scored
    .filter((s) => s.note.type === 'file-neuron')
    .map((s) => s.pr)
    .sort((a, b) => a - b);
  const thresholdIdx = Math.floor(fileNeuronPrValues.length * SKELETON_PAGERANK_PERCENTILE);
  return fileNeuronPrValues[thresholdIdx] ?? 0;
}

// ---------------------------------------------------------------------------
// tryFeatureMapInject — turn mode fast-path for project overview queries
// ---------------------------------------------------------------------------

/** Minimum number of real feature lines required for a feature map to be emitted. */
const FEATURE_MAP_MIN_LINES = 2;

export function tryFeatureMapInject(query: string, _cwd?: string): string | null {
  const lower = query.toLowerCase().trim();
  const allNotes = listAll({ includeExpired: false });

  const projects = new Map<string, Map<string, IndexedNote[]>>();
  for (const n of allNotes) {
    const topic = n.topic;
    if (!topic) continue;
    const parts = topic.split('/');
    const proj = parts[0];
    const feat = parts[1] || '_general';
    if (!projects.has(proj)) projects.set(proj, new Map());
    const p = projects.get(proj)!;
    if (!p.has(feat)) p.set(feat, []);
    p.get(feat)!.push(n);
  }

  for (const [projName, features] of projects) {
    if (!lower.includes(projName)) continue;
    const overview = buildProjectOverviewText(projName, features, lower);
    // Minimum-usefulness gate: return null when the map has fewer than
    // FEATURE_MAP_MIN_LINES real feature lines (i.e. only a bare header).
    if (overview === null) return null;
    return overview;
  }

  return null;
}

/**
 * Build a text overview of a project's features.
 * Returns null when the result would be a bare header with no useful content
 * (minimum-usefulness gate: fewer than FEATURE_MAP_MIN_LINES feature lines).
 */
function buildProjectOverviewText(
  projName: string,
  features: Map<string, IndexedNote[]>,
  lower: string,
): string | null {
  const featureLines: string[] = [];
  for (const [featName, featNotes] of [...features.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    if (featName === '_general') continue;
    const decisions = featNotes.filter((n) => n.type === 'decision' && !n.valid_until);
    const warnings = featNotes.filter((n) => n.warnings);
    const best = [...featNotes].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
    const tldr = (best?.title ?? '').slice(0, 60);
    let line = `  ${featName}: ${tldr}`;
    const counts: string[] = [];
    if (decisions.length) counts.push(`D:${decisions.length}`);
    if (warnings.length) counts.push(`W:${warnings.length}`);
    if (counts.length) line += ` | ${counts.join(' ')}`;
    featureLines.push(line);
    for (const d of decisions.slice(0, 2)) {
      featureLines.push(`    D ${(d.title ?? '').slice(0, 50)}`);
    }
    for (const w of warnings.slice(0, 1)) {
      const wText = (w.warnings ?? '').split('|')[0].slice(0, 60);
      featureLines.push(`    ! ${wText}`);
    }
  }

  // Gate: require at least FEATURE_MAP_MIN_LINES real feature lines.
  if (featureLines.length < FEATURE_MAP_MIN_LINES) return null;

  const lines: string[] = [`[${projName}/ map]`, ...featureLines];

  for (const [featName, featNotes] of features) {
    if (lower.includes(featName) && featName !== '_general') {
      lines.push(`\n  [${projName}/${featName} detail]`);
      for (const n of [...featNotes]
        .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
        .slice(0, 5)) {
        const type = n.type === 'decision' ? 'D' : n.type === 'reference' ? 'R' : 'E';
        lines.push(`    ${type} ${(n.title ?? '').slice(0, 60)}`);
      }
    }
  }

  return lines.join('\n');
}
