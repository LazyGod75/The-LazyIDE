/**
 * previewLayoutWorkerClient.test.ts — 2026-08 off-main-thread rewrite (see
 * layout.ts's own header for the founder's #1 complaint diagnosis: elkjs
 * starved on the main thread by React rendering/mission streaming/canvas
 * reconciliation under load), CORRECTED after a real-app regression: the
 * first version of this fix used `elkjs/lib/elk.bundled.js` inside the
 * worker, which crashed on every call (`_Worker is not a constructor`,
 * reproduced in elkWorkerBundling.crash.test.ts). This suite now covers
 * previewLayoutWorkerClient.ts's OWN code on top of the corrected
 * `elk-api.js` + `elk-worker.min.js` combination (that combination's own
 * end-to-end correctness is proven separately in
 * elkWorkerBundling.fixed.test.ts / elkWorkerBundling.crash.test.ts):
 *
 *   1. The Worker is constructed pointing at elkLayoutWorker.ts (not the
 *      old broken file), reused across calls (never one per call), and a
 *      crashed worker self-heals (the NEXT call gets a fresh worker).
 *   2. `layoutPreviewGraphViaWorker` never hangs forever — its own
 *      internal WORKER_LAYOUT_TIMEOUT_MS rejects a call whose worker never
 *      answers, which is what lets layout.ts's `layoutPreviewGraph` fall
 *      back to the guaranteed-working synchronous computation
 *      independently of the worker's health (the founder's requirement 3).
 *   3. The signature cache computes a given graph exactly once and reuses
 *      the SAME resolved object for every later call with an identical
 *      signature, and never poisons the cache with a failed attempt.
 *
 * ENVIRONMENT NOTE: jsdom has no real `Worker` (same fact
 * transformSandbox.test.ts's own header documents for its sandbox worker),
 * so this suite installs a minimal in-process fake via `vi.stubGlobal` that
 * mimics a worker speaking elk-api.js's own `{cmd, id}` protocol closely
 * enough to drive `previewLayoutWorkerClient.ts`'s OWN construction/reuse/
 * self-heal/timeout logic — it deliberately does NOT re-verify that
 * elk-api.js's `PromisedWorker` implementation itself is correct (that is
 * elkjs's own code, proven separately against elkjs's own real worker
 * implementation in elkWorkerBundling.fixed.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import {
  computePreviewGraphSignature,
  getOrComputeCachedPreviewLayout,
  layoutPreviewGraphViaWorker,
  _resetPreviewLayoutClientForTests,
  WORKER_LAYOUT_TIMEOUT_MS,
  type CachedPreviewLayout,
} from '../components/agents/canvas/previewLayoutWorkerClient';

interface PostedMessage {
  id: number;
  cmd: string;
  graph?: ElkNode;
}

// Mimics ONLY as much of a real Worker (and elk-api.js's own `{cmd, id}`
// wire protocol) as previewLayoutWorkerClient.ts's OWN logic needs to be
// exercised: construction, reuse, crash/self-heal. `elk-api.js`'s ELK
// class posts a 'register' message immediately on construction (fire-
// and-forget, never awaited by `.layout()` — see elk-api.js's own source);
// this fake never answers it, which is fine and matches how a slow/never-
// responding real worker would behave too.
class FakeWorker {
  readonly url: string;
  readonly options: unknown;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  posted: PostedMessage[] = [];
  terminated = false;

  constructor(url?: string | URL, options?: unknown) {
    this.url = String(url);
    this.options = options;
    instances.push(this);
  }

  postMessage(message: PostedMessage): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answers the most recent 'layout' command posted to this worker. */
  respondToLayout(resultGraph: ElkNode): void {
    const layoutMsg = [...this.posted].reverse().find((m) => m.cmd === 'layout');
    if (!layoutMsg) throw new Error('FakeWorker: no layout message posted yet');
    this.onmessage?.({ data: { id: layoutMsg.id, data: resultGraph } });
  }

  crash(message: string): void {
    this.onerror?.({ message });
  }
}

let instances: FakeWorker[] = [];

beforeEach(() => {
  _resetPreviewLayoutClientForTests();
  instances = [];
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetPreviewLayoutClientForTests();
  vi.useRealTimers();
});

function elkGraph(id: string): ElkNode {
  return { id, children: [{ id: 'n', width: 100, height: 50 }] };
}

describe('layoutPreviewGraphViaWorker — worker construction, reuse, and self-heal', () => {
  it('constructs the Worker pointing at elkLayoutWorker.ts as a module worker — not the old, broken elk.bundled.js-inside-a-worker approach', async () => {
    const promise = layoutPreviewGraphViaWorker(elkGraph('g1'));
    expect(instances).toHaveLength(1);
    expect(instances[0]!.url).toContain('elkLayoutWorker');
    expect(instances[0]!.options).toEqual({ type: 'module' });
    instances[0]!.respondToLayout({ id: 'g1', width: 300, height: 200 });
    await expect(promise).resolves.toMatchObject({ width: 300, height: 200 });
  });

  it('reuses ONE worker across multiple calls — never constructs a second one on the happy path', async () => {
    const first = layoutPreviewGraphViaWorker(elkGraph('g1'));
    expect(instances).toHaveLength(1);
    instances[0]!.respondToLayout({ id: 'g1', width: 1, height: 1 });
    await first;

    const second = layoutPreviewGraphViaWorker(elkGraph('g2'));
    expect(instances).toHaveLength(1); // still the SAME worker
    instances[0]!.respondToLayout({ id: 'g2', width: 2, height: 2 });
    await second;
  });

  it('self-heals after a worker crash — the NEXT call spins up a fresh worker instead of posting into a dead one', async () => {
    const stalled = layoutPreviewGraphViaWorker(elkGraph('g1'));
    // Swallow the eventual internal-timeout rejection below (see the
    // dedicated timeout test) — this test is only about what happens to
    // FUTURE calls after the crash, not this specific call's own fate.
    stalled.catch(() => {});
    expect(instances).toHaveLength(1);

    instances[0]!.crash('boom');

    const afterCrash = layoutPreviewGraphViaWorker(elkGraph('g2'));
    expect(instances).toHaveLength(2); // a fresh worker was constructed
    instances[1]!.respondToLayout({ id: 'g2', width: 5, height: 5 });
    await expect(afterCrash).resolves.toMatchObject({ width: 5, height: 5 });
  });
});

describe('layoutPreviewGraphViaWorker — bounded internal timeout (requirement 3: recovery independent of the worker)', () => {
  it('rejects instead of hanging forever when the worker never answers', async () => {
    vi.useFakeTimers();
    const promise = layoutPreviewGraphViaWorker(elkGraph('g1'));
    expect(instances).toHaveLength(1);
    // Deliberately never call instances[0]!.respondToLayout(...) — this IS
    // the "worker never settles" scenario. Without its own bounded
    // timeout, this promise (and therefore layout.ts's layoutPreviewGraph,
    // and therefore GraphProposalCard's whole preview) would hang forever.
    const assertion = expect(promise).rejects.toThrow(new RegExp(`${WORKER_LAYOUT_TIMEOUT_MS}ms`));
    await vi.advanceTimersByTimeAsync(WORKER_LAYOUT_TIMEOUT_MS + 1);
    await assertion;
  });

  it('does NOT time out a call that answers well within the budget', async () => {
    vi.useFakeTimers();
    const promise = layoutPreviewGraphViaWorker(elkGraph('g1'));
    await vi.advanceTimersByTimeAsync(10);
    instances[0]!.respondToLayout({ id: 'g1', width: 42, height: 42 });
    // elk-api.js's own `PromisedWorker` wraps message receipt in its OWN
    // `setTimeout(fn, 0)` (see node_modules/elkjs/lib/elk-api.js) — under
    // fake timers that needs an explicit (tiny) advance to actually fire,
    // exactly like any other timer in this test.
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({ width: 42, height: 42 });
  });
});

describe('computePreviewGraphSignature — pure, order-independent structural hash', () => {
  it('is identical regardless of node/edge array order', () => {
    const a = computePreviewGraphSignature(
      [{ id: 'a', width: 10, height: 20 }, { id: 'b', width: 30, height: 40 }],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    const b = computePreviewGraphSignature(
      [{ id: 'b', width: 30, height: 40 }, { id: 'a', width: 10, height: 20 }],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );
    expect(a).toBe(b);
  });

  it('ignores edge id — two edges with the same endpoints but different ids signature identically (they lay out identically)', () => {
    const a = computePreviewGraphSignature([{ id: 'a', width: 1, height: 1 }, { id: 'b', width: 1, height: 1 }], [{ id: 'e1', source: 'a', target: 'b' }]);
    const b = computePreviewGraphSignature([{ id: 'a', width: 1, height: 1 }, { id: 'b', width: 1, height: 1 }], [{ id: 'e-different', source: 'a', target: 'b' }]);
    expect(a).toBe(b);
  });

  it('differs when a node size changes', () => {
    const a = computePreviewGraphSignature([{ id: 'a', width: 10, height: 20 }], []);
    const b = computePreviewGraphSignature([{ id: 'a', width: 99, height: 20 }], []);
    expect(a).not.toBe(b);
  });
});

describe('getOrComputeCachedPreviewLayout — signature cache (requirement 3: no redundant recompute)', () => {
  it('computes once and returns the SAME object for two calls with an identical signature', async () => {
    const compute = vi.fn(async (): Promise<CachedPreviewLayout> => ({ positions: { a: { x: 1, y: 2 } }, width: 10, height: 20 }));
    const first = await getOrComputeCachedPreviewLayout('sig-1', compute);
    const second = await getOrComputeCachedPreviewLayout('sig-1', compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('computes independently for two different signatures', async () => {
    const compute = vi.fn(async (): Promise<CachedPreviewLayout> => ({ positions: {}, width: 1, height: 1 }));
    await getOrComputeCachedPreviewLayout('sig-a', compute);
    await getOrComputeCachedPreviewLayout('sig-b', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('a rejected compute is evicted — the SAME signature gets a fresh attempt on retry instead of being permanently poisoned', async () => {
    const compute = vi
      .fn<() => Promise<CachedPreviewLayout>>()
      .mockRejectedValueOnce(new Error('transient worker hiccup'))
      .mockResolvedValueOnce({ positions: {}, width: 5, height: 5 });

    await expect(getOrComputeCachedPreviewLayout('sig-retry', compute)).rejects.toThrow('transient worker hiccup');
    await expect(getOrComputeCachedPreviewLayout('sig-retry', compute)).resolves.toEqual({ positions: {}, width: 5, height: 5 });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('two concurrent calls for a brand-new signature share ONE in-flight computation', async () => {
    let computeCalls = 0;
    const compute = vi.fn(async (): Promise<CachedPreviewLayout> => {
      computeCalls += 1;
      return { positions: {}, width: 7, height: 7 };
    });
    const [a, b] = await Promise.all([
      getOrComputeCachedPreviewLayout('sig-concurrent', compute),
      getOrComputeCachedPreviewLayout('sig-concurrent', compute),
    ]);
    expect(computeCalls).toBe(1);
    expect(a).toBe(b);
  });
});
