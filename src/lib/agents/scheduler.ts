/* scheduler.ts — provider-aware concurrency scheduler for agent missions
   (T1.1, spec §7.1).

   Every mission launch routes through ONE "pool" keyed by the engine that
   will run it (resolveProvider): the native CLI subscription tool
   ('claude-cli' — shared by claude-code AND codex, both spawn a real OS
   process via runtime.ts's planAndActLive, the actual scarce resource), the
   managed Lazy Pro engine ('managed', via the shared ai-proxy), or a direct
   BYOK API key ('byok:<8-char-hash>' — one pool per distinct key, so
   unrelated keys never share a budget and one key's own rate limit is
   respected).

   dispatch() launches immediately when a pool AND the global cap
   (lazy.agents.maxParallel) both have a free slot; otherwise it queues the
   mission (FIFO within priority) and emits `scheduler.queued` — additive
   context alongside, never a replacement for, the `mission.queued`
   lifecycle event agentsStore.tsx already emits at creation.

   Backoff: a run failing with a 429/rate-limit-shaped error pauses ITS OWN
   pool only (pools are independent) for an exponential window (30s base,
   10min cap, doubling per failure, reset on the next success). A backed-off
   pool is skipped by drain() even with a numerically free slot.

   Mostly event-driven — a pool's backoff/capacity is primarily re-checked on
   a mission settling or a new dispatch() call, so every dispatch() call
   opportunistically drains everything eligible first. A low-frequency
   periodic sweep (startPeriodicSweep, see the root-cause fix note below) is
   the one deliberate exception — a pure safety net, never the primary
   mechanism.

   Module-level singleton (zustand-style, no Context) — mirrors
   src/lib/brain/seedProgressStore.ts. _running/_backoff Maps are mutated in
   place, like agentsStore.tsx's own stopFlags/pauseFlags refs; _queue is
   reassigned wholesale on every change, like journal.ts's own _buffer.

   Conflict pre-flight (T1.6, spec §7.2): dispatch() additionally accepts
   opts.scopeInfo.runningMissions — the caller's OWN snapshot of currently
   running missions (agentsStore.tsx holds the full Mission list; this
   scheduler only ever tracked per-pool COUNTS, never which missions those
   counts refer to, so it cannot reconstruct that list itself). When
   provided, a mission that would otherwise launch immediately is instead
   checked (preflight.ts's checkConflicts) against that list; a scope
   overlap queues it (reason 'scope_conflict') instead of launching. Fully
   additive and backward-compatible: opts.scopeInfo is optional, and every
   existing call site (and every pre-T1.6 test) that never sets it sees
   byte-identical behavior, since the new code paths below are gated behind
   its presence.

   To know WHEN a scope-conflict-queued entry becomes launchable again
   ("drain it when the conflicting mission settles"), _runningMissionIds
   tracks every mission id currently occupying a launched slot (populated
   whenever a Mission is available at launch time — both the direct-dispatch
   path and drain()'s queued path always have one). A queued entry that
   carries conflictsWith is only eligible once none of those ids are in
   _runningMissionIds anymore — a cheap synchronous membership check, not a
   re-run of checkConflicts (whose async journal query is why the conflict
   check only ever happens once, at the moment a slot was first available —
   see dispatch()).

   Root-cause fix (real production defect, 2026-07-28 — a validated plan's
   next step queued for 'pool_full' 15s after the PREVIOUS step's own
   mission.completed event, then never started again for 2+ hours): a
   mission's launchFn (agentsStore.tsx's wrapped runMission() call) does not
   settle until the ENTIRE run finishes, including work runtime.ts performs
   AFTER the mission already reached a terminal, user-visible status
   (review/done/failed/cancelled) — orchestrator sub-agent fan-out and the
   automated tester/reviewer/security/judge evaluation pipeline both run
   AFTER runMission's onUpdate(status:'review') patch and BEFORE its promise
   resolves. Holding this pool slot for that entire unrelated tail (which can
   be slow, or even hang forever on a stuck/orphaned sub-agent process) starved
   every OTHER mission waiting on the same pool, with nothing to recover it:
   this file deliberately has no background timer (see below), so a slot that
   never numerically frees again is stuck for good.
   Fix, in two additive parts:
     1. releaseMissionSlot(missionId) — an idempotent EARLY release agentsStore
        .tsx now calls the moment a mission's status first leaves 'running'
        (review/done/failed/cancelled), decoupled from launchFn's full
        settlement. Whichever of that call or launchNow's own eventual
        .finally() runs first performs the real decRunning+drain; the other
        is a guaranteed no-op (see _missionPool's doc comment).
     2. A periodic sweep (startPeriodicSweep) — a deliberate, narrow exception
        to "no background timer" below: a safety net so a missed
        settle/dispatch notification (or a genuinely stuck slot that a crash
        left uncounted — see agentsStore.tsx's own reconciliation loop, which
        pairs getRunningMissionIds() against real mission state) can never
        stall a queue forever in silence. Also surfaces `scheduler.stalled`
        (never silent — mirrors scheduler.throttled's existing pattern) once
        per queued entry that has waited past STALLED_QUEUE_WAIT_MS.
*/

import { invoke } from '@tauri-apps/api/core';
import { emitEvent } from '../journal/journal.js';
import type { Mission } from './types.js';
import { classifyMissionModel, type ModelRouteKind } from './runtime.js';
import { getProviderMode, type ProviderMode } from '../models/index.js';
import { loadAccessSettings, type ByokProvider } from '../models/accessSettings.js';
// Secret-storage hardening (audit 2026-08-12): BYOK keys now live in the OS
// credential vault on desktop (see byokProviders.ts's header comment), not
// always in localStorage — byokPool() below must read through the shared,
// vault-aware loadByokKey() rather than hitting `lazy.apikey.<provider>` in
// localStorage directly, or it would silently degrade to "one pool per
// provider" (hashing the provider name instead of the key) for every user
// who has migrated.
import { BYOK_PROVIDER_DEFS, loadByokKey } from '../models/byokProviders.js';
import { checkConflicts } from './preflight.js';
import { getRemoteOccupancySnapshot } from '../collab/remoteOccupancy.js';
import { isOverBudget, wouldExceedBudget, estimateMissionCostCents } from './budgetTracker.js';
import { isTauri } from '../platform/index.js';
import { getSystemPressure, subscribeSystemPressure, type PressureLevel } from './systemPressure.js';
import {
  defaultMaxParallelFromHardware,
  detectHardwareConcurrency,
  resolveGlobalMaxParallel,
} from './schedulerHardware.js';
// AgentsPanel.tsx (src/components/settings/AgentsPanel.tsx) remains the
// registry of record for every `lazy.agents.*` localStorage key, but as a
// .tsx component file it cannot be imported from tsconfig.cli.json's
// program (no --jsx support) — scheduler.ts is reachable from there via
// runtime.ts's dynamic `import('./scheduler.js')`. LS_AGENTS_MAX_PARALLEL
// therefore lives in agentSettingsKeys.ts, a plain .ts module that
// AgentsPanel.tsx itself re-exports for backward compatibility.
import { LS_AGENTS_MAX_PARALLEL } from './agentSettingsKeys.js';

// ── Pool identity ────────────────────────────────────────────────

/** localStorage key for per-pool cap overrides — optional JSON object, e.g.
 *  `{"claude-cli": 1, "byok:*": 2}`. Absent/invalid -> built-in defaults. */
export const LS_AGENTS_POOLS = 'lazy.agents.pools';

const DEFAULT_POOL_CAPS: Readonly<Record<string, number>> = {
  'claude-cli': 2,
  managed: 4,
  'byok:*': 4,
};

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;

/** Deterministic, non-cryptographic 32-bit hash (FNV-1a) as 8 hex chars —
 *  derives a stable pool id from a BYOK key's value so the raw secret never
 *  appears in a pool name or journal payload. Not a security boundary: a
 *  collision only merges two keys into one pool, it never leaks key material. */
function shortHash(input: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV-1a 32-bit prime
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Falls back to hashing the provider name itself when no key is configured
 *  yet, so this never throws and always returns a deterministic pool id. */
function byokPool(provider: ByokProvider): string {
  const key = loadByokKey(provider);
  return `byok:${shortHash(key || provider)}`;
}

/**
 * Which concurrency pool a mission's engine belongs to. Mirrors runtime.ts's
 * OWN dispatch logic (classifyMissionModel first, then the same
 * getProviderMode()-based fallback planAndAct uses) rather than re-inventing
 * engine selection. 'native' missions (no '/' in the model id) split further
 * by the CURRENT access mode, since classifyMissionModel cannot tell a
 * CLI-subscription id from a BYOK-direct-key id apart by shape alone.
 */
export function resolveProvider(mission: Mission): string {
  const chosenKind: ModelRouteKind | undefined = classifyMissionModel(mission.model);

  if (chosenKind === 'managed') return 'managed';
  if (chosenKind === 'native') return resolveNativePool();
  // A BYOK-catalog model whose provider key is set (deepseek-chat, grok-4,
  // …) runs on the user's OWN key — its pool is that key's, never the CLI
  // subscription's. Live repro (2026-09-02): this branch was missing, so a
  // deepseek-chat LazyBot fell through to resolveModePool → 'claude-cli'
  // and sat "pool_full" behind a CLI it never used.
  if (chosenKind === 'byok') return byokPool(byokProviderForModel(mission.model) ?? 'anthropic');

  // No classifiable model on this mission (legacy/low-level callers) — the
  // same mode-based fallback runtime.ts's planAndAct falls back to.
  return resolveModePool(getProviderMode());
}

/** The BYOK provider whose catalog lists `model` — the same catalog walk
 *  classifyMissionModel does to decide 'byok' in the first place. */
function byokProviderForModel(model: string | undefined): ByokProvider | undefined {
  if (!model) return undefined;
  for (const def of BYOK_PROVIDER_DEFS) {
    if (def.id === 'anthropic') continue;
    if (def.models.some((m) => m.id === model)) return def.id;
  }
  return undefined;
}

function resolveNativePool(): string {
  const settings = loadAccessSettings();
  if (settings.accessMode === 'byok') return byokPool(settings.byokProvider ?? 'anthropic');
  return 'claude-cli';
}

function resolveModePool(mode: ProviderMode): string {
  if (mode === 'managed') return 'managed';
  if (mode === 'claude-code' || mode === 'codex' || mode === 'devin') return 'claude-cli';
  if (mode === 'live-key') return byokPool(loadAccessSettings().byokProvider ?? 'anthropic');
  // 'pro' (selected but inactive) / 'mock' (no real engine at all) — no
  // engine will actually run this mission (see runtime.ts's
  // planAndActUnavailable / planAndActScripted), but dispatch() still needs
  // SOME bucket to count it against; the smallest default cap is the
  // conservative choice.
  return 'claude-cli';
}

// ── Pool caps ────────────────────────────────────────────────────

function loadPoolOverrides(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LS_AGENTS_POOLS);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) result[key] = Math.floor(n);
    }
    return result;
  } catch {
    return {};
  }
}

function poolCap(pool: string): number {
  const overrides = loadPoolOverrides();
  if (overrides[pool] !== undefined) return overrides[pool];
  if (pool.startsWith('byok:')) return overrides['byok:*'] ?? DEFAULT_POOL_CAPS['byok:*'];
  return DEFAULT_POOL_CAPS[pool] ?? DEFAULT_POOL_CAPS['byok:*'];
}

/** Empty/absent → hardware 3–8 (same default the settings panel shows).
 *  User-saved positive ints win. Explicit 0 / invalid → unlimited. */
function globalCap(): number {
  try {
    return resolveGlobalMaxParallel(localStorage.getItem(LS_AGENTS_MAX_PARALLEL));
  } catch {
    return defaultMaxParallelFromHardware(detectHardwareConcurrency());
  }
}

/**
 * Machine-pressure-adjusted view of globalCap() (founder north star: the
 * app adapts automatically, the user never manually unblocks anything).
 * 'high' admits NO new launches at all — the effective cap is pinned to
 * whatever is CURRENTLY running, so canLaunch's `totalRunning() >= cap` is
 * always true. 'elevated' halves the configured cap (floored, minimum 1 so
 * a configured cap of 1 is never fully starved). 'normal' — or an older
 * Rust build that never reports pressure at all, see systemPressure.ts's
 * own graceful-degradation contract — leaves globalCap() completely
 * untouched, i.e. today's exact behavior.
 */
function pressureAdjustedGlobalCap(): number {
  const configured = globalCap();
  const level = getSystemPressure().level;
  if (level === 'high') return totalRunning();
  if (level === 'elevated') return Math.max(1, Math.floor(configured / 2));
  return configured;
}

// ── Module state ─────────────────────────────────────────────────

interface QueuedEntry {
  mission: Mission;
  pool: string;
  launchFn: () => Promise<void>;
  priority: number;
  /** Monotonic tie-breaker (replaces missionQueue.ts's enqueuedAt-string
   *  comparison — a plain counter can never collide within one session). */
  seq: number;
  /** Set ONLY when this entry was queued for a scope conflict (T1.6) rather
   *  than a full pool — ids of the running missions it overlaps. Entry
   *  stays ineligible (see conflictsResolved) until every one of these ids
   *  has left _runningMissionIds. Absent for ordinary pool_full entries,
   *  which conflictsResolved always treats as immediately eligible. */
  conflictsWith?: string[];
  /** Set ONLY when this entry was queued because a budget gate
   *  (isOverBudget / wouldExceedBudget) refused the launch, rather than a
   *  full pool or a scope conflict. The entry must stay queued until the
   *  budget is explicitly released or increased — drain() re-checks the
   *  gate (see budgetResolved) before launching, so a later dispatch()
   *  call cannot launch it just because a pool/global slot is numerically
   *  free. Absent for ordinary pool_full and scope_conflict entries, which
   *  budgetResolved always treats as immediately eligible. */
  budgetBlocked?: boolean;
  /** projectId threaded through from dispatch() so a budgetBlocked entry
   *  can re-run isOverBudget/wouldExceedBudget in budgetResolved without
   *  re-deriving it. */
  projectId?: string;
  /** Estimated cost (cents) captured at queue time so a budgetBlocked entry
   *  can re-run wouldExceedBudget in budgetResolved identically. */
  estimatedCostCents?: number;
  /** Wall-clock time this entry was enqueued — the basis for
   *  emitStalledSignals' wait-time check and missionQueueWait's reported
   *  waitedMs (root-cause fix's "never silent" requirement). */
  queuedAtMs: number;
}

interface BackoffEntry {
  untilMs: number;
  windowMs: number;
}

let _running = new Map<string, number>();
let _queue: QueuedEntry[] = [];
let _backoff = new Map<string, BackoffEntry>();
let _seq = 0;
/** Mission ids currently occupying a launched slot, regardless of pool —
 *  see this file's header ("Conflict pre-flight") for why this exists
 *  alongside _running's per-pool counts. */
let _runningMissionIds = new Set<string>();
/** missionId -> pool, for every mission id in _runningMissionIds — lets
 *  releaseMissionSlot (the root-cause fix's early, idempotent release, see
 *  this file's header) look up which pool's count to decrement without
 *  waiting for launchFn's promise to settle. An id present here means "not
 *  yet released"; releaseMissionSlot deletes it as the FIRST thing it does,
 *  so whichever of {agentsStore.tsx's early call, launchNow's own eventual
 *  .finally()} runs first performs the real release — the other reads a
 *  missing entry and is a guaranteed no-op. */
let _missionPool = new Map<string, string>();
/** Mission ids emitStalledSignals has already emitted a `scheduler.stalled`
 *  event for — same one-shot-per-condition idea as
 *  _lastThrottledLevelEmitted below, just keyed per mission instead of per
 *  pressure level. Cleared when the entry leaves the queue (drained or
 *  otherwise removed) so a LATER re-queue of the same mission id can signal
 *  again fresh. */
let _stalledEmitted = new Set<string>();
/** The lazily-started safety-net interval — see startPeriodicSweep. */
let _sweepTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Count of launchFn promises genuinely still in flight — deliberately
 * SEPARATE from _running's per-pool counts (which releaseMissionSlot frees
 * EARLY, see this file's header). notifyMissionsActive gates the Rust
 * brain-consolidator (maintenance.rs's MissionsActiveState) against
 * competing for disk I/O with an agent that's still doing REAL work —
 * runtime.ts's post-'review' orchestrator fan-out and tester/reviewer/
 * security/judge evaluation both still spawn real OS processes (via direct
 * agent_run invokes, outside this scheduler's own accounting) even after a
 * mission's pool slot has been released early. Tracking this separately
 * means the early-release fix changes ONLY scheduling (when the NEXT
 * mission gets to launch), never this safety signal (which still reflects
 * launchFn's true, full settlement, exactly like before the fix). */
let _liveLaunchCount = 0;

/** Founder north star: adaptation must be TOLD, not silent — see the
 *  scheduler.throttled emission in handlePressureSnapshot below. Tracks the
 *  last non-'normal' level a `scheduler.throttled` event was already
 *  emitted for, so a level that STAYS elevated/high never re-emits on every
 *  subsequent pressure tick, only the first time it trips (or trips to a
 *  MORE severe level). Reset back to 'normal' once pressure clears, so a
 *  LATER re-trip emits again. */
let _lastThrottledLevelEmitted: PressureLevel = 'normal';
/** Unsubscribe for the (lazily, once) registered systemPressure.ts watch —
 *  see ensurePressureWatch. */
let _pressureWatchUnsub: (() => void) | null = null;

/** Test-only reset — mirrors seedProgressStore.ts's resetSeedProgressForTests. */
export function resetSchedulerForTests(): void {
  _running = new Map();
  _queue = [];
  _backoff = new Map();
  _seq = 0;
  _runningMissionIds = new Set();
  _missionPool = new Map();
  _stalledEmitted = new Set();
  _liveLaunchCount = 0;
  _lastThrottledLevelEmitted = 'normal';
  if (_pressureWatchUnsub) {
    _pressureWatchUnsub();
    _pressureWatchUnsub = null;
  }
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
}

function runningCount(pool: string): number {
  return _running.get(pool) ?? 0;
}

function totalRunning(): number {
  let sum = 0;
  for (const n of _running.values()) sum += n;
  return sum;
}

/**
 * Best-effort, resilient to an older Rust build without this command —
 * never awaited by callers, never blocks a launch/settle on its result.
 * Outside a real Tauri app (web/harness/tests) this is a pure no-op: there
 * is nothing to tell and no process to protect.
 */
function notifyMissionsActive(active: boolean): void {
  if (!isTauri()) return;
  invoke('set_missions_active', { active }).catch(() => {
    // Command may not exist yet (older Rust build) — see this function's
    // own doc comment; never worse than not calling it at all.
  });
}

function incRunning(pool: string): void {
  _running.set(pool, runningCount(pool) + 1);
}

function decRunning(pool: string): void {
  const next = runningCount(pool) - 1;
  if (next <= 0) _running.delete(pool);
  else _running.set(pool, next);
}

function isBackedOff(pool: string): boolean {
  const b = _backoff.get(pool);
  return b !== undefined && b.untilMs > Date.now();
}

function clearBackoff(pool: string): void {
  _backoff.delete(pool);
}

/** Agent ≠ LazyBot: the pressure adjustment exists because a local code
 *  agent spawns a CLI process, a git worktree, tests — real load on THIS
 *  machine. A LazyBot mission (`botId`) is a Solari cloud computer driven by
 *  a few HTTP calls from the WebView; local CPU/RAM pressure says nothing
 *  about whether it can run. Live repro (2026-09-02): pressure 'high' from
 *  an unrelated brain-indexing process pinned the cap to totalRunning()
 *  and a deepseek-chat LazyBot sat "pool_full" with nothing running at all.
 *  Bots still honor the CONFIGURED global cap, their pool cap and backoff
 *  (rate limits on the brain's API are real). */
function isCloudOnlyMission(mission: Mission): boolean {
  return typeof mission.botId === 'string' && mission.botId.length > 0;
}

function canLaunch(pool: string, mission: Mission): boolean {
  if (isBackedOff(pool)) return false;
  const cap = isCloudOnlyMission(mission) ? globalCap() : pressureAdjustedGlobalCap();
  if (totalRunning() >= cap) return false;
  return runningCount(pool) < poolCap(pool);
}

// ── System pressure watch (founder north star: tell the user, don't stay
// silent) ──────────────────────────────────────────────────────────────

function handlePressureSnapshot(snapshot: { level: PressureLevel }): void {
  if (snapshot.level !== 'normal' && snapshot.level !== _lastThrottledLevelEmitted) {
    emitEvent({
      type: 'scheduler.throttled',
      tsMs: Date.now(),
      projectId: 'unknown',
      actor: 'system',
      payload: { level: snapshot.level },
    });
  }
  _lastThrottledLevelEmitted = snapshot.level;
}

/**
 * Lazy, idempotent — mirrors this file's own "no background timer, only
 * react to what's already happening" posture (see this file's header):
 * registers ONE subscription to systemPressure.ts's shared store the first
 * time dispatch() ever runs, rather than at module load, so a session that
 * never launches a single mission never subscribes to anything at all.
 */
function ensurePressureWatch(): void {
  if (_pressureWatchUnsub) return;
  _pressureWatchUnsub = subscribeSystemPressure(handlePressureSnapshot);
}

// ── Backoff ──────────────────────────────────────────────────────

/** Message-shape check for a 429/rate-limit/overloaded failure — mirrors
 *  useAuth.ts's identical `/rate limit/i.test(error.message)` convention. */
function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /429|rate limit|overloaded/i.test(message);
}

/**
 * Pauses `pool` for an exponential backoff window: 30s the first time, then
 * doubling on each further call before the pool sees a success, capped at
 * 10min. A pool's own success (see launchNow) clears this entirely, so the
 * NEXT failure after a success starts fresh at the base rather than
 * escalating from an old streak. Exported (not just called internally by
 * launchNow) so a launchFn that swallows its own rejection can still report
 * a rate-limit signal it detected some other way.
 */
export function reportRateLimit(pool: string): void {
  const prev = _backoff.get(pool);
  const windowMs = prev ? Math.min(prev.windowMs * 2, BACKOFF_MAX_MS) : BACKOFF_BASE_MS;
  _backoff.set(pool, { untilMs: Date.now() + windowMs, windowMs });
}

/** Fallback backoff window when a quota-exhaustion condition (see
 *  quotaExhaustion.ts) carried no parseable reset time — deliberately long
 *  and conservative (well past reportRateLimit's own 10min ceiling) rather
 *  than guessing a shorter one: an unparsed reset time means the app
 *  genuinely does not know when the CLI's own quota wall clears, so backing
 *  off for LESS time would risk the exact pointless-retry storm this exists
 *  to prevent. */
const QUOTA_EXHAUSTED_FALLBACK_MS = 30 * 60_000;

/**
 * Real incident fix (2026-08-19, session-limit overnight loss) — pauses
 * `pool` until an ABSOLUTE clock time (`untilMs`) rather than
 * reportRateLimit's exponential window: the Claude CLI's own subscription/
 * session quota wall clears at a KNOWN moment (the reset time it reports),
 * not by retrying sooner and sooner. Overwrites any exponential backoff
 * already in place for this pool — a quota wall is a harder, longer stop
 * than an ordinary transient 429.
 *
 * This is what stops the OTHER half of the real incident: recovery.ts's
 * quotaExhaustionPolicy already stops the ONE mission that hit the wall from
 * retrying itself, but every OTHER mission still queued behind the same
 * pool (e.g. the remaining steps of a multi-mission plan, still waiting for
 * a free slot) would otherwise be dispatched straight into the identical
 * wall the moment a slot frees — exactly what happened to M68-M74 overnight.
 * Backing off the whole pool means drain()/canLaunch() simply will not
 * admit ANY mission on this pool again until the reset time (or the
 * conservative fallback below, when no reset time was parseable) has
 * passed — those missions stay safely queued, not failed, not dropped.
 *
 * `untilMs` absent, in the past, or otherwise unusable falls back to
 * QUOTA_EXHAUSTED_FALLBACK_MS from now — never a shorter, optimistic guess.
 */
export function reportQuotaExhausted(pool: string, untilMs?: number): void {
  const now = Date.now();
  const resolvedUntilMs = untilMs !== undefined && untilMs > now ? untilMs : now + QUOTA_EXHAUSTED_FALLBACK_MS;
  _backoff.set(pool, { untilMs: resolvedUntilMs, windowMs: resolvedUntilMs - now });
}

// ── Queue + dispatch ─────────────────────────────────────────────

export interface SchedulerDispatchOptions {
  /** Journal envelope projectId for `scheduler.queued`. Falls back to
   *  'unknown' when omitted — never blocks/throws. */
  projectId?: string;
  /** FIFO tie-breaker weight — higher drains first within the same pool.
   *  Mirrors missionQueue.ts's QueuedMission priority semantics (default 0). */
  priority?: number;
  /**
   * Conflict pre-flight input (T1.6, spec §7.2) — optional and additive.
   * When present, dispatch() checks `mission`'s predicted scope
   * (preflight.ts) against `runningMissions` before launching; a scope
   * overlap queues the mission instead (reason 'scope_conflict'). Absent
   * (the default) skips the check entirely — dispatch()'s behavior is then
   * IDENTICAL to before T1.6.
   */
  scopeInfo?: {
    /** The caller's current snapshot of running missions — see this file's
     *  header for why the scheduler needs this threaded in rather than
     *  tracking it itself. */
    runningMissions: readonly Mission[];
  };
  /**
   * User override (spec §7.2's "warn-and-launch" choice): launch even if
   * checkConflicts finds an overlap, instead of auto-queueing behind it.
   * No effect when `scopeInfo` is absent (nothing was checked to override).
   */
  overrideConflicts?: boolean;
}

function launchNow(pool: string, launchFn: () => Promise<void>, missionId?: string): void {
  incRunning(pool);
  if (missionId) {
    _runningMissionIds.add(missionId);
    _missionPool.set(missionId, pool);
  }
  // _liveLaunchCount (never affected by an early releaseMissionSlot call —
  // see its own doc comment) tracks launchFn's TRUE lifecycle, so
  // notifyMissionsActive keeps its original, full-lifecycle-accurate
  // semantics for the Rust brain-consolidator gate.
  if (_liveLaunchCount === 0) notifyMissionsActive(true);
  _liveLaunchCount += 1;
  let result: Promise<void>;
  try {
    result = launchFn();
  } catch (err) {
    // A launchFn that throws synchronously is normalized into the same
    // rejection path as one that returns a rejected promise.
    result = Promise.reject(err);
  }
  result
    .then(() => {
      clearBackoff(pool);
    })
    .catch((err: unknown) => {
      if (isRateLimitError(err)) reportRateLimit(pool);
    })
    .finally(() => {
      // Root-cause fix: when missionId is known, route the release through
      // releaseMissionSlot's idempotent path — agentsStore.tsx may already
      // have released this SAME slot early (the moment the mission's status
      // left 'running', well before launchFn's promise — which awaits
      // runtime.ts's post-completion fan-out/evaluation tail — actually
      // settles). If so, _missionPool no longer has this id and the call
      // below is a guaranteed no-op; nothing here double-decrements. Absent
      // a missionId (older/direct call sites with nothing to key an early
      // release on), fall back to the original unconditional release.
      if (missionId) {
        releaseMissionSlot(missionId);
      } else {
        decRunning(pool);
        drain();
      }
      _liveLaunchCount -= 1;
      if (_liveLaunchCount === 0) notifyMissionsActive(false);
    });
}

/**
 * Frees `missionId`'s scheduler pool slot immediately and re-drains the
 * queue — idempotent: a no-op if the slot was already released, whether by
 * an earlier call to this same function or by launchNow's own .finally()
 * running first. See this file's header ("Root-cause fix") for why an EARLY
 * release (called from agentsStore.tsx the moment a mission's status first
 * leaves 'running') matters: launchFn's promise does not settle until
 * runtime.ts's entire post-completion tail (orchestrator fan-out,
 * tester/reviewer/security/judge evaluation) finishes too, which can be
 * slow or, on a stuck sub-agent, never finish at all — starving this pool
 * for every OTHER mission with nothing to do with that tail work.
 *
 * Also the release primitive agentsStore.tsx's reconciliation loop uses (see
 * getRunningMissionIds) to correct the reverse leak: a mission this
 * scheduler still counts as running but that the app's own mission list
 * already shows terminal (done/failed/cancelled) or gone entirely — e.g.
 * after a crash that never let launchFn's promise settle at all.
 */
export function releaseMissionSlot(missionId: string): void {
  const pool = _missionPool.get(missionId);
  if (pool === undefined) return; // already released — safe no-op
  _missionPool.delete(missionId);
  _runningMissionIds.delete(missionId);
  decRunning(pool);
  drain();
}

/** Snapshot of every mission id this scheduler currently believes occupies a
 *  launched slot — the reconciliation input agentsStore.tsx's periodic loop
 *  compares against its own authoritative mission list (see
 *  releaseMissionSlot's doc comment, "reverse leak"). A plain array copy:
 *  callers must never mutate scheduler internals directly. */
export function getRunningMissionIds(): string[] {
  return Array.from(_runningMissionIds);
}

/** True once none of a scope-conflict-queued entry's blocking mission ids
 *  are still running — i.e. "the conflicting mission settled". Entries
 *  without `conflictsWith` (every ordinary pool_full entry, and every
 *  entry from before T1.6) are always eligible here, so this is a pure
 *  no-op addition to pickNextIndex's existing filter. */
function conflictsResolved(entry: QueuedEntry): boolean {
  if (!entry.conflictsWith || entry.conflictsWith.length === 0) return true;
  return !entry.conflictsWith.some((id) => _runningMissionIds.has(id));
}

/** True when a budgetBlocked entry's budget gate has cleared (the budget
 *  was explicitly released or increased) — re-runs the SAME isOverBudget /
 *  wouldExceedBudget checks dispatch() used to queue it, so a later
 *  dispatch()/drain() cannot launch it just because a pool/global slot is
 *  numerically free. Entries without budgetBlocked are always eligible
 *  here, so this is a pure no-op addition to pickNextIndex's existing
 *  filter. */
function budgetResolved(entry: QueuedEntry): boolean {
  if (!entry.budgetBlocked) return true;
  const projectId = entry.projectId ?? 'unknown';
  if (isOverBudget(entry.mission.id, projectId)) return false;
  const estimatedCost = entry.estimatedCostCents ?? estimateMissionCostCents(entry.mission.model ?? '', 10);
  if (wouldExceedBudget(entry.mission.id, projectId, estimatedCost)) return false;
  return true;
}

/** Index of the highest-priority, earliest-enqueued eligible entry, or -1
 *  when every candidate's pool is at cap, backed off, still scope-conflicted,
 *  budget-blocked, or the global cap is saturated. Mirrors missionQueue.ts's
 *  dequeue() comparator (`priority desc, enqueuedAt asc`), using an
 *  incrementing `seq` for a stable tie-break. */
function pickNextIndex(): number {
  let bestIdx = -1;
  for (let i = 0; i < _queue.length; i += 1) {
    const entry = _queue[i];
    if (!canLaunch(entry.pool, entry.mission)) continue;
    if (!conflictsResolved(entry)) continue;
    if (!budgetResolved(entry)) continue;
    if (bestIdx === -1) {
      bestIdx = i;
      continue;
    }
    const best = _queue[bestIdx];
    if (entry.priority > best.priority || (entry.priority === best.priority && entry.seq < best.seq)) {
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Launches every currently-eligible queued entry, across all pools, until
 *  none remain. Called opportunistically after a mission settles and at the
 *  top of every dispatch() call, and — as a pure safety net, see this file's
 *  header — on the periodic sweep tick too. */
function drain(): void {
  for (;;) {
    const idx = pickNextIndex();
    if (idx === -1) return;
    const entry = _queue[idx];
    _queue = _queue.filter((_, i) => i !== idx);
    // This entry is no longer queued — a LATER re-queue of the same mission
    // id (e.g. a user retry) must be free to signal `scheduler.stalled`
    // again fresh rather than staying permanently suppressed.
    _stalledEmitted.delete(entry.mission.id);
    launchNow(entry.pool, entry.launchFn, entry.mission.id);
  }
}

function enqueue(
  mission: Mission,
  pool: string,
  launchFn: () => Promise<void>,
  priority: number,
  projectId: string,
  conflictsWith?: string[],
  budgetBlocked?: boolean,
  estimatedCostCents?: number,
): void {
  const entry: QueuedEntry = {
    mission,
    pool,
    launchFn,
    priority,
    seq: _seq,
    conflictsWith,
    budgetBlocked,
    projectId,
    estimatedCostCents,
    queuedAtMs: Date.now(),
  };
  _seq += 1;
  _queue = [..._queue, entry];

  const depth = _queue.filter((e) => e.pool === pool).length;
  const isConflict = conflictsWith !== undefined && conflictsWith.length > 0;
  const reason = isConflict ? 'scope_conflict' : budgetBlocked ? 'budget_blocked' : 'pool_full';
  emitEvent({
    type: 'scheduler.queued',
    tsMs: Date.now(),
    projectId,
    missionId: mission.id,
    actor: 'system',
    payload: isConflict
      ? { reason: 'scope_conflict', pool, depth, conflictsWith }
      : { reason, pool, depth },
  });
}

// ── Visibility + safety-net sweep ("never silent") ────────────────

/** How often the periodic safety-net sweep runs — see startPeriodicSweep. */
const SWEEP_INTERVAL_MS = 15_000;

/** Wait threshold past which a still-queued entry is honest enough to
 *  surface as a `scheduler.stalled` signal rather than staying invisible.
 *  Chosen well above a legitimate short wait behind a busy-but-healthy pool
 *  (seconds to low minutes), but short enough that a genuinely stuck queue
 *  (the real-world defect this fixes: a mission queued for OVER TWO HOURS
 *  with zero signal) is told to the user promptly rather than eventually. */
const STALLED_QUEUE_WAIT_MS = 3 * 60_000;

export interface QueueWaitInfo {
  pool: string;
  reason: 'pool_full' | 'scope_conflict' | 'budget_blocked';
  /** When this entry was enqueued (Date.now()-style epoch ms). */
  queuedAtMs: number;
  /** Date.now() - queuedAtMs, computed at call time. */
  waitedMs: number;
}

/** True when `missionId` currently has a live entry in the scheduler's
 *  wait queue (pool_full / scope_conflict / backed-off pool) — i.e. the
 *  mission is LEGITIMATELY waiting for a concurrency slot, not stalled.
 *  Lets agentsStore's own queued-launch watchdog (armQueuedLaunchWatchdog)
 *  distinguish "waiting for a free slot" from "stuck before dispatch": a
 *  graph with more parallel nodes than the pool/global caps can keep a
 *  mission queued for well past the watchdog's 45s window, and flagging
 *  that as `launch_stalled` is a false alarm — the scheduler's OWN
 *  periodic sweep (emitStalledSignals, STALLED_QUEUE_WAIT_MS = 3min) is
 *  the honest signal for a queue that is genuinely stuck. */
export function isMissionSchedulerQueued(missionId: string): boolean {
  return _queue.some((entry) => entry.mission.id === missionId);
}

/** "Why is this mission waiting, and since when?" (root-cause fix's
 *  visibility requirement) — looks up `missionId`'s current queue entry, if
 *  any. undefined when the mission isn't (or is no longer) queued. */
export function missionQueueWait(missionId: string): QueueWaitInfo | undefined {
  const entry = _queue.find((e) => e.mission.id === missionId);
  if (!entry) return undefined;
  const isConflict = entry.conflictsWith !== undefined && entry.conflictsWith.length > 0;
  const reason = isConflict ? 'scope_conflict' : entry.budgetBlocked ? 'budget_blocked' : 'pool_full';
  return {
    pool: entry.pool,
    reason,
    queuedAtMs: entry.queuedAtMs,
    waitedMs: Date.now() - entry.queuedAtMs,
  };
}

/** Emits ONE `scheduler.stalled` event per queued entry the first time its
 *  wait crosses STALLED_QUEUE_WAIT_MS — never silent, mirrors
 *  handlePressureSnapshot's existing one-shot-per-condition pattern below.
 *  Never re-emits for the same still-queued entry (see _stalledEmitted);
 *  drain() clears the guard once the entry actually leaves the queue, so a
 *  future re-queue of the same mission id can signal again. */
function emitStalledSignals(): void {
  const now = Date.now();
  for (const entry of _queue) {
    if (_stalledEmitted.has(entry.mission.id)) continue;
    const waitedMs = now - entry.queuedAtMs;
    if (waitedMs < STALLED_QUEUE_WAIT_MS) continue;
    _stalledEmitted.add(entry.mission.id);
    const isConflict = entry.conflictsWith !== undefined && entry.conflictsWith.length > 0;
    const reason = isConflict ? 'scope_conflict' : entry.budgetBlocked ? 'budget_blocked' : 'pool_full';
    emitEvent({
      type: 'scheduler.stalled',
      tsMs: now,
      projectId: 'unknown',
      missionId: entry.mission.id,
      actor: 'system',
      payload: {
        pool: entry.pool,
        reason,
        waitedMs,
      },
    });
  }
}

/**
 * Lazy, idempotent — mirrors ensurePressureWatch's own "register once, on
 * first real use" posture. A deliberate, narrow exception to this file's
 * otherwise event-driven design (see the header's root-cause fix note): a
 * low-frequency safety net that (1) re-drains the queue in case a settle or
 * dispatch() notification was ever missed and (2) surfaces a queue that has
 * been stuck for a while instead of leaving it silent. Never the primary
 * drain mechanism — dispatch()'s own eager drain() call still handles the
 * overwhelming majority of cases immediately, this only covers the gap.
 */
function startPeriodicSweep(): void {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    drain();
    emitStalledSignals();
  }, SWEEP_INTERVAL_MS);
}

/**
 * Launches `mission` now if its pool (resolveProvider) AND the global cap
 * both have a free slot AND (when opts.scopeInfo is given) it has no scope
 * conflict with a currently running mission; otherwise queues it (FIFO
 * within priority) and emits `scheduler.queued`. Never throws: a launchFn
 * rejection is observed internally (for backoff detection), same
 * fire-and-forget contract the existing launch call sites already have.
 *
 * Runs a drain() pass FIRST — every dispatch() call doubles as a mechanism
 * that notices an expired backoff window or a slot freed elsewhere;
 * startPeriodicSweep (below) is only the safety net for when NO dispatch()
 * call happens to trigger this for a while.
 */
export async function dispatch(
  mission: Mission,
  launchFn: () => Promise<void>,
  opts: SchedulerDispatchOptions = {},
): Promise<void> {
  ensurePressureWatch();
  startPeriodicSweep();
  drain();
  const pool = resolveProvider(mission);

  // Budget gate (Pillar A3): refuse launch when over budget or when the
  // estimated cost would push any budget over its limit. The mission is
  // queued (not dropped) so a later budget increase can still drain it.
  const projectId = opts.projectId ?? 'unknown';
  if (isOverBudget(mission.id, projectId)) {
    enqueue(mission, pool, launchFn, opts.priority ?? 0, projectId, undefined, true);
    return;
  }
  const estimatedCost = estimateMissionCostCents(mission.model ?? '', 10);
  if (wouldExceedBudget(mission.id, projectId, estimatedCost)) {
    enqueue(mission, pool, launchFn, opts.priority ?? 0, projectId, undefined, true, estimatedCost);
    return;
  }

  if (canLaunch(pool, mission)) {
    if (opts.scopeInfo && !opts.overrideConflicts) {
      const { conflictsWith } = await checkConflicts(
        mission,
        opts.scopeInfo.runningMissions,
        getRemoteOccupancySnapshot(),
      );
      if (conflictsWith.length > 0) {
        enqueue(mission, pool, launchFn, opts.priority ?? 0, opts.projectId ?? 'unknown', conflictsWith);
        return;
      }
      // The conflict check above awaited a journal query — re-verify the
      // slot is still free rather than trusting the check from before that
      // await (another dispatch()/settle may have filled it meanwhile).
      if (!canLaunch(pool, mission)) {
        enqueue(mission, pool, launchFn, opts.priority ?? 0, opts.projectId ?? 'unknown');
        return;
      }
    }
    launchNow(pool, launchFn, mission.id);
    return;
  }

  enqueue(mission, pool, launchFn, opts.priority ?? 0, opts.projectId ?? 'unknown');
}

// ── Pool status (for future UI, W2) ───────────────────────────────

export interface PoolStatusEntry {
  pool: string;
  running: number;
  cap: number;
  queued: number;
  backoffUntilMs?: number;
  /** How long the OLDEST queued entry in this pool has been waiting, in ms
   *  — "never silent" visibility (root-cause fix). Absent when `queued` is
   *  0. */
  oldestQueuedWaitMs?: number;
}

/** Snapshot of every pool with activity (running, queued, or backed off) —
 *  an idle pool is simply absent, not listed at 0/0. */
export function poolStatus(): PoolStatusEntry[] {
  const pools = new Set<string>();
  for (const p of _running.keys()) pools.add(p);
  for (const e of _queue) pools.add(e.pool);
  for (const p of _backoff.keys()) pools.add(p);

  const now = Date.now();
  return Array.from(pools)
    .sort()
    .map((pool) => {
      const backoff = _backoff.get(pool);
      const queuedEntries = _queue.filter((e) => e.pool === pool);
      const entry: PoolStatusEntry = {
        pool,
        running: runningCount(pool),
        cap: poolCap(pool),
        queued: queuedEntries.length,
      };
      if (backoff && backoff.untilMs > Date.now()) entry.backoffUntilMs = backoff.untilMs;
      if (queuedEntries.length > 0) {
        const oldestQueuedAtMs = Math.min(...queuedEntries.map((e) => e.queuedAtMs));
        entry.oldestQueuedWaitMs = now - oldestQueuedAtMs;
      }
      return entry;
    });
}
