/* previewLayoutWorkerClient.ts — main-thread client for the in-chat plan-
   preview graph's off-main-thread elkjs layout (layout.ts's own
   `layoutPreviewGraph` header explains WHY: founder's #1 complaint, elkjs
   starved on the main thread). Two responsibilities:

   1. WORKER-BACKED ELK INSTANCE — `elkjs/lib/elk-api.js`'s own `ELK` class
      (NOT `elk.bundled.js` — see elkLayoutWorker.ts's header for the exact
      crash that combination causes inside a real Worker) constructed with a
      `workerFactory` pointed at elkLayoutWorker.ts. elk-api.js's class
      already implements a correct, battle-tested request/response
      protocol (`PromisedWorker`: an incrementing `id` per `.layout()` call,
      matched back via `resolvers[id]`) — a slower, superseded call's
      response can never be delivered to a different, newer call's promise,
      because each call gets its own id and its own resolver, not a shared
      "latest result" slot. One instance is created lazily and reused for
      every subsequent call ("one worker, reused across layout calls, not
      one per render"); on an `onerror` from the raw worker (a genuine
      thread-level crash, not a normal per-layout elkjs failure — those
      arrive as an ordinary promise rejection), the instance is dropped so
      the NEXT call constructs a fresh worker+ELK pair instead of posting
      into a dead one forever.

      `layoutPreviewGraphViaWorker` additionally bounds the wait with its
      OWN short internal timeout (WORKER_LAYOUT_TIMEOUT_MS, well under
      GraphProposalCard's own UI watchdog) — layout.ts's `layoutPreviewGraph`
      treats either an outright rejection OR this internal timeout as "the
      worker did not deliver", and falls back to the guaranteed-working
      synchronous `elk.bundled.js` call it already had. This is what makes
      recovery independent of the worker ever being fixed: even if the
      worker mechanism itself were completely broken, the feature still
      produces a real layout, just without the off-main-thread benefit for
      that one call.

   2. SIGNATURE CACHE — the SAME proposal graph re-renders repeatedly
      (parent re-render, tab switch, panel expand/collapse) with an
      IDENTICAL shape; recomputing a layout elkjs already solved is pure
      waste. `getOrComputeCachedPreviewLayout` memoizes by a pure structural
      signature (node ids/sizes + edge endpoints — see
      `computePreviewGraphSignature`), caching the in-flight PROMISE (not
      just the resolved value) so two calls that race for the same
      signature share one real computation instead of firing two.

   `layoutPreviewGraphViaWorker` is only ever called by layout.ts's
   `layoutPreviewGraph` when `typeof Worker === 'function'` — false under
   Vitest/jsdom (confirmed: transformSandbox.test.ts's own header) and never
   false in the shipped Tauri app or plain `vite` dev/preview, both real
   browsers.
*/

import ElkConstructor from 'elkjs/lib/elk-api.js';
import type { ELK as ElkInstance, ElkNode } from 'elkjs/lib/elk-api';
import type { PreviewLayoutEdge, PreviewLayoutNode } from './layout';

// Same stable log-prefix convention as layout.ts's own `LAYOUT_LOG_PREFIX`
// (a developer greps for either) — this module logs worker lifecycle
// events (crash/self-heal), layout.ts logs the dangling-edge guard.
const LAYOUT_LOG_PREFIX = '[layoutPreviewGraph]';

// 2026-08 verification wave — the founder's own CDP probe of
// `layoutPreviewGraph` resolved in ~20ms while the SAME proposal's card
// stayed stuck on the watchdog banner forever, and the working hypothesis
// (still unconfirmed at the time this instrumentation was added — see this
// module's `getOrComputeCachedPreviewLayout` doc comment) was that the
// signature cache was handing out an in-flight promise that never settles.
// `console.debug` (never `.warn`, which is reserved for the genuine
// failure/self-heal paths already logged elsewhere in this file) traces
// every cache hit/miss and settle outcome by signature — read live via:
//   copy(JSON.stringify(window.__lazyLayoutDebugLog ?? []))
// (see `_lazyLayoutDebugLog` below — console output alone scrolls out of
// reach on a long-running session, so every entry is ALSO appended to a
// small ring buffer on `window` for exactly this kind of after-the-fact
// CDP inspection).
const DEBUG_PREFIX = '[layoutPreviewGraph:debug]';
const DEBUG_LOG_MAX_ENTRIES = 200;

// Dev-only / cheap in production — `import.meta.env.DEV` is a Vite
// build-time constant (statically replaced with `false` and dead-code-
// eliminated by Rollup in a production build, per Vite's own docs), so
// `debugLog`'s entire body — building the log entry object, the
// console.debug call, the ring-buffer push — never runs at all in the
// shipped app; every call site pays only the cost of this one already-
// inlined boolean check. `true` under Vitest (matches this repo's other
// `import.meta.env.DEV`-style checks) and in `vite`/Tauri dev, which is
// exactly where this instrumentation is meant to help.
const DEBUG_ENABLED = import.meta.env.DEV;

function debugLog(event: string, data: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) return;
  const entry = { event, ...data, at: Date.now() };
  console.debug(DEBUG_PREFIX, event, data);
  const globalScope = globalThis as unknown as { __lazyLayoutDebugLog?: unknown[] };
  if (!Array.isArray(globalScope.__lazyLayoutDebugLog)) globalScope.__lazyLayoutDebugLog = [];
  const log = globalScope.__lazyLayoutDebugLog;
  log.push(entry);
  if (log.length > DEBUG_LOG_MAX_ENTRIES) log.shift();
}

/** Exported so GraphProposalCard.tsx's own effect can append to the SAME
 *  `window.__lazyLayoutDebugLog` ring buffer/console stream — one
 *  chronologically-interleaved trace spanning "effect started" all the way
 *  through "cache hit/miss" and "compute resolved/rejected", instead of two
 *  disjoint logs a developer has to manually correlate by timestamp. */
export function _debugLogPreviewLayout(event: string, data: Record<string, unknown>): void {
  debugLog(event, data);
}

// ── Signature cache ──────────────────────────────────────────────────────

export interface CachedPreviewLayout {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/**
 * Pure, order-independent structural signature of a preview graph — two
 * calls describing the SAME shape (same node ids/sizes, same edge
 * endpoints) hash identically regardless of array order, so a re-render
 * that rebuilds the same `ProposalGraph` from scratch (a fresh JS array
 * every time, per graphProposalGraph.ts's `buildProposalGraph`) still hits
 * the cache. Deliberately excludes edge ids and node labels/tooltips/detail
 * text: none of that affects elkjs's actual layout geometry, so including
 * it would only fragment the cache into near-duplicate entries for what is,
 * layout-wise, the exact same graph.
 */
export function computePreviewGraphSignature(
  nodes: readonly PreviewLayoutNode[],
  edges: readonly PreviewLayoutEdge[],
): string {
  const nodePart = nodes.map((n) => `${n.id}:${n.width}x${n.height}`).sort().join('|');
  const edgePart = edges.map((e) => `${e.source}>${e.target}`).sort().join('|');
  return `${nodePart}##${edgePart}`;
}

// This cache only exists to avoid re-laying-out the SAME proposal
// repeatedly within one session (re-render/tab-switch/panel-expand, not a
// long-lived store) — a hard cap plus oldest-first eviction (Map preserves
// insertion order) keeps a long session's many distinct proposals from
// growing this unboundedly.
const PREVIEW_LAYOUT_CACHE_MAX_ENTRIES = 50;
const cache = new Map<string, Promise<CachedPreviewLayout>>();

// 2026-08 verification wave — a promise can only be evicted from `cache` on
// REJECTION (see below); nothing evicted one that simply never settles at
// all. Real JS promises cannot be cancelled, so a caller "giving up" on a
// request (GraphProposalCard.tsx's own cancellation, or React StrictMode's
// dev-only double effect invoke) never actually stops the underlying
// computation — but IF that computation genuinely hangs forever for some
// reason outside this cache's control (a worker wedged by a dev-server
// module-loading hiccup, a future regression, ...), every LATER call for
// the identical signature would silently inherit that same stuck promise
// forever, with no way out. This bound makes that structurally impossible:
// an entry that hasn't settled within CACHE_ENTRY_STALE_MS is evicted
// (never resolved/rejected FOR ITS ORIGINAL CALLER — that promise is simply
// abandoned, its own eventual settlement now moot since nothing reads
// `cache` for this signature anymore), so the NEXT call gets a fresh
// attempt instead of permanently inheriting an entry nobody can prove is
// still alive. Comfortably above WORKER_LAYOUT_TIMEOUT_MS (5000ms) + a
// synchronous-fallback margin, so a normally-recovering call is never
// evicted out from under itself.
const CACHE_ENTRY_STALE_MS = 9000;

/**
 * Returns the cached (or in-flight) layout for `signature`, computing it via
 * `compute` only on a genuine cache miss. Caches the PROMISE, not just the
 * eventual value, so two calls racing for the same never-before-seen
 * signature share one real elkjs/worker computation instead of firing two.
 * A rejected computation is evicted immediately (never cached) — a
 * transient worker hiccup must not permanently block every future attempt
 * at laying out this exact graph. A computation that never settles at all
 * is ALSO evicted, after CACHE_ENTRY_STALE_MS (see that constant's own
 * comment) — the one failure mode a plain "evict on rejection" cannot
 * catch, because a promise that never settles never rejects either.
 */
export function getOrComputeCachedPreviewLayout(
  signature: string,
  compute: () => Promise<CachedPreviewLayout>,
): Promise<CachedPreviewLayout> {
  const cached = cache.get(signature);
  if (cached) {
    debugLog('cache hit', { signature });
    return cached;
  }

  debugLog('cache miss — computing', { signature });
  const startedAt = Date.now();
  const promise = compute()
    .then((value) => {
      debugLog('compute resolved', { signature, elapsedMs: Date.now() - startedAt, width: value.width, height: value.height });
      return value;
    })
    .catch((err: unknown) => {
      debugLog('compute rejected — evicting', { signature, elapsedMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) });
      cache.delete(signature);
      throw err;
    });
  cache.set(signature, promise);

  // Staleness backstop (see CACHE_ENTRY_STALE_MS's own comment) — only
  // evicts THIS exact promise instance (`cache.get(signature) === promise`
  // guards against evicting a NEWER entry a later call already installed
  // after this one settled and cleaned itself up, or after this one was
  // already evicted for some other reason).
  const staleTimer = setTimeout(() => {
    if (cache.get(signature) === promise) {
      debugLog('cache entry evicted as stale — never settled', { signature, waitedMs: CACHE_ENTRY_STALE_MS });
      cache.delete(signature);
    }
  }, CACHE_ENTRY_STALE_MS);
  // Clears the stale-eviction timer the moment `promise` settles either
  // way (resolves via the `.then` above, or rejects via the `.catch` above
  // — both handled explicitly here so this can never itself surface as an
  // "unhandled rejection") — avoids leaking a live timer for the whole
  // CACHE_ENTRY_STALE_MS window on the overwhelmingly common fast path.
  // Re-audited for the SAME class of bug as GraphProposalCard.tsx's own
  // watchdog (see that file's header, THIRD root cause: a timer that only
  // gets cleared on the "unhappy" path fires anyway after a SUCCESS and
  // corrupts already-correct state) — this one was already safe: unlike
  // the card's watchdog, this specific `clearTimeout` call was already
  // reachable from BOTH the resolve and reject branch since the day this
  // cache was added, not added after the fact.
  promise.then(
    () => clearTimeout(staleTimer),
    () => clearTimeout(staleTimer),
  );

  if (cache.size > PREVIEW_LAYOUT_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }

  return promise;
}

// ── Worker-backed ELK instance ──────────────────────────────────────────

// Bounds how long a single worker call is trusted before layout.ts's
// `layoutPreviewGraph` gives up on it and falls back to the synchronous
// in-thread computation — deliberately well under GraphProposalCard's own
// LAYOUT_RESOLUTION_TIMEOUT_MS (8000ms) so a worker that is merely slow
// under real system load (not dead) still gets recovered via the sync
// fallback well before the UI's own honest-degraded-view watchdog would
// otherwise fire.
export const WORKER_LAYOUT_TIMEOUT_MS = 5000;

let elkWorkerInstance: ElkInstance | null = null;
// Rejects the INSTANT the current instance's raw worker crashes — paired
// with `elkWorkerInstance` (both reset together) and raced against every
// `.layout()` call below. elk-api.js's `PromisedWorker` has no public way
// to force-reject whatever call(s) were in flight when a crash happens (it
// only resolves/rejects a call when a MESSAGE arrives, never on a raw
// `worker.onerror`); without this, a genuine crash would only be rescued
// by WORKER_LAYOUT_TIMEOUT_MS's full timeout window (verified as a real
// gap by a test that timed itself out here during development — a crash
// is a CERTAINTY the worker is dead, so it must fail fast, not wait out
// the same budget reserved for "maybe just slow").
let crashSignal: Promise<never> | null = null;

function getElkWorkerInstance(): { instance: ElkInstance; crashed: Promise<never> } {
  if (elkWorkerInstance && crashSignal) return { instance: elkWorkerInstance, crashed: crashSignal };

  let rejectOnCrash: (err: Error) => void;
  const crashed = new Promise<never>((_resolve, reject) => {
    rejectOnCrash = reject;
  });
  // A permanent, no-op handler so this promise can never surface as an
  // "unhandled rejection" on its own — every real call still races it
  // below (via Promise.race), this is only a safety net for the edge case
  // of an instance created but never used before a crash.
  crashed.catch(() => {});

  // Same relative `new URL(...)` + `{ type: 'module' }` construction as
  // lib/agents/transformSandbox.ts's `runInBrowserWorker` — that module's
  // own header documents the CSP/bundling evidence this relies on: a
  // Vite-bundled worker chunk is served from the same origin as every
  // other asset under Tauri's `script-src 'self'` CSP, already proven
  // end-to-end in the shipped app. UNLIKE that module, this worker is a
  // long-lived singleton (reused across every layout call via elk-api.js's
  // own ELK instance, never terminated after one use).
  const instance = new ElkConstructor({
    workerFactory: () => {
      const raw = new Worker(new URL('./elkLayoutWorker.ts', import.meta.url), { type: 'module' });
      raw.onerror = (event: ErrorEvent) => {
        // A worker-THREAD-level crash (not a per-layout elkjs failure,
        // which arrives as a normal promise rejection from `.layout()`
        // instead). Rejects every call CURRENTLY racing `crashed` right
        // away (fast recovery), and drops the instance so the NEXT call
        // never posts into a worker that will never answer again.
        console.warn(
          LAYOUT_LOG_PREFIX,
          `elk layout worker crashed (${event.message || 'unknown error'}) — the next layout call spins up a fresh worker`,
        );
        if (elkWorkerInstance === instance) {
          elkWorkerInstance = null;
          crashSignal = null;
        }
        rejectOnCrash(new Error(`elk layout worker crashed: ${event.message || 'unknown error'}`));
      };
      return raw;
    },
  });
  elkWorkerInstance = instance;
  crashSignal = crashed;
  return { instance, crashed };
}

// Re-audited alongside GraphProposalCard.tsx's own watchdog fix (that
// file's header, THIRD root cause) for the same class of bug — a timer
// only disarmed on one settle path fires anyway after the OTHER one and
// corrupts already-correct state. Already safe here: both the resolve AND
// reject branches below call `clearTimeout(timer)` before doing anything
// else, so this timer can never fire once `promise` has settled either way.
function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Runs one layout call through the shared worker-backed ELK instance,
 *  bounded by WORKER_LAYOUT_TIMEOUT_MS. Rejects (never hangs forever) on a
 *  worker crash (immediately, via `crashed` — see `getElkWorkerInstance`'s
 *  own comment for why this can't just wait out the timeout below), a
 *  genuine elkjs failure, OR the internal timeout for a worker that is
 *  merely slow/never answers without ever erroring — the caller
 *  (layout.ts's `layoutPreviewGraph`) is responsible for falling back to
 *  the synchronous computation on any rejection. */
export function layoutPreviewGraphViaWorker(graph: ElkNode): Promise<ElkNode> {
  const { instance, crashed } = getElkWorkerInstance();
  return withTimeout(
    Promise.race([instance.layout(graph) as Promise<ElkNode>, crashed]),
    WORKER_LAYOUT_TIMEOUT_MS,
    `worker layout exceeded ${WORKER_LAYOUT_TIMEOUT_MS}ms`,
  );
}

/** Test-only reset — mirrors canvasStore.ts's own `_resetCanvasStoreForTests`
 *  convention. Clears the signature cache and terminates+drops the shared
 *  ELK/worker instance so the next call starts from a clean slate. */
export function _resetPreviewLayoutClientForTests(): void {
  cache.clear();
  if (elkWorkerInstance) {
    elkWorkerInstance.terminateWorker();
    elkWorkerInstance = null;
  }
  crashSignal = null;
}
