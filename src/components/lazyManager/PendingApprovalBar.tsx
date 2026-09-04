/* PendingApprovalBar — the persistent, pinned-above-composer approval
   surface (real-user design 2026-08-03, Cursor/Windsurf-style — see
   LazyManager.tsx's own mounting comment for why this exists ALONGSIDE
   PendingApprovalCard.tsx's in-transcript card): one click, always visible,
   works in every approval mode.

   SAFETY FIX (2026-08-15): this bar used to render ONLY a bare count
   ("N action(s) awaiting approval") and two bulk buttons — no tool name, no
   argument, no way to see what was actually being approved, and the count
   text was not interactive despite looking like it might be. A user
   approving from here was approving BLIND: this app runs shell commands and
   writes files on the real machine, so that is unacceptable. This bar is
   now the ONE place that MUST show, for every pending action: what it is
   (`actionType`, the raw ManagerAction discriminant) and what it targets
   (`label`, already action-type + key-argument prose from
   describePendingAction — see agentsStore.tsx). Each row also gets its own
   Approve/Reject, so a single risky action in a batch can be approved or
   rejected without an all-or-nothing bulk click.

   PLURALIZATION FIX (2026-08-15): "1 action(s) awaiting approval" was a
   hand-rolled English pluralization cop-out baked into the FRENCH string
   too ("1 action(s) en attente") — wrong in both languages. The count text
   and the bulk-vs-singular button wording are now both driven by the real
   count via i18n/plural.ts's `pluralKey` (CLDR Intl.PluralRules, the shared
   helper this codebase already extracted from LeadView.tsx's team header —
   reused here rather than re-derived a third time).

   HONESTY FIX (real user report, 2026-08-14 — "M4/M5 zombie approval loop"
   incident): this bar used to fire approve/reject-all as pure
   fire-and-forget calls (LazyManager.tsx: `void agents.approvePendingAction
   (...)`), discarding the real outcome entirely — a blocked approve_mission
   (e.g. M4's merge genuinely refused by the backend) rendered NO reason at
   all, the row just sat there, and repeatedly clicking "Tout approuver"
   silently failed every time with zero feedback (the exact defect
   PendingApprovalCard.tsx's own 2026-07-28 honesty fix already solved for
   the in-transcript card — see that file's module doc comment). This bar
   now applies the SAME contract: `onApprove`/`onApproveAll`/`onForce`
   resolve to the REAL outcome (never assumed success just because the call
   was made), a failed attempt shows the system's own reason verbatim and,
   when a force retry might resolve it (approve_mission's judge/proof
   bypass), an explicit Force button — mirrors PendingApprovalCard's
   `toFailedState`/`isJudgeUnavailableFailure` conventions (kept LOCAL here,
   not imported, matching this file's own established "plain, decoupled
   shape" convention — see `PendingApprovalBarItem`'s doc comment). Unlike
   the card, a row that resolves to a genuine SUCCESS needs no local
   "approved" state of its own: the store removes it from
   `pendingApprovals` the instant it succeeds, so it simply stops appearing
   in the next `pending` prop — only `resolving` and `failed` need to be
   tracked here at all.

   CROSS-TURN BULK FIX (same incident): `pending` intentionally lists EVERY
   currently-unresolved action across the WHOLE conversation, not just one
   manager turn's batch (see LazyManager.tsx's pendingApprovalBarItems) —
   but the store's own approveAllPendingActions/rejectAllPendingActions are
   turn-scoped (they group a turn's results into one digest message). The
   bulk buttons here used to call them with only `pending[0].turnId`, so a
   SECOND stuck action from a LATER turn (exactly the shape a manager
   re-proposing a blocked approve_mission across turns produces) was
   silently left out of "Tout approuver" no matter how many times it was
   clicked — indistinguishable, from the user's seat, from the button doing
   nothing. `approveAll`/`rejectAll` below now call the turn-scoped
   primitive once per DISTINCT turnId actually present in `pending`, so the
   bulk action really does act on everything the bar is showing. */

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { truncateMiddle } from '../../lib/truncateMiddle';
import { pluralKey } from '../../i18n/plural';
import { JUDGE_UNAVAILABLE_PROVIDER_REASON } from '../../lib/agents/evaluator';

/** One pending action, already reduced to the plain shape this
 *  presentational component needs — LazyManager.tsx maps the store's own
 *  (unexported) PendingApprovalAction into this shape, same
 *  decoupling convention PendingApprovalCard.tsx's own PendingApprovalItem
 *  already establishes for the in-transcript card. */
export interface PendingApprovalBarItem {
  id: string;
  /** Raw ManagerAction discriminant (e.g. "retry_mission", "open_project")
   *  — the literal tool/action name, shown as its own small badge so it
   *  never depends on the prose in `label` actually naming it clearly. */
  actionType: string;
  /** Compact, human-readable "action : key argument" summary — may itself
   *  already be a truncated preview (see describePendingAction's own doc
   *  comment) if the underlying argument is long free-form text. */
  label: string;
  /** Full, UNTRUNCATED counterpart to `label` (describePendingActionDetail)
   *  — revealed by this row's expand affordance whenever it carries more
   *  than `label` already shows. */
  detail: string;
  turnId: string;
  /** Set when the STORE already knows this entry's last approval attempt
   *  failed (mirrors agentsStore.tsx's PendingApprovalAction.lastFailure /
   *  PendingApprovalCard.tsx's own `lastFailure` seeding) — reflected as a
   *  failed row even on a fresh mount that never itself triggered the
   *  attempt that failed. */
  lastFailure?: PendingApprovalBarFailure;
}

/** Shared shape for a failed approval attempt's detail — mirrors
 *  PendingApprovalCard.tsx's own PendingApprovalFailureDetail (kept as a
 *  SEPARATE local type rather than imported, per this file's established
 *  decoupling convention — see PendingApprovalBarItem's own doc comment). */
export interface PendingApprovalBarFailure {
  reason: string;
  canForce?: boolean;
  /** True when `reason` reflects an evaluation that never actually ran
   *  (judge/evaluator provider unavailable), never a genuine rejection —
   *  same honesty distinction as PendingApprovalCard.tsx's own
   *  isJudgeUnavailableFailure. */
  judgeUnavailable?: boolean;
}

/** Real outcome of one approval attempt — structurally mirrors (never
 *  imports) agentsStore.tsx's own PendingApprovalOutcome. */
export interface PendingApprovalBarOutcome {
  ok: boolean;
  reason?: string;
  canForce?: boolean;
  judgeUnavailable?: boolean;
}

export interface PendingApprovalBarProps {
  pending: PendingApprovalBarItem[];
  onApprove: (id: string) => Promise<PendingApprovalBarOutcome>;
  onReject: (id: string) => void;
  onApproveAll: (turnId: string) => Promise<Array<{ id: string } & PendingApprovalBarOutcome>>;
  onRejectAll: (turnId: string) => void;
  /** Retries a failed approve_mission bypassing the judge/proof gate — same
   *  primitive as PendingApprovalCard.tsx's own `onForce`. Optional: only
   *  rendered for a failure whose own `canForce` says a retry might help,
   *  and only when the caller actually wires it up. */
  onForce?: (id: string) => Promise<PendingApprovalBarOutcome>;
}

type RowDecision =
  | { kind: 'resolving' }
  | ({ kind: 'failed' } & PendingApprovalBarFailure);

/** Compact-row label budget — the bar is a thin strip, not the transcript
 *  card's full-width column, so the label is middle-truncated (never loses
 *  a distinguishing suffix like a mission id or a path's final segment) at
 *  render time regardless of whether `detail` carries anything extra. */
const ROW_LABEL_MAX = 64;

const barButtonStyle = (variant: 'accent' | 'outline'): React.CSSProperties => ({
  fontSize: 11,
  fontWeight: 600,
  padding: '3px 10px',
  borderRadius: 6,
  border: variant === 'accent' ? '1px solid rgba(52, 199, 89, 0.5)' : '1px solid rgba(255, 69, 58, 0.5)',
  background: variant === 'accent' ? 'rgba(52, 199, 89, 0.12)' : 'rgba(255, 69, 58, 0.1)',
  color: variant === 'accent' ? '#34c759' : '#ff453a',
  cursor: 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0,
});

const dangerColor = 'var(--color-danger, #dc2626)';

/** Mirrors PendingApprovalCard.tsx's own isJudgeUnavailableFailure — best-
 *  effort text match for evaluator.ts's stable marker when the caller
 *  didn't already supply the explicit `judgeUnavailable` flag. */
function isJudgeUnavailableFailure(failure: PendingApprovalBarFailure): boolean {
  if (failure.judgeUnavailable) return true;
  return failure.reason.includes(JUDGE_UNAVAILABLE_PROVIDER_REASON);
}

export function PendingApprovalBar({ pending, onApprove, onReject, onApproveAll, onRejectAll, onForce }: PendingApprovalBarProps) {
  const { t, locale } = useI18n();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});

  // Seed/refresh local `decisions` from the store's own `lastFailure` — same
  // convention as PendingApprovalCard.tsx's own effect: the store is the
  // source of truth for a failure, so a row must reflect it even if this
  // bar never itself triggered the attempt that failed (e.g. it already
  // failed before this bar re-rendered, or a different surface — the
  // in-transcript card — is what actually clicked Approve). Never
  // overwrites a decision that already agrees, so this is a no-op on every
  // unrelated render. A row that leaves `pending` (resolved successfully,
  // or rejected) simply stops being read from `decisions` at render time —
  // no explicit cleanup needed.
  useEffect(() => {
    const failing = pending.filter((p) => p.lastFailure);
    if (failing.length === 0) return;
    setDecisions((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const item of failing) {
        const failure = item.lastFailure!;
        const current = next[item.id];
        if (current?.kind === 'failed' && current.reason === failure.reason && current.canForce === failure.canForce && current.judgeUnavailable === failure.judgeUnavailable) continue;
        next[item.id] = { kind: 'failed', ...failure };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [pending]);

  if (pending.length === 0) return null;

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toFailedRow(outcome: PendingApprovalBarOutcome): RowDecision {
    return {
      kind: 'failed',
      reason: outcome.reason ?? t('lazyManager.approval.unknownError'),
      canForce: outcome.canForce,
      judgeUnavailable: outcome.judgeUnavailable,
    };
  }

  async function approve(id: string) {
    setDecisions((prev) => ({ ...prev, [id]: { kind: 'resolving' } }));
    const outcome = await onApprove(id);
    if (outcome.ok) {
      // Success: the store removes this id from `pendingApprovals` on its
      // own next update, so the row disappears from `pending` — no local
      // "approved" state to hold onto. Clearing here too so a THEN-rejected
      // stale id (edge case: id reused across a remount in tests) never
      // reads a leftover 'resolving' row.
      setDecisions((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setDecisions((prev) => ({ ...prev, [id]: toFailedRow(outcome) }));
  }

  function reject(id: string) {
    onReject(id);
  }

  async function force(id: string) {
    if (!onForce) return;
    setDecisions((prev) => ({ ...prev, [id]: { kind: 'resolving' } }));
    const outcome = await onForce(id);
    if (outcome.ok) {
      setDecisions((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setDecisions((prev) => ({ ...prev, [id]: toFailedRow(outcome) }));
  }

  // CROSS-TURN BULK FIX (see module doc comment) — `pending` can carry
  // actions from more than one manager turn; the store's own bulk
  // primitives are turn-scoped, so this calls each distinct turn's batch
  // separately and merges every outcome, rather than acting on only the
  // first item's turnId.
  async function approveAll() {
    const turnIds = Array.from(new Set(pending.map((p) => p.turnId)));
    const ids = pending.map((p) => p.id);
    setDecisions((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = { kind: 'resolving' };
      return next;
    });
    const outcomeBatches = await Promise.all(turnIds.map((turnId) => onApproveAll(turnId)));
    const outcomes = outcomeBatches.flat();
    setDecisions((prev) => {
      const next = { ...prev };
      for (const outcome of outcomes) {
        if (outcome.ok) delete next[outcome.id];
        else next[outcome.id] = toFailedRow(outcome);
      }
      return next;
    });
  }

  function rejectAll() {
    const turnIds = Array.from(new Set(pending.map((p) => p.turnId)));
    for (const turnId of turnIds) onRejectAll(turnId);
  }

  const count = pending.length;
  const isSingle = count === 1;
  const countKey = pluralKey('lazyManager.approval.pendingCount', count, locale);

  return (
    <div
      data-testid="pending-approval-bar"
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 12px',
        borderTop: '1px solid var(--color-border, rgba(128,128,128,0.25))',
        background: 'rgba(124, 92, 255, 0.08)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            flex: 1,
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-muted, #999)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {t(countKey, { count })}
        </span>
        {/* Bulk buttons only when there is more than one action to bulk-act
         *  on — a single pending action is approved/rejected via its own
         *  row below, whose buttons already read the singular label. */}
        {!isSingle && (
          <>
            <button
              type="button"
              data-testid="pending-approval-bar-accept-all"
              onClick={() => void approveAll()}
              style={barButtonStyle('accent')}
            >
              {t('lazyManager.approval.approveAll')}
            </button>
            <button
              type="button"
              data-testid="pending-approval-bar-reject-all"
              onClick={rejectAll}
              style={barButtonStyle('outline')}
            >
              {t('lazyManager.approval.rejectAll')}
            </button>
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
        {pending.map((item) => {
          const isExpanded = expandedIds.has(item.id);
          const hasMoreDetail = item.detail !== item.label || item.label.length > ROW_LABEL_MAX;
          const decision = decisions[item.id];
          return (
            <div
              key={item.id}
              data-testid={`pending-approval-bar-item-${item.id}`}
              style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  data-testid={`pending-approval-bar-type-${item.id}`}
                  style={{
                    flexShrink: 0,
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: '0.02em',
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'rgba(255,255,255,0.06)',
                    color: 'var(--color-text-muted, #999)',
                    fontFamily: 'monospace',
                  }}
                >
                  {item.actionType}
                </span>
                <button
                  type="button"
                  data-testid={`pending-approval-bar-expand-${item.id}`}
                  onClick={() => toggleExpanded(item.id)}
                  disabled={!hasMoreDetail}
                  title={item.detail}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: 'left',
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    margin: 0,
                    fontSize: 11.5,
                    color: 'var(--color-text-secondary)',
                    cursor: hasMoreDetail ? 'pointer' : 'default',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {truncateMiddle(item.label, ROW_LABEL_MAX)}
                </button>
                {decision?.kind === 'resolving' && (
                  <span
                    data-testid={`pending-approval-bar-status-${item.id}`}
                    style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-muted)', flexShrink: 0 }}
                  >
                    {t('lazyManager.approval.resolving')}
                  </span>
                )}
                {/* HONESTY FIX: while a decision is in flight or already
                    failed, the plain Approve/Reject row is replaced by the
                    failure's own recovery affordances below — never left
                    alongside a stale "Approve" button offering to repeat the
                    exact same doomed call. */}
                {!decision && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      data-testid={`pending-approval-bar-approve-${item.id}`}
                      onClick={() => void approve(item.id)}
                      style={{ ...barButtonStyle('accent'), padding: '2px 8px' }}
                    >
                      {t('lazyManager.approval.approve')}
                    </button>
                    <button
                      type="button"
                      data-testid={`pending-approval-bar-reject-${item.id}`}
                      onClick={() => reject(item.id)}
                      style={{ ...barButtonStyle('outline'), padding: '2px 8px' }}
                    >
                      {t('lazyManager.approval.reject')}
                    </button>
                  </div>
                )}
              </div>
              {isExpanded && (
                <div
                  data-testid={`pending-approval-bar-detail-${item.id}`}
                  style={{
                    fontSize: 11,
                    color: 'var(--color-text-muted)',
                    lineHeight: 1.4,
                    overflowWrap: 'break-word',
                    wordBreak: 'break-word',
                    paddingLeft: 2,
                  }}
                >
                  {item.detail}
                </div>
              )}
              {/* HONESTY FIX (real user report, 2026-08-14): the system's own
                  reason, verbatim — never a silent dead row. Mirrors
                  PendingApprovalCard.tsx's identical honesty treatment. */}
              {decision?.kind === 'failed' && (
                <div data-testid={`pending-approval-bar-reason-${item.id}`} style={{ fontSize: 11, color: dangerColor, lineHeight: 1.4, paddingLeft: 2 }}>
                  {isJudgeUnavailableFailure(decision) ? t('lazyManager.approval.judgeUnavailable') : decision.reason}
                </div>
              )}
              {decision?.kind === 'failed' && (
                <div style={{ display: 'flex', gap: 6, paddingLeft: 2 }}>
                  {decision.canForce && onForce && (
                    <button
                      type="button"
                      data-testid={`pending-approval-bar-force-${item.id}`}
                      onClick={() => void force(item.id)}
                      style={{ ...barButtonStyle('accent'), padding: '2px 8px' }}
                    >
                      {t('agents.detail.forceApprove')}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`pending-approval-bar-reject-${item.id}`}
                    onClick={() => reject(item.id)}
                    style={{ ...barButtonStyle('outline'), padding: '2px 8px' }}
                  >
                    {t('lazyManager.approval.reject')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
