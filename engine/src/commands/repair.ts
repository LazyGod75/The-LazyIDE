/**
 * Repair command: targeted, tag-scoped undo for notes damaged by a known
 * bug in dream.ts's noise-cleanup pass (Phase 0.5, runNoiseCleanup).
 *
 * Background: before dream.ts gained NOISE_EXEMPT_TAGS (see dream.ts's
 * hasNoiseExemptTag), a sparse-but-legitimate mission/agent/skill note could
 * be misclassified as noise and stamped
 * `data-cerveau-invalidated-by="dream-noise-cleanup"` — which excludes it
 * from all default recall (fts-search.ts's searchFts excludes any note with
 * a non-empty valid_until unless --include-expired is passed). That bug is
 * fixed going forward, but brains that already accumulated these stamps
 * need a one-time repair. This command is that repair.
 *
 * Actions (currently one; the --un-invalidate-noise flag selects it so more
 * repair actions can be added later without a new command):
 *
 *   --un-invalidate-noise --tags <t1,t2,...>
 *     Scans every note under notes/ and knowledge-nodes/. For each note
 *     that (a) carries the dream-noise-cleanup invalidation stamp AND
 *     (b) has at least one tag in --tags (default: mission,agent,skill),
 *     removes ONLY the data-cerveau-invalidated-by="dream-noise-cleanup"
 *     and data-cerveau-valid-until="..." attributes, then reindexes the
 *     note (the same indexNote(readNote(path)) call invalidate.ts uses)
 *     so the FTS index reflects the repaired note immediately.
 *
 *     Never touches: notes without a matching tag, or notes invalidated
 *     for any OTHER reason (explicit `invalidate` command, contradiction
 *     supersession, a different invalidated-by value) — the stamp-value
 *     check is exact, not a general "un-invalidate everything" tool.
 *
 *     Idempotent: once repaired, the stamp is gone, so a second run finds
 *     zero candidates for the same brain.
 *
 * Safety: --dry-run lists candidates without writing anything. Without
 * --dry-run, the repair APPLIES immediately — this command only ever
 * strips one specific, narrowly-matched attribute pair from notes that
 * already carry a protected tag, so (unlike prune's irreversible delete)
 * there is no destructive default to guard with a dry-run-first policy;
 * --dry-run remains available so a caller can preview before applying.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexNote, listAll } from '../indexer/fts.js';
import { brainRoot } from '../store/paths.js';
import { readNote } from '../store/reader.js';
import { getLogger } from '../util/logger.js';
import { collectHtmlFiles } from './prune.js';

export const DEFAULT_REPAIR_TAGS = ['mission', 'agent', 'skill'];

const INVALIDATED_BY_NOISE_RE = /\s*data-cerveau-invalidated-by\s*=\s*["']dream-noise-cleanup["']/i;
const VALID_UNTIL_RE = /\s*data-cerveau-valid-until\s*=\s*["'][^"']*["']/i;

export interface RepairOptions {
  /** Tags to scope the repair to. Defaults to DEFAULT_REPAIR_TAGS. */
  tags?: string[];
  /** Preview candidates without modifying anything. Default: false (applies). */
  dryRun?: boolean;
  /** Override the brain path (for tests). Falls back to brainRoot(). */
  brainPath?: string;
}

export interface RepairCandidate {
  id: string;
  path: string;
  tags: string[];
}

export interface RepairReport {
  action: 'un-invalidate-noise';
  dryRun: boolean;
  tags: string[];
  candidates: RepairCandidate[];
  repaired: number;
}

function extractTags(html: string): string[] {
  const m = html.match(/data-cerveau-tags\s*=\s*["']([^"']*)["']/i);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

function extractId(html: string, fallback: string): string {
  const m = html.match(/<(?:article|section)\b[^>]*\bid\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : fallback;
}

function wasInvalidatedByNoiseCleanup(html: string): boolean {
  return INVALIDATED_BY_NOISE_RE.test(html);
}

/**
 * Shared core: repair ONE note file if it is an eligible candidate (carries
 * the dream-noise-cleanup stamp AND at least one protected tag). Used by
 * both candidate-sourcing strategies below so the actual eligibility check +
 * attribute-stripping + reindex logic lives in exactly one place:
 *
 *   - runRepairUnInvalidateNoise (manual `repair` CLI): sources candidates
 *     from a full filesystem walk (collectHtmlFiles) — thorough and
 *     index-independent, appropriate for a one-shot ops tool that must keep
 *     working even if the index itself is stale, missing, or corrupt.
 *   - healNoiseExemptNotes (automatic maintenance pass, dream.ts): sources
 *     candidates from the FTS index's `valid_until` column — bounded to
 *     already-invalidated notes only, appropriate for a step that runs
 *     unattended every 30 minutes and must never re-scan the whole brain.
 *
 * Returns null when `filePath`/`html` is not an eligible candidate. When
 * dryRun is false, applies the fix (strip the two attributes + reindex) as
 * a side effect before returning the candidate info.
 */
function repairFileIfEligible(
  filePath: string,
  html: string,
  tags: string[],
  dryRun: boolean,
  log: ReturnType<typeof getLogger>,
): RepairCandidate | null {
  if (!wasInvalidatedByNoiseCleanup(html)) return null;

  const fileTags = extractTags(html);
  if (!tags.some((t) => fileTags.includes(t))) return null;

  if (!dryRun) {
    const repaired = html.replace(INVALIDATED_BY_NOISE_RE, '').replace(VALID_UNTIL_RE, '');
    writeFileSync(filePath, repaired, 'utf-8');
    try {
      indexNote(readNote(filePath));
    } catch (err) {
      log.warn({ path: filePath, err: (err as Error).message }, 'repair: reindex failed');
    }
  }

  return { id: extractId(html, filePath), path: filePath, tags: fileTags };
}

/**
 * Run the "un-invalidate-noise" repair action.
 *
 * Dry-run when opts.dryRun === true; applies immediately otherwise — see
 * this module's doc comment for why the default differs from prune's.
 *
 * Full filesystem walk (notes/ + knowledge-nodes/) — this is the manual/ops
 * surface, deliberately independent of the FTS index. See healNoiseExemptNotes
 * below for the bounded, index-based variant the automatic maintenance pass uses.
 */
export function runRepairUnInvalidateNoise(opts: RepairOptions = {}): RepairReport {
  const log = getLogger();
  const tags = opts.tags && opts.tags.length > 0 ? opts.tags : DEFAULT_REPAIR_TAGS;
  const dryRun = opts.dryRun === true;

  const root = opts.brainPath ?? brainRoot();
  const files = [
    ...collectHtmlFiles(join(root, 'notes')),
    ...collectHtmlFiles(join(root, 'knowledge-nodes')),
  ];

  const candidates: RepairCandidate[] = [];

  for (const filePath of files) {
    let html: string;
    try {
      html = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const candidate = repairFileIfEligible(filePath, html, tags, dryRun, log);
    if (candidate) candidates.push(candidate);
  }

  log.info(
    { action: 'un-invalidate-noise', dryRun, tags, count: candidates.length },
    'repair: complete',
  );

  return {
    action: 'un-invalidate-noise',
    dryRun,
    tags,
    candidates,
    repaired: dryRun ? 0 : candidates.length,
  };
}

export interface HealReport {
  tags: string[];
  candidates: RepairCandidate[];
  healed: number;
}

/**
 * Bounded variant of the un-invalidate-noise repair for the AUTOMATIC
 * maintenance pass (dream.ts's runDream, invoked every 30 min by the brain
 * consolidator — see src-tauri/src/commands/brain/maintenance.rs). Scans
 * only notes the FTS index already marks as invalidated (`valid_until` set)
 * instead of walking every note file in the brain, then applies the exact
 * same eligibility check + repair as the manual CLI (repairFileIfEligible) —
 * no duplicated logic between the two surfaces.
 *
 * dryRun defaults to false (the automatic pass is meant to actually heal),
 * but dream.ts wires its own --dry-run flag through so a preview run never
 * writes anything, matching the rest of the dream pipeline's contract.
 *
 * Idempotent: once a note is repaired it no longer has `valid_until` set, so
 * it drops out of the candidate set on the very next call — 0 candidates
 * forever after, for that note, on every subsequent maintenance pass.
 */
export function healNoiseExemptNotes(
  tags: string[] = DEFAULT_REPAIR_TAGS,
  dryRun = false,
): HealReport {
  const log = getLogger();
  const invalidated = listAll({ includeExpired: true }).filter((n) => !!n.valid_until);

  const candidates: RepairCandidate[] = [];
  for (const n of invalidated) {
    let html: string;
    try {
      html = readFileSync(n.path, 'utf-8');
    } catch {
      continue;
    }

    const candidate = repairFileIfEligible(n.path, html, tags, dryRun, log);
    if (candidate) candidates.push(candidate);
  }

  const healed = dryRun ? 0 : candidates.length;
  if (healed > 0) {
    log.info({ healedNotes: healed, tags }, 'repair: maintenance auto-heal complete');
  }

  return { tags, candidates, healed };
}
