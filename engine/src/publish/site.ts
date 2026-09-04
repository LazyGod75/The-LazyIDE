/**
 * Static site generator for `lazybrain publish --site`.
 *
 * Turns a brain into a self-contained GitHub Pages-deployable SPA.
 * Copies the brain-ui assets, injects the static-mode meta tag, and
 * pre-computes all data/ files required by the CONTRACT.
 *
 * Static-mode detection: the generated index.html contains
 *   <meta name="lazybrain-static" content="true">
 * which is absent in the live server-served index.html. The SPA checks
 * for this tag at boot time to switch from live-API mode to static mode.
 *
 * Dry-run (default) → reports what WOULD be generated.
 * --confirm         → actually writes files.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBacklinks } from '../graph/backlinks.js';
import { loadKnowledgeGraph } from '../graph/knowledge-graph.js';
import { listAll } from '../indexer/fts.js';
import type { IndexedNote } from '../indexer/fts.js';
import type { PublishProfile } from '../schema/scrubber.js';
import { scrubForPublic } from '../schema/scrubber.js';
import { buildSlimLayout } from '../server/routes/graph.js';
import { brainRoot } from '../store/paths.js';
import { readAllNotes } from '../store/reader.js';
import { getLogger } from '../util/logger.js';
import {
  type AcceptedNote,
  buildBacklinksJson,
  buildManifest,
  buildMetaJson,
  buildNeighborsJson,
  noteResourcePaths,
} from './manifest.js';
import { buildSearchIndex } from './search-index.js';
import { buildRobotsTxt, buildSitemap } from './sitemap.js';
import { isEmptyAggregate, matchesTopic } from './topic-filter.js';
import type { GraphEdge, GraphNode, GraphPayload, SiteGenerationResult } from './types.js';

// ---------------------------------------------------------------------------
// The static-mode meta tag (CONTRACT)
// ---------------------------------------------------------------------------

export const STATIC_META_TAG = '<meta name="lazybrain-static" content="true">';

/**
 * CSP meta tag for the published static SPA.
 * GitHub Pages cannot set HTTP headers, so we use the meta http-equiv form.
 * vis-network is vendored locally, so no CDN allowlist is needed.
 * style-src retains 'unsafe-inline' because the SPA generates dynamic inline
 * styles (cluster palette colors) that cannot be moved to stylesheets without
 * a significant refactor.
 */
export const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'self'">`;

// ---------------------------------------------------------------------------
// brain-ui assets root discovery
// ---------------------------------------------------------------------------

/**
 * Locate the examples/brain-ui directory relative to this source file.
 * Works in both tsx dev mode (src/publish/) and compiled dist/ layout.
 */
export function brainUiRoot(): string {
  const base = dirname(fileURLToPath(import.meta.url));
  // src/publish/ → ../../examples/brain-ui
  // dist/src/publish/ → ../../../examples/brain-ui
  const candidates = [
    join(base, '..', '..', 'examples', 'brain-ui'),
    join(base, '..', '..', '..', 'examples', 'brain-ui'),
    join(base, '..', '..', '..', '..', 'examples', 'brain-ui'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`brain-ui directory not found. Looked in:\n${candidates.join('\n')}`);
}

// ---------------------------------------------------------------------------
// Recursive directory copy
// ---------------------------------------------------------------------------

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// index.html injection
// ---------------------------------------------------------------------------

/**
 * Inject the static-mode meta tag and OpenGraph meta tags into the copied
 * index.html. The meta tag goes right after the opening <head> tag.
 */
export function injectStaticMeta(
  html: string,
  opts: { siteTitle: string; siteDescription: string; baseUrl: string },
): string {
  const ogBlock = [
    CSP_META_TAG,
    STATIC_META_TAG,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeAttr(opts.siteTitle)}">`,
    `<meta property="og:description" content="${escapeAttr(opts.siteDescription)}">`,
    `<meta property="og:url" content="${escapeAttr(opts.baseUrl)}">`,
    `<meta name="generator" content="LazyBrain">`,
  ].join('\n  ');

  return html.replace(/(<head[^>]*>)/, `$1\n  ${ogBlock}`);
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Graph payload builder (mirrors server routes/graph.ts)
// ---------------------------------------------------------------------------

function buildGraphPayload(
  allNotes: ReadonlyArray<IndexedNote>,
  inScopeIds: ReadonlySet<string>,
): GraphPayload {
  const backlinksIdx = loadBacklinks();

  // Load precomputed positions from knowledge graph cache (if available)
  const knowledgeGraph = loadKnowledgeGraph();
  const posMap = new Map<string, { x: number; y: number; degree: number; cluster: string }>();
  if (knowledgeGraph) {
    for (const n of knowledgeGraph.nodes) {
      if (n.x !== undefined && n.y !== undefined) {
        posMap.set(n.id, {
          x: n.x,
          y: n.y,
          degree: n.degree ?? 0,
          cluster: n.cluster,
        });
      }
    }
  }

  const nodes: GraphNode[] = allNotes
    .filter((n) => inScopeIds.has(n.id))
    .map((n) => {
      const pos = posMap.get(n.id);
      return {
        id: n.id,
        title: n.title,
        type: n.type,
        topic: n.topic ?? null,
        importance: n.importance ?? 0.5,
        ...(pos ? { x: pos.x, y: pos.y, degree: pos.degree, cluster: pos.cluster } : {}),
      };
    });

  // Prefer edges from brain-graph.json (includes structural edges) when available.
  // Fall back to raw backlinks for backward compatibility.
  const edges: GraphEdge[] = [];
  if (knowledgeGraph && knowledgeGraph.edges.length > 0) {
    for (const edge of knowledgeGraph.edges) {
      if (inScopeIds.has(edge.source) && inScopeIds.has(edge.target)) {
        edges.push({
          from: edge.source,
          to: edge.target,
          type: edge.type,
          auto: edge.confidence !== 'extracted',
        });
      }
    }
  } else if (backlinksIdx) {
    for (const outgoingEdges of Object.values(backlinksIdx.outgoing)) {
      for (const edge of outgoingEdges) {
        // Only include edges where BOTH endpoints are in scope
        if (inScopeIds.has(edge.from) && inScopeIds.has(edge.to)) {
          edges.push({
            from: edge.from,
            to: edge.to,
            type: edge.type,
            auto: edge.auto,
          });
        }
      }
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Tree builder (mirrors server routes/tree.ts — simplified project view)
// ---------------------------------------------------------------------------

function normSeg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

interface TreeChild {
  id: string;
  label: string;
  noteId: string | null;
  type: string | null;
  children: TreeChild[];
}

interface TreePayload {
  projects: TreeChild[];
}

function buildTreePayload(
  allNotes: ReadonlyArray<IndexedNote>,
  inScopeIds: ReadonlySet<string>,
): TreePayload {
  const scopedNotes = allNotes.filter((n) => inScopeIds.has(n.id));
  const aggregates = scopedNotes.filter((n) => n.type === 'aggregate-neuron');
  const fileNeurons = scopedNotes.filter((n) => n.type === 'file-neuron');

  const projectSlug = (note: IndexedNote): string =>
    normSeg((note.topic ?? '').split('/')[0] ?? '') || note.id;

  type ProjectBucket = {
    label: string;
    rootAgg: IndexedNote | null;
    subAggs: IndexedNote[];
    files: IndexedNote[];
  };

  const byProject = new Map<string, ProjectBucket>();

  const ensureBucket = (key: string, label: string): ProjectBucket => {
    if (!byProject.has(key)) {
      byProject.set(key, { label, rootAgg: null, subAggs: [], files: [] });
    }
    return byProject.get(key)!;
  };

  for (const agg of aggregates) {
    const key = projectSlug(agg);
    const label = (agg.topic ?? '').split('/')[0] ?? agg.id;
    const bucket = ensureBucket(key, label);
    const depth = (agg.topic ?? '').split('/').filter(Boolean).length;
    if (depth <= 1 && !bucket.rootAgg) {
      bucket.rootAgg = agg;
    } else {
      bucket.subAggs.push(agg);
    }
  }

  for (const file of fileNeurons) {
    const key = projectSlug(file);
    const label = (file.topic ?? '').split('/')[0] ?? '_unknown';
    ensureBucket(key, label).files.push(file);
  }

  const projects: TreeChild[] = [...byProject.entries()]
    .filter(([k]) => k !== '' && k !== '_unknown')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, { label, rootAgg, subAggs, files }]) => {
      const children: TreeChild[] = [
        ...subAggs.map<TreeChild>((a) => ({
          id: a.id,
          label: a.title || a.id,
          noteId: a.id,
          type: 'aggregate-neuron',
          children: [],
        })),
        ...files.map<TreeChild>((f) => ({
          id: f.id,
          label: f.title || f.id,
          noteId: f.id,
          type: f.type,
          children: [],
        })),
      ].sort((a, b) => a.label.localeCompare(b.label));

      return {
        id: rootAgg?.id ?? label,
        label,
        noteId: rootAgg?.id ?? null,
        type: 'project',
        children,
      };
    });

  return { projects };
}

// ---------------------------------------------------------------------------
// Write helper (creates parent dirs automatically)
// ---------------------------------------------------------------------------

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

// ---------------------------------------------------------------------------
// Scrub + collect accepted notes
// ---------------------------------------------------------------------------

interface ScrubStats {
  failures: Array<{ id: string; reason: string }>;
  accepted: AcceptedNote[];
  totalProvenanceStripped: number;
  totalPathsScrubbed: number;
  allDetectedPatterns: Set<string>;
}

function scrubNotes(
  profile: PublishProfile,
  excludeTier?: 'archival' | 'working',
  topicPrefix?: string,
): ScrubStats {
  const notes = readAllNotes();
  const allIndex = listAll({ includeExpired: false });

  const failures: Array<{ id: string; reason: string }> = [];
  const accepted: AcceptedNote[] = [];
  let totalProvenanceStripped = 0;
  let totalPathsScrubbed = 0;
  const allDetectedPatterns = new Set<string>();

  for (const note of notes) {
    if (!note.id) continue;

    // Tier exclusion
    if (excludeTier) {
      const indexEntry = allIndex.find((n) => n.id === note.id);
      if (indexEntry) {
        const isArchival = indexEntry.path.includes('batches');
        const shouldExclude =
          (excludeTier === 'archival' && isArchival) || (excludeTier === 'working' && !isArchival);
        if (shouldExclude) continue;
      }
    }

    // Topic prefix filter
    if (topicPrefix) {
      const indexEntry = allIndex.find((n) => n.id === note.id);
      const noteTopic = indexEntry?.topic ?? null;
      if (!noteTopic) continue; // no topic → exclude when filter is active
      if (!noteTopic.toLowerCase().startsWith(topicPrefix.toLowerCase())) continue;
    }

    // Find indexed metadata for this note
    const indexed = allIndex.find((n) => n.id === note.id);
    if (!indexed) continue; // not in the index, skip

    const result = scrubForPublic(note.html, { profile });

    for (const p of result.detectedPatterns) {
      allDetectedPatterns.add(p);
    }

    if (result.blockedReason) {
      failures.push({ id: note.id, reason: result.blockedReason });
      continue;
    }

    // Skip empty aggregate-neurons (e.g. __tests__ dirs with no real children)
    if (isEmptyAggregate({ type: indexed.type, cleaned: result.cleaned })) continue;

    totalProvenanceStripped += result.strippedProvenanceAttrs.length;
    totalPathsScrubbed += result.pathsScrubbed;

    accepted.push({
      indexed,
      cleaned: result.cleaned,
      paths: noteResourcePaths(note.id),
    });
  }

  return {
    failures,
    accepted,
    totalProvenanceStripped,
    totalPathsScrubbed,
    allDetectedPatterns,
  };
}

// ---------------------------------------------------------------------------
// Synthesis data collector
// ---------------------------------------------------------------------------

interface SynthesisData {
  index: string | null;
  topics: Array<{ topic: string; html: string }>;
}

function collectSynthesisData(
  profile: PublishProfile,
  topicPrefix: string | null | undefined,
): SynthesisData {
  const allNotes = readAllNotes();
  let index: string | null = null;
  const topics: Array<{ topic: string; html: string }> = [];

  for (const note of allNotes) {
    if (/data-cerveau-type="brain-index"/.test(note.html)) {
      // Only emit brain-index when no topic filter is active, to avoid
      // a synthesis-index that aggregates out-of-scope projects.
      if (!topicPrefix) {
        const r = scrubForPublic(note.html, { profile });
        if (!r.blockedReason) index = r.cleaned;
      }
      continue;
    }
    if (/data-cerveau-type="topic-overview"/.test(note.html)) {
      const topicMatch = note.html.match(/data-cerveau-topic="([^"]*)"/);
      if (!topicMatch) continue;
      const noteTopic = topicMatch[1];
      // When a prefix is active, only include overviews whose topic is in scope
      if (!matchesTopic(noteTopic, topicPrefix)) continue;
      const topic = noteTopic.split('/')[0]?.trim() ?? '';
      if (!topic) continue;
      const r = scrubForPublic(note.html, { profile });
      if (!r.blockedReason) topics.push({ topic, html: r.cleaned });
    }
  }

  return { index, topics };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface SiteOptions {
  outDir?: string;
  profile?: PublishProfile;
  excludeTier?: 'archival' | 'working';
  baseUrl?: string;
  siteTitle?: string;
  siteDescription?: string;
  /** If true (default when --confirm absent), only validate and report. */
  dryRun?: boolean;
  /**
   * When set, include ONLY notes whose data-cerveau-topic starts with this
   * prefix (case-insensitive). Notes without a topic are excluded when set.
   */
  topic?: string;
}

export interface SiteRunResult {
  dryRun: boolean;
  result: SiteGenerationResult | null;
  /** Only set when dryRun=true */
  wouldPublish?: number;
  /** Only set when dryRun=true */
  blockedCount?: number;
}

export function generateSite(opts: SiteOptions = {}): SiteRunResult {
  const root = brainRoot();
  const target = opts.outDir ?? join(root, '..', 'public-site');
  const profile: PublishProfile = opts.profile ?? 'public-strict';
  const baseUrl = opts.baseUrl ?? 'https://example.github.io/brain';
  const siteTitle = opts.siteTitle ?? 'LazyBrain Wiki';
  const siteDescription = opts.siteDescription ?? 'Exported knowledge base';
  const isDryRun = opts.dryRun ?? true;

  // Always scrub — even in dry-run (validates secrets)
  const { failures, accepted, totalProvenanceStripped, totalPathsScrubbed, allDetectedPatterns } =
    scrubNotes(profile, opts.excludeTier, opts.topic);

  if (isDryRun) {
    return {
      dryRun: true,
      result: null,
      wouldPublish: accepted.length,
      blockedCount: failures.length,
    };
  }

  // Blocked notes abort the publish
  if (failures.length > 0) {
    return {
      dryRun: false,
      result: {
        outputDir: target,
        notesPublished: 0,
        notesBlocked: failures.length,
        blockedReasons: failures,
        provenanceAttrsStripped: totalProvenanceStripped,
        pathsScrubbed: totalPathsScrubbed,
        sensitivePatternsDetected: [...allDetectedPatterns],
      },
    };
  }

  // --- Build all data in memory ---
  const backlinksIndex = loadBacklinks();
  const allIndexed = listAll({ includeExpired: false });

  // Build the definitive in-scope ID set from accepted notes (already filtered
  // by topic + tier + scrub). This is the single source of truth for all
  // subsequent outputs — graph, tree, synthesis, backlinks, neighbors all use it.
  const inScopeIds = new Set<string>(accepted.map((a) => a.indexed.id));

  const manifest = buildManifest(accepted, root);
  const searchIndex = buildSearchIndex(accepted);
  const graph = buildGraphPayload(allIndexed, inScopeIds);
  const tree = buildTreePayload(allIndexed, inScopeIds);
  const sitemap = buildSitemap(baseUrl, manifest);
  const robots = buildRobotsTxt(baseUrl);
  const synthesis = collectSynthesisData(profile, opts.topic);

  const uiRoot = brainUiRoot();
  const originalIndex = readFileSync(join(uiRoot, 'index.html'), 'utf8');
  const patchedIndex = injectStaticMeta(originalIndex, { siteTitle, siteDescription, baseUrl });

  const scrubReport = {
    notesPublished: accepted.length,
    notesBlocked: failures.length,
    blockedReasons: failures,
    provenanceAttrsStripped: totalProvenanceStripped,
    pathsScrubbed: totalPathsScrubbed,
    sensitivePatternsDetected: [...allDetectedPatterns],
  };

  // --- Write to disk ---
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  // 1. Copy brain-ui assets (skip index.html; we write the patched version)
  const uiEntries = readdirSync(uiRoot, { withFileTypes: true });
  for (const entry of uiEntries) {
    if (entry.name === 'index.html') continue;
    const srcPath = join(uiRoot, entry.name);
    const destPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }

  // 2. Patched index.html
  writeFileSync(join(target, 'index.html'), patchedIndex, 'utf8');

  // 3. data/ directory
  const dataDir = join(target, 'data');

  writeJson(join(dataDir, 'notes.json'), manifest);
  writeJson(join(dataDir, 'graph.json'), graph);
  writeJson(join(dataDir, 'graph-layout.json'), buildSlimLayout(graph));
  writeJson(join(dataDir, 'tree.json'), tree);
  writeJson(join(dataDir, 'search-index.json'), searchIndex);

  // Per-note resources
  for (const { indexed, cleaned, paths } of accepted) {
    const htmlPath = join(dataDir, paths.html);
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, cleaned, 'utf8');

    writeJson(
      join(dataDir, paths.backlinks),
      buildBacklinksJson(indexed.id, backlinksIndex, inScopeIds),
    );
    writeJson(
      join(dataDir, paths.neighbors),
      buildNeighborsJson(indexed.id, backlinksIndex, inScopeIds),
    );
    writeJson(join(dataDir, paths.meta), buildMetaJson(indexed, root));
  }

  // Synthesis (topic overviews + brain-index)
  if (synthesis.index !== null) {
    writeFileSync(join(dataDir, 'synthesis-index.html'), synthesis.index, 'utf8');
  }
  for (const { topic, html } of synthesis.topics) {
    const safeTopicName = topic.replace(/[^a-z0-9_-]/gi, '-').slice(0, 60);
    writeFileSync(join(dataDir, `synthesis-${safeTopicName}.html`), html, 'utf8');
  }

  // Root-level metadata files
  writeFileSync(join(target, 'sitemap.xml'), sitemap, 'utf8');
  writeFileSync(join(target, 'robots.txt'), robots, 'utf8');

  // scrub-report.json is written OUTSIDE the published tree (sibling to outDir)
  // so it is never served to visitors on GitHub Pages.
  const scrubReportPath = `${target}.scrub-report.json`;
  writeJson(scrubReportPath, scrubReport);
  getLogger().info(`scrub report written to: ${scrubReportPath}`);

  return {
    dryRun: false,
    result: {
      outputDir: target,
      notesPublished: accepted.length,
      notesBlocked: failures.length,
      blockedReasons: failures,
      provenanceAttrsStripped: totalProvenanceStripped,
      pathsScrubbed: totalPathsScrubbed,
      sensitivePatternsDetected: [...allDetectedPatterns],
    },
  };
}
