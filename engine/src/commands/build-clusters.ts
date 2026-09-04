/**
 * Generate per-cwd cluster atlases.
 *
 * Scans all notes, groups by data-cerveau-cwd (or source column),
 * and generates _cluster.html + _topology.json for each cwd with ≥3 notes.
 *
 * Output:
 *   <brain_path>/clusters/<slug>/_cluster.html
 *   <brain_path>/clusters/<slug>/_topology.json
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBacklinks } from '../graph/backlinks.js';
import { type IndexedNote, activeDecisions, listAll } from '../indexer/fts.js';
import { brainRoot } from '../store/paths.js';
import { slugifyCwd } from '../util/cwd-normalizer.js';
import { nowIso } from '../util/telemetry.js';

// Re-export so existing callers (inject-context, etc.) still work
export { slugifyCwd };

export interface BuildClustersOptions {
  pretty?: boolean;
}

export interface BuildClustersOutput {
  status: 'ok' | 'error';
  clusters: number;
  totalNotes: number;
  paths?: string[];
  error?: string;
}

interface ClusterTopology {
  cluster_id: string;
  cwd: string;
  note_ids: string[];
  entities: string[];
  hubs: Array<{ id: string; title: string; backlinks: number }>;
  edges_count: number;
  generated_at: string;
}

/**
 * Extract top entities by frequency.
 */
function extractTopEntities(notes: Array<{ entities: string | null }>, limit = 10): string[] {
  const entityCounts = new Map<string, number>();
  for (const note of notes) {
    if (!note.entities) continue;
    const ents = note.entities.split(/[,\s]+/).filter(Boolean);
    for (const e of ents) {
      entityCounts.set(e, (entityCounts.get(e) ?? 0) + 1);
    }
  }
  return [...entityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([e]) => e);
}

/**
 * Find hub notes by backlink count.
 */
interface HubNote {
  id: string;
  title: string;
  backlinks: number;
}

function extractHubs(
  notes: IndexedNote[],
  backlinks: Exclude<ReturnType<typeof loadBacklinks>, null>,
  limit = 3,
): HubNote[] {
  const hubMap = new Map<string, number>();
  for (const note of notes) {
    const inbound = backlinks.incoming?.[note.id] ?? [];
    hubMap.set(note.id, inbound.length);
  }
  return [...hubMap.entries()]
    .map(([id, count]) => {
      const note = notes.find((n) => n.id === id);
      return {
        id,
        title: note?.title ?? id,
        backlinks: count,
      };
    })
    .sort((a, b) => b.backlinks - a.backlinks)
    .slice(0, limit);
}

/**
 * Build HTML cluster atlas.
 */
function buildClusterHtml(
  slug: string,
  cwd: string,
  notes: IndexedNote[],
  hubs: HubNote[],
  entities: string[],
  activeDecCount: number,
): string {
  const notesHtml = notes
    .slice(0, 20)
    .map(
      (n) =>
        `<li><a href="../../notes/${n.path.split('/').slice(-2).join('/')}#${n.id}">#${n.id}</a> ${n.title}</li>`,
    )
    .join('\n');

  const hubsHtml = hubs
    .map(
      (h) =>
        `<li><a href="../../notes/.../${h.id}.html">#${h.id} ${h.title}</a> (${h.backlinks})</li>`,
    )
    .join('\n');

  const entitiesHtml = entities
    .map(
      (e) =>
        `<dt><dfn id="${e.replace(/[:/]/g, '-')}">${e}</dfn></dt><dd>Referenced in cluster</dd>`,
    )
    .join('\n');

  const tagsHtml = notes
    .filter((n) => n.tags)
    .flatMap((n) => n.tags?.split(/\s+/) ?? [])
    .filter(Boolean)
    .reduce((m, tag) => m.set(tag, (m.get(tag) ?? 0) + 1), new Map<string, number>());

  const tagsListHtml = Array.from(tagsHtml.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map((entry) => `<li><a href="#tag-${entry[0]}">${entry[0]}</a> (${entry[1]})</li>`)
    .join('\n');

  const edgesHint = Math.max(1, Math.floor(notes.length * 1.5));

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Cluster: ${slug}</title>
  <meta name="cluster-cwd" content="${cwd}">
  <meta name="cluster-note-count" content="${notes.length}">
  <meta name="cluster-entities" content="${entities.join(', ')}">
  <meta name="cluster-hubs" content="${hubs.map((h) => h.id).join(', ')}">
  <meta name="cluster-active-decisions" content="${activeDecCount}">
  <meta name="cluster-generated-at" content="${nowIso()}">
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #333; }
    h1 { font-size: 2rem; margin: 0; }
    .cluster-summary { color: #666; font-size: 0.95rem; margin: 0.5rem 0; }
    details { margin: 1.5rem 0; }
    summary { cursor: pointer; font-weight: 600; }
    ol, ul { margin: 0.5rem 0 0 1.5rem; }
    li { margin: 0.25rem 0; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .categories { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #ddd; font-size: 0.9rem; }
    footer { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #eee; color: #999; font-size: 0.85rem; }
  </style>
</head>
<body>
  <header>
    <hgroup>
      <h1>Cluster: ${slug}</h1>
      <p class="cluster-summary">${notes.length} neurons · ${entities.length} entities · ${activeDecCount} active decisions</p>
    </hgroup>
  </header>

  <nav class="cluster-atlas" aria-label="Neurons">
    <details open>
      <summary>Hubs (top backlinks, ${hubs.length})</summary>
      <ol>
${hubsHtml}
      </ol>
    </details>

    <details open>
      <summary>Active decisions (${activeDecCount})</summary>
      <ul>
        <li>Use 'lazybrain search "decision"' to find all active decisions</li>
      </ul>
    </details>

    <details open>
      <summary>Tags by frequency</summary>
      <ol>
${tagsListHtml}
      </ol>
    </details>

    <details>
      <summary>Entities (canonical refs, ${entities.length})</summary>
      <dl>
${entitiesHtml}
      </dl>
    </details>

    <details>
      <summary>Topology summary</summary>
      <p>This cluster has ${notes.length} nodes, ~${edgesHint} edges, avg connectivity ${(edgesHint / Math.max(1, notes.length)).toFixed(1)}. Top hub neurons share core concepts.</p>
    </details>

    <details>
      <summary>All neurons (${notes.length})</summary>
      <ol>
${notesHtml}
      </ol>
    </details>
  </nav>

  <footer>
    <nav class="categories">
      Categories: <a href="../../_index.html">brain global</a> · Generated ${nowIso()}
    </nav>
  </footer>
</body>
</html>`;
}

/**
 * Build JSON topology description.
 */
function buildTopologyJson(
  slug: string,
  cwd: string,
  notes: IndexedNote[],
  hubs: HubNote[],
  entities: string[],
  edgesCount: number,
): ClusterTopology {
  return {
    cluster_id: slug,
    cwd,
    note_ids: notes.map((n) => n.id),
    entities,
    hubs,
    edges_count: edgesCount,
    generated_at: nowIso(),
  };
}

/**
 * Main entry point: scan all notes, group by cwd, generate cluster files.
 */
export async function runBuildClusters(opts: BuildClustersOptions): Promise<BuildClustersOutput> {
  try {
    const allNotes = listAll({ includeExpired: false });
    if (allNotes.length === 0) {
      return { status: 'ok', clusters: 0, totalNotes: 0, paths: [] };
    }

    // Group notes by source (cwd)
    const cwdGroups = new Map<string, IndexedNote[]>();
    for (const note of allNotes) {
      const source = note.source || 'unknown';
      if (!cwdGroups.has(source)) {
        cwdGroups.set(source, []);
      }
      cwdGroups.get(source)!.push(note);
    }

    // Load backlinks for hub detection
    const backlinks = loadBacklinks();

    // Load active decisions for each cwd
    const activeDecs = activeDecisions(30, 1000);
    const activeDecsBySource = new Map<string, number>();
    for (const dec of activeDecs) {
      const source = dec.source || 'unknown';
      activeDecsBySource.set(source, (activeDecsBySource.get(source) ?? 0) + 1);
    }

    const clustersDir = join(brainRoot(), 'clusters');
    if (!existsSync(clustersDir)) {
      mkdirSync(clustersDir, { recursive: true });
    }

    const paths: string[] = [];
    let clusterCount = 0;

    // Generate cluster files for each cwd with ≥3 notes
    for (const [cwd, notes] of cwdGroups) {
      if (notes.length < 3) continue;

      const slug = slugifyCwd(cwd);
      const clusterDir = join(clustersDir, slug);
      if (!existsSync(clusterDir)) {
        mkdirSync(clusterDir, { recursive: true });
      }

      // Extract metadata
      const entities = extractTopEntities(notes, 10);
      const hubs = backlinks ? extractHubs(notes, backlinks, 3) : [];
      const activeDecCount = activeDecsBySource.get(cwd) ?? 0;
      const edgesCount = Math.max(1, Math.floor(notes.length * 1.5));

      // Build and write HTML
      const htmlContent = buildClusterHtml(slug, cwd, notes, hubs, entities, activeDecCount);
      const htmlPath = join(clusterDir, '_cluster.html');
      writeFileSync(htmlPath, htmlContent, 'utf-8');
      paths.push(htmlPath);

      // Build and write JSON topology
      const topology = buildTopologyJson(slug, cwd, notes, hubs, entities, edgesCount);
      const jsonPath = join(clusterDir, '_topology.json');
      writeFileSync(jsonPath, JSON.stringify(topology, null, opts.pretty ? 2 : 0), 'utf-8');
      paths.push(jsonPath);

      clusterCount++;
    }

    return {
      status: 'ok',
      clusters: clusterCount,
      totalNotes: allNotes.length,
      paths,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      clusters: 0,
      totalNotes: 0,
      error: message,
    };
  }
}
