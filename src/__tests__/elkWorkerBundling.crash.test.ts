/**
 * elkWorkerBundling.crash.test.ts — REGRESSION PROOF for the real-app crash
 * the founder caught after the first version of this fix shipped: the
 * in-chat plan-preview graph's worker offload used `elkjs/lib/elk.bundled.js`
 * inside the Worker (elkLayoutWorker.ts), which threw
 * `TypeError: _Worker is not a constructor` on every single call, verified
 * live via CDP. jsdom has no real `Worker`, so the original test suite
 * never actually exercised the worker's own code path — a false green.
 *
 * The crash's root cause is PURE JS branching, not a browser-API quirk, so
 * it CAN be reproduced deterministically under Vitest/jsdom without a real
 * Worker: elkjs's own `elk-worker.min.js` (bundled inside `elk.bundled.js`
 * too) decides at its own top-level evaluation time whether it is "being
 * required as a library" or "running AS the worker itself" purely by
 * checking `typeof document === 'undefined' && typeof self !== 'undefined'`
 * — true only inside a real Worker's global scope (no `document`, has
 * `self`). Stubbing `document` to `undefined` (jsdom otherwise provides
 * both `document` and `self`, matching a real browser main thread)
 * reproduces the exact condition a real Worker sees — first verified as a
 * standalone Node script before writing this file (see this fix's commit
 * message for the exact command + output).
 *
 * `document` is deleted ONCE, for this file's entire module registry, and
 * never restored mid-file — elkjs is a real npm CJS package, and empirically
 * `vi.resetModules()` does NOT force a fresh top-level re-evaluation of it
 * between tests in the same file (its internal browserify-style
 * require-cache survives), so a test that needs the OPPOSITE (`document`
 * defined) condition lives in the SEPARATE elkWorkerBundling.fixed.test.ts
 * instead, relying on Vitest's per-FILE module isolation rather than
 * `vi.resetModules()` mid-file. Every OTHER test in this repo's suite that
 * touches elkjs (layout.test.ts, GraphProposalCard.test.tsx, ...) runs in
 * its own file too, so this file's document-undefined state can never leak
 * into them.
 */
import { describe, it, expect } from 'vitest';

// A real Worker's global scope has `self` but no `document` — jsdom gives
// this test process both by default (it simulates a browser main thread),
// so only `document` needs removing to reproduce the exact condition
// elk-worker.min.js's own top-level branch checks. Done once, at module
// load, before elkjs is ever imported below — this file makes NO claim
// about what happens if you flip `document` back mid-file (see this file's
// own header for why that specifically does not work for this package).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (globalThis as any).document;

describe('elk.bundled.js CANNOT run inside a Worker (the exact live crash, reproduced)', () => {
  it('throws "_Worker is not a constructor" when constructed with document undefined — the precise error the founder captured via CDP', async () => {
    const { default: ELKBundled } = await import('elkjs/lib/elk.bundled.js');
    expect(() => new ELKBundled()).toThrow(/_Worker is not a constructor/);
  });
});

describe('elk-worker.min.js — the file elkLayoutWorker.ts now loads instead, verified under real-Worker conditions', () => {
  it('self-installs the worker message handler AND correctly answers a real register+layout exchange (the exact protocol a browser Worker running elkLayoutWorker.ts speaks)', async () => {
    const posted: Array<{ id: number; data?: unknown; error?: unknown }> = [];
    const fakeWorkerGlobalScope = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: { id: number; data?: unknown; error?: unknown }) => posted.push(message),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).self = fakeWorkerGlobalScope;

    await import('elkjs/lib/elk-worker.min.js');
    expect(typeof fakeWorkerGlobalScope.onmessage).toBe('function');

    // Drive the SAME two-step protocol elk-api.js's ELK class uses in
    // production (register algorithms, then request a layout) — proves
    // the worker-SIDE half of the protocol works under genuinely
    // real-Worker conditions (document undefined), independent of
    // elk-api.js's own client-side implementation (proven separately in
    // elkWorkerBundling.fixed.test.ts).
    fakeWorkerGlobalScope.onmessage!({
      data: { id: 0, cmd: 'register', algorithms: ['layered'] },
    });
    fakeWorkerGlobalScope.onmessage!({
      data: {
        id: 1,
        cmd: 'layout',
        graph: {
          id: 'root',
          layoutOptions: { 'elk.algorithm': 'layered' },
          children: [
            { id: 'a', width: 100, height: 50 },
            { id: 'b', width: 100, height: 50 },
          ],
          edges: [{ id: 'e1', sources: ['a'], targets: ['b'] }],
        },
        layoutOptions: {},
        options: {},
      },
    });

    const registerResponse = posted.find((m) => m.id === 0);
    const layoutResponse = posted.find((m) => m.id === 1);
    expect(registerResponse).toBeDefined();
    expect(registerResponse!.error).toBeUndefined();
    expect(layoutResponse).toBeDefined();
    expect(layoutResponse!.error).toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const graphResult = layoutResponse!.data as any;
    expect(graphResult.width).toBeGreaterThan(0);
    expect(graphResult.height).toBeGreaterThan(0);
    const a = graphResult.children.find((c: { id: string }) => c.id === 'a');
    const b = graphResult.children.find((c: { id: string }) => c.id === 'b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(b.x).toBeGreaterThan(a.x);
  });
});
