/**
 * Regression tests for loadBacklinks()'s in-process cache.
 *
 * Context: on a realistic 5488-note brain, backlinks.json is ~44 MB.
 * loadBacklinks() used to call readFileSync + JSON.parse on EVERY call —
 * measured ~300-590ms per call — and is invoked from router.ts's
 * hydrateHits() on every route(..., hydrateNote: true) request (i.e. nearly
 * every assistant turn) plus pagerank.ts's computePageRank() on every
 * PageRank cache miss. This test proves:
 *   1. Repeated calls with nothing on disk changed reuse the SAME parsed
 *      object (no re-parse) — the direct evidence the cache is working.
 *   2. A rewrite through saveBacklinks() (same process) is picked up.
 *   3. A rewrite by a SEPARATE process (simulated: raw writeFileSync
 *      bypassing saveBacklinks()) is also picked up — the cache is gated on
 *      file (mtime, size), not just this module's own write path.
 *   4. On a large payload, the warm path is dramatically faster than the
 *      cold (first) call.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../../util/config.js';
import {
  type BacklinksIndex,
  loadBacklinks,
  resetBacklinksCacheForTests,
  saveBacklinks,
} from '../backlinks.js';

let tmpDir: string;
let cachePath: string;

function makeIndex(totalEdges: number): BacklinksIndex {
  const outgoing: BacklinksIndex['outgoing'] = {};
  const incoming: BacklinksIndex['incoming'] = {};
  for (let i = 0; i < totalEdges; i++) {
    const from = `note-${i}`;
    const to = `note-${(i + 1) % totalEdges}`;
    const entry = {
      from,
      to,
      type: 'mentions',
      auto: true,
      confidence: 'inferred' as const,
      confidenceScore: 0.5,
      surface: `link text number ${i} with some padding to bulk up the payload`,
    };
    (outgoing[from] ??= []).push(entry);
    (incoming[to] ??= []).push(entry);
  }
  return { outgoing, incoming, generated: new Date().toISOString(), total_edges: totalEdges };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lb-backlinks-cache-test-'));
  cachePath = join(tmpDir, 'cache');
  mkdirSync(cachePath, { recursive: true });
  process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, 'brain');
  mkdirSync(process.env.LAZYBRAIN_BRAIN_PATH, { recursive: true });
  process.env.LAZYBRAIN_CACHE_PATH = cachePath;
  resetConfigForTests();
  resetBacklinksCacheForTests();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LAZYBRAIN_BRAIN_PATH;
  delete process.env.LAZYBRAIN_CACHE_PATH;
  resetConfigForTests();
  resetBacklinksCacheForTests();
});

describe('loadBacklinks() in-process cache', () => {
  it('returns null (not a throw) when no backlinks.json exists yet', () => {
    expect(loadBacklinks()).toBeNull();
  });

  it('repeated calls with no write in between reuse the same parsed object', () => {
    saveBacklinks(makeIndex(50));

    const first = loadBacklinks();
    const second = loadBacklinks();
    const third = loadBacklinks();

    expect(first).not.toBeNull();
    // Identity equality — if a re-parse happened, JSON.parse would produce a
    // brand-new object even with identical content.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('a rewrite through saveBacklinks() invalidates the cache with the new content', () => {
    saveBacklinks(makeIndex(10));
    const before = loadBacklinks();
    expect(before?.total_edges).toBe(10);

    saveBacklinks(makeIndex(20));
    const after = loadBacklinks();

    expect(after).not.toBe(before);
    expect(after?.total_edges).toBe(20);
  });

  it('a rewrite by a SEPARATE process (raw writeFileSync) is still detected', () => {
    saveBacklinks(makeIndex(5));
    const before = loadBacklinks();
    expect(before?.total_edges).toBe(5);

    // Simulate an external `lazybrain graph` rebuild process writing the same
    // path without going through this module's saveBacklinks().
    const externalIndex = makeIndex(7);
    const path = join(cachePath, 'backlinks.json');
    writeFileSync(path, JSON.stringify(externalIndex), 'utf8');

    const after = loadBacklinks();
    expect(after).not.toBe(before);
    expect(after?.total_edges).toBe(7);
  });

  it('the cache is scoped per cachePath (switching brains never serves a stale entry)', () => {
    saveBacklinks(makeIndex(1));
    const firstBrainResult = loadBacklinks();
    expect(firstBrainResult?.total_edges).toBe(1);

    // Point at a different brain's cache dir.
    const otherCachePath = join(tmpDir, 'cache-other');
    mkdirSync(otherCachePath, { recursive: true });
    process.env.LAZYBRAIN_CACHE_PATH = otherCachePath;
    resetConfigForTests();

    // No backlinks.json in the new location yet.
    expect(loadBacklinks()).toBeNull();

    saveBacklinks(makeIndex(2));
    expect(loadBacklinks()?.total_edges).toBe(2);
  });

  it('warm cache is dramatically faster than the cold (first) parse on a large payload', () => {
    // Large enough that JSON.parse cost is measurable but the test stays fast.
    saveBacklinks(makeIndex(20_000));
    resetBacklinksCacheForTests(); // force the next call to be a genuine cold read

    const coldStart = performance.now();
    loadBacklinks();
    const coldMs = performance.now() - coldStart;

    const warmStart = performance.now();
    for (let i = 0; i < 50; i++) loadBacklinks();
    const warmMs = (performance.now() - warmStart) / 50;

    // Generous margin to avoid CI flakiness — the point is "dramatically
    // faster", not a precise ratio.
    expect(warmMs * 10).toBeLessThan(Math.max(coldMs, 1));
  });
});
