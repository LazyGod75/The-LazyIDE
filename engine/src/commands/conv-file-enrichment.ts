/**
 * conv-file-enrichment.ts
 *
 * Deterministic conversation→file-neuron enrichment pipeline (Task 5).
 *
 * Strategy:
 * 1. For each classified knowledge item from a conversation, build
 *    evidence: { neuronId, weight }[] using tool-trace tags.
 * 2. Call canonicalMerge(evidence):
 *    - 'section'  → attach the item to the dominant file-neuron.
 *    - 'concept'  → create a standalone CONCEPT neuron via composeConceptNeuron.
 * 3. Apply recency superseding within each file-neuron: if an older item
 *    contradicts a newer one (same kind + high text overlap), mark the older
 *    with data-cerveau-valid-until and data-cerveau-superseded="true".
 * 4. Re-render each touched file-neuron via composeFileNeuron with the
 *    accumulated enrichment, persisting via writeNote/indexNote.
 *
 * No LLM calls — fully deterministic.
 */

import {
  type ConceptNeuronDescriptor,
  composeConceptNeuron,
} from '../annotator/blocks/composers/concept-neuron.js';
import {
  type EnrichmentItem,
  type FileNeuronEnrichment,
  type FileNeuronSeeAlsoLink,
  composeFileNeuron,
  fileNeuronArticleId,
  normalizeItemText,
} from '../annotator/blocks/composers/file-neuron.js';
import { canonicalMerge } from '../graph/canonical-merge.js';
import type { EvidenceItem } from '../graph/canonical-merge.js';
import type { CodeNode } from '../graph/code-scanner.js';
import { parseSeeAlsoFromHtml } from '../graph/file-neuron-parse.js';
import { getNoteById, indexNote } from '../indexer/fts.js';
import { slug } from '../store/paths.js';
import { readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { getLogger } from '../util/logger.js';
import { isAgentMetaText } from './dream.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Kinds of classified knowledge items (matches enrich.ts CLASSIFIERS).
 *
 * 'activity' is an honest fallback for keyword-less conversations: instead of
 * mislabeling the conversation as a 'decision', we record it as "this file was
 * touched in conversation X" — rendered in its own low-key section.
 */
export type ItemKind = 'decision' | 'bug' | 'idea' | 'rule' | 'qa' | 'warning' | 'activity';

/** A classified knowledge item extracted from a conversation note. */
export interface ConvKnowledgeItem {
  kind: ItemKind;
  text: string;
  sourceId: string;
}

/** A conversation note summarised for enrichment purposes. */
export interface ConvNote {
  id: string;
  /** Project-relative forward-slash file paths that were modified (weight 1.0). */
  filesModified: string[];
  /** Project-relative forward-slash file paths that were read (weight 0.4). */
  filesRead: string[];
  /**
   * Project-relative paths found by scanning the note body text for file-path
   * mentions and matching unambiguously against known file-neuron IDs (weight 0.85).
   * These are pre-validated — no ambiguous basename matches are included.
   * Optional: absent when the note was created without body-mention scanning
   * (e.g. in test fixtures or legacy notes that only carry tool-trace attrs).
   */
  filesBodyMentions?: string[];
  /** ISO date (YYYY-MM-DD) of the conversation. */
  timestamp: string;
  classifiedItems: ConvKnowledgeItem[];
}

/** Input for runFileNeuronEnrichment. */
export interface FileNeuronEnrichmentInput {
  projectRoot: string;
  fileNodes: CodeNode[];
  convNotes: ConvNote[];
}

/** Report produced by runFileNeuronEnrichment. */
export interface FileNeuronEnrichmentReport {
  fileNeuronsEnriched: number;
  conceptNeuronsCreated: number;
  errors: string[];
}

/**
 * An item with temporal metadata — used by applyRecencySuperseding.
 * Extends EnrichmentItem so the result can be passed directly to composeFileNeuron.
 */
// All fields are inherited from EnrichmentItem (text, confidence, date, sourceConvLink,
// superseded?, validUntil?) — a type alias avoids an empty-interface lint error while
// keeping the same structural type.
export type TimestampedItem = EnrichmentItem;

// ---------------------------------------------------------------------------
// Weight constants — match the project's canonical weight table.
// ---------------------------------------------------------------------------

const WEIGHT_MODIFIED = 1.0;
const WEIGHT_TEXT_MENTION = 0.85;
const WEIGHT_READ = 0.4;

// ---------------------------------------------------------------------------
// Contradiction heuristic
// ---------------------------------------------------------------------------

/**
 * Measure text overlap between two strings using a simple bigram Jaccard similarity.
 * Returns a value in [0, 1]; 1.0 means identical.
 *
 * Heuristic: two items of the same kind are "contradicting" when their text
 * overlap > 0.3 (bigram Jaccard). This is intentionally low-precision —
 * the goal is to catch near-duplicate claims, not semantic contradiction.
 * A higher threshold would miss revised claims; a lower one would
 * over-suppress distinct items.
 */
function textOverlap(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const tokens = s.toLowerCase().split(/\s+/).filter(Boolean);
    const result = new Set<string>();
    for (let i = 0; i < tokens.length - 1; i++) {
      result.add(`${tokens[i]} ${tokens[i + 1]}`);
    }
    return result;
  };
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.size === 0 && bb.size === 0) return 1.0;
  if (ba.size === 0 || bb.size === 0) return 0.0;
  let intersection = 0;
  for (const gram of ba) {
    if (bb.has(gram)) intersection++;
  }
  return intersection / (ba.size + bb.size - intersection);
}

const CONTRADICTION_OVERLAP_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// Public: evidence builder
// ---------------------------------------------------------------------------

export interface BuildEvidenceInput {
  filesModified: string[];
  filesRead: string[];
  itemText: string;
  /**
   * Pre-validated body-level file mentions (project-relative paths, already
   * matched unambiguously against the file-neuron set). Weight: WEIGHT_TEXT_MENTION.
   * These are note-level paths, not item-level; they widen evidence beyond the
   * single classified item's text.
   */
  filesBodyMentions?: string[];
}

/**
 * Build evidence array for a single knowledge item.
 *
 * Weights (per canonical table):
 *   filesModified entry    → 1.0
 *   filesRead entry        → 0.4
 *   text file mention      → 0.85  (from itemText OR filesBodyMentions)
 *
 * De-duplication: one entry per neuronId, highest weight wins.
 */
export function buildEvidenceFromTags(input: BuildEvidenceInput): EvidenceItem[] {
  const { filesModified, filesRead, itemText, filesBodyMentions } = input;

  // Accumulate weights per neuron; keep the max weight for each neuronId.
  const weightMap = new Map<string, number>();

  const add = (neuronId: string, weight: number): void => {
    const existing = weightMap.get(neuronId) ?? 0;
    if (weight > existing) weightMap.set(neuronId, weight);
  };

  for (const path of filesModified) {
    add(`file:${path}`, WEIGHT_MODIFIED);
  }

  for (const path of filesRead) {
    add(`file:${path}`, WEIGHT_READ);
  }

  // Pre-validated body mentions (note-level, already disambiguated).
  for (const path of filesBodyMentions ?? []) {
    add(`file:${path}`, WEIGHT_TEXT_MENTION);
  }

  // Text-mention detection: scan itemText for patterns that look like file paths.
  // Pattern: word boundary + optional "./" + path segments with slashes + file extension
  const FILE_PATH_RE = /(?:^|[\s(["'])([a-zA-Z0-9_./\\-]+\.[a-zA-Z]{1,6})(?=$|[\s),"'])/g;
  for (
    let match = FILE_PATH_RE.exec(itemText);
    match !== null;
    match = FILE_PATH_RE.exec(itemText)
  ) {
    const rawPath = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (rawPath?.includes('/')) {
      add(`file:${rawPath}`, WEIGHT_TEXT_MENTION);
    }
  }

  return Array.from(weightMap.entries()).map(([neuronId, weight]) => ({ neuronId, weight }));
}

// ---------------------------------------------------------------------------
// Public: recency superseding
// ---------------------------------------------------------------------------

/**
 * Apply recency superseding to a list of same-kind items from multiple conversations.
 *
 * Items are sorted by date (oldest first). When two items have high text overlap
 * (bigram Jaccard > CONTRADICTION_OVERLAP_THRESHOLD), the older one is marked
 * as superseded with validUntil = newer item's date.
 *
 * Only direct pairwise comparisons are made (N² over typically small lists).
 *
 * @returns New array sorted oldest→newest, with superseded/validUntil set.
 */
export function applyRecencySuperseding(items: TimestampedItem[]): TimestampedItem[] {
  if (items.length <= 1) return items.map((i) => ({ ...i }));

  // Sort by date ascending (oldest first) — immutable copy
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));

  // Mark superseded pairs: compare all (i, j) where i < j (i is older)
  const result: TimestampedItem[] = sorted.map((i) => ({ ...i }));
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      const older = result[i];
      const newer = result[j];
      if (older.superseded) continue; // already superseded — skip further checks
      const overlap = textOverlap(older.text, newer.text);
      if (overlap > CONTRADICTION_OVERLAP_THRESHOLD) {
        result[i] = { ...older, superseded: true, validUntil: newer.date };
        break; // oldest contradicted by the first newer match — no need to check further
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public: merge with already-attached enrichment (incremental-mode safety net)
// ---------------------------------------------------------------------------

/** Normalise item text for exact-duplicate comparison (trim + lowercase). */
function normalizeForDedup(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Merge previously-attached items (already rendered on a file-neuron, parsed
 * back via graph/file-neuron-parse.ts) with this run's freshly-classified
 * items for the same kind.
 *
 * An old item is dropped when its normalized text exactly matches a fresh
 * item's — the fresh item (recomputed this run, generally more trustworthy)
 * wins over the stale HTML-parsed copy. Everything else from `existing`
 * passes through untouched, ahead of the fresh items.
 *
 * This single rule is what makes runFileNeuronEnrichment safe to call with
 * EITHER the full conversation corpus OR only a delta (see the Pass 2 comment
 * in runFileNeuronEnrichment for why each case collapses correctly).
 */
export function mergeWithExisting(
  existing: EnrichmentItem[] | undefined,
  fresh: TimestampedItem[],
): TimestampedItem[] {
  if (!existing || existing.length === 0) return fresh;
  const freshTextSet = new Set(fresh.map((i) => normalizeForDedup(i.text)));
  const survivingOld = existing.filter((i) => !freshTextSet.has(normalizeForDedup(i.text)));
  return [...survivingOld, ...fresh];
}

// ---------------------------------------------------------------------------
// Internal: accumulate enrichment buckets per file-neuron
// ---------------------------------------------------------------------------

type KindBuckets = {
  decisions: TimestampedItem[];
  bugs: TimestampedItem[];
  ideas: TimestampedItem[];
  rules: TimestampedItem[];
  qa: TimestampedItem[];
  warnings: TimestampedItem[];
  activities: TimestampedItem[];
};

function emptyKindBuckets(): KindBuckets {
  return { decisions: [], bugs: [], ideas: [], rules: [], qa: [], warnings: [], activities: [] };
}

function addItemToBucket(buckets: KindBuckets, kind: ItemKind, item: TimestampedItem): void {
  switch (kind) {
    case 'decision':
      buckets.decisions.push(item);
      break;
    case 'bug':
      buckets.bugs.push(item);
      break;
    case 'idea':
      buckets.ideas.push(item);
      break;
    case 'rule':
      buckets.rules.push(item);
      break;
    case 'qa':
      buckets.qa.push(item);
      break;
    case 'warning':
      buckets.warnings.push(item);
      break;
    case 'activity':
      buckets.activities.push(item);
      break;
  }
}

// ---------------------------------------------------------------------------
// Internal: build a concept neuron descriptor
// ---------------------------------------------------------------------------

function buildConceptDescriptor(
  item: ConvKnowledgeItem,
  contributors: string[],
  confidence: number,
  date: string,
  projectRoot: string,
): ConceptNeuronDescriptor {
  const projectName = projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'project';
  // Strip wikilink markers before building the id slug — raw item.text may contain
  // [Label→#...] markers from LLM output that produce garbage slugs like "note-acme-conv-...".
  const cleanText = normalizeItemText(item.text);
  // Build a stable id from kind + text prefix
  const idSlug = slug(`${item.kind}-${cleanText.slice(0, 60)}`);
  const conceptId = `concept:${idSlug}`;

  const related = contributors.map((neuronId) => ({
    id: neuronId,
    title: neuronId.replace(/^file:/, ''),
  }));

  // Map ItemKind to ConceptKind (they overlap; 'qa' maps to 'qa').
  // 'activity' is never expected in concept placement (it is always section-placed),
  // but we map it to 'fact' as a safe fallback to maintain exhaustiveness.
  const kindMap: Record<
    ItemKind,
    import('../annotator/blocks/composers/concept-neuron.js').ConceptKind
  > = {
    decision: 'decision',
    bug: 'bug',
    idea: 'idea',
    rule: 'rule',
    qa: 'qa',
    warning: 'bug',
    activity: 'fact',
  };

  return {
    id: conceptId,
    title: cleanText.slice(0, 80),
    projectName,
    kind: kindMap[item.kind],
    body: item.text,
    confidence,
    date,
    related,
    seeAlso: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse data-code-inbound from an existing file-neuron HTML string.
 * Returns 0 if the attribute is absent or not a valid integer.
 */
function parseInboundFromHtml(html: string): number {
  const m = html.match(/data-code-inbound\s*=\s*["'](\d+)["']/i);
  return m ? Number.parseInt(m[1], 10) || 0 : 0;
}

/**
 * Look up structural metadata (inbound count, see-also links) already stored
 * on an indexed file-neuron.
 *
 * IMPORTANT: looked up via fileNeuronArticleId(node) — the PERSISTED note id
 * (e.g. "file-acme-src-auth-ts") that composeFileNeuron actually writes to
 * disk under — NOT node.id (the CodeNode's internal graph id, shaped
 * "file:<relPath>"). Those are two different id namespaces; looking up by
 * node.id against the notes index silently finds nothing, which is why this
 * used to always fall back to inbound=0 and an empty seeAlso — quietly
 * resetting "Inbound" to 0 and wiping the "See also" section on every
 * conv-enrichment pass over a file-neuron that already had them.
 *
 * Falls back to inbound=0 / seeAlso=[] when the note doesn't exist yet
 * (first enrich run) or on any read/parse failure — this metadata is a
 * best-effort carry-through, never a hard requirement for enrichment to
 * proceed.
 */
function resolveExistingFileNeuronMeta(node: CodeNode): {
  inbound: number;
  seeAlso: FileNeuronSeeAlsoLink[];
} {
  const empty = { inbound: 0, seeAlso: [] as FileNeuronSeeAlsoLink[] };
  try {
    const indexed = getNoteById(fileNeuronArticleId(node));
    if (!indexed) return empty;
    const file = readNote(indexed.path);
    return {
      inbound: parseInboundFromHtml(file.html),
      seeAlso: parseSeeAlsoFromHtml(file.html),
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Public: production entry point
// ---------------------------------------------------------------------------

/**
 * Wire conversation knowledge onto file-neurons (and concept neurons).
 *
 * For each conversation note:
 *   For each classified knowledge item:
 *     1. Build evidence from tool-trace tags (filesModified, filesRead, text mentions).
 *     2. Call canonicalMerge(evidence):
 *        - 'section' → accumulate item into target file-neuron bucket.
 *        - 'concept' → compose+persist a CONCEPT neuron.
 *
 * After processing all conversations, for each touched file-neuron:
 *   3. Apply recency superseding within each kind bucket.
 *   4. Re-compose file-neuron HTML with enrichment and persist via writeNote/indexNote.
 *
 * This is additive — does not delete existing file-neuron notes.
 */
export async function runFileNeuronEnrichment(
  input: FileNeuronEnrichmentInput,
): Promise<FileNeuronEnrichmentReport> {
  const log = getLogger();
  const report: FileNeuronEnrichmentReport = {
    fileNeuronsEnriched: 0,
    conceptNeuronsCreated: 0,
    errors: [],
  };

  // Build lookup: neuronId → CodeNode
  const nodeById = new Map<string, CodeNode>();
  for (const node of input.fileNodes) {
    nodeById.set(node.id, node);
  }

  // Accumulate per-file enrichment buckets (indexed by neuronId)
  const fileBuckets = new Map<string, KindBuckets>();

  const getOrCreateBucket = (neuronId: string): KindBuckets => {
    if (!fileBuckets.has(neuronId)) fileBuckets.set(neuronId, emptyKindBuckets());
    return fileBuckets.get(neuronId)!;
  };

  // Pass 1: classify and route each item
  for (const conv of input.convNotes) {
    for (const item of conv.classifiedItems) {
      const evidence = buildEvidenceFromTags({
        filesModified: conv.filesModified,
        filesRead: conv.filesRead,
        itemText: item.text,
        filesBodyMentions: conv.filesBodyMentions,
      });

      // Filter evidence to only neurons that exist in our node map
      const filteredEvidence = evidence.filter((e) => nodeById.has(e.neuronId));

      if (filteredEvidence.length === 0) {
        // No known file neurons — nothing to attach
        continue;
      }

      const mergeResult = canonicalMerge(filteredEvidence);
      const confidence = mergeResult.maxShare > 0 ? mergeResult.maxShare : 0.5;
      const timestampedItem: TimestampedItem = {
        text: item.text,
        confidence,
        date: conv.timestamp,
        sourceConvLink: `#${item.sourceId}`,
      };

      if (mergeResult.placement === 'section' && mergeResult.neuronId !== null) {
        const bucket = getOrCreateBucket(mergeResult.neuronId);
        addItemToBucket(bucket, item.kind, timestampedItem);
      } else {
        // concept placement — guard against note-metadata residue leaking into concepts.
        // isAgentMetaText includes inline checks for all known residue patterns
        // (session source-id, Type/Status/Tags infobox, Kind/Files/Lines run-ons)
        // so a single call covers all residue categories without a circular import.
        if (isAgentMetaText(item.text)) {
          log.debug(
            { text: item.text.slice(0, 60) },
            'conv-enrich: skipping concept neuron — item text is metadata residue',
          );
          continue;
        }

        // use the projectRoot of the dominant contributor node,
        // falling back to the first contributor's root, then the global input.projectRoot.
        // This ensures concept neurons from project B don't get project A's root.
        const conceptProjectRoot = (() => {
          for (const contributor of mergeResult.contributors) {
            const contributorNode = nodeById.get(contributor);
            if (contributorNode) return contributorNode.projectRoot;
          }
          return input.projectRoot;
        })();
        try {
          const descriptor = buildConceptDescriptor(
            item,
            mergeResult.contributors,
            confidence,
            conv.timestamp,
            conceptProjectRoot,
          );
          const html = composeConceptNeuron(descriptor);
          const written = writeNote(html, { overwrite: true });
          try {
            indexNote(readNote(written.path));
          } catch (err) {
            log.warn(
              { path: written.path, err: (err as Error).message },
              'conv-enrich: concept reindex',
            );
          }
          report.conceptNeuronsCreated += 1;
        } catch (err) {
          const msg = (err as Error).message;
          report.errors.push(`concept for "${item.text.slice(0, 40)}": ${msg}`);
          log.warn({ err: msg }, 'conv-enrich: concept write failed');
        }
      }
    }
  }

  // Pass 2: merge with whatever is already attached to the node (parsed back
  // from its rendered HTML — see file-neuron-parse.ts), apply recency
  // superseding, and persist file-neurons.
  //
  // mergeWithExisting() is always safe to call here, for BOTH call shapes:
  //   - full runs (input.convNotes = the entire conversation corpus): every
  //     "old" item's text is re-derived fresh by Pass 1 this same run, so the
  //     exact-text dedup drops all old entries in favour of their freshly
  //     classified duplicates — net result is identical to reprocessing from
  //     scratch (today's behavior, unchanged).
  //   - incremental runs (input.convNotes = only notes since the last run,
  //     see enrich.ts's runIncrementalEnrich): old items whose text is not
  //     touched by the delta simply pass through unchanged. Combined with
  //     Pass 1 only bucketing neurons that received at least one NEW item,
  //     this is what makes incremental mode non-destructive — a file-neuron
  //     (or a single kind within one) untouched by the delta keeps its full
  //     existing history exactly as rendered before this run.
  for (const [neuronId, buckets] of fileBuckets.entries()) {
    const node = nodeById.get(neuronId);
    if (!node) continue;

    try {
      const enrichment: FileNeuronEnrichment = {
        decisions: applyRecencySuperseding(mergeWithExisting(node.decisions, buckets.decisions)),
        bugs: applyRecencySuperseding(mergeWithExisting(node.bugs, buckets.bugs)),
        ideas: applyRecencySuperseding(mergeWithExisting(node.ideas, buckets.ideas)),
        rules: applyRecencySuperseding(mergeWithExisting(node.rules, buckets.rules)),
        qa: applyRecencySuperseding(mergeWithExisting(node.qa, buckets.qa)),
        warnings: applyRecencySuperseding(mergeWithExisting(node.warnings, buckets.warnings)),
        activities: mergeWithExisting(node.activities, buckets.activities),
      };

      // Preserve the real inbound count and see-also links from the existing
      // file-neuron note so that importance, "Used by", and "See also" are
      // not degraded/wiped on re-enrich.
      const { inbound, seeAlso } = resolveExistingFileNeuronMeta(node);
      const html = composeFileNeuron(node, inbound, enrichment, seeAlso);
      const written = writeNote(html, { overwrite: true });
      try {
        indexNote(readNote(written.path));
      } catch (err) {
        log.warn(
          { path: written.path, err: (err as Error).message },
          'conv-enrich: file-neuron reindex',
        );
      }
      report.fileNeuronsEnriched += 1;
    } catch (err) {
      const msg = (err as Error).message;
      report.errors.push(`${neuronId}: ${msg}`);
      log.warn({ neuronId, err: msg }, 'conv-enrich: file-neuron write failed');
    }
  }

  log.debug(
    {
      fileNeuronsEnriched: report.fileNeuronsEnriched,
      conceptNeuronsCreated: report.conceptNeuronsCreated,
      errors: report.errors.length,
    },
    'conv-enrich: done',
  );

  return report;
}
