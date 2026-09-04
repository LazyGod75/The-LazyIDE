/* managerPersistence — localStorage-backed history for the LazyManager
   cockpit rail, modeled on lib/ai/chatPersistence.ts (the Code assistant's
   equivalent). Key difference from that module: the manager is NOT scoped
   per project — a single AgentsStoreProvider is mounted once for the whole
   Agent Canvas / Mission Control space (see agentsStore.tsx's own doc
   comment on AgentsStoreProvider, and LazyManagerRail's `projects:
   FleetProject[]` prop — the manager talks about the WHOLE fleet across
   every project at once), so sessions are stored and listed globally rather
   than filtered by projectRoot.

   Bounded like every other unbounded-growth surface in this codebase (see
   missionCaps.ts's own doc comment): MAX_SESSIONS caps how many past
   conversations localStorage keeps, and each session's own messages are run
   through capManagerMessages (the SAME cap agentsStore.tsx already applies
   to the live in-memory managerMessages) before being written to disk.

   PENDING-APPROVAL PERSISTENCE FIX (real user test, 2026-07-28 — see
   agentsStore.tsx's PendingApprovalAction doc comment for the live-state
   half of this fix): a gate-deferred ('ask') action used to vanish forever
   the instant AgentsStoreProvider remounted (app relaunch, or a dev-server
   full reload) — this module's `sanitizeMessage` reconstructed a persisted
   ManagerMessage WITHOUT its `actionStatuses`/`actionRefs` fields (dropped
   silently, "keeping only the known/serializable fields" never actually
   listed them), so a restored message's action chip read as a false SUCCESS
   (undefined !== false, the same "not failed" default a genuinely-executed
   action gets) instead of its real pending/denied state. Worse,
   `pendingApprovals` itself was pure in-memory React state, never persisted
   anywhere — so even with the chip fixed, the approval card itself (which
   renders only from `pendingApprovals`, see PendingApprovalCard.tsx's
   MOUNTING CONTRACT) could never come back: the action became permanently
   unreachable, exactly the "toute action soumise a approbation est
   definitivement inatteignable" defect. Both are fixed together: this
   module now persists `pendingApprovals` alongside each session's messages
   (PersistedPendingApproval — the same shape as agentsStore.tsx's own
   PendingApprovalAction, minus the live `aliasMap`, which doesn't survive
   JSON and is serialized as `aliasEntries` instead, restored as a fresh Map
   on load — see agentsStore.tsx's own doc comment on why an empty/rebuilt
   Map is an acceptable degradation for a restored entry, not a functional
   loss for the actions that actually need approval).
*/

import { useCallback, useState } from 'react';
import { capManagerMessages } from './missionCaps.js';
import type { ActionStatus, ManagerAction, ManagerMessage } from './types.js';

/**
 * Serializable counterpart to agentsStore.tsx's (unexported)
 * PendingApprovalAction — same fields, except `aliasMap` (a live `Map`,
 * never JSON-safe) becomes `aliasEntries` (`Array.from(aliasMap.entries())`),
 * restored as `new Map(aliasEntries)` by the caller. Declared independently
 * here (never imported from agentsStore.tsx) — same "structurally mirrored,
 * never imported" convention LazyManagerMessageList.tsx and
 * PendingApprovalCard.tsx already use for this exact type, so this module
 * stays decoupled from agentsStore.tsx's internals.
 */
export interface PersistedPendingApproval {
  id: string;
  action: ManagerAction;
  label: string;
  turnId: string;
  messageId: string;
  actionIndex: number;
  model: string;
  aliasEntries: Array<[string, string]>;
  createdAt: string;
  lastFailure?: { reason: string; canForce?: boolean };
}

export interface ManagerSession {
  id: string;
  messages: ManagerMessage[];
  createdAt: number;
  updatedAt: number;
  /** Optional for backward compatibility with sessions persisted before this
   *  field existed — an older/missing entry means "nothing was pending",
   *  never a parse failure (see sanitizeSession below). */
  pendingApprovals?: PersistedPendingApproval[];
  /** Tab-strip rename feature (agentsStore.tsx's
   *  ManagerConversationState.customTitle) — the user's own chosen name for
   *  this conversation, if they ever set one. `undefined` for every session
   *  persisted before this field existed, and for one that was never
   *  renamed; callers fall back to deriving a label from the first user
   *  message, same as always (see conversationTabLabel.ts). */
  title?: string;
}

const STORAGE_KEY = 'lazy.managerSessions';

/** Keep-last cap for how many past manager conversations localStorage
 *  retains — same "keep-last N" convention as MAX_MANAGER_MESSAGES/
 *  MAX_INACTIVE_MISSIONS in missionCaps.ts. */
export const MAX_MANAGER_SESSIONS = 30;

function isManagerRole(v: unknown): v is ManagerMessage['role'] {
  return v === 'user' || v === 'assistant' || v === 'system';
}

function sanitizeProposal(raw: unknown): ManagerMessage['proposal'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (
    (value.state !== 'pending' && value.state !== 'launching' && value.state !== 'accepted' && value.state !== 'rejected') ||
    typeof value.objective !== 'string' ||
    !Array.isArray(value.steps)
  ) return undefined;

  const steps = value.steps.flatMap((rawStep) => {
    if (!rawStep || typeof rawStep !== 'object') return [];
    const stepValue = rawStep as Record<string, unknown>;
    if (typeof stepValue.description !== 'string') return [];
    const step: NonNullable<ManagerMessage['proposal']>['steps'][number] = { description: stepValue.description };
    if (typeof stepValue.id === 'string') step.id = stepValue.id;
    if (typeof stepValue.agentName === 'string') step.agentName = stepValue.agentName;
    if (typeof stepValue.model === 'string') step.model = stepValue.model;
    if (typeof stepValue.modelId === 'string') step.modelId = stepValue.modelId;
    if (Array.isArray(stepValue.dependsOn)) step.dependsOn = stepValue.dependsOn.filter((id): id is string => typeof id === 'string');
    if (typeof stepValue.contestN === 'number') step.contestN = stepValue.contestN;
    if (stepValue.role === 'worker' || stepValue.role === 'evaluator' || stepValue.role === 'fixer' || stepValue.role === 'reflector') step.role = stepValue.role;
    if (stepValue.onFail === 'retry' || stepValue.onFail === 'fix' || stepValue.onFail === 'route' || stepValue.onFail === 'block' || stepValue.onFail === 'skip') step.onFail = stepValue.onFail;
    if (typeof stepValue.maxAttempts === 'number') step.maxAttempts = stepValue.maxAttempts;
    if (typeof stepValue.joinGroup === 'string') step.joinGroup = stepValue.joinGroup;
    return [step];
  });
  const proposal: NonNullable<ManagerMessage['proposal']> = {
    state: value.state,
    objective: value.objective,
    steps,
  };
  if (typeof value.planId === 'string') proposal.planId = value.planId;
  if (typeof value.estimatedCostUsd === 'number') proposal.estimatedCostUsd = value.estimatedCostUsd;
  if (typeof value.estimatedDurationMs === 'number') proposal.estimatedDurationMs = value.estimatedDurationMs;
  if (value.estimatedCreditsByModel && typeof value.estimatedCreditsByModel === 'object') {
    const entries = Object.entries(value.estimatedCreditsByModel as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number');
    if (entries.length > 0) proposal.estimatedCreditsByModel = Object.fromEntries(entries);
  }
  if (value.autonomyMode === 'manual' || value.autonomyMode === 'supervised' || value.autonomyMode === 'yolo' || value.autonomyMode === 'custom') proposal.autonomyMode = value.autonomyMode;
  if (Array.isArray(value.deferredActions)) proposal.deferredActions = value.deferredActions as ManagerAction[];
  // PERSISTED-INDEX DEADLOCK FIX — see ManagerMessage.proposal.deferredActionIndexes'
  // own doc comment (types.ts) for why this array exists at all. Restored
  // only when it is a real number[] of the EXACT same length as
  // `deferredActions` (hand-edited/corrupt/version-drifted storage degrades
  // to leaving it undefined, never a misaligned partial array) — the replay
  // loop's own fallback to reference-matching then applies exactly as it
  // did before this fix existed, same "never worse than before" contract
  // every other field in this function follows.
  const rawDeferredActionIndexes = value.deferredActionIndexes;
  if (
    Array.isArray(rawDeferredActionIndexes) &&
    proposal.deferredActions &&
    rawDeferredActionIndexes.length === proposal.deferredActions.length &&
    rawDeferredActionIndexes.every((n): n is number => typeof n === 'number' && Number.isInteger(n))
  ) {
    proposal.deferredActionIndexes = rawDeferredActionIndexes;
  }
  if (Array.isArray(value.citedLessonIds)) proposal.citedLessonIds = value.citedLessonIds.filter((id): id is string => typeof id === 'string');
  if (typeof value.errorMessage === 'string') proposal.errorMessage = value.errorMessage;
  return proposal;
}

/**
 * Rebuilds one ManagerMessage from a raw parsed localStorage entry, keeping
 * only the known/serializable fields and dropping anything else. Protects
 * against hand-edited or version-drifted storage, and against any FUTURE
 * ManagerMessage field that isn't plain JSON (e.g. a callback) ever leaking
 * through rehydration — it is simply never copied onto the reconstructed
 * object. Returns `null` when a required field is missing/mistyped, so the
 * caller can drop that one entry rather than surface a broken message.
 *
 * PENDING-APPROVAL PERSISTENCE FIX (see this module's own doc comment):
 * `actionStatuses`/`actionRefs` used to be silently dropped here — they are
 * plain JSON-safe (boolean[] / (string|undefined)[]), no different from
 * `actions` just above, which WAS already preserved. Restoring them is what
 * lets a reloaded message's action chip keep showing its real
 * denied/pending state instead of silently reading as a false success.
 */
function sanitizeMessage(raw: unknown): ManagerMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    !isManagerRole(r.role) ||
    typeof r.content !== 'string' ||
    typeof r.timestamp !== 'string'
  ) {
    return null;
  }
  const msg: ManagerMessage = { id: r.id, role: r.role, content: r.content, timestamp: r.timestamp };
  if (Array.isArray(r.actions)) msg.actions = r.actions as ManagerMessage['actions'];
  if (Array.isArray(r.actionStatuses)) {
    // CONSENT-BYPASS FIX: `.filter()` used to drop anything non-boolean —
    // harmless while `true`/`false` were the only values ever produced, but
    // `'deferred'` (ActionStatus's third member, types.ts) is now a real,
    // persisted value. Dropping it would shift every LATER entry's index
    // out of alignment with `actions`, silently mispairing a chip with the
    // wrong action after a reload. `.map()` preserves the index for every
    // slot; anything neither boolean nor `'deferred'` (corrupt/hand-edited
    // storage) degrades to `false` — never a fabricated success.
    msg.actionStatuses = r.actionStatuses.map((v): ActionStatus =>
      v === 'deferred' ? 'deferred' : typeof v === 'boolean' ? v : false);
  }
  if (Array.isArray(r.actionRefs)) {
    msg.actionRefs = r.actionRefs.map((v) => (typeof v === 'string' ? v : undefined));
  }
  if (typeof r.approxCreditsUsed === 'number') msg.approxCreditsUsed = r.approxCreditsUsed;
  if (typeof r.creditsBlocked === 'boolean') msg.creditsBlocked = r.creditsBlocked;
  if (typeof r.sessionBlocked === 'boolean') msg.sessionBlocked = r.sessionBlocked;
  if (typeof r.timedOut === 'boolean') msg.timedOut = r.timedOut;
  if (typeof r.retryText === 'string') msg.retryText = r.retryText;
  const proposal = sanitizeProposal(r.proposal);
  if (proposal) msg.proposal = proposal;
  return msg;
}

/**
 * Rebuilds one PersistedPendingApproval from a raw parsed localStorage
 * entry, same defensive boundary-validation as sanitizeMessage above.
 * `aliasEntries` degrades to `[]` (never a parse failure) when missing or
 * malformed — an empty rebuilt Map on restore, never a dropped entry.
 */
function sanitizePendingApproval(raw: unknown): PersistedPendingApproval | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    !r.action || typeof r.action !== 'object' ||
    typeof r.label !== 'string' ||
    typeof r.turnId !== 'string' ||
    typeof r.messageId !== 'string' ||
    typeof r.actionIndex !== 'number' ||
    typeof r.model !== 'string' ||
    typeof r.createdAt !== 'string'
  ) {
    return null;
  }
  const aliasEntries = Array.isArray(r.aliasEntries)
    ? r.aliasEntries.filter((e): e is [string, string] =>
        Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string')
    : [];
  const result: PersistedPendingApproval = {
    id: r.id,
    action: r.action as ManagerAction,
    label: r.label,
    turnId: r.turnId,
    messageId: r.messageId,
    actionIndex: r.actionIndex,
    model: r.model,
    aliasEntries,
    createdAt: r.createdAt,
  };
  if (r.lastFailure && typeof r.lastFailure === 'object') {
    const lf = r.lastFailure as Record<string, unknown>;
    if (typeof lf.reason === 'string') {
      result.lastFailure = { reason: lf.reason, canForce: typeof lf.canForce === 'boolean' ? lf.canForce : undefined };
    }
  }
  return result;
}

/** Rebuilds one ManagerSession from a raw parsed localStorage entry, or
 *  `null` when the entry is missing a required field — same defensive
 *  boundary-validation as sanitizeMessage above. */
function sanitizeSession(raw: unknown): ManagerSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.createdAt !== 'number' || typeof r.updatedAt !== 'number') {
    return null;
  }
  const messages = Array.isArray(r.messages)
    ? r.messages.map(sanitizeMessage).filter((m): m is ManagerMessage => m !== null)
    : [];
  // Optional (older persisted sessions never had this field) — absent means
  // "nothing was pending when this session was last saved", never a parse
  // failure (see PersistedPendingApproval's own doc comment).
  const pendingApprovals = Array.isArray(r.pendingApprovals)
    ? r.pendingApprovals.map(sanitizePendingApproval).filter((p): p is PersistedPendingApproval => p !== null)
    : [];
  const title = typeof r.title === 'string' && r.title.trim() ? r.title : undefined;
  return { id: r.id, messages, createdAt: r.createdAt, updatedAt: r.updatedAt, pendingApprovals, title };
}

function loadSessions(): ManagerSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeSession).filter((s): s is ManagerSession => s !== null);
  } catch {
    return [];
  }
}

function saveSessions(sessions: ManagerSession[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch { /* quota */ }
}

/** Keep-last N sessions by recency (`updatedAt`) — a no-op when already
 *  within budget. Mirrors missionCaps.ts's capActionTimeline/
 *  capManagerMessages shape (pure, always returns a new array). */
export function capManagerSessions(
  sessions: readonly ManagerSession[],
  max: number = MAX_MANAGER_SESSIONS,
): ManagerSession[] {
  if (sessions.length <= max) return [...sessions];
  return [...sessions].sort((a, b) => a.updatedAt - b.updatedAt).slice(-max);
}

/**
 * Mints a fresh manager session/conversation id. Multi-conversation
 * LazyManager (wave 1) reuses this SAME id as the live conversation id
 * (agentsStore.tsx's ManagerConversationState.id — "conversation id space
 * === session id space", see that type's own doc comment) — there is no
 * translation between the two anywhere in this app. Exported so the CALLER
 * (agentsStore.tsx) mints ids eagerly, since `saveMessages` below no longer
 * mints one implicitly.
 */
export function mintManagerSessionId(): string {
  return `manager-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persistence hook for the LazyManager rail's history — minus the
 * projectRoot scoping (see this module's doc comment above for why the
 * manager is global).
 *
 * ID-EAGER SHAPE (multi-conversation LazyManager, wave 1): this hook used
 * to own an internal `currentSessionId` slot and mint a session id lazily
 * on first save (plus a `flushAndSwitch` primitive to atomically move that
 * slot between two conversations — see this file's git history for the
 * race it existed to close). With SEVERAL conversations now live at once,
 * "the current session" is not a single slot this hook could own — each
 * open conversation has its OWN id, minted by the caller
 * (mintManagerSessionId above) the instant it opens. `saveMessages` is now
 * the ONLY write path, and the id is ALWAYS supplied by the caller: no
 * mint-on-first-save, no hidden slot, no `flushAndSwitch`/`newSession`
 * atomicity concern (each open conversation writes to its OWN id
 * independently — there is nothing to atomically move between two ids
 * anymore, since neither one is ever "the" current slot).
 */
export function useManagerPersistence() {
  const [sessions, setSessions] = useState<ManagerSession[]>(() => loadSessions());

  /** Writes `messages`/`pendingApprovals`/`title` under `sessionId` —
   *  creates the session if it doesn't exist yet, updates it in place
   *  otherwise. A no-op for an empty `messages` array (never persists an
   *  empty session, same guard the old lazy-mint version had). `title` is
   *  always the CALLER's current authoritative value (agentsStore.tsx's
   *  live `conv.customTitle`, threaded through on every call site) — this
   *  function never tries to merge/preserve a previous on-disk title of
   *  its own, so an explicit `undefined` here really does clear a
   *  previously-set name (the rename feature's own "empty the input to
   *  un-rename" contract). */
  const saveMessages = useCallback((
    sessionId: string,
    messages: ManagerMessage[],
    pendingApprovals: PersistedPendingApproval[] = [],
    title?: string,
  ) => {
    if (messages.length === 0) return;
    const now = Date.now();
    const cappedMessages = capManagerMessages(messages);
    setSessions(prev => {
      const exists = prev.some(s => s.id === sessionId);
      const updated = capManagerSessions(
        exists
          ? prev.map(s => (s.id === sessionId ? { ...s, messages: cappedMessages, updatedAt: now, pendingApprovals, title } : s))
          : [...prev, { id: sessionId, messages: cappedMessages, createdAt: now, updatedAt: now, pendingApprovals, title }],
      );
      saveSessions(updated);
      return updated;
    });
  }, []);

  /** Returns the session's messages, its own pending approvals (never just
   *  messages — see this module's own doc comment: a restored conversation
   *  without its pendingApprovals would show the right chat but never
   *  bring back the approval card), AND its custom title if it was ever
   *  renamed. `null` when the session id is unknown, same not-found
   *  contract as before. */
  const loadSession = useCallback((sessionId: string): { messages: ManagerMessage[]; pendingApprovals: PersistedPendingApproval[]; title?: string } | null => {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return null;
    return { messages: session.messages, pendingApprovals: session.pendingApprovals ?? [], title: session.title };
  }, [sessions]);

  const deleteSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const updated = prev.filter(s => s.id !== sessionId);
      saveSessions(updated);
      return updated;
    });
  }, []);

  return {
    sessions,
    saveMessages,
    loadSession,
    deleteSession,
  };
}

// ── Open working set (multi-conversation LazyManager, wave 2) ─────────
//
// FIX (real user QA, 2026-08-01 — item 1, "worse than not having tabs"):
// wave 1 (agentsStore.tsx's AgentsState.conversations/conversationOrder)
// only ever persisted each conversation's OWN transcript/pendingApprovals
// (saveMessages above) — WHICH conversations were open, in what order, and
// which one was active never left React state. `lazy.managerSessions` kept
// every past history, but `lazy.managerOpenSessions` (this key) simply did
// not exist: every restart collapsed back to exactly one conversation,
// silently discarding every other open tab even while a mission chain
// launched from one of them kept running unattended in the background.
//
// This module stores ONLY the layout (which session ids are open, in what
// order, which is active, which were mid-turn) — never a second copy of the
// transcripts themselves (those stay owned by `sessions` above/`saveMessages`,
// same "one source of truth per concern" split useChatPersistence already
// follows for the Code assistant). The caller (agentsStore.tsx's boot
// effect) cross-references `order` against `sessions` to rebuild each
// conversation's live state and MUST drop any id no longer present there
// (a session the user deleted from history) rather than resurrecting a
// tab with no backing data.
const OPEN_SESSIONS_KEY = 'lazy.managerOpenSessions';

export interface PersistedOpenWorkingSet {
  /** Open conversation ids, in tab-strip order — same id space as
   *  ManagerSession.id above (mintManagerSessionId mints both). */
  order: string[];
  /** Which of `order` was the active tab when this was last saved. Always
   *  a member of `order` by construction (see sanitizeOpenWorkingSet) —
   *  never a dangling id the caller would have to guess a fallback for. */
  activeId: string;
  /**
   * Ids that were BUSY (a manager turn genuinely in flight) at the moment
   * this was last saved. NEVER trusted as "still running" on restore — a
   * reload always drops every in-flight turn, there is no process to
   * reattach to (see agentsStore.tsx's managerAbortRef/runningManagerTurnsRef,
   * both plain in-memory, never persisted). Restoring this conversation
   * must come back idle; a caller uses this ONLY to decide whether to
   * append an honest "this was interrupted" system marker, never to resume
   * a turn.
   */
  busyIds: string[];
}

function sanitizeOpenWorkingSet(raw: unknown): PersistedOpenWorkingSet | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.order)) return null;
  const order = r.order.filter((id): id is string => typeof id === 'string');
  if (order.length === 0) return null;
  const busyIds = Array.isArray(r.busyIds)
    ? r.busyIds.filter((id): id is string => typeof id === 'string')
    : [];
  const activeId = typeof r.activeId === 'string' && order.includes(r.activeId) ? r.activeId : order[0];
  return { order, activeId, busyIds };
}

/** Reads the last-saved open-conversation layout, or `null` on first boot
 *  (never persisted yet) / a hand-edited or version-drifted value — the
 *  caller's fallback for `null` is exactly today's single-conversation
 *  boot behaviour (see agentsStore.tsx's mount-restore effect). */
export function loadOpenWorkingSet(): PersistedOpenWorkingSet | null {
  try {
    const raw = localStorage.getItem(OPEN_SESSIONS_KEY);
    if (!raw) return null;
    return sanitizeOpenWorkingSet(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Writes the current open-conversation layout. Plain overwrite (no cap of
 *  its own beyond `order.length`) — `order` is already bounded by
 *  MAX_OPEN_MANAGER_CONVERSATIONS on the caller's side (agentsStore.tsx),
 *  same "the caller enforces the cap, this module just persists whatever
 *  it's given" split saveMessages above already follows. */
export function saveOpenWorkingSet(order: string[], activeId: string, busyIds: string[]): void {
  try {
    const value: PersistedOpenWorkingSet = { order, activeId, busyIds };
    localStorage.setItem(OPEN_SESSIONS_KEY, JSON.stringify(value));
  } catch { /* quota */ }
}
