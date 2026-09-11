/**
 * Regression tests for loadKnowledgeGraph()'s in-process cache.
 *
 * Same design and same rationale as backlinks-cache.test.ts (which this
 * mirrors): brain-graph.json is a multi-MB file on a real brain, and
 * loadKnowledgeGraph() is called on every /_api/graph.json and
 * /_api/graph-layout.json request plus synthesize/inject-context paths.
 * Before the cache each call paid readFileSync + JSON.parse on the whole
 * file with nothing on disk having changed.
 *
 * This test proves:
 *   1. Repeated calls with nothing on disk changed reuse the SAME parsed
 *      object (no re-parse) — the direct evidence the cache is working.
 *   2. A rewrite through saveKnowledgeGraph() (same process) is picked up.
 *   3. A rewrite by a SEPARATE process (simulated: raw writeFileSync
 *      bypassing saveKnowledgeGraph()) is also picked up — the cache is
 *      gated on file (mtime, size), not just this module's own write path.
 *   4. A malformed file is reported as null and does not poison the cache.
 *   5. The cache is scoped per cachePath (switching brains never serves a
 *      stale entry from a previous brain).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';
import {
  type BrainKnowledgeGraph,
  loadKnowledgeGraph,
  resetKnowledgeGraphCacheForTests,
  saveKnowledgeGraph,
} from '../knowledge-graph.js';

let tmpDir: string;
let cachePath: string;

function makeGraph(nodeCount: number): BrainKnowledgeGraph {
  const nodes: BrainKnowledgeGraph['nodes'] = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `note-${i}`,
      title: `Note ${i}`,
      type: 'note',
      topic: 'project-a',
      topicPath: 'project-a',
      tags: [],
      importance: 0.5,
      tldr: `Summary of note ${i} with some padding to bulk up the payload`,
      pagerank: 0.1,
      cluster: 'cluster-a',
    });
  }
  return {
    version: '1.0.0',
    generated: new Date().toISOString(),
    stats: {
      nodes: nodeCount,
      edges: 0,
      clusters: 1,
      hubs: 0,
      avgImportance: 0.5,
      topTypes: {},
      topTopics: {},
    },
    nodes,
    edges: [],
    clusters: [],
    hubs: [],
    layers: [],
    tour: [],
    topicTree: [],
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-graph-cache-test-'));
  cachePath = join(tmpDir, 'cache');
  mkdirSync(cachePath, { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, 'brain');
  mkdirSync(process.env.LAZYBRAIN_BRAIN_PATH, { recursive: true });
  process.env.LAZYBRAIN_CACHE_PATH = cachePath;
  resetConfigForTests();
  resetKnowledgeGraphCacheForTests();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
  resetKnowledgeGraphCacheForTests();
});

describe('loadKnowledgeGraph() in-process cache', () => {
  it('returns null (not a throw) when no brain-graph.json exists yet', () => {
    expect(loadKnowledgeGraph()).toBeNull();
  });

  it('repeated calls with no write in between reuse the same parsed object', () => {
    saveKnowledgeGraph(makeGraph(50));

    const first = loadKnowledgeGraph();
    const second = loadKnowledgeGraph();
    const third = loadKnowledgeGraph();

    expect(first).not.toBeNull();
    // Identity equality — if a re-parse happened, JSON.parse would produce a
    // brand-new object even with identical content.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('a rewrite through saveKnowledgeGraph() is picked up with the new content', () => {
    saveKnowledgeGraph(makeGraph(10));
    const before = loadKnowledgeGraph();
    expect(before?.nodes.length).toBe(10);

    saveKnowledgeGraph(makeGraph(20));
    const after = loadKnowledgeGraph();

    expect(after).not.toBe(before);
    expect(after?.nodes.length).toBe(20);
  });

  it('a rewrite by a SEPARATE process (raw writeFileSync) is still detected', () => {
    saveKnowledgeGraph(makeGraph(5));
    const before = loadKnowledgeGraph();
    expect(before?.nodes.length).toBe(5);

    // Simulate an external `lazybrain graph` rebuild writing the same path
    // without going through this module's saveKnowledgeGraph().
    const externalGraph = makeGraph(7);
    const path = join(cachePath, 'brain-graph.json');
    writeFileSync(path, JSON.stringify(externalGraph), 'utf8');

    const after = loadKnowledgeGraph();
    expect(after).not.toBe(before);
    expect(after?.nodes.length).toBe(7);
  });

  it('a malformed brain-graph.json returns null and stays uncached', () => {
    const path = join(cachePath, 'brain-graph.json');
    writeFileSync(path, '{not valid json', 'utf8');
    expect(loadKnowledgeGraph()).toBeNull();

    // Valid JSON but missing required fields — also null, still uncached.
    writeFileSync(path, '{"version":"1.0.0"}', 'utf8');
    expect(loadKnowledgeGraph()).toBeNull();

    // A valid rewrite afterwards is picked up normally.
    saveKnowledgeGraph(makeGraph(3));
    expect(loadKnowledgeGraph()?.nodes.length).toBe(3);
  });

  it('the cache is scoped per cachePath (switching brains never serves a stale entry)', () => {
    saveKnowledgeGraph(makeGraph(1));
    expect(loadKnowledgeGraph()?.nodes.length).toBe(1);

    // Point at a different brain's cache dir.
    const otherCachePath = join(tmpDir, 'cache-other');
    mkdirSync(otherCachePath, { recursive: true });
    process.env.LAZYBRAIN_CACHE_PATH = otherCachePath;
    resetConfigForTests();

    // No brain-graph.json in the new location yet.
    expect(loadKnowledgeGraph()).toBeNull();

    saveKnowledgeGraph(makeGraph(2));
    expect(loadKnowledgeGraph()?.nodes.length).toBe(2);
  });
});
