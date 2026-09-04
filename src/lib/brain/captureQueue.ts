/* captureQueue.ts — bounded in-memory retry queue for failed brain captures.

   capture.ts's dispatch() is fire-and-forget by design: capture() callers
   (editor saves, chat turns, agent missions) must never throw or block on
   a capture. Previously a failed capture (sidecar briefly down, transient
   spawn/write error) was only logged via console.warn and then dropped —
   the note was lost with no retry and no user-facing signal, even though
   nothing else in the UI hints that the capture failed.

   This module adds a bounded retry queue: each failed capture gets up to
   MAX_RETRIES more attempts with exponential backoff, and only reaches for
   user-facing notification (via onCaptureGiveUp subscribers) once every
   retry is exhausted. The queue itself never throws — enqueueCaptureRetry()
   preserves capture.ts's fail-open contract.

   Duplication risk (FIX 1c — read before changing the retry/backoff logic):
   the vendored LazyBrain store CLI derives a note's id from
   `slug(title) + "-" + day` (see src-tauri/src/lib.rs's event_to_html —
   NOT a content hash, day granularity only) and is fail-closed on
   collision: writeNote() (lazybrain.js) throws a "Note already exists: ...
   Pass overwrite to replace." ConflictError rather than silently
   overwriting or duplicating, and Rust's brain_capture invokes `store`
   without --overwrite. Net effect:
     - A retry of a capture that actually landed on an earlier attempt
       (e.g. the write succeeded but the Tauri invoke() response was lost/
       timed out before dispatch() saw it resolve) fails again with the
       SAME ConflictError — isConflictError() below recognizes this and
       treats it as a success (stop retrying, no failure toast) instead of
       burning the retry budget and then wrongly telling the user their
       note was lost when it was actually captured on the first try.
     - This is NOT full content-hash idempotency: two genuinely different
       captures that happen to share both title and calendar day (e.g. two
       edits of the same file, or two short chat turns with the same
       opening words, on the same day) collide on the SAME id and the
       second is ALSO rejected by the vendored store — this happens today
       even without any retry involved, and is unrelated to this queue.
       True idempotency would require the client to send a content hash
       (or the vendored store to dedupe on one) — out of scope here since
       lazybrain.js is a vendored build artifact and lib.rs is owned by
       another agent this wave. See capture.ts's dispatch() for the call
       site and the final report for the full writeup.
*/

import type { CaptureEvent, CaptureResult } from '../platform/types.js';
import { emitBuffered } from '../journal/journal.js';

// ── Config ────────────────────────────────────────────────────────

/** Retry delays in ms: attempt 1 after 2s, attempt 2 after 8s, attempt 3 after 30s. */
const BACKOFF_MS = [2_000, 8_000, 30_000] as const;

/** Number of retry attempts (in addition to the original attempt made by dispatch()). */
const MAX_RETRIES = BACKOFF_MS.length;

/** Hard cap on concurrently-tracked failed captures. Oldest is dropped (with a warn) past this. */
const MAX_QUEUE_SIZE = 50;

// ── Types ─────────────────────────────────────────────────────────

/** Re-sends a capture event. Injectable so tests can mock the transport without touching the platform layer. */
export type CaptureTransport = (event: CaptureEvent) => Promise<CaptureResult>;

export interface CaptureRetryHooks {
  /** Called once a queued capture eventually succeeds — including the "already exists" case above. */
  onSuccess?: (event: CaptureEvent) => void;
}

type GiveUpListener = (event: CaptureEvent) => void;

interface QueueEntry {
  event: CaptureEvent;
  transport: CaptureTransport;
  hooks: CaptureRetryHooks;
  /** Number of retry attempts already made (0 before the first retry fires). */
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

// ── State ─────────────────────────────────────────────────────────

const _queue = new Map<string, QueueEntry>();
const _giveUpListeners = new Set<GiveUpListener>();
let _seq = 0;

// ── Conflict detection (FIX 1c) ──────────────────────────────────

/**
 * Recognizes the vendored store CLI's ConflictError ("Note already exists:
 * <path>. Pass overwrite to replace."), relayed verbatim through Rust's
 * brain_capture error string. See module header for why this means "an
 * earlier attempt already saved it", not "retry again".
 *
 * Exported (not just used internally by runAttempt below) so capture.ts's
 * dispatch() can apply the SAME success-equivalence check to the very FIRST
 * attempt, before a failure is ever queued here — otherwise a first-attempt
 * conflict still logged a spurious "capture failed, queuing retry" warning
 * and burned one queue slot + a 2s backoff delay before this module's own
 * runAttempt recognized the very same error as success (BUG 3, run-6c).
 */
export function isConflictError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists/i.test(message);
}

// ── Give-up notifications ────────────────────────────────────────

/**
 * Subscribe to "permanently failed after all retries" events. Mirrors the
 * subscribeCost()/getCostState() pub-sub pattern already used by
 * lib/models/costStore.ts: capture.ts and this module are plain modules
 * with no React context, so they cannot call useToast() directly. A
 * mounted component (BrainContextBanner) drains this via useEffect and
 * surfaces a toast instead. Returns an unsubscribe function.
 *
 * Known limitation: this is a live subscription, not a replay log — a
 * give-up that fires while no consuming component happens to be mounted
 * is still logged via console.warn but produces no toast. Still a strict
 * improvement over the previous behavior (always silently dropped, no
 * retry at all).
 */
export function onCaptureGiveUp(fn: GiveUpListener): () => void {
  _giveUpListeners.add(fn);
  return () => _giveUpListeners.delete(fn);
}

/**
 * Pulls `mission:<id>` out of a CaptureEvent's tags — the SAME convention
 * learningLoop.ts's captureSkillNote and captureToBrain already tag their
 * events with (see capture.ts/learningLoop.ts). Returns undefined for
 * non-mission captures (edits, chat turns) which carry no such tag.
 */
function extractMissionId(event: CaptureEvent): string | undefined {
  const tag = event.tags?.find((t) => t.startsWith('mission:'));
  return tag ? tag.slice('mission:'.length) : undefined;
}

// ── Last-failure health state (capture honesty) ──────────────────
//
// onCaptureGiveUp() above is a LIVE subscription only: a give-up that fires
// while no component happens to be mounted (e.g. BrainContextBanner) is
// still lost as a user-facing signal — the doc comment on onCaptureGiveUp
// says as much. getLastCaptureFailure() gives any health surface (Settings >
// Memory, a future brain-health panel) a durable fact to read on mount,
// independent of whether it was listening at the exact moment of failure —
// same "read the current state, don't rely on having caught the event"
// pattern as BrainConnection.initFailedReason (platform/types.ts).

export interface CaptureFailure {
  /** The CaptureEvent.kind that failed (edit/decision/episodic/agent/commit/learning). */
  kind: string;
  /** Present when the failed capture was mission-scoped (see extractMissionId). */
  missionId?: string;
  atMs: number;
}

let _lastFailure: CaptureFailure | null = null;

/** Most recent capture that gave up after exhausting every retry, or null if
 *  none since app start (or since the last resetCaptureQueueForTests()). */
export function getLastCaptureFailure(): CaptureFailure | null {
  return _lastFailure;
}

function announceGiveUp(event: CaptureEvent): void {
  console.warn('[brain/captureQueue] capture permanently failed after retries:', event.title);

  const missionId = extractMissionId(event);
  _lastFailure = { kind: event.kind, missionId, atMs: Date.now() };

  // Durable signal, never silent — the counterpart to the ephemeral toast
  // below: this survives even when no UI was mounted to catch it, and lets
  // a future backfill pass find exactly which mission's learning capture
  // needs replaying (see the report for the backfillMissionLearnings design
  // this enables). emitBuffered() is fire-and-forget and internally
  // fail-safe (journal.ts guards its own circuit breaker/timeout), but this
  // queue's fail-open contract (module header) still wraps it defensively —
  // a journal hiccup must never resurrect a capture failure as a THROWN
  // error out of this queue.
  try {
    emitBuffered({
      tsMs: Date.now(),
      // No project-scoped id is available at this chokepoint (the queue is
      // shared across every project's captures) — '*' mirrors the same
      // "unscoped/system" convention brain.recalled/teams.* events already
      // use elsewhere (see teamSearch.ts, syncDaemon.ts) when no specific
      // project applies.
      projectId: '*',
      missionId,
      actor: 'system',
      type: 'brain.capture_failed',
      payload: { kind: event.kind },
    });
  } catch (err: unknown) {
    console.warn('[brain/captureQueue] emitBuffered(brain.capture_failed) threw:', err);
  }

  for (const fn of _giveUpListeners) {
    try {
      fn(event);
    } catch (err: unknown) {
      // A subscriber must never break the queue itself.
      console.warn('[brain/captureQueue] onCaptureGiveUp listener threw:', err);
    }
  }
}

// ── Queue bookkeeping ────────────────────────────────────────────

function dropOldest(): void {
  const oldest = _queue.keys().next();
  if (oldest.done) return;
  const entry = _queue.get(oldest.value);
  _queue.delete(oldest.value);
  if (entry?.timer) clearTimeout(entry.timer);
  console.warn(
    '[brain/captureQueue] retry queue full (cap',
    MAX_QUEUE_SIZE,
    ') — dropped oldest pending capture:',
    entry?.event.title,
  );
}

function scheduleAttempt(id: string): void {
  const entry = _queue.get(id);
  if (!entry) return;
  const delay = BACKOFF_MS[entry.attempt];
  entry.timer = setTimeout(() => {
    void runAttempt(id);
  }, delay);
}

async function runAttempt(id: string): Promise<void> {
  const entry = _queue.get(id);
  if (!entry) return;

  try {
    await entry.transport(entry.event);
    _queue.delete(id);
    entry.hooks.onSuccess?.(entry.event);
  } catch (err: unknown) {
    if (isConflictError(err)) {
      // Already written by an earlier attempt — see module header (FIX 1c).
      _queue.delete(id);
      entry.hooks.onSuccess?.(entry.event);
      return;
    }

    entry.attempt += 1;
    if (entry.attempt >= MAX_RETRIES) {
      _queue.delete(id);
      announceGiveUp(entry.event);
      return;
    }
    scheduleAttempt(id);
  }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Queue a failed capture for retry with exponential backoff. Never throws —
 * capture.ts's fail-open contract (capture() callers must never throw or
 * crash) extends to this queue.
 */
export function enqueueCaptureRetry(
  event: CaptureEvent,
  transport: CaptureTransport,
  hooks: CaptureRetryHooks = {},
): void {
  try {
    if (_queue.size >= MAX_QUEUE_SIZE) dropOldest();
    const id = `capture-retry-${Date.now()}-${++_seq}`;
    _queue.set(id, { event, transport, hooks, attempt: 0, timer: null });
    scheduleAttempt(id);
  } catch (err: unknown) {
    console.warn('[brain/captureQueue] enqueueCaptureRetry failed:', err);
  }
}

/** Current queue depth — exposed for tests and potential future UI use (not currently rendered). */
export function getCaptureRetryQueueSize(): number {
  return _queue.size;
}

// ── Test-only helpers ────────────────────────────────────────────

/** Clears all pending timers/state. Call from test afterEach() to avoid leaking timers across test files. */
export function resetCaptureQueueForTests(): void {
  for (const entry of _queue.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  _queue.clear();
  _giveUpListeners.clear();
  _seq = 0;
  _lastFailure = null;
}
