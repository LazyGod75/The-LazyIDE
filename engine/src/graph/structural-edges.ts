/**
 * structural-edges.ts — Principled, deterministic structural edge generator.
 *
 * Adds four families of edges to the brain graph that the backlinks index does
 * not capture, making the layout genuinely clustered (not a starfield):
 *
 *   1. HIERARCHY   — note → topic-parent → … → root aggregate.
 *                   Creates the backbone "belongs-to" chain for every note.
 *
 *   2. SHARED-ENTITY — notes sharing a named entity (data-cerveau-entities)
 *                   get paired, capped at K_ENTITY_PER_NOTE per note and
 *                   skipped for entities that appear in > TOO_GENERIC_RATIO
 *                   of all notes (too-generic skip).
 *
 *   3. SAME-FILE   — conversation notes that were recorded against the same
 *                   source file link to each other (via their `source` field or
 *                   data-code-file attribute that survived indexing).
 *
 *   4. TEMPORAL    — consecutive notes from the same cwd/session get a thin
 *                   chain edge (capped at TEMPORAL_CHAIN_CAP per cwd group so
 *                   no single project dominates the edge budget).
 *
 * All edges carry:
 *   type       — "hierarchy" | "shared-entity" | "same-file" | "temporal"
 *   strength   — 0.8 / 0.5 / 0.7 / 0.3  (decreasing by confidence)
 *   confidence — "inferred"
 *
 * Determinism guarantee:
 *   - No Math.random calls anywhere.
 *   - All sorting is by stable, data-derived keys (id asc as tiebreaker).
 *   - Same input → byte-identical output (verified by determinism tests).
 *
 * Degree cap:
 *   A node accumulates at most MAX_STRUCTURAL_DEGREE structural edges total.
 *   When the cap would be exceeded, we keep the highest-strength edges
 *   (tiebreak: target id asc) and drop the rest, logging a single warn.
 */

import type { IndexedNote } from '../indexer/fts.js';
import type { BrainEdge, BrainNode } from './knowledge-graph.js';

// ---------------------------------------------------------------------------
// Constants — all tunable without breaking determinism
// ---------------------------------------------------------------------------

/** Maximum structural edges from shared-entity pairings per note. */
export const K_ENTITY_PER_NOTE = 5;

/**
 * If an entity string appears in more than this fraction of notes,
 * it is treated as too-generic and skipped for pairwise linking.
 * At 2204 notes: floor(2204 * 0.08) = 176 → entities in 177+ notes are skipped.
 */
export const TOO_GENERIC_RATIO = 0.08;

/** Maximum temporal chain edges per cwd group. */
export const TEMPORAL_CHAIN_CAP = 30;

/** Maximum total structural (in+out) degree added per node. */
export const MAX_STRUCTURAL_DEGREE = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StructuralEdgesInput {
  /** Full note records from the FTS index (listAll output). */
  notes: IndexedNote[];
  /** Existing graph nodes (used for type lookups and aggregate identification). */
  nodes: BrainNode[];
}

export interface StructuralEdgesResult {
  /** New edges to merge into the graph. May contain duplicates vs existing edges;
   * callers should deduplicate by source+target+type. */
  edges: BrainEdge[];
  stats: {
    hierarchy: number;
    sharedEntity: number;
    sameFile: number;
    temporal: number;
    degreeCapDropped: number;
  };
}

// ---------------------------------------------------------------------------
// 1. HIERARCHY edges
// ---------------------------------------------------------------------------

/**
 * For every note with a topicPath like "project/module/feature", emit:
 *   note          --hierarchy--> project/module/feature   (its direct parent)
 *   project/module/feature --hierarchy--> project/module  (aggregate chain)
 *   project/module         --hierarchy--> project          (aggregate chain)
 *
 * Aggregate nodes are identified by type "aggregate-neuron" or by being the
 * canonical node whose id matches a topic-path segment exactly.
 *
 * If no aggregate node exists for an intermediate path, the edge is still
 * emitted — it will be filtered downstream if the target id is not in the
 * graph (consistent with backlinks behaviour).
 */
function buildHierarchyEdges(notes: IndexedNote[], nodeMap: Map<string, BrainNode>): BrainEdge[] {
  const edges: BrainEdge[] = [];
  const seen = new Set<string>();

  const addEdge = (source: string, target: string): void => {
    if (source === target) return;
    const key = `${source}::${target}::hierarchy`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      source,
      target,
      type: 'hierarchy',
      strength: 0.8,
      confidence: 'inferred',
      confidenceScore: 0.8,
    });
  };

  // Aggregate nodes keyed by their topicPath (or id for project-level)
  const aggregateByPath = new Map<string, string>();
  for (const node of nodeMap.values()) {
    if (node.type === 'aggregate-neuron' || node.type === 'topic-overview') {
      aggregateByPath.set(node.topicPath, node.id);
    }
  }

  for (const note of notes) {
    const topicPath = note.topic ?? '';
    if (!topicPath || topicPath === 'unknown') continue;

    const segments = topicPath.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    // note → direct parent aggregate (if exists), else first ancestor that has a node
    // Walk up the path and emit "belongs-to" for each adjacent pair
    let childId = note.id;
    for (let depth = segments.length; depth >= 1; depth--) {
      const parentPath = segments.slice(0, depth).join('/');
      // Direct parent: depth = segments.length → this is note's topic-path container
      const parentId = aggregateByPath.get(parentPath);
      if (parentId && nodeMap.has(parentId) && parentId !== childId) {
        addEdge(childId, parentId);
        childId = parentId; // continue chain up
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// 2. SHARED-ENTITY edges
// ---------------------------------------------------------------------------

/**
 * Parse the data-cerveau-entities attribute value.
 * Format: "db:postgres-prod,lib:react,api:stripe" (comma-separated).
 * Returns normalised lowercase keys.
 */
function parseEntities(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length >= 3);
}

function buildSharedEntityEdges(notes: IndexedNote[], nodeIds: Set<string>): BrainEdge[] {
  const edges: BrainEdge[] = [];
  const seen = new Set<string>();

  // Build entity → note ids map
  const entityToNotes = new Map<string, string[]>();
  for (const note of notes) {
    if (!nodeIds.has(note.id)) continue;
    for (const entity of parseEntities(note.entities)) {
      const arr = entityToNotes.get(entity) ?? [];
      arr.push(note.id);
      entityToNotes.set(entity, arr);
    }
  }

  const totalNotes = notes.length;
  const tooGenericThreshold = Math.max(2, Math.floor(totalNotes * TOO_GENERIC_RATIO));

  // Candidate pairs per note: sorted by (shared entity count desc, target id asc)
  // Map note → array of { targetId, sharedCount }
  const pairScore = new Map<string, Map<string, number>>();

  for (const [_entity, noteList] of entityToNotes) {
    // Skip too-generic entities
    if (noteList.length > tooGenericThreshold) continue;
    // Skip singletons — no pairing possible
    if (noteList.length < 2) continue;

    const sorted = [...noteList].sort(); // deterministic: id asc
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        const mapA = pairScore.get(a) ?? new Map<string, number>();
        mapA.set(b, (mapA.get(b) ?? 0) + 1);
        pairScore.set(a, mapA);
        const mapB = pairScore.get(b) ?? new Map<string, number>();
        mapB.set(a, (mapB.get(a) ?? 0) + 1);
        pairScore.set(b, mapB);
      }
    }
  }

  // For each note, pick top-K pairs by (sharedCount desc, id asc)
  for (const [sourceId, targets] of pairScore) {
    const sorted = [...targets.entries()]
      .sort(([idA, cntA], [idB, cntB]) => {
        if (cntB !== cntA) return cntB - cntA;
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      })
      .slice(0, K_ENTITY_PER_NOTE);

    for (const [targetId] of sorted) {
      // Canonical key: smaller id first to avoid bidirectional duplicates
      const [lo, hi] = sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];
      const key = `${lo}::${hi}::shared-entity`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: lo,
        target: hi,
        type: 'shared-entity',
        strength: 0.5,
        confidence: 'inferred',
        confidenceScore: 0.5,
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// 3. SAME-FILE edges
// ---------------------------------------------------------------------------

/**
 * Notes that share the same `source` field (e.g. "code-scanner:/path/to/file.ts")
 * or the same code-file slug from their id (file-neurons share the same file path)
 * are linked to each other.
 *
 * Only conversation notes (not file-neuron or aggregate-neuron) are candidates
 * for being linked to a file. File-neurons are the "hub" target — they already
 * provide the anchor.
 */
function buildSameFileEdges(notes: IndexedNote[], nodeIds: Set<string>): BrainEdge[] {
  const edges: BrainEdge[] = [];
  const seen = new Set<string>();

  // source value → note ids that carry it
  const sourceToNotes = new Map<string, string[]>();

  for (const note of notes) {
    if (!nodeIds.has(note.id)) continue;
    if (!note.source) continue;
    // Normalise: strip "code-scanner:" prefix if present
    const src = note.source
      .replace(/^code-scanner:/i, '')
      .toLowerCase()
      .trim();
    if (!src || src.length < 4) continue;
    const arr = sourceToNotes.get(src) ?? [];
    arr.push(note.id);
    sourceToNotes.set(src, arr);
  }

  for (const noteList of sourceToNotes.values()) {
    if (noteList.length < 2) continue;
    // Deterministic sort: id asc
    const sorted = [...noteList].sort();
    // Link each pair (capped: only K_ENTITY_PER_NOTE links per note)
    const countPerNote = new Map<string, number>();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if ((countPerNote.get(a) ?? 0) >= K_ENTITY_PER_NOTE) continue;
        if ((countPerNote.get(b) ?? 0) >= K_ENTITY_PER_NOTE) continue;
        const key = `${a}::${b}::same-file`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: a,
          target: b,
          type: 'same-file',
          strength: 0.7,
          confidence: 'inferred',
          confidenceScore: 0.7,
        });
        countPerNote.set(a, (countPerNote.get(a) ?? 0) + 1);
        countPerNote.set(b, (countPerNote.get(b) ?? 0) + 1);
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// 4. TEMPORAL/SESSION edges
// ---------------------------------------------------------------------------

/**
 * Extract the cwd group key from a note.
 * Uses the `source` attribute when it looks like a cwd path, else the topic.
 * Returns null for notes without useful cwd/topic context.
 */
function cwdGroupKey(note: IndexedNote): string | null {
  // source may be a cwd-style path like "/Users/david/Documents/cerveau/LazyBrain"
  if (note.source && !note.source.startsWith('code-scanner:') && note.source.length > 4) {
    return note.source.toLowerCase().trim();
  }
  // Fall back to top-level topic segment as a proxy for project
  if (note.topic) {
    return note.topic.split('/')[0].toLowerCase().trim();
  }
  return null;
}

function buildTemporalEdges(notes: IndexedNote[], nodeIds: Set<string>): BrainEdge[] {
  const edges: BrainEdge[] = [];

  // Group notes by cwd-key, then sort each group by created timestamp (asc)
  const groups = new Map<string, IndexedNote[]>();
  for (const note of notes) {
    if (!nodeIds.has(note.id)) continue;
    const key = cwdGroupKey(note);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(note);
    groups.set(key, arr);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Sort by created asc, then id asc as tiebreaker (deterministic)
    const sorted = [...group].sort((a, b) => {
      const ca = a.created ?? '';
      const cb = b.created ?? '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    let added = 0;
    for (let i = 0; i < sorted.length - 1 && added < TEMPORAL_CHAIN_CAP; i++) {
      const src = sorted[i].id;
      const tgt = sorted[i + 1].id;
      if (src === tgt) continue;
      edges.push({
        source: src,
        target: tgt,
        type: 'temporal',
        strength: 0.3,
        confidence: 'inferred',
        confidenceScore: 0.3,
      });
      added++;
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Degree cap enforcement
// ---------------------------------------------------------------------------

/**
 * Given a merged list of structural edges and the existing edge count per node,
 * enforce MAX_STRUCTURAL_DEGREE per node: keep the strongest edges first
 * (tiebreak: target id asc), drop the rest.
 *
 * Returns { kept, dropped }.
 */
function enforceDegreeCap(
  candidates: BrainEdge[],
  existingDegree: Map<string, number>,
): { kept: BrainEdge[]; dropped: number } {
  // Sort by strength desc, then canonical key asc (deterministic)
  const sorted = [...candidates].sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    const keyA = `${a.source}::${a.target}`;
    const keyB = `${b.source}::${b.target}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  // Track structural degree budget per node
  const structDegree = new Map<string, number>();
  const kept: BrainEdge[] = [];
  let dropped = 0;

  for (const edge of sorted) {
    const srcExisting = existingDegree.get(edge.source) ?? 0;
    const tgtExisting = existingDegree.get(edge.target) ?? 0;
    const srcStruct = structDegree.get(edge.source) ?? 0;
    const tgtStruct = structDegree.get(edge.target) ?? 0;

    const srcTotal = srcExisting + srcStruct;
    const tgtTotal = tgtExisting + tgtStruct;

    if (srcTotal >= MAX_STRUCTURAL_DEGREE || tgtTotal >= MAX_STRUCTURAL_DEGREE) {
      dropped++;
      continue;
    }

    kept.push(edge);
    structDegree.set(edge.source, srcStruct + 1);
    structDegree.set(edge.target, tgtStruct + 1);
  }

  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build all structural edges for the brain graph.
 *
 * Call after buildEdgesFromBacklinks() in buildKnowledgeGraph().
 * Returns new edges to merge; callers deduplicate by source+target+type.
 *
 * @param input - notes and nodes from the current graph build pass
 * @param existingEdges - backlink edges already added (for degree accounting)
 */
export function buildStructuralEdges(
  input: StructuralEdgesInput,
  existingEdges: BrainEdge[],
): StructuralEdgesResult {
  const { notes, nodes } = input;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Precompute existing degree per node
  const existingDegree = new Map<string, number>();
  for (const e of existingEdges) {
    existingDegree.set(e.source, (existingDegree.get(e.source) ?? 0) + 1);
    existingDegree.set(e.target, (existingDegree.get(e.target) ?? 0) + 1);
  }

  const hierarchyEdges = buildHierarchyEdges(notes, nodeMap);
  const sharedEntityEdges = buildSharedEntityEdges(notes, nodeIds);
  const sameFileEdges = buildSameFileEdges(notes, nodeIds);
  const temporalEdges = buildTemporalEdges(notes, nodeIds);

  const allCandidates = [
    ...hierarchyEdges,
    ...sharedEntityEdges,
    ...sameFileEdges,
    ...temporalEdges,
  ];

  // Deduplicate within structural edges (same key may arise from multiple families)
  const dedupSeen = new Set<string>();
  const deduped = allCandidates.filter((e) => {
    const key = `${e.source}::${e.target}::${e.type}`;
    if (dedupSeen.has(key)) return false;
    dedupSeen.add(key);
    return true;
  });

  // Filter: both endpoints must be in the graph
  const valid = deduped.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  const { kept, dropped } = enforceDegreeCap(valid, existingDegree);

  return {
    edges: kept,
    stats: {
      hierarchy: hierarchyEdges.length,
      sharedEntity: sharedEntityEdges.length,
      sameFile: sameFileEdges.length,
      temporal: temporalEdges.length,
      degreeCapDropped: dropped,
    },
  };
}
