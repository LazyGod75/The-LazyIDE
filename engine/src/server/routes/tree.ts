import type { IncomingMessage, ServerResponse } from 'node:http';
import { listAllReadonly } from '../../indexer/fts.js';
import { slug } from '../../store/paths.js';
import { getLogger } from '../../util/logger.js';
import { IndexVersionedCache, computeNotesFingerprint, sendJsonCached } from '../cache.js';
import { CSP_API, mapDbError, sendError, sendJson } from '../security.js';

// ---------------------------------------------------------------------------
// Shared path normaliser
// ---------------------------------------------------------------------------

function normPath(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^.*[/\\]brain[/\\]/, '');
}

// ---------------------------------------------------------------------------
// In-memory caches keyed by index fingerprint
// ---------------------------------------------------------------------------

const hierarchyCache = new IndexVersionedCache<unknown>();
const treeCache = new IndexVersionedCache<{ projects: TreeChild[] }>();

// ---------------------------------------------------------------------------
// GET /_api/hierarchy — nested topic/project tree
// ---------------------------------------------------------------------------

type TreeNode = { children: Record<string, TreeNode>; count: number; total?: number };

function addTotals(node: TreeNode): number {
  let total = node.count;
  for (const child of Object.values(node.children)) {
    total += addTotals(child);
  }
  node.total = total;
  return total;
}

function buildHierarchy(allNotes: ReturnType<typeof listAllReadonly>): unknown {
  const root: TreeNode = { children: {}, count: 0 };

  for (const note of allNotes) {
    const parts = (note.topic || '_uncategorized').split('/').filter(Boolean);
    let node = root;
    for (const part of parts) {
      if (!node.children[part]) {
        node.children[part] = { children: {}, count: 0 };
      }
      node = node.children[part]!;
    }
    node.count += 1;
  }

  addTotals(root);
  return root;
}

export function handleHierarchy(req: IncomingMessage, res: ServerResponse): void {
  const log = getLogger();
  try {
    const allNotes = listAllReadonly({ includeExpired: false });
    const fingerprint = computeNotesFingerprint(allNotes);
    let result = hierarchyCache.get(fingerprint);
    if (!result) {
      result = buildHierarchy(allNotes);
      hierarchyCache.set(fingerprint, result);
    }

    sendJsonCached(req, res, 200, result, { csp: CSP_API }).catch((err) => {
      log.error({ err }, 'Compression error in /_api/hierarchy');
    });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, 'API error in /_api/hierarchy');
    sendError(res, 500, 'Failed to build hierarchy');
  }
}

// ---------------------------------------------------------------------------
// GET /_api/topics/:path
// ---------------------------------------------------------------------------

export function handleTopics(_req: unknown, res: ServerResponse, topicPath: string): void {
  const log = getLogger();
  try {
    const allNotes = listAllReadonly({ includeExpired: false });
    const topicNotes = allNotes.filter((n) => (n.topic ?? '').startsWith(topicPath));
    const topicDecisions = topicNotes.filter((n) => n.type === 'decision');

    const tagCounts = new Map<string, number>();
    for (const n of topicNotes) {
      const tags = (n.tags ?? '').split(/\s+/).filter(Boolean);
      for (const tag of tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag]) => tag);

    const avgImportance =
      topicNotes.length > 0
        ? topicNotes.reduce((sum, n) => sum + (n.importance ?? 0), 0) / topicNotes.length
        : 0;

    sendJson(res, 200, {
      topic: topicPath,
      stats: {
        totalNotes: topicNotes.length,
        activeDecisions: topicDecisions.length,
        topTags,
        avgImportance: Math.round(avgImportance * 100) / 100,
      },
      notes: topicNotes.map((n) => ({
        id: n.id,
        path: normPath(n.path),
        title: n.title,
        type: n.type,
        importance: n.importance,
      })),
      decisions: topicDecisions.map((d) => ({
        id: d.id,
        title: d.title,
        created: d.created,
        importance: d.importance,
      })),
    });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, 'API error in /_api/topics/:path');
    sendError(res, 500, 'Failed to load topic');
  }
}

// ---------------------------------------------------------------------------
// GET /_api/tree — sidebar code-first hierarchy
// ---------------------------------------------------------------------------

type NoteEntry = ReturnType<typeof listAllReadonly>[0];

function normSeg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function normTopic(t: string): string {
  return t.split('/').map(normSeg).join('/');
}

function projectSlug(note: NoteEntry): string {
  const first = (note.topic || '').split('/')[0];
  return normSeg(first ?? '') || slug(note.id);
}

type ProjectEntry = {
  label: string;
  rootAgg: NoteEntry | null;
  subAggs: NoteEntry[];
  files: NoteEntry[];
};

function buildProjectMap(
  aggregates: NoteEntry[],
  fileNeurons: NoteEntry[],
): Map<string, ProjectEntry> {
  const projectMap = new Map<string, ProjectEntry>();

  function ensureProject(key: string, label: string): void {
    if (!projectMap.has(key)) {
      projectMap.set(key, { label, rootAgg: null, subAggs: [], files: [] });
    }
  }

  for (const agg of aggregates) {
    const key = projectSlug(agg);
    const label = (agg.topic || '').split('/')[0] || agg.id;
    ensureProject(key, label);
    const entry = projectMap.get(key)!;
    const topicDepth = (agg.topic || '').split('/').filter(Boolean).length;
    if (topicDepth <= 1 && !entry.rootAgg) {
      entry.rootAgg = agg;
    } else {
      entry.subAggs.push(agg);
    }
  }

  // Promote highest-importance sub-aggregate when no root aggregate exists
  for (const entry of projectMap.values()) {
    if (entry.rootAgg === null && entry.subAggs.length > 0) {
      const best = entry.subAggs.reduce<NoteEntry>(
        (prev, cur) => ((cur.importance ?? 0) > (prev.importance ?? 0) ? cur : prev),
        entry.subAggs[0]!,
      );
      entry.rootAgg = best;
      entry.subAggs = entry.subAggs.filter((a) => a.id !== best.id);
    }
  }

  for (const file of fileNeurons) {
    const key = projectSlug(file);
    const label = (file.topic || '').split('/')[0] || '_unknown';
    ensureProject(key, label);
    projectMap.get(key)!.files.push(file);
  }

  return projectMap;
}

type TreeChild = {
  id: string;
  label: string;
  // Widened to allow synthetic "topic" branch nodes (see nestKnowledgeNotes
  // below) that group notes by data-cerveau-topic but have no note of their
  // own — a real note-backed leaf (module/file/knowledge note) still always
  // sets a real string id here.
  noteId: string | null;
  type: string | null;
  children: TreeChild[];
};

function buildModuleChildren(subAggs: NoteEntry[], files: NoteEntry[]): TreeChild[] {
  return subAggs
    .sort((a, b) => (a.topic || '').localeCompare(b.topic || ''))
    .map((agg) => {
      const topicParts = (agg.topic || '').split('/').filter(Boolean);
      const moduleLabel = topicParts.slice(1).join('/') || agg.title || agg.id;
      const normAggTopic = normTopic(agg.topic || '');

      const moduleFiles: TreeChild[] = files
        .filter((f) => {
          const nft = normTopic(f.topic || '');
          return nft === normAggTopic || nft.startsWith(`${normAggTopic}/`);
        })
        .map((f) => ({
          id: f.id,
          label: f.title || f.id,
          noteId: f.id,
          type: f.type,
          children: [],
        }));

      return {
        id: agg.id,
        label: moduleLabel,
        noteId: agg.id,
        type: 'aggregate-neuron',
        children: moduleFiles,
      };
    });
}

// ---------------------------------------------------------------------------
// Knowledge (topic-based) projects — for notes that were never code-scanned.
//
// The code-first branch above only ever populates a project when a `graph
// --cwd` run created aggregate-neuron/file-neuron notes for it. A brain
// built purely from imported conversation history (no live repo scan) has
// none of those, so buildTree() used to return zero projects — the Wiki
// tree showed only the synthetic "Accueil du brain" row even on a brain
// with hundreds of neurons. Every note (whatever its type) already carries
// a data-cerveau-topic set at import/capture time, so we build a second,
// generic project→module→topic→note tree from that field and merge it
// (by project key) into the same `projects` array the code-first branch
// produces — a project scanned from real code AND full of imported
// knowledge notes ends up as one merged node, not two.
// ---------------------------------------------------------------------------

/** Generated/derived note types excluded from the knowledge tree: code-scan
 *  types get their own branch above, and synthesis pages are navigation
 *  *destinations* (see WikiTab.openTopic), not tree entries in their own
 *  right — listing them here too would create noisy self-referential rows. */
const KNOWLEDGE_EXCLUDED_TYPES = new Set([
  'aggregate-neuron',
  'file-neuron',
  'topic-overview',
  'brain-index',
  'hierarchy-node',
  'project-summary',
]);

function isKnowledgeNote(n: NoteEntry): boolean {
  return !KNOWLEDGE_EXCLUDED_TYPES.has(n.type ?? '') && (n.topic ?? '').trim() !== '';
}

function noteLeaf(note: NoteEntry): TreeChild {
  return {
    id: note.id,
    label: note.title || note.id,
    noteId: note.id,
    type: note.type,
    children: [],
  };
}

/**
 * Recursively nest knowledge notes under their topic-path segments beyond
 * `depth` (the project's own first segment is already consumed by the
 * caller). A note whose topic ends exactly at `depth` becomes a leaf row;
 * a note with a deeper topic groups into an intermediate "topic" branch
 * node whose `id` is the full dotted path (e.g. "cerveau/auth") so it
 * round-trips as a synthesisTopic() slug — see WikiTab.handleTreeSelect
 * and the exact-path match added to handleSynthesisTopic.
 */
function nestKnowledgeNotes(notes: NoteEntry[], depth: number): TreeChild[] {
  const direct: NoteEntry[] = [];
  const bySegment = new Map<string, NoteEntry[]>();

  for (const note of notes) {
    const segments = (note.topic ?? '').split('/').filter(Boolean);
    if (segments.length <= depth) {
      direct.push(note);
      continue;
    }
    const seg = segments[depth]!;
    const group = bySegment.get(seg) ?? [];
    group.push(note);
    bySegment.set(seg, group);
  }

  const branches: TreeChild[] = [...bySegment.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([seg, group]) => {
      const path = (group[0]?.topic ?? '')
        .split('/')
        .filter(Boolean)
        .slice(0, depth + 1)
        .join('/');
      return {
        id: path,
        label: seg,
        noteId: null,
        type: 'topic',
        children: nestKnowledgeNotes(group, depth + 1),
      };
    });

  const leaves = direct
    .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id))
    .map(noteLeaf);

  return [...branches, ...leaves];
}

type KnowledgeProject = { label: string; children: TreeChild[] };

/** Group knowledge notes by their first topic segment (project key); each
 *  becomes project-level content nested by remaining segments down to
 *  individual notes via nestKnowledgeNotes. */
function buildKnowledgeProjects(allNotes: NoteEntry[]): Map<string, KnowledgeProject> {
  const byProject = new Map<string, NoteEntry[]>();
  for (const note of allNotes) {
    if (!isKnowledgeNote(note)) continue;
    const first = (note.topic ?? '').split('/')[0] ?? '';
    const key = normSeg(first);
    if (!key) continue;
    const group = byProject.get(key) ?? [];
    group.push(note);
    byProject.set(key, group);
  }

  const result = new Map<string, KnowledgeProject>();
  for (const [key, notes] of byProject) {
    const label = (notes[0]?.topic ?? '').split('/')[0] || key;
    result.set(key, { label, children: nestKnowledgeNotes(notes, 1) });
  }
  return result;
}

/** Assemble the code-first children (modules + top-level files) for a
 *  project that has at least one aggregate/file-neuron entry — extracted
 *  from buildTree() verbatim so merging in knowledge children stays simple. */
function buildCodeChildren(entry: ProjectEntry, label: string): TreeChild[] {
  const normProjectTopic = normTopic((entry.rootAgg?.topic || label).split('/')[0] || label);
  const moduleChildren = buildModuleChildren(entry.subAggs, entry.files);
  const assignedFileIds = new Set(moduleChildren.flatMap((m) => m.children.map((f) => f.id)));
  const topFiles: TreeChild[] = entry.files
    .filter((f) => {
      if (assignedFileIds.has(f.id)) return false;
      return normTopic(f.topic || '').split('/')[0] === normProjectTopic;
    })
    .map((f) => ({ id: f.id, label: f.title || f.id, noteId: f.id, type: f.type, children: [] }));
  return [...moduleChildren, ...topFiles];
}

/** Merge one project key's code-scan entry and/or knowledge entry into a
 *  single tree node. Either side may be absent (a code-only project has no
 *  knowledge notes yet; a knowledge-only project was never code-scanned)
 *  but at least one is always present — callers only invoke this for keys
 *  drawn from the union of both maps. */
function buildProjectNode(
  codeEntry: ProjectEntry | undefined,
  knowledgeEntry: KnowledgeProject | undefined,
  fallbackKey: string,
): TreeChild {
  const label = codeEntry?.label ?? knowledgeEntry?.label ?? fallbackKey;
  const codeChildren = codeEntry ? buildCodeChildren(codeEntry, label) : [];
  const children = [...codeChildren, ...(knowledgeEntry?.children ?? [])].sort((a, b) =>
    a.label.localeCompare(b.label),
  );
  const rootAgg = codeEntry?.rootAgg ?? null;

  return {
    id: rootAgg?.id ?? label,
    label,
    noteId: rootAgg?.id ?? null,
    type: 'project',
    children,
  };
}

// ---------------------------------------------------------------------------
// Temporal validity — `valid_until` is a review WINDOW, not an "ever
// invalidated" flag
// ---------------------------------------------------------------------------
//
// Decision notes are stamped with `created + 90 days` as their
// data-cerveau-valid-until at write time (see annotator/blocks/composers) —
// the note stays fully active until that date arrives, it is not already
// stale the moment it is written. listAllReadonly({ includeExpired: false })
// filters at the SQL level with `WHERE (valid_until IS NULL OR valid_until =
// '')`, which drops ANY note carrying a valid_until at all, regardless of
// whether that date is in the future or the past. Proven on a disposable
// scratch brain: 4 of 20 real notes (all type=decision, all still inside
// their 90-day window) were silently missing from /_api/tree because of
// this — the topic-tree feature (buildKnowledgeProjects below) was never
// broken, its input was already short a slice of active notes before it
// ever saw them. handleTree fetches with includeExpired: true and applies
// the real "is this still active as of now" comparison itself instead.
function isActive(note: NoteEntry, nowIso: string): boolean {
  const until = note.valid_until;
  return !until || until.trim() === '' || until > nowIso;
}

function buildTree(
  allNotes: ReturnType<typeof listAllReadonly>,
  nowIso: string = new Date().toISOString(),
): { projects: TreeChild[] } {
  const activeNotes = allNotes.filter((n) => isActive(n, nowIso));
  const aggregates = activeNotes.filter((n) => n.type === 'aggregate-neuron');
  const fileNeurons = activeNotes.filter((n) => n.type === 'file-neuron');

  const projectMap = buildProjectMap(aggregates, fileNeurons);
  const knowledgeMap = buildKnowledgeProjects(activeNotes);
  const keys = new Set([...projectMap.keys(), ...knowledgeMap.keys()]);

  // Knowledge (topic-carrying) projects surface before pure code-scan
  // aggregates: a `graph --cwd` root note with no module/file children
  // (buildCodeChildren yields nothing) is noise next to an actual
  // navigable topic tree, so it sorts after any project with real content.
  const projects = [...keys]
    .filter((k) => k !== '' && k !== '_unknown')
    .sort((a, b) => {
      const aRank = knowledgeMap.has(a) ? 0 : 1;
      const bRank = knowledgeMap.has(b) ? 0 : 1;
      return aRank !== bRank ? aRank - bRank : a.localeCompare(b);
    })
    .map((key) => buildProjectNode(projectMap.get(key), knowledgeMap.get(key), key));

  return { projects };
}

export function handleTree(req: IncomingMessage, res: ServerResponse): void {
  const log = getLogger();
  try {
    // includeExpired: true — buildTree() now does its own time-aware
    // active-note filtering (see isActive above), so the truly-expired rows
    // it discards must still be fetched here for it to filter correctly.
    const allNotes = listAllReadonly({ includeExpired: true });
    const fingerprint = computeNotesFingerprint(allNotes);
    let result = treeCache.get(fingerprint);
    if (!result) {
      result = buildTree(allNotes);
      treeCache.set(fingerprint, result);
    }

    sendJsonCached(req, res, 200, result, { csp: CSP_API }).catch((err) => {
      log.error({ err }, 'Compression error in /_api/tree');
    });
  } catch (err) {
    if (mapDbError(res, err)) return;
    log.error({ err }, 'API error in /_api/tree');
    sendError(res, 500, 'Failed to build tree');
  }
}

// Export for tests
export { buildTree, isActive };
export type { NoteEntry, TreeChild };
