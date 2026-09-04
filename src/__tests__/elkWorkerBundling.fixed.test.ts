/**
 * elkWorkerBundling.fixed.test.ts — proves the CORRECTED combination
 * previewLayoutWorkerClient.ts now uses (`elkjs/lib/elk-api.js`'s `ELK`
 * class + a `workerFactory`) actually produces a real, non-degenerate
 * layout end to end. See elkWorkerBundling.crash.test.ts for the paired
 * regression proof (the OLD `elk.bundled.js`-inside-a-worker combination
 * crashing) and elkLayoutWorker.ts's header for the full root-cause story.
 *
 * This file deliberately does NOT touch `document`/`self` (left at jsdom's
 * normal defaults, matching a real browser MAIN thread) — kept in its own
 * file rather than combined with elkWorkerBundling.crash.test.ts because,
 * empirically, `vi.resetModules()` does not force a fresh top-level
 * re-evaluation of the `elkjs` npm package between tests in the same file
 * (see that file's header), so a test needing the OPPOSITE `document`
 * state cannot safely share a file with one that deletes it.
 *
 * The "worker" here is `elk-worker.min.js`'s own CJS-exported `Worker`
 * class (obtained under these NORMAL, document-defined conditions — the
 * same in-process, synchronous implementation `elk.bundled.js`'s
 * main-thread path already relies on for layoutZone/layoutAll/laneLayout),
 * not a real browser Worker (jsdom has none — confirmed by
 * transformSandbox.test.ts's own header). It speaks the IDENTICAL
 * `{cmd, id}` message protocol a real browser Worker running
 * elkLayoutWorker.ts would, and elkWorkerBundling.crash.test.ts
 * independently proves the OTHER half of that exact protocol (the
 * worker-side dispatcher) works correctly under genuinely real-Worker
 * conditions — together, both halves of the real production combination
 * are verified using elkjs's own real implementation.
 */
import { describe, it, expect } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api.js';

describe('elk-api.js ELK + elk-worker.min.js Worker — the combination previewLayoutWorkerClient.ts now uses', () => {
  it('produces a real, non-degenerate layout (register + layout, end to end) — never a stub result', async () => {
    const [{ default: ElkConstructor }, workerModule] = await Promise.all([
      import('elkjs/lib/elk-api.js'),
      import('elkjs/lib/elk-worker.min.js'),
    ]);
    const FakeWorker = (workerModule as unknown as { Worker: new (url?: string) => Worker }).Worker;
    expect(typeof FakeWorker).toBe('function');

    const elk = new ElkConstructor({ workerFactory: (url?: string) => new FakeWorker(url) });
    const graph: ElkNode = {
      id: 'root',
      layoutOptions: { 'elk.algorithm': 'layered' },
      children: [
        { id: 'a', width: 100, height: 50 },
        { id: 'b', width: 100, height: 50 },
      ],
      edges: [{ id: 'e1', sources: ['a'], targets: ['b'] }],
    };
    const result = await elk.layout(graph);

    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    const a = result.children?.find((c) => c.id === 'a');
    const b = result.children?.find((c) => c.id === 'b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // The layered algorithm ran for real (not a stub/degenerate result) —
    // b is laid out downstream (to the right) of a, per the real edge a->b.
    expect(b!.x!).toBeGreaterThan(a!.x!);
    // No elk.terminateWorker() here — the test-only `FakeWorker` stand-in
    // (elk-worker.min.js's own CJS export, an in-process simulation with
    // no real OS thread to tear down) implements `postMessage` only, not
    // `terminate`; a real browser Worker implements both, and
    // previewLayoutWorkerClient.ts's `_resetPreviewLayoutClientForTests`
    // calls the real one in its own tests.
  });

  it('a second, larger layout call through the SAME (reused) ELK/worker instance still resolves correctly', async () => {
    const [{ default: ElkConstructor }, workerModule] = await Promise.all([
      import('elkjs/lib/elk-api.js'),
      import('elkjs/lib/elk-worker.min.js'),
    ]);
    const FakeWorker = (workerModule as unknown as { Worker: new (url?: string) => Worker }).Worker;
    const elk = new ElkConstructor({ workerFactory: (url?: string) => new FakeWorker(url) });

    await elk.layout({
      id: 'first',
      layoutOptions: { 'elk.algorithm': 'layered' },
      children: [{ id: 'a', width: 50, height: 50 }],
      edges: [],
    });

    const secondGraph: ElkNode = {
      id: 'second',
      layoutOptions: { 'elk.algorithm': 'layered' },
      children: Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, width: 80, height: 40 })),
      edges: Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, sources: [`n${i}`], targets: [`n${i + 1}`] })),
    };
    const second = await elk.layout(secondGraph);

    expect(second.width).toBeGreaterThan(0);
    expect(second.children).toHaveLength(6);
  });
});
