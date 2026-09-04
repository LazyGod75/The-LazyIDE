/* journal.ts — the ONLY journal API the rest of the frontend may use.

   Wraps the Rust-owned event journal (spec §4: single append-only SQLite
   table, global across projects). Two write paths:
     - emitEvent(): immediate, one invoke per event. Use for events a view
       needs to react to right away.
     - emitBuffered(): coalesces high-frequency events (tool.called,
       mission.step, spend.tokens, loop.tick, ...) into one batched invoke
       every 500ms, so a chatty agent run doesn't turn into an IPC storm.
       Terminal events (a mission reaching a final state, or a budget hard
       stop) flush immediately instead of waiting out the window, since the
       cockpit's Inbox/kanban must reflect those the moment they happen.

   Fail-safe by construction (spec's "journal-truth" principle must never
   become "journal crashes the app"): every invoke is wrapped in try/catch
   and logged via console.warn, never thrown to the caller. The buffered
   path additionally trips a circuit breaker after 5 consecutive flush
   failures — at that point further buffered events are dropped on arrival
   (no more invoke attempts, no more warnings) rather than retried forever
   against a backend that is clearly down. This mirrors the "queue must
   never break the app" contract already established by
   ../brain/captureQueue.ts. Neither write path retries a dropped event —
   a dropped `tool.called` event only costs a KPI/feed row, not user data,
   so the journal stays a best-effort projection sink, not a durable
   offline outbox.

   journalQuery has its own resilience layer, independent from the write
   paths above: a module-level failure-streak backoff shared by every
   caller/poller (managerWakeup.ts, loopScheduler.ts, nightShift.ts,
   useZoneDigest.ts, ...). REAL INCIDENT (2026-08-05): while the SQLite
   backend was held by long builds, journal_query_events started
   failing/timing out, and each poller kept calling journalQuery on its own
   interval regardless — dozens of "[journal] journalQuery failed:"
   warnings fired in a row while every poller kept hammering an already-
   saturated backend. Now, after one real failure, further calls
   short-circuit to the same benign [] the try/catch already returns,
   WITHOUT attempting invoke, for a cooldown window starting at 5s and
   doubling per consecutive failure up to a 120s cap; a success resets the
   streak. See "Module state (query backoff)" and journalQuery's own doc
   comment below for the exact contract.

   Argument-shape convention (matches the rest of src/lib/platform/tauri.ts):
   a whole structured record is nested under one key (e.g. nativeBrain's
   `invoke('brain_capture', { payload: event })`); independent scalar/filter
   fields are flattened as individual top-level keys (e.g. nativeBrain's
   `invoke('brain_seed', { sources, useLlm, since })`). journal_emit/
   journal_emit_batch follow the first pattern (event/events are single
   cohesive rows); journal_query_events follows the second (filter is a set
   of independent optional filters).
*/

import { invoke } from '@tauri-apps/api/core';
import { withTimeout } from '../models/brainSearchLoop.js';
import type {
  JournalEventInput,
  JournalEventRow,
  JournalEventWireRow,
  JournalQueryFilter,
} from './eventTypes.js';

// ── Config ────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 500;
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Ceiling for a single journal invoke (emit/emit_batch/query_events) — root
 * cause proven via instrumented run: under the same backend contention
 * window that makes get_project_root time out (see NewMissionModal.tsx),
 * these invokes had NO timeout at all and hung forever (no DB row, no catch,
 * no warn), going dark instead of degrading. withTimeout (brainSearchLoop.ts)
 * turns that hang into an ordinary rejection so it flows into the existing
 * catch/circuit-breaker paths below unchanged.
 */
const JOURNAL_INVOKE_TIMEOUT_MS = 15_000;

/**
 * journalQuery failure-streak backoff (see file header's "REAL INCIDENT").
 * First consecutive real failure opens a QUERY_BACKOFF_BASE_MS cooldown;
 * each additional consecutive failure doubles it, up to QUERY_BACKOFF_MAX_MS.
 */
const QUERY_BACKOFF_BASE_MS = 5_000;
const QUERY_BACKOFF_MAX_MS = 120_000;

/**
 * Event types that flush the buffer immediately instead of waiting for the
 * 500ms window — a mission reaching a final state, or a hard budget stop,
 * must be visible to the cockpit right away.
 */
const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  'mission.completed',
  'mission.failed',
  'mission.cancelled',
  'mission.approved',
  'mission.reverted',
  'budget.exceeded',
  'merge.conflicted',
  'merge.noop_already_merged',
]);

function isTerminal(type: string): boolean {
  return TERMINAL_TYPES.has(type);
}

// ── Module state (buffered path) ─────────────────────────────────
// Reassigned wholesale on every change rather than pushed/mutated in place
// (immutable-data, mutable-reference — the array itself is never mutated).

let _buffer: JournalEventInput[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _consecutiveFailures = 0;
let _circuitOpen = false;

// ── Module state (query backoff) ─────────────────────────────────
// Same "module-level, shared by every caller" shape as the buffered path's
// circuit breaker above, but for journalQuery — see file header and
// journalQuery's own doc comment for the exact short-circuit contract.

let _queryFailureStreak = 0;
let _queryCooldownUntilMs = 0;

// ── Serialization (camelCase TS -> snake_case Rust wire contract) ────

/**
 * Maps a JournalEventInput onto the exact `events` table column shape
 * (spec §4.1). For spend.tokens, tokensIn/tokensOut/costUsd are ALSO
 * copied onto the top-level tokens_in/tokens_out/cost_usd columns so
 * SUM() projections (KPI bar, budgets) never need to parse payload JSON.
 */
export function serializeEvent(e: JournalEventInput): JournalEventWireRow {
  const base: JournalEventWireRow = {
    ts_ms: e.tsMs,
    project_id: e.projectId,
    mission_id: e.missionId ?? null,
    agent_id: e.agentId ?? null,
    run_id: e.runId ?? null,
    actor: e.actor,
    type: e.type,
    payload: JSON.stringify(e.payload),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };

  if (e.type === 'spend.tokens') {
    return {
      ...base,
      tokens_in: e.payload.tokensIn,
      tokens_out: e.payload.tokensOut,
      cost_usd: e.payload.costUsd,
    };
  }

  return base;
}

// ── Immediate emit ────────────────────────────────────────────────

/**
 * Emit one event immediately. Never throws — a failed emit is logged and
 * dropped, since the journal must never be able to break the caller's flow
 * (spec's "journal-truth" principle is about read-side honesty, not an
 * excuse to crash the app on a transient IPC failure).
 */
export async function emitEvent(e: JournalEventInput): Promise<void> {
  try {
    await withTimeout(
      invoke('journal_emit', { event: serializeEvent(e) }),
      JOURNAL_INVOKE_TIMEOUT_MS,
      'journal_emit',
    );
  } catch (err: unknown) {
    console.warn('[journal] emitEvent failed:', err);
  }
}

// ── Buffered emit ─────────────────────────────────────────────────

function clearScheduledFlush(): void {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
}

function scheduleFlush(): void {
  if (_flushTimer) return; // already scheduled — batch into that window
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    void flushBuffer();
  }, FLUSH_INTERVAL_MS);
}

async function flushBuffer(): Promise<void> {
  if (_buffer.length === 0) return;

  const batch = _buffer;
  _buffer = [];

  try {
    await withTimeout(
      invoke('journal_emit_batch', { events: batch.map(serializeEvent) }),
      JOURNAL_INVOKE_TIMEOUT_MS,
      'journal_emit_batch',
    );
    _consecutiveFailures = 0;
  } catch (err: unknown) {
    _consecutiveFailures += 1;
    console.warn('[journal] emitBuffered flush failed:', err);

    if (_consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !_circuitOpen) {
      _circuitOpen = true;
      console.warn(
        '[journal] circuit breaker open after',
        MAX_CONSECUTIVE_FAILURES,
        'consecutive failures — dropping buffered events until reload',
      );
    }
  }
}

/**
 * Buffer one event for batched delivery. Coalesces into one
 * journal_emit_batch call every 500ms, except terminal events (see
 * TERMINAL_TYPES) which flush the buffer immediately — including whatever
 * non-terminal events were already waiting in it.
 *
 * Silently drops the event once the circuit breaker has tripped (see
 * flushBuffer) — a single warning already fired at trip time, so repeated
 * drops stay quiet rather than spamming the console.
 */
export function emitBuffered(e: JournalEventInput): void {
  if (_circuitOpen) return;

  _buffer = [..._buffer, e];

  if (isTerminal(e.type)) {
    clearScheduledFlush();
    void flushBuffer();
    return;
  }

  scheduleFlush();
}

// ── Query ─────────────────────────────────────────────────────────

/**
 * Backoff window for the Nth consecutive journalQuery failure (N >= 1):
 * 5s, 10s, 20s, 40s, 80s, then capped at QUERY_BACKOFF_MAX_MS (120s). Same
 * `base * 2^(streak-1)` shape as syncDaemon.ts's nextRetryDelay.
 */
function queryBackoffDurationMs(streak: number): number {
  return Math.min(QUERY_BACKOFF_BASE_MS * 2 ** (streak - 1), QUERY_BACKOFF_MAX_MS);
}

/**
 * Records one failed real invoke attempt: bumps the failure streak, opens
 * the cooldown window further journalQuery calls will short-circuit
 * against (see below), and logs exactly one warning for this transition.
 * Only ever called from journalQuery's catch block below — a
 * short-circuited call returns before reaching invoke at all, so it never
 * reaches here and never warns. This is what keeps a saturated-backend
 * incident to one warning per backoff step instead of one per poll (see
 * file header's REAL INCIDENT).
 */
function recordQueryFailure(nowMs: number, err: unknown): void {
  _queryFailureStreak += 1;
  const durationMs = queryBackoffDurationMs(_queryFailureStreak);
  _queryCooldownUntilMs = nowMs + durationMs;
  console.warn(
    `[journal] journalQuery failing — backoff ${durationMs / 1000}s (streak ${_queryFailureStreak})`,
    err,
  );
}

/**
 * Records one successful real invoke attempt: closes the cooldown window
 * and, only if a streak was actually in progress, logs exactly one
 * recovery line. A no-op (and silent) when the streak is already 0, so the
 * common case — no prior failures — never logs anything extra.
 */
function recordQuerySuccess(): void {
  if (_queryFailureStreak === 0) return;
  console.info(`[journal] journalQuery recovered after ${_queryFailureStreak} failures`);
  _queryFailureStreak = 0;
  _queryCooldownUntilMs = 0;
}

/**
 * Query the journal. Never rejects, never resolves undefined — always
 * resolves an array, so a projection view degrades to "no data yet"
 * instead of crashing. Two failure shapes are coerced to []: the invoke
 * rejecting (backend/IPC error), and the invoke resolving a non-array value
 * (e.g. a test mock or a future backend contract change that hands back
 * undefined/null instead of rows) — callers are expected to iterate the
 * result directly (see CockpitKpiBar's brain.recalled polling) so either
 * shape reaching them as a bare non-array would throw "is not iterable".
 *
 * FAILURE-STREAK BACKOFF (module-level, shared by every caller/poller —
 * see file header's REAL INCIDENT): once a real invoke attempt fails,
 * further calls short-circuit to the same benign [] below WITHOUT
 * attempting invoke, until the cooldown window opened by
 * recordQueryFailure elapses. A successful real attempt resets the streak
 * via recordQuerySuccess. The non-array coercion path above is left out of
 * the streak on purpose: invoke DID resolve there (the backend is
 * reachable), it just hands back an unexpected shape, which is a distinct
 * failure mode from "backend unreachable/saturated".
 */
export async function journalQuery(filter: JournalQueryFilter): Promise<JournalEventRow[]> {
  if (Date.now() < _queryCooldownUntilMs) {
    return [];
  }

  try {
    const result = await withTimeout(
      invoke<JournalEventRow[]>('journal_query_events', {
        projectId: filter.projectId,
        missionId: filter.missionId,
        types: filter.types,
        sinceSeq: filter.sinceSeq,
        sinceMs: filter.sinceMs,
        limit: filter.limit,
      }),
      JOURNAL_INVOKE_TIMEOUT_MS,
      'journal_query_events',
    );
    if (!Array.isArray(result)) {
      console.warn('[journal] journalQuery resolved a non-array result, coercing to []:', result);
      return [];
    }
    recordQuerySuccess();
    return result;
  } catch (err: unknown) {
    recordQueryFailure(Date.now(), err);
    return [];
  }
}

// ── Test-only helpers ─────────────────────────────────────────────

/** Clears all module state (buffer, pending timer, circuit breaker, query
 *  backoff streak/cooldown). Call from afterEach(). */
export function resetJournalForTests(): void {
  clearScheduledFlush();
  _buffer = [];
  _consecutiveFailures = 0;
  _circuitOpen = false;
  _queryFailureStreak = 0;
  _queryCooldownUntilMs = 0;
}
