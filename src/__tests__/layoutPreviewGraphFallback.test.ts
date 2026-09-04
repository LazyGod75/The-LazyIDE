/**
 * layoutPreviewGraphFallback.test.ts — proves layout.ts's `layoutPreviewGraph`
 * recovers a REAL layout when the worker path fails or never answers,
 * independently of the worker's own health (the founder's requirement 3
 * after the real-app regression: the first version of this fix crashed the
 * worker on every call, and — because nothing fell back — the honest
 * degraded view latched forever).
 *
 * layout.test.ts already covers `layoutPreviewGraph`'s dangling-edge guard
 * running under jsdom's default state (no real `Worker`, so it already
 * always takes the synchronous fallback branch — see that file's own
 * header). THIS file specifically stubs `global.Worker` present (so
 * `typeof Worker === 'function'` is true, exactly like a real browser) and
 * makes the worker path fail two different ways — an outright rejection,
 * and a worker that never answers at all — proving `layoutPreviewGraph`'s
 * OWN `.catch()` fallback (layout.ts, around the `layoutPreviewGraphViaWorker`
 * call) still resolves with a real, correct layout either way, via the
 * same synchronous `elk.bundled.js` computation used when there is no
 * Worker at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { layoutPreviewGraph } from '../components/agents/canvas/layout';
import { _resetPreviewLayoutClientForTests } from '../components/agents/canvas/previewLayoutWorkerClient';

class RejectingWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage(): void {
    // Immediately reject the 'layout' call by crashing — mirrors the
    // real-app regression this fix addresses.
    queueMicrotask(() => this.onerror?.({ message: 'simulated worker crash' }));
  }
  terminate(): void {}
}

class SilentWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage(): void {
    // Deliberately never responds and never errors — the "worker never
    // settles" scenario layoutPreviewGraphViaWorker's own internal
    // WORKER_LAYOUT_TIMEOUT_MS exists to rescue.
  }
  terminate(): void {}
}

beforeEach(() => {
  _resetPreviewLayoutClientForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetPreviewLayoutClientForTests();
  vi.useRealTimers();
});

describe('layoutPreviewGraph — recovers via the synchronous fallback when the worker fails (requirement 3)', () => {
  it('still resolves a real, correct layout when the worker crashes outright', async () => {
    vi.stubGlobal('Worker', RejectingWorker as unknown as typeof Worker);

    const result = await layoutPreviewGraph(
      [{ id: 'a', width: 180, height: 84 }, { id: 'b', width: 180, height: 84 }],
      [{ id: 'e1', source: 'a', target: 'b' }],
    );

    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.positions.a).toBeDefined();
    expect(result.positions.b).toBeDefined();
    // The real layered algorithm ran (via the synchronous fallback) — b is
    // laid out downstream of a, per the real edge.
    expect(result.positions.b!.x).toBeGreaterThan(result.positions.a!.x);
  });

  it(
    'still resolves a real, correct layout when the worker never answers at all (bounded by the internal timeout)',
    async () => {
      // Deliberately REAL timers here, not fake ones — elk.bundled.js's own
      // in-process FakeWorker (the synchronous fallback this test proves
      // gets reached) schedules ITS OWN internal `setTimeout(fn, 0)` chains
      // (see node_modules/elkjs/lib/elk.bundled.js), which need real
      // wall-clock ticks to settle; chaining fake-timer advances precisely
      // through a third-party library's own internal timer usage proved
      // fragile in practice. The real cost is previewLayoutWorkerClient.ts's
      // own WORKER_LAYOUT_TIMEOUT_MS (5000ms), covered by this test's own
      // extended timeout below.
      vi.stubGlobal('Worker', SilentWorker as unknown as typeof Worker);

      const result = await layoutPreviewGraph(
        [{ id: 'a', width: 180, height: 84 }, { id: 'b', width: 180, height: 84 }],
        [{ id: 'e1', source: 'a', target: 'b' }],
      );

      expect(result.width).toBeGreaterThan(0);
      expect(result.positions.a).toBeDefined();
      expect(result.positions.b).toBeDefined();
    },
    10_000,
  );
});
