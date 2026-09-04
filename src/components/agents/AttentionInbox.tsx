/**
 * AttentionInbox — cockpit v2 surface showing missions that need human action.
 *
 * Pulls base items (review/failed/blocked) from the journal projection query
 * (T2.0 `queryAttentionInbox`), and derives two further kinds TS-side on top
 * of the same Mission/journal data (T3.2/T2.1 — see the plan's note on
 * projections.ts ownership: the Rust-side inbox projection is NOT extended
 * here, both journal.rs and projections.ts are owned by a concurrent task
 * this wave):
 *
 *   - 'question': a running mission's actionTimeline carries a live,
 *     unanswered `ask_user` observation (see toolRuntime.ts's 'ask_user'
 *     case — the ONLY real signal today that an agent is genuinely blocked
 *     on a human answer; there is no dedicated engine-side mission.question
 *     producer yet, since wiring one at the tool-execution site would touch
 *     toolRuntime.ts/managedAgent.ts, both out of this task's file scope).
 *     Before such a question is ever shown here, it is run through the
 *     decision registry (lib/brain/decisions.ts): a confident match
 *     auto-answers it (interveneMission + mission.answered) and it never
 *     reaches the list; otherwise it appears as kind 'question' with an
 *     inline answer box.
 *   - 'budget': a running-but-paused mission whose most recent relevant
 *     journal event is `budget.warning` (i.e. paused by the T1.3 budget
 *     enforcer, not by a manual pauseMission()) — surfaced with a
 *     raise-cap control.
 *
 * Both derivations are best-effort and journal/store-grounded — never
 * fabricated: see extractPendingQuestionText/classifyBudgetPause below.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useAgentsStore, resolveProjectRoot } from './agentsStore';
import { ApproveBlockedError } from './approveGate';
import { queryAttentionInbox, type AttentionItem } from '../../lib/journal/projections';
import { emitEvent, journalQuery } from '../../lib/journal/journal';
import { projectIdFromRoot } from '../../lib/journal/projectId';
import type { BudgetWarningPayload, DurationWarningPayload, MissionQuestionPayload } from '../../lib/journal/eventTypes';
import { lookupDecision } from '../../lib/brain/decisions';
import { extractPendingQuestionOptions, extractPendingQuestionText, recordMissionAnswer } from '../../lib/agents/missionQuestion';
import { isTauri } from '../../lib/platform';
import type { Mission } from '../../lib/agents/types';
import { EmptyState, useToast } from '../ui';
import { CpuIcon } from '../icons';

// ── Kinds + colors ───────────────────────────────────────────────────

type InboxKind = 'approval' | 'question' | 'blocked' | 'budget' | 'duration';

interface InboxEntry {
  kind: InboxKind;
  missionId: string;
  projectId: string;
  reason: string;
  updatedMs: number;
  /** Present only for kind 'question' — the raw question text. */
  question?: string;
  /** W-COST (quick-reply wave) — present only for kind 'question', and only
   *  when the agent's ask_user call actually supplied structured options
   *  (missionQuestion.ts's extractPendingQuestionOptions — never fabricated
   *  when the agent asked a genuinely open-ended question). Rendered as
   *  one-click numbered buttons ABOVE the always-present free-text fallback. */
  options?: string[];
  /** Present only for kind 'budget' — the cap in force when paused. */
  budgetCapUsd?: number;
  /** Present only for kind 'duration' — the wall-clock cap (ms) in force
   *  when paused (mirrors budgetCapUsd — see MissionContract.maxDurationMs). */
  durationCapMs?: number;
}

const KIND_COLORS: Record<InboxKind, string> = {
  approval: '#FBB924',
  question: '#7C5CFF',
  blocked: '#F87171',
  budget: '#FB923C',
  duration: '#38BDF8',
};

const KIND_BG: Record<InboxKind, string> = {
  approval: 'rgba(251,185,36,0.10)',
  question: 'rgba(124,92,255,0.10)',
  blocked: 'rgba(248,113,113,0.10)',
  budget: 'rgba(251,146,60,0.10)',
  duration: 'rgba(56,189,248,0.10)',
};

const KIND_LABEL_KEY: Record<InboxKind, string> = {
  approval: 'agents.inbox.kindApproval',
  question: 'agents.inbox.kindQuestion',
  blocked: 'agents.inbox.kindBlocked',
  budget: 'agents.inbox.kindBudget',
  duration: 'agents.inbox.kindDuration',
};

const BUDGET_RAISE_MULTIPLIER = 1.5;
/** Fixed extension granted by the duration card's « +30 min » action
 *  (task requirement — unlike budget's editable RaiseCapForm, this is a
 *  single fixed-amount action, no user-editable input). */
const EXTEND_DURATION_MS = 30 * 60_000;

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Short human-readable duration for the 'duration' card's "elapsed / cap"
 *  display (e.g. "13min", "1h30min"). */
function formatDurationShort(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}min`;
}

// ── Pure helpers ───────────────────────────────────────────────────

function baseItemToEntry(item: AttentionItem): InboxEntry {
  return {
    kind: item.status === 'review' ? 'approval' : 'blocked',
    missionId: item.mission_id,
    projectId: item.project_id,
    reason: item.reason,
    updatedMs: item.updated_ms,
  };
}

/** Non-Tauri (web/mock) fallback — mirrors the pre-existing behavior: no
 *  Rust backend, so 'blocked' (a Rust-only status derived from mission.blocked
 *  events with no resolution) is unavailable; only review/failed missions
 *  from local state are shown. */
function missionToLocalEntry(m: Mission): InboxEntry {
  return {
    kind: m.status === 'review' ? 'approval' : 'blocked',
    missionId: m.id,
    projectId: 'local',
    reason: m.status === 'review' ? 'Awaiting approval' : 'Mission failed',
    updatedMs: m.createdAt ?? Date.now(),
  };
}

async function currentProjectId(): Promise<string> {
  const root = await resolveProjectRoot();
  return projectIdFromRoot(root);
}

/**
 * Classify a paused+running mission as budget-paused (kind 'budget') or not,
 * from the journal — the only durable signal, since onBudgetPaused
 * (agentsStore.tsx) sets the same `paused` flag a manual pauseMission() does,
 * with no distinguishing field on Mission itself. Looks at the most recent
 * of {budget.warning, mission.paused, mission.resumed} for this mission:
 * budget.warning latest -> still budget-paused; anything else latest (a
 * manual pause came after, or it was already resumed) -> not a budget item.
 * Returns null (not [] ambiguity) on journal failure/unavailability — fails
 * closed, never fabricates a raise-cap affordance it can't justify.
 */
async function classifyBudgetPause(mission: Mission): Promise<InboxEntry | null> {
  const rows = await journalQuery({
    missionId: mission.id,
    types: ['budget.warning', 'mission.resumed', 'mission.paused'],
  });
  if (rows.length === 0) return null;

  const latest = [...rows].sort((a, b) => a.seq - b.seq).at(-1);
  if (!latest || latest.type !== 'budget.warning') return null;

  try {
    const payload = JSON.parse(latest.payload) as BudgetWarningPayload;
    return {
      kind: 'budget',
      missionId: mission.id,
      projectId: latest.project_id,
      reason: `${payload.pct}% of $${payload.capUsd.toFixed(2)} cap`,
      updatedMs: latest.ts_ms,
      budgetCapUsd: payload.capUsd,
    };
  } catch {
    return null;
  }
}

/**
 * Classify a paused+running mission as duration-paused (kind 'duration') or
 * not — the missing link for W-GUARD's wall-clock cap: onDurationPaused
 * (agentsStore.tsx) sets the SAME `paused` flag onBudgetPaused/a manual
 * pauseMission() does, with no distinguishing field on Mission itself, so
 * this reads the journal exactly like classifyBudgetPause above (same
 * shape, same fail-closed-on-ambiguity contract), just against
 * duration.warning instead of budget.warning.
 */
async function classifyDurationPause(mission: Mission): Promise<InboxEntry | null> {
  const rows = await journalQuery({
    missionId: mission.id,
    types: ['duration.warning', 'mission.resumed', 'mission.paused'],
  });
  if (rows.length === 0) return null;

  const latest = [...rows].sort((a, b) => a.seq - b.seq).at(-1);
  if (!latest || latest.type !== 'duration.warning') return null;

  try {
    const payload = JSON.parse(latest.payload) as DurationWarningPayload;
    const elapsedMs = Math.round((payload.capMs * payload.pct) / 100);
    return {
      kind: 'duration',
      missionId: mission.id,
      projectId: latest.project_id,
      reason: `${formatDurationShort(elapsedMs)} / ${formatDurationShort(payload.capMs)} (${payload.pct}%)`,
      updatedMs: latest.ts_ms,
      durationCapMs: payload.capMs,
    };
  } catch {
    return null;
  }
}

// ── Sub-components ───────────────────────────────────────────────────

/** Inline free-text answer box for a 'question' item. Manages its own draft
 *  text so the parent list doesn't need a per-mission draft dictionary. */
function QuestionAnswerForm({
  missionId,
  onSubmit,
  placeholder,
  submitLabel,
}: {
  missionId: string;
  onSubmit: (answer: string) => Promise<void>;
  placeholder: string;
  submitLabel: string;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      setValue('');
    } finally {
      setBusy(false);
    }
  }, [value, busy, onSubmit]);

  return (
    <div
      style={{ display: 'flex', gap: 6, marginTop: 8 }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        data-testid={`inbox-answer-input-${missionId}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmit(); }}
        placeholder={placeholder}
        disabled={busy}
        style={{
          flex: 1,
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid rgba(124,92,255,0.30)',
          background: 'rgba(124,92,255,0.06)',
          color: '#E2E2F0',
          fontSize: 12,
          fontFamily: 'inherit',
        }}
      />
      <button
        data-testid={`inbox-answer-submit-${missionId}`}
        onClick={() => void handleSubmit()}
        disabled={busy || !value.trim()}
        style={{
          padding: '6px 14px',
          borderRadius: 6,
          border: '1px solid rgba(124,92,255,0.35)',
          background: 'rgba(124,92,255,0.12)',
          color: '#C4B5FD',
          fontSize: 12,
          cursor: busy ? 'default' : 'pointer',
          fontFamily: 'inherit',
          fontWeight: 600,
        }}
      >
        {submitLabel}
      </button>
    </div>
  );
}

/** Inline raise-cap control for a 'budget' item — prefilled at +50% (task
 *  requirement: "+50% or input"), editable to any custom amount. */
function RaiseCapForm({
  missionId,
  currentCapUsd,
  onSubmit,
  applyLabel,
}: {
  missionId: string;
  currentCapUsd: number;
  onSubmit: (newCapUsd: number) => Promise<void>;
  applyLabel: string;
}) {
  const [value, setValue] = useState(() => (currentCapUsd * BUDGET_RAISE_MULTIPLIER).toFixed(2));
  const [busy, setBusy] = useState(false);

  const handleSubmit = useCallback(async () => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= currentCapUsd || busy) return;
    setBusy(true);
    try {
      await onSubmit(parsed);
    } finally {
      setBusy(false);
    }
  }, [value, currentCapUsd, busy, onSubmit]);

  return (
    <div
      style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}
      onClick={(e) => e.stopPropagation()}
    >
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>$</span>
      <input
        data-testid={`inbox-raise-cap-input-${missionId}`}
        type="number"
        step="0.01"
        min={currentCapUsd}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
        style={{
          width: 90,
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid rgba(251,146,60,0.30)',
          background: 'rgba(251,146,60,0.06)',
          color: '#E2E2F0',
          fontSize: 12,
          fontFamily: 'inherit',
        }}
      />
      <button
        data-testid={`inbox-raise-cap-submit-${missionId}`}
        onClick={() => void handleSubmit()}
        disabled={busy}
        style={{
          padding: '6px 14px',
          borderRadius: 6,
          border: '1px solid rgba(251,146,60,0.35)',
          background: 'rgba(251,146,60,0.12)',
          color: '#FDBA74',
          fontSize: 12,
          cursor: busy ? 'default' : 'pointer',
          fontFamily: 'inherit',
          fontWeight: 600,
        }}
      >
        {applyLabel}
      </button>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

export function AttentionInbox() {
  const { t } = useI18n();
  const { toast } = useToast();
  const {
    missions,
    setSelectedMissionId,
    interveneMission,
    approveMission,
    retryMission,
    takeoverMission,
    resumeMission,
    updateMission,
  } = useAgentsStore();

  const [baseEntries, setBaseEntries] = useState<InboxEntry[]>([]);
  const [derivedEntries, setDerivedEntries] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [blockedErrors, setBlockedErrors] = useState<Record<string, string>>({});
  const [approvingIds, setApprovingIds] = useState<Record<string, boolean>>({});

  const missionsRef = useRef(missions);
  useEffect(() => { missionsRef.current = missions; }, [missions]);

  /** Per-mission question state across refreshes — key is the actionTimeline
   *  length at which the question was first seen, so a NEW occurrence (even
   *  an identical question text asked again later) is re-evaluated, while
   *  the SAME still-open occurrence is never re-emitted/re-looked-up.
   *  Session-scoped by design (not journal-durable across app restarts) —
   *  acceptable for this task's scope; see the module doc comment. */
  const questionStateRef = useRef(new Map<string, { key: number; question: string; autoAnswered: boolean; projectId: string }>());
  /** Caches a mission's budget classification while it stays paused, so an
   *  unrelated re-render (another mission's timeline growing) doesn't refire
   *  a journalQuery for a mission whose pause state hasn't changed. */
  const budgetCacheRef = useRef(new Map<string, InboxEntry | null>());
  /** Same caching contract as budgetCacheRef, for the duration classification. */
  const durationCacheRef = useRef(new Map<string, InboxEntry | null>());

  // ── Base items (review/approval/blocked) — Rust-projected, polled every
  // 30s (unchanged cadence from before this task). Reads missions via a ref
  // so the timer itself never restarts on every mission update. ──
  const refreshBase = useCallback(async () => {
    const base = await queryAttentionInbox();
    const entries = isTauri()
      ? base.map(baseItemToEntry)
      : missionsRef.current
          .filter((m) => m.status === 'review' || m.status === 'failed')
          .map(missionToLocalEntry);
    setBaseEntries(entries);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refreshBase();
    const interval = setInterval(() => void refreshBase(), 30_000);
    return () => clearInterval(interval);
  }, [refreshBase]);

  // ── Derived items (question/budget) — reacts to mission changes directly
  // (a blocked agent shouldn't wait out a 30s poll to surface). The actual
  // IPC work (emit/lookup/journalQuery) only fires for genuinely NEW
  // occurrences, guarded by questionStateRef/budgetCacheRef. ──
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const running = missions.filter((m) => m.status === 'running');
      const results: InboxEntry[] = [];

      for (const mission of running) {
        const pendingQuestion = extractPendingQuestionText(mission);
        const timelineLength = mission.actionTimeline?.length ?? 0;

        if (pendingQuestion) {
          const known = questionStateRef.current.get(mission.id);
          if (!known || known.key !== timelineLength) {
            const projectId = await currentProjectId();
            await emitEvent({
              type: 'mission.question',
              tsMs: Date.now(),
              projectId,
              missionId: mission.id,
              actor: 'agent',
              payload: { question: pendingQuestion } satisfies MissionQuestionPayload,
            });

            const hit = await lookupDecision(pendingQuestion);
            if (hit.found && hit.answer) {
              interveneMission(mission.id, hit.answer);
              await emitEvent({
                type: 'mission.answered',
                tsMs: Date.now(),
                projectId,
                missionId: mission.id,
                actor: 'system',
                payload: { answer: hit.answer, decisionId: hit.decisionId },
              });
              questionStateRef.current.set(mission.id, { key: timelineLength, question: pendingQuestion, autoAnswered: true, projectId });
              toast(t('agents.inbox.autoAnswered'), 'info');
            } else {
              questionStateRef.current.set(mission.id, { key: timelineLength, question: pendingQuestion, autoAnswered: false, projectId });
            }
          }

          const state = questionStateRef.current.get(mission.id);
          if (state && !state.autoAnswered) {
            results.push({
              kind: 'question',
              missionId: mission.id,
              projectId: state.projectId,
              reason: state.question,
              updatedMs: Date.now(),
              question: state.question,
              options: extractPendingQuestionOptions(mission) ?? undefined,
            });
          }
        } else {
          questionStateRef.current.delete(mission.id);
        }

        if (mission.paused) {
          if (!budgetCacheRef.current.has(mission.id)) {
            budgetCacheRef.current.set(mission.id, await classifyBudgetPause(mission));
          }
          const budgetEntry = budgetCacheRef.current.get(mission.id);
          if (budgetEntry) results.push(budgetEntry);

          if (!durationCacheRef.current.has(mission.id)) {
            durationCacheRef.current.set(mission.id, await classifyDurationPause(mission));
          }
          const durationEntry = durationCacheRef.current.get(mission.id);
          if (durationEntry) results.push(durationEntry);
        } else {
          budgetCacheRef.current.delete(mission.id);
          durationCacheRef.current.delete(mission.id);
        }
      }

      if (!cancelled) setDerivedEntries(results);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- interveneMission/t/toast are store/i18n callbacks recreated often; re-running this effect on their identity churn (rather than only on `missions`) is harmless since all IPC work is idempotent/guarded above.
  }, [missions]);

  // ── Actions ──────────────────────────────────────────────────────

  const handleApprove = useCallback(async (missionId: string, force: boolean) => {
    setApprovingIds((p) => ({ ...p, [missionId]: true }));
    try {
      const repoPath = await resolveProjectRoot();
      await approveMission(missionId, repoPath, force ? { force: true } : undefined);
      setBlockedErrors((p) => { const next = { ...p }; delete next[missionId]; return next; });
    } catch (err) {
      if (err instanceof ApproveBlockedError) {
        setBlockedErrors((p) => ({ ...p, [missionId]: err.reason }));
      } else {
        toast(`${t('common.error')}: ${String(err)}`, 'error');
      }
    } finally {
      setApprovingIds((p) => ({ ...p, [missionId]: false }));
    }
  }, [approveMission, toast, t]);

  const handleRetry = useCallback((missionId: string) => {
    retryMission(missionId);
  }, [retryMission]);

  const handleTakeover = useCallback((missionId: string) => {
    void takeoverMission(missionId);
  }, [takeoverMission]);

  /** The answer flow closing the decision loop (spec §6, T3.2's missing
   *  caller): intervene delivers the answer to the running mission, then
   *  createDecision persists the Q/A pair so an identical future question
   *  auto-answers via lookupDecision above — no re-ask. */
  const handleAnswer = useCallback(async (missionId: string, question: string, answer: string) => {
    interveneMission(missionId, answer);
    const projectId = await currentProjectId();
    await recordMissionAnswer({ missionId, question, answer, projectId, actor: 'user' });
    questionStateRef.current.delete(missionId);
    setDerivedEntries((prev) => prev.filter((e) => !(e.missionId === missionId && e.kind === 'question')));
  }, [interveneMission]);

  const handleRaiseCap = useCallback(async (missionId: string, newCapUsd: number) => {
    const mission = missionsRef.current.find((m) => m.id === missionId);
    if (!mission?.contract) return;
    updateMission({ id: missionId, patch: { contract: { ...mission.contract, budgetCapUsd: newCapUsd } } });
    resumeMission(missionId);
    budgetCacheRef.current.delete(missionId);
  }, [updateMission, resumeMission]);

  /** « +30 min » action for a duration-paused mission — mirrors handleRaiseCap
   *  exactly: an immutable contract update through updateMission, then the
   *  same real resumeMission() a manual Resume click uses. */
  const handleExtendDuration = useCallback((missionId: string) => {
    const mission = missionsRef.current.find((m) => m.id === missionId);
    const currentCapMs = mission?.contract?.maxDurationMs;
    if (!mission?.contract || currentCapMs === undefined) return;
    updateMission({
      id: missionId,
      patch: { contract: { ...mission.contract, maxDurationMs: currentCapMs + EXTEND_DURATION_MS } },
    });
    resumeMission(missionId);
    durationCacheRef.current.delete(missionId);
  }, [updateMission, resumeMission]);

  // ── Render ───────────────────────────────────────────────────────

  const entries = [...baseEntries, ...derivedEntries].sort((a, b) => b.updatedMs - a.updatedMs);

  if (!loading && entries.length === 0) {
    return (
      <div
        data-testid="attention-inbox"
        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <EmptyState
          icon={CpuIcon}
          title={t('agents.inbox.emptyTitle')}
          subtitle={t('agents.inbox.emptySubtitle')}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="attention-inbox"
      style={{
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflowY: 'auto',
        height: '100%',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.45)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: 4,
        }}
      >
        {t('agents.inbox.title')} ({entries.length})
      </div>
      {entries.map((entry) => {
        const color = KIND_COLORS[entry.kind];
        const bg = KIND_BG[entry.kind];
        const mission = missions.find((m) => m.id === entry.missionId);
        const canTakeover = mission?.status === 'running';

        const hasQuickOptions = entry.kind === 'question' && !!entry.options && entry.options.length > 0;

        return (
          <div
            key={`${entry.kind}-${entry.missionId}`}
            data-testid={`inbox-item-${entry.missionId}`}
            // W-COST (quick-reply wave) — numeric quick-reply while this item
            // is focused (task requirement: "pressing the number key while
            // the item is focused answers"). Only wired when there is
            // actually a numbered list to answer from; every other item kind
            // stays exactly as before (no tabIndex, no key handling).
            tabIndex={hasQuickOptions ? 0 : undefined}
            onKeyDown={
              hasQuickOptions
                ? (e) => {
                    const index = Number(e.key) - 1;
                    if (!Number.isInteger(index) || index < 0 || index >= entry.options!.length) return;
                    e.preventDefault();
                    void handleAnswer(entry.missionId, entry.question!, entry.options![index]);
                  }
                : undefined
            }
            style={{
              display: 'flex',
              flexDirection: 'column',
              padding: '10px 14px',
              borderRadius: 8,
              border: `1px solid ${color}33`,
              background: bg,
              fontFamily: 'inherit',
            }}
          >
            <div
              onClick={() => setSelectedMissionId(entry.missionId)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: '#E2E2F0',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {entry.missionId}
                  </span>
                  <span
                    data-testid={`inbox-kind-${entry.missionId}`}
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color,
                      border: `1px solid ${color}55`,
                      borderRadius: 4,
                      padding: '1px 5px',
                      flexShrink: 0,
                    }}
                  >
                    {t(KIND_LABEL_KEY[entry.kind])}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                  {entry.reason} · {entry.projectId}
                </div>
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {timeAgo(entry.updatedMs)}
              </div>
            </div>

            {entry.kind === 'approval' && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                <button
                  data-testid={`inbox-approve-${entry.missionId}`}
                  onClick={() => void handleApprove(entry.missionId, false)}
                  disabled={approvingIds[entry.missionId]}
                  style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(74,222,128,0.35)', background: 'rgba(74,222,128,0.12)', color: '#4ADE80', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}
                >
                  {t('agents.detail.approveAndMerge')}
                </button>
                {blockedErrors[entry.missionId] && (
                  <button
                    data-testid={`inbox-force-approve-${entry.missionId}`}
                    onClick={() => void handleApprove(entry.missionId, true)}
                    disabled={approvingIds[entry.missionId]}
                    title={t('agents.detail.forceMergeTitle')}
                    style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(251,185,36,0.35)', background: 'rgba(251,185,36,0.10)', color: '#FBB924', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}
                  >
                    {t('agents.detail.forceApprove')}
                  </button>
                )}
              </div>
            )}
            {blockedErrors[entry.missionId] && entry.kind === 'approval' && (
              <div
                data-testid={`inbox-blocked-reason-${entry.missionId}`}
                style={{ marginTop: 6, padding: '6px 10px', borderRadius: 6, background: 'rgba(251,185,36,0.08)', border: '1px solid rgba(251,185,36,0.22)', color: '#FBB924', fontSize: 11 }}
              >
                {blockedErrors[entry.missionId]}
              </div>
            )}

            {entry.kind === 'blocked' && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                <button
                  data-testid={`inbox-retry-${entry.missionId}`}
                  onClick={() => handleRetry(entry.missionId)}
                  style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(124,92,255,0.35)', background: 'rgba(124,92,255,0.10)', color: '#C4B5FD', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}
                >
                  {t('agents.detail.retry')}
                </button>
                {canTakeover && (
                  <button
                    data-testid={`inbox-takeover-${entry.missionId}`}
                    onClick={() => handleTakeover(entry.missionId)}
                    style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(251,185,36,0.35)', background: 'rgba(251,185,36,0.10)', color: '#FBB924', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}
                  >
                    {t('agents.detail.takeover')}
                  </button>
                )}
              </div>
            )}

            {/* W-COST (quick-reply wave) — one-click numbered options, when
                the agent's ask_user call actually supplied any (see
                InboxEntry.options's doc comment). Answers directly via
                recordMissionAnswer's real flow (handleAnswer below) — no
                mission-detail navigation, no modal. Always alongside (never
                instead of) the free-text fallback right below it, so a human
                whose real answer isn't one of the offered options is never
                stuck. */}
            {hasQuickOptions && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                {entry.options!.map((option, index) => (
                  <button
                    key={option}
                    type="button"
                    data-testid={`inbox-option-${entry.missionId}-${index}`}
                    onClick={() => void handleAnswer(entry.missionId, entry.question!, option)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      textAlign: 'left',
                      padding: '6px 10px',
                      borderRadius: 6,
                      border: '1px solid rgba(124,92,255,0.30)',
                      background: 'rgba(124,92,255,0.08)',
                      color: '#C4B5FD',
                      fontSize: 12,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontWeight: 500,
                    }}
                  >
                    <span style={{ fontWeight: 700, opacity: 0.7 }}>{index + 1}.</span>
                    {option}
                  </button>
                ))}
              </div>
            )}
            {entry.kind === 'question' && entry.question && (
              <QuestionAnswerForm
                missionId={entry.missionId}
                placeholder={t('agents.inbox.answerPlaceholder')}
                submitLabel={t('agents.inbox.answerSubmit')}
                onSubmit={(answer) => handleAnswer(entry.missionId, entry.question!, answer)}
              />
            )}

            {entry.kind === 'budget' && entry.budgetCapUsd !== undefined && (
              <RaiseCapForm
                missionId={entry.missionId}
                currentCapUsd={entry.budgetCapUsd}
                applyLabel={t('agents.inbox.raiseCapSubmit')}
                onSubmit={(newCap) => handleRaiseCap(entry.missionId, newCap)}
              />
            )}

            {entry.kind === 'duration' && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                <button
                  data-testid={`inbox-extend-duration-${entry.missionId}`}
                  onClick={() => handleExtendDuration(entry.missionId)}
                  style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(56,189,248,0.35)', background: 'rgba(56,189,248,0.12)', color: '#7DD3FC', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}
                >
                  {t('agents.inbox.extendDuration')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
