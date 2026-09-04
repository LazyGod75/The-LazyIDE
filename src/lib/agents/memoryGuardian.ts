/* memoryGuardian.ts — renderer JS-heap watchdog (memory-pressure hardening
   wave, 2026-08-05 incident: the WebView2 renderer grew 1.8GB -> 2.5GB
   repeatedly during a QA session; the historical OOM crash threshold is
   ~2.6GB, and the operator had to manually purge UI state and reload three
   times. Founder's verdict (verbatim): "le fait que tu purges toi est
   problematique, l'IDE devrait pouvoir le faire intelligemment" — the IDE
   must manage its own memory, not the human.

   This module is the DETECTION half of that fix: it watches the renderer's
   OWN JS heap (performance.memory.usedJSHeapSize — a Chromium/WebView2-only
   API) and tells the rest of the app when usage crosses a soft or hard
   threshold. It is a different signal from systemPressure.ts, which only
   tracks OS-level RAM/CPU via the Rust backend's `system://pressure` event
   and cannot see the renderer's own heap. This module does NOT evict
   anything, cap anything, or reload anything itself — see CONSUMER
   CONTRACT below. Its armed/re-arm-on-drop shape deliberately mirrors
   systemPressureShedding.ts's `shouldShed` (edge-triggered, re-arms once
   pressure drops back down) — same policy shape, different pressure
   signal.

   EVENTS + CONSUMER CONTRACT (for whoever wires a reaction in a later
   wave): a single DOM CustomEvent name, `lazy:memory-pressure`
   (MEMORY_PRESSURE_EVENT), dispatched on `window` with
   `detail: MemoryPressureEventDetail = { level: 'soft' | 'hard', usedMB }`.
     - 'soft' (default 1.5GB used): early warning. A consumer should shed
       CHEAP, low-risk state on this signal — evict stale fleet signals,
       cap timeline/history buffers, drop reclaimable caches (the same kind
       of action systemPressureShedding.ts's ShedActions already models for
       OS-level pressure).
     - 'hard' (default 2.2GB used): urgent. The historical crash threshold
       is ~2.6GB, so a consumer should reclaim aggressively and, if that is
       not enough, orchestrate a reload AT A SAFE BOUNDARY — never mid-turn,
       never mid-write (same safety floor systemPressureShedding.ts's
       header already commits to for its own actions).
   This module never performs any of that itself — it only detects and
   emits, so the eviction/reload policy can be designed and reviewed
   independently. Store owners are expected to wire the `window.addEventListener('lazy:memory-pressure', ...)` listener in a later wave.

   RATE LIMITING (per level, soft and hard tracked independently): a level
   fires again only once BOTH (a) usage has dropped back below THAT level's
   own threshold since it last fired (re-arm — stops one sustained overage
   from firing every single poll) AND (b) at least
   MEMORY_GUARDIAN_RATE_LIMIT_MS has passed since it last fired (belt and
   suspenders against fast flapping right at the threshold boundary). Soft
   and hard are independent trackers: a poll that jumps straight past both
   thresholds at once (plausible at a 30s cadence during a heavy operation)
   legitimately fires both in the same tick — a 'soft' listener (cheap
   shedding) and a 'hard' listener (urgent reclaim) each still want their
   own signal.

   GRACEFUL DEGRADATION (deliberate, not a gap): performance.memory is a
   non-standard Chromium extension (present in WebView2, absent in Firefox/
   Safari and in a bare jsdom test environment). When it is missing, every
   poll is a silent no-op — no throw, no fabricated reading, and
   deliberately NOT a fallback to navigator.deviceMemory: that API reports a
   static, coarse "total device RAM" bucket, not a live heap-usage number,
   so treating it as a substitute would misrepresent actual pressure rather
   than just doing nothing.

   SELF-CONTAINED BY DESIGN: zero internal imports (no agentsStore,
   managerEngine, not even platform.ts's isTauri) — only the global
   `performance`, `window`, and `setInterval`, so this module can be
   reasoned about and tested in complete isolation. All state is local to
   each startMemoryGuardian() call (no module-level singleton), so unlike
   systemPressure.ts/crashReporter.ts this module needs no
   resetForTests helper — each test's own handle is already independent.
*/

export type MemoryPressureLevel = 'soft' | 'hard';

/** Payload of the `lazy:memory-pressure` CustomEvent — see this module's
 *  header for the full consumer contract. */
export interface MemoryPressureEventDetail {
  level: MemoryPressureLevel;
  /** Rounded MB reading of performance.memory.usedJSHeapSize at the moment
   *  this level was crossed. */
  usedMB: number;
}

/** DOM CustomEvent name dispatched on `window`. */
export const MEMORY_PRESSURE_EVENT = 'lazy:memory-pressure';

// ── Thresholds (exported so consumers/tests reference the same numbers
//    this module defaults to, instead of hardcoding a duplicate). ──────
export const MEMORY_GUARDIAN_SOFT_THRESHOLD_MB = 1500;
export const MEMORY_GUARDIAN_HARD_THRESHOLD_MB = 2200;
export const MEMORY_GUARDIAN_SOFT_THRESHOLD_BYTES = MEMORY_GUARDIAN_SOFT_THRESHOLD_MB * 1024 * 1024;
export const MEMORY_GUARDIAN_HARD_THRESHOLD_BYTES = MEMORY_GUARDIAN_HARD_THRESHOLD_MB * 1024 * 1024;

/** Default poll cadence. */
export const MEMORY_GUARDIAN_POLL_INTERVAL_MS = 30_000;

/** Minimum gap between two emissions of the SAME level, even if it re-arms
 *  sooner via a drop-below-threshold blip (see header's RATE LIMITING). */
export const MEMORY_GUARDIAN_RATE_LIMIT_MS = 3 * 60_000;

export interface MemoryGuardianOptions {
  /** Bytes. Default {@link MEMORY_GUARDIAN_SOFT_THRESHOLD_BYTES}. */
  softThresholdBytes?: number;
  /** Bytes. Default {@link MEMORY_GUARDIAN_HARD_THRESHOLD_BYTES}. */
  hardThresholdBytes?: number;
  /** Default {@link MEMORY_GUARDIAN_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Default {@link MEMORY_GUARDIAN_RATE_LIMIT_MS}. */
  rateLimitMs?: number;
  /** Clock — real Date.now in production, injectable for tests. */
  now?: () => number;
}

export interface MemoryGuardianHandle {
  /** Stops polling. Idempotent — a second call is a no-op. */
  stop: () => void;
}

/** Chromium/WebView2-only extension to the standard Performance interface —
 *  not part of TS's DOM lib typings, so it is declared locally rather than
 *  widening the global Performance type for the whole app. */
interface PerformanceWithMemory {
  memory?: {
    usedJSHeapSize: number;
  };
}

/** Reads the current JS heap usage in bytes, or undefined when the API is
 *  absent or malformed. NEVER throws — see header's GRACEFUL DEGRADATION. */
function readUsedJSHeapSize(): number | undefined {
  if (typeof performance === 'undefined') return undefined;
  const mem = (performance as unknown as PerformanceWithMemory).memory;
  const used = mem?.usedJSHeapSize;
  return typeof used === 'number' && Number.isFinite(used) ? used : undefined;
}

/** Per-level hysteresis + rate-limit state — see header's RATE LIMITING. */
export interface LevelState {
  readonly armed: boolean;
  readonly lastFiredAtMs: number | null;
}

/** Fresh per-level state: armed, never fired. */
export function createInitialLevelState(): LevelState {
  return { armed: true, lastFiredAtMs: null };
}

/**
 * Pure decision: given one level's current state and the latest reading,
 * does THIS poll cross into a firing condition, and what is the level's
 * next state? Exported (mirrors crashReporter.ts's shouldReport /
 * systemPressureShedding.ts's shouldShed convention) so the hysteresis and
 * rate-limit logic is directly unit-testable without a real timer or a
 * faked performance.memory. Immutable: `state` is never mutated; the same
 * reference is returned when nothing about it actually changes.
 */
export function evaluateMemoryLevel(
  state: LevelState,
  usedBytes: number,
  thresholdBytes: number,
  rateLimitMs: number,
  nowMs: number,
): { fired: boolean; state: LevelState } {
  if (usedBytes < thresholdBytes) {
    // Below threshold: re-arm (idempotent — keep the same reference if
    // already armed, so a long stretch of low usage allocates nothing).
    return state.armed ? { fired: false, state } : { fired: false, state: { ...state, armed: true } };
  }

  const withinCooldown = state.lastFiredAtMs !== null && nowMs - state.lastFiredAtMs < rateLimitMs;
  if (!state.armed || withinCooldown) {
    return { fired: false, state };
  }

  return { fired: true, state: { armed: false, lastFiredAtMs: nowMs } };
}

function dispatchPressureEvent(level: MemoryPressureLevel, usedBytes: number): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  const usedMB = Math.round(usedBytes / (1024 * 1024));
  window.dispatchEvent(new CustomEvent(MEMORY_PRESSURE_EVENT, { detail: { level, usedMB } }));
}

/**
 * Starts polling the renderer's own JS heap every `pollIntervalMs` (default
 * 30s, checked immediately once on start too) and dispatching
 * `lazy:memory-pressure` on `window` when usage crosses the soft/hard
 * thresholds. See this module's header for the full contract (events,
 * consumer responsibilities, rate limiting, graceful degradation). Returns
 * a handle to stop polling — call stop() on unmount / app teardown.
 */
export function startMemoryGuardian(opts: MemoryGuardianOptions = {}): MemoryGuardianHandle {
  const softThresholdBytes = opts.softThresholdBytes ?? MEMORY_GUARDIAN_SOFT_THRESHOLD_BYTES;
  const hardThresholdBytes = opts.hardThresholdBytes ?? MEMORY_GUARDIAN_HARD_THRESHOLD_BYTES;
  const pollIntervalMs = opts.pollIntervalMs ?? MEMORY_GUARDIAN_POLL_INTERVAL_MS;
  const rateLimitMs = opts.rateLimitMs ?? MEMORY_GUARDIAN_RATE_LIMIT_MS;
  const now = opts.now ?? (() => Date.now());

  let stopped = false;
  let soft: LevelState = createInitialLevelState();
  let hard: LevelState = createInitialLevelState();
  let unexpectedErrorLogged = false;

  function poll(): void {
    if (stopped) return;
    try {
      const usedBytes = readUsedJSHeapSize();
      if (usedBytes === undefined) return; // API absent — silent no-op, never throws.

      const nowMs = now();

      const softResult = evaluateMemoryLevel(soft, usedBytes, softThresholdBytes, rateLimitMs, nowMs);
      soft = softResult.state;
      if (softResult.fired) dispatchPressureEvent('soft', usedBytes);

      const hardResult = evaluateMemoryLevel(hard, usedBytes, hardThresholdBytes, rateLimitMs, nowMs);
      hard = hardResult.state;
      if (hardResult.fired) dispatchPressureEvent('hard', usedBytes);
    } catch (err: unknown) {
      // Defensive only — readUsedJSHeapSize/dispatchPressureEvent are not
      // expected to throw in a real browser/WebView2, but a background
      // poll must never crash the app either way (same "degrade, don't
      // throw" convention as journal.ts/managerWakeup.ts's own poll()).
      // Logged once per guardian instance, not once per poll, so a genuine
      // regression stays diagnosable without spamming the console for the
      // rest of the session.
      if (!unexpectedErrorLogged) {
        unexpectedErrorLogged = true;
        console.warn(
          '[memoryGuardian] unexpected poll failure — memory-pressure detection degraded for this session:',
          err,
        );
      }
    }
  }

  poll();
  const interval = setInterval(poll, pollIntervalMs);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
    },
  };
}
