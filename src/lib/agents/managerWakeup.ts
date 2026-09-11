/* managerWakeup.ts — LazyManager proactive event wakeup.

   FOUNDER DIRECTIVE (verbatim): "...le réveil sur événement doit permettre
   au LazyManager d'être proactif si besoin et de réagir ou demander au
   user." Recon's #1 orchestrator gap: sendManagerMessage (agentsStore.tsx)
   only ever runs from an explicit user click — no automated call site
   exists anywhere in the codebase, so the manager's own "je vérifie à la
   prochaine occasion" promises are structurally dead: nobody ever asks it
   the next question. This module gives it a spontaneous turn instead, the
   moment something SIGNIFICANT happens to the active project while the
   user isn't talking to it.

   ARCHITECTURE
   - Polls the SAME journal-query primitive the activity ticker uses
     (queryJournalSince → journal_since — see projections.ts and
     FluxFooter.tsx's own POLL_MS-based queryActivityFeed poll) rather than
     subscribing to a live push bus: the Rust journal has no event-push
     mechanism of its own (see journal.ts's module header — it is a pure
     invoke/query store), so "subscribe to journal events" here means "poll
     for new rows since the last seen tsMs", exactly FluxFooter's own
     established pattern, just coarser (WAKEUP_POLL_MS) since a wakeup can
     end in a real LLM call, not a cheap read.
   - classifyWakeupEvent is pure and locale-agnostic (kind + raw fields
     only, e.g. missionId/reason/targetRef/hygieneTotal) — it deliberately
     does NOT build the user-facing message text, so this module stays
     completely free of any i18n dependency; agentsStore.tsx (which already
     holds a live `t()` from useI18n) formats the localized instruction
     text from the candidate list right before calling sendManagerMessage.
   - The stateful scheduler (startManagerWakeupScheduler) wraps that pure
     core with a real poll interval + a real debounce timer, entirely
     dependency-injected (fetchEventsSince/isManagerBusy/sendWakeupTurn/
     getConfig/now) so agentsStore.tsx only wires it up: start once on
     mount, stop on unmount, call notifyManagerTurnEnded on every
     managerBusy true→false transition. See that file's own wiring comment
     for the full contract.

   GUARDRAILS (founder cares about token budget — an idle fleet must never
   quietly turn into a background LLM bill):
   - DEBOUNCE_MS (90s default): a burst of terminal events (several
     missions landing within seconds of each other) coalesces into exactly
     ONE wakeup turn describing all of them, never one turn per event —
     every new significant event resets the timer (standard trailing
     debounce), so a truly noisy stretch keeps deferring until it goes
     quiet for a full debounce window.
   - MAX_AUTO_TURNS_PER_HOUR (6 default, configurable): a sliding-window
     cap — once hit, further significant events in that window are
     silently DROPPED (never queued for "later", which would just turn into
     a burst the moment the window rolls) rather than firing more turns;
     the window slides forward continuously, so a quiet stretch always
     recovers capacity on its own.
   - ECHO_SUPPRESS_MS (30s default): a manager turn's OWN actions (e.g. it
     just approved a mission as one of its own tool calls, mid-turn) emit
     journal events exactly like a human or an agent would — without this
     window, that self-caused event would arm ANOTHER wakeup the moment the
     debounce elapses: a genuine infinite-loop risk, not a hypothetical
     one. notifyManagerTurnEnded() — called by the wiring for EVERY
     managerBusy true→false transition, whether that turn was wakeup-
     triggered or an ordinary user-initiated chat turn, since either kind
     can perform a mission-mutating action — anchors this window: any
     candidate event whose OWN tsMs falls inside
     [lastManagerTurnEndedAtMs, lastManagerTurnEndedAtMs + echoSuppressMs]
     is treated as an echo and never arms or extends the debounce timer.
   - "never wake while a manager turn is already running" — isManagerBusy()
     is checked again at FIRE time (not only when the candidate event was
     first observed — the whole point of debouncing is that real time
     passes), and a busy fire is deferred with a few bounded short retries
     (see MAX_BUSY_RETRIES) rather than silently dropped, since "a user's
     own turn is still finishing" is exactly the ordinary case this rule
     exists for, not a signal to discard.
   - Full on/off toggle (isManagerWakeupEnabled/setManagerWakeupEnabled,
     localStorage-backed — same convention as fleetHygiene.ts's
     getFleetHygieneConfig/getConfiguredGracePeriodMs) — re-read at every
     decision point (both when a candidate event arrives and again at fire
     time), so flipping it off mid-debounce cancels the pending batch
     cleanly instead of firing one last time.
*/

import type { JournalEventRow } from '../journal/eventTypes.js';

// ── Configuration (localStorage-backed, same convention as fleetHygiene.ts) ──

const ENABLED_STORAGE_KEY = 'lazy.managerWakeup.enabled';
const MAX_PER_HOUR_STORAGE_KEY = 'lazy.managerWakeup.maxPerHour';

export const DEFAULT_DEBOUNCE_MS = 90_000;
export const DEFAULT_MAX_AUTO_TURNS_PER_HOUR = 6;
export const DEFAULT_ECHO_SUPPRESS_MS = 30_000;
/** Poll cadence for new journal rows — coarser than FluxFooter's own 8s
 *  activity-ticker poll (this file's module header explains why). */
export const WAKEUP_POLL_MS = 20_000;
/** How many times a fire deferred by "manager turn already running" retries
 *  before the batch is dropped (a future significant event schedules a
 *  fresh attempt regardless — nothing is permanently lost, just this one
 *  stale batch). */
export const MAX_BUSY_RETRIES = 3;
const BUSY_RETRY_DELAY_MS = 15_000;
const HOUR_MS = 60 * 60 * 1000;

const CRITICAL_WAKEUP_KINDS: ReadonlySet<WakeupEventKind> = new Set([
  'mission_failed',
  'approve_blocked',
  'bot_completed',
  'bot_routine_failed',
  'review_failed',
  // brain_ops_orphan deliberately NOT critical (2026-09-11): the dream/kill
  // maintenance loop can recur every consolidation cycle — a bypass-cap
  // wakeup each time burns a full manager turn to report infra noise the
  // manager cannot act on. The journal event + FLUX trace stay; the wakeup
  // still fires, just under the ordinary hourly cap instead of bypassing it.
]);

export function isCriticalWakeupKind(kind: WakeupEventKind | string): boolean {
  return CRITICAL_WAKEUP_KINDS.has(kind as WakeupEventKind);
}

export interface WakeupConversationSlice {
  id: string;
  busy: boolean;
  lastActiveAt: number;
}

export interface WakeupConversationsState {
  conversationOrder: string[];
  conversations: Record<string, WakeupConversationSlice | undefined>;
}

/** Idle conversation to route a wakeup into. When `preferredId` is set and
 *  that conversation is busy, returns undefined (retry — never dump onto
 *  a different thread). */
export function pickWakeupTargetConversationId(
  state: WakeupConversationsState,
  preferredId?: string,
): string | undefined {
  if (preferredId) {
    const conv = state.conversations[preferredId];
    return conv && !conv.busy ? preferredId : undefined;
  }
  const idle = state.conversationOrder
    .map((id) => state.conversations[id])
    .filter((conv): conv is WakeupConversationSlice => !!conv && !conv.busy);
  if (idle.length === 0) return undefined;
  return idle.reduce((latest, conv) => (conv.lastActiveAt > latest.lastActiveAt ? conv : latest)).id;
}

/**
 * fleet.hygiene only wakes the manager when a sweep's combined counts are
 * "big" (founder's own wording, verbatim in the task brief) — a routine
 * 1-2 item sweep is exactly the kind of silent housekeeping the manager
 * should NOT interrupt anyone about; only a sweep big enough to be worth a
 * one-line FYI counts as significant.
 */
export const FLEET_HYGIENE_SIGNIFICANT_TOTAL = 5;

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === 'true';
  } catch {
    return fallback;
  }
}

function readPositiveInt(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  } catch {
    return fallback;
  }
}

/** Whether the wakeup feature is currently enabled — defaults to ON (the
 *  founder directive is unconditional; this toggle exists as an escape
 *  hatch, not an opt-in gate). */
export function isManagerWakeupEnabled(): boolean {
  return readBool(ENABLED_STORAGE_KEY, true);
}

export function setManagerWakeupEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_STORAGE_KEY, String(enabled));
  } catch {
    // best-effort only — same convention as fleetHygiene.ts's writeStoredMs
  }
}

export function getConfiguredMaxAutoTurnsPerHour(): number {
  return readPositiveInt(MAX_PER_HOUR_STORAGE_KEY, DEFAULT_MAX_AUTO_TURNS_PER_HOUR);
}

export function setConfiguredMaxAutoTurnsPerHour(n: number | undefined): void {
  try {
    if (n === undefined) localStorage.removeItem(MAX_PER_HOUR_STORAGE_KEY);
    else localStorage.setItem(MAX_PER_HOUR_STORAGE_KEY, String(n));
  } catch {
    // best-effort only
  }
}

export interface ManagerWakeupConfig {
  enabled: boolean;
  debounceMs: number;
  maxAutoTurnsPerHour: number;
  echoSuppressMs: number;
}

/** Reads every configured knob at once — the shape the scheduler re-reads
 *  at every decision point. Callers that already have a config object (e.g.
 *  a unit test's fixture) should build one directly instead of calling this
 *  (which touches `localStorage`). */
export function getManagerWakeupConfig(): ManagerWakeupConfig {
  return {
    enabled: isManagerWakeupEnabled(),
    debounceMs: DEFAULT_DEBOUNCE_MS,
    maxAutoTurnsPerHour: getConfiguredMaxAutoTurnsPerHour(),
    echoSuppressMs: DEFAULT_ECHO_SUPPRESS_MS,
  };
}

// ── Event classification (pure, no i18n, no journal I/O) ────────────────

export type WakeupEventKind =
  | 'mission_failed'
  | 'merge_landed'
  | 'approve_blocked'
  | 'review_passed'
  | 'review_failed'
  | 'chain_fired'
  | 'fleet_hygiene'
  | 'bot_completed'
  | 'bot_routine_failed'
  | 'brain_ops_orphan';

/** One significant event, classified from a real journal row — every field
 *  is either copied straight off the row or its already-typed payload,
 *  never fabricated. agentsStore.tsx's formatWakeupMessage (i18n-aware,
 *  outside this module) turns a batch of these into the actual message
 *  text. */
export interface WakeupCandidate {
  kind: WakeupEventKind;
  tsMs: number;
  missionId?: string;
  /** mission.failed's reason / mission.approve_blocked's reason. */
  reason?: string;
  /** gate.passed / gate.failed's reviewer role. */
  role?: string;
  /** chain.fired's target ref (e.g. "draft:abc-123"). */
  targetRef?: string;
  /** fleet.hygiene's combined archived+purged+deduped count. */
  hygieneTotal?: number;
  /** lazybot.completed's bot display name. */
  botName?: string;
  /** lazybot.completed's final report excerpt — the bot's actual answer. */
  report?: string;
  /** brain.ops_orphan step / detail for manager digest. */
  opsStep?: string;
  opsDetail?: string;
}

/** Minimal shape this module reads off a journal row — a real
 *  `JournalEventRow` (eventTypes.ts) satisfies this by structural typing,
 *  so production callers pass rows straight through; tests only need to
 *  fill in what classifyWakeupEvent actually inspects (same `Pick`
 *  convention as fleetHygiene.ts's `HygieneMission`). */
export type WakeupJournalRow = Pick<JournalEventRow, 'type' | 'ts_ms' | 'mission_id' | 'payload'>;

function parsePayload(row: WakeupJournalRow): Record<string, unknown> {
  if (typeof row.payload !== 'string' || !row.payload) return {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Classify one journal row as a significant wakeup candidate, or `null` when
 * it is not one of the founder-specified kinds (mission failed, merge
 * landed, approve_blocked, a JUDGE review verdict, chain fired, or a
 * fleet.hygiene sweep whose combined counts clear
 * {@link FLEET_HYGIENE_SIGNIFICANT_TOTAL}). Deliberately excludes
 * mission.cancelled — the founder's own list names only "done/failed", and
 * a user-cancelled mission is already known to the very user who cancelled
 * it; waking the manager for that would be pure token waste with no payoff.
 *
 * Two deliberate exclusions fixed by defect C2 (real founder repro: a wakeup
 * firing for a mission that needed no action, and 4 near-identical "review
 * verdict ready" wakeups for the SAME mission):
 * - `mission.completed` is no longer significant on its own — the pipeline's
 *   own judge verdict (below) always follows for that mission, and the
 *   canvas already shows mission completion; a dedicated wakeup for it was
 *   pure token waste with nothing new to report.
 * - `gate.passed`/`gate.failed` only classify when `payload.role === 'judge'`
 *   — evaluator.ts's pipeline runs tester/reviewer/security/judge, each
 *   emitting its OWN gate event, but the judge's verdict already aggregates
 *   every other role's input (see evaluator.ts's judgeEntry usage); waking
 *   on all four turned one real verdict into four illegible near-duplicates.
 */
export function classifyWakeupEvent(row: WakeupJournalRow): WakeupCandidate | null {
  const missionId = row.mission_id ?? undefined;
  const tsMs = row.ts_ms;

  switch (row.type) {
    case 'mission.failed': {
      const payload = parsePayload(row);
      return { kind: 'mission_failed', tsMs, missionId, reason: stringField(payload, 'reason') };
    }
    case 'mission.approved':
      return { kind: 'merge_landed', tsMs, missionId };
    case 'mission.approve_blocked': {
      const payload = parsePayload(row);
      return { kind: 'approve_blocked', tsMs, missionId, reason: stringField(payload, 'reason') };
    }
    case 'gate.passed': {
      const payload = parsePayload(row);
      // Judge-only (see this function's doc comment): tester/reviewer/
      // security gate events are real but non-terminal for the pipeline —
      // the judge's own verdict already reflects their input.
      if (stringField(payload, 'role') !== 'judge') return null;
      return { kind: 'review_passed', tsMs, missionId, role: 'judge' };
    }
    case 'gate.failed': {
      const payload = parsePayload(row);
      if (stringField(payload, 'role') !== 'judge') return null;
      return { kind: 'review_failed', tsMs, missionId, role: 'judge' };
    }
    case 'chain.fired': {
      const payload = parsePayload(row);
      return { kind: 'chain_fired', tsMs, missionId, targetRef: stringField(payload, 'targetRef') };
    }
    case 'fleet.hygiene': {
      const payload = parsePayload(row);
      const archived = Number(payload.archived) || 0;
      const purged = Number(payload.purged) || 0;
      const deduped = Number(payload.deduped) || 0;
      const total = archived + purged + deduped;
      if (total < FLEET_HYGIENE_SIGNIFICANT_TOTAL) return null;
      return { kind: 'fleet_hygiene', tsMs, hygieneTotal: total };
    }
    case 'lazybot.completed': {
      // The one "completed" that IS significant on its own: a LazyBot is a
      // Solari cloud computer with no judge verdict to follow (see
      // LazyBotCompletedPayload, eventTypes.ts) — this is the only moment
      // the manager can relay the bot's answer to the user.
      const payload = parsePayload(row);
      return {
        kind: 'bot_completed',
        tsMs,
        missionId,
        botName: stringField(payload, 'botName'),
        report: stringField(payload, 'report'),
      };
    }
    case 'lazybot.routine_failed': {
      // C76 — cron launch failure must wake the manager (not console-only).
      const payload = parsePayload(row);
      return {
        kind: 'bot_routine_failed',
        tsMs,
        botName: stringField(payload, 'botName'),
        reason: stringField(payload, 'error'),
      };
    }
    case 'brain.ops_orphan': {
      const payload = parsePayload(row);
      return {
        kind: 'brain_ops_orphan',
        tsMs,
        opsStep: stringField(payload, 'step') ?? undefined,
        opsDetail: stringField(payload, 'detail') ?? undefined,
      };
    }
    default:
      return null;
  }
}

// ── Pure scheduling primitives (debounce/caps/echo — unit-testable with no timers) ──

/** True when `candidateTsMs` falls inside the echo-suppression window that
 *  opened at `lastManagerTurnEndedAtMs` (0 — the "never happened yet"
 *  sentinel — never matches any real epoch ms, so this is safe to call
 *  before the first manager turn ever completes). */
export function isEchoOfManagerTurn(
  candidateTsMs: number,
  lastManagerTurnEndedAtMs: number,
  echoSuppressMs: number,
): boolean {
  if (lastManagerTurnEndedAtMs <= 0) return false;
  return candidateTsMs >= lastManagerTurnEndedAtMs && candidateTsMs <= lastManagerTurnEndedAtMs + echoSuppressMs;
}

/** Prunes timestamps older than one hour from `nowMs`, then reports whether
 *  firing one more turn right now stays under `maxPerHour`. Returns the
 *  pruned array so the caller can store it back (immutable — never mutates
 *  the input array). */
export function checkHourlyCap(
  timestamps: readonly number[],
  nowMs: number,
  maxPerHour: number,
): { allowed: boolean; pruned: number[] } {
  const cutoff = nowMs - HOUR_MS;
  const pruned = timestamps.filter((t) => t > cutoff);
  return { allowed: pruned.length < maxPerHour, pruned };
}

// ── Stateful scheduler ────────────────────────────────────────────────

export interface ManagerWakeupDeps {
  /** Fetch new journal rows since `sinceMs` for the currently active
   *  project — in production, `queryJournalSince(activeProjectId, sinceMs)`
   *  (projections.ts). Never expected to throw (journal.ts's own
   *  never-throws convention); returning `[]` on any failure degrades to
   *  "nothing new this poll", never a crash. */
  fetchEventsSince: (sinceMs: number) => Promise<WakeupJournalRow[]>;
  /** True while a manager turn (of ANY origin — user chat or a previous
   *  wakeup) is currently in flight. */
  isManagerBusy: () => boolean;
  /** Fires the actual proactive turn (in production, agentsStore's
   *  sendManagerMessage) with the fully-formatted, already-localized
   *  message text and the real candidate batch it was built from (for the
   *  caller's own audit-trail journaling — see agentsStore.tsx's wiring). */
  sendWakeupTurn: (text: string, candidates: WakeupCandidate[]) => Promise<void>;
  /** Builds the final message text from a coalesced batch — kept OUT of
   *  this module so it stays i18n-free (agentsStore.tsx owns the real
   *  `t()` call). Never called with an empty array. */
  formatWakeupText: (candidates: WakeupCandidate[]) => string;
  /** Reads the live config — re-read at every decision point so a toggle
   *  takes effect immediately, no restart required. */
  getConfig: () => ManagerWakeupConfig;
  /** Clock — real `Date.now` in production, injectable for tests. */
  now?: () => number;
}

export interface ManagerWakeupHandle {
  /** Stops polling and cancels any pending debounce/retry timer. */
  stop: () => void;
  /** Call on EVERY managerBusy true→false transition (both a wakeup-
   *  triggered turn and an ordinary user-initiated one) — anchors the echo-
   *  suppression window (see this module's header). Defaults to `now()`. */
  notifyManagerTurnEnded: (atMs?: number) => void;
  /** Feed rows directly, bypassing the real poll interval — the seam both
   *  the internal poller and this module's own tests use. */
  ingestRows: (rows: WakeupJournalRow[]) => void;
}

/**
 * Starts the manager wakeup scheduler: polls `fetchEventsSince` on
 * {@link WAKEUP_POLL_MS}, classifies new rows via {@link classifyWakeupEvent},
 * and — respecting the on/off toggle, echo suppression, debounce coalescing,
 * the hourly cap, and "never while busy" — fires at most one
 * `sendWakeupTurn` per settled batch. See this module's header for the full
 * guardrail rationale.
 */
export function startManagerWakeupScheduler(deps: ManagerWakeupDeps): ManagerWakeupHandle {
  const now = deps.now ?? (() => Date.now());
  let stopped = false;
  let lastSeenMs = now();
  let lastManagerTurnEndedAtMs = 0;
  let pending: WakeupCandidate[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let turnTimestamps: number[] = [];
  let busyRetryCount = 0;

  function clearDebounce(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function fire(): void {
    debounceTimer = null;
    if (stopped) return;
    if (pending.length === 0) return;

    const cfg = deps.getConfig();
    if (!cfg.enabled) {
      pending = [];
      busyRetryCount = 0;
      return;
    }

    if (deps.isManagerBusy()) {
      const critical = pending.some((c) => isCriticalWakeupKind(c.kind));
      busyRetryCount += 1;
      if (critical || busyRetryCount <= MAX_BUSY_RETRIES) {
        debounceTimer = setTimeout(fire, BUSY_RETRY_DELAY_MS);
      } else {
        pending = [];
        busyRetryCount = 0;
      }
      return;
    }
    busyRetryCount = 0;

    const { allowed, pruned } = checkHourlyCap(turnTimestamps, now(), cfg.maxAutoTurnsPerHour);
    turnTimestamps = pruned;
    if (!allowed) {
      const critical = pending.filter((c) => isCriticalWakeupKind(c.kind));
      if (critical.length === 0) {
        pending = [];
        return;
      }
      pending = critical;
    }

    const batch = pending;
    pending = [];
    turnTimestamps = [...turnTimestamps, now()];
    const text = deps.formatWakeupText(batch);
    void deps.sendWakeupTurn(text, batch);
  }

  function scheduleFire(): void {
    clearDebounce();
    const cfg = deps.getConfig();
    debounceTimer = setTimeout(fire, cfg.debounceMs);
  }

  function ingestRows(rows: WakeupJournalRow[] | undefined | null): void {
    // Defensive against a misbehaving `fetchEventsSince` (a test double, or
    // a future caller that doesn't honor the "always resolves an array"
    // contract queryJournalSince itself guarantees) — never let a bad
    // dependency crash the whole poll loop into an unhandled rejection.
    if (stopped || !rows || rows.length === 0) return;
    const cfg = deps.getConfig();
    if (!cfg.enabled) return;

    let armed = false;
    for (const row of rows) {
      const candidate = classifyWakeupEvent(row);
      if (!candidate) continue;
      if (isEchoOfManagerTurn(candidate.tsMs, lastManagerTurnEndedAtMs, cfg.echoSuppressMs)) continue;
      pending = [...pending, candidate];
      armed = true;
    }
    if (armed) scheduleFire();
  }

  async function poll(): Promise<void> {
    if (stopped) return;
    const cfg = deps.getConfig();
    if (!cfg.enabled) return;
    const sinceMs = lastSeenMs;
    try {
      const rows = await deps.fetchEventsSince(sinceMs);
      if (stopped || !rows || rows.length === 0) return;
      lastSeenMs = rows.reduce((max, r) => Math.max(max, r.ts_ms), sinceMs) + 1;
      ingestRows(rows);
    } catch (err: unknown) {
      // Never throws out of the poll loop — same "a background poll must
      // degrade, never crash" convention as journal.ts's own emitEvent/
      // journalQuery (which this module's fetchEventsSince dependency
      // wraps in production).
      console.warn('[managerWakeup] poll failed:', err);
    }
  }

  void poll();
  const pollInterval = setInterval(() => void poll(), WAKEUP_POLL_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(pollInterval);
      clearDebounce();
    },
    notifyManagerTurnEnded: (atMs) => {
      lastManagerTurnEndedAtMs = atMs ?? now();
    },
    ingestRows,
  };
}

/** Stable prefix marking a ManagerMessage as a wakeup-triggered turn's
 *  visible input, shared by agentsStore.tsx (which builds it) and
 *  LazyManagerMessageList.tsx (which detects it to render the small chip
 *  style instead of a normal user bubble) — see LazyManagerMessageList's
 *  own doc comment for why this is a content-prefix convention rather than
 *  a `role: 'system'` message: the role must stay 'user' so every provider
 *  backend (claude-code/codex/managed) keeps receiving the exact same
 *  message shape it always has, zero pipeline risk. */
export const WAKEUP_MARKER_PREFIX = '\u{1F514} ';
