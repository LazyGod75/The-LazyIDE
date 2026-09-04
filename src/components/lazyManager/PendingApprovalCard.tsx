/* PendingApprovalCard — the approval surface that did not exist before this
   fix. Real user test (2026-07-28): every gate-deferred ("ask" tier) action
   — clear_canvas, approve_mission, create_draft, chain_agents — rendered
   only a toast reading "L'action X nécessite une approbation avant
   exécution", then vanished with nothing to approve it, ANYWHERE in the
   app (see agentsStore.tsx's PendingApprovalAction doc comment for the
   store-side fix this reads from: `pendingApprovals` / `approvePendingAction`
   / `rejectPendingAction` / `approveAllPendingActions` /
   `rejectAllPendingActions`, added by a sibling task on that file).

   Same visual family as GraphProposalCard.tsx (this folder): a bordered
   card inline in the assistant bubble, plain-language labels, real buttons.

   HONESTY FIX (real user test, 2026-07-28: three approve_mission actions
   blocked by `mission.approve_blocked` — the judge gate refused them, exact
   reason "Le juge a rejeté cette mission (score indisponible). Corrigez les
   problèmes ou utilisez "Merger quand même" pour forcer." — still rendered
   as "Approuvée" for all three): clicking Approve/"Tout approuver" no
   longer flips a row to "Approuvée" on the mere fact that the click
   happened. It shows a brief "resolving" state, then reflects the REAL
   outcome `onApprove`/`onApproveAll` resolves to — never a positive verdict
   the system did not actually reach. A refused/failed attempt shows the
   system's own reason verbatim and, when the store says a force retry might
   resolve it (approve_mission only), an explicit "Merger quand même" button
   — the row stays actionable instead of dead-ending on a lie.

   PERSISTENCE ACROSS RESOLUTION (why this can't just render `pending`
   directly): the store removes an item from `pendingApprovals` the instant
   it resolves SUCCESSFULLY (a failed attempt stays there instead — see
   agentsStore.tsx's approvePendingAction doc comment). If this card only
   ever showed the current `pending` prop, it would go blank the moment the
   user acts, with no trace of the decision (the exact "toast that
   disappears" defect this whole feature exists to fix). Instead it
   accumulates every action id it has EVER seen for this message into local
   state (`known`, monotonically growing) and tracks each one's outcome
   locally too (`decisions`).

   MOUNTING CONTRACT: the parent (LazyManagerMessageList's ManagerBubble)
   MUST render this component unconditionally for every assistant message
   (never gated on `pending.length > 0`) — this component itself decides
   whether it has anything to show (returns null once `known` is empty) and
   relies on staying mounted across the pending -> resolved transition to
   keep its own accumulated state alive. Gating the render at the call site
   would unmount it the moment the last action resolves, discarding exactly
   the history this component exists to preserve. */

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { JUDGE_UNAVAILABLE_PROVIDER_REASON } from '../../lib/agents/evaluator';

/** One action awaiting (or having awaited) approval, already reduced to the
 *  plain shape this presentational component needs — callers map the
 *  store's own PendingApprovalAction into this shape (see
 *  LazyManagerMessageList.tsx) so this file never needs to import
 *  agentsStore.tsx's internal (unexported) type. */
export interface PendingApprovalItem {
  id: string;
  label: string;
  /**
   * Full, UNTRUNCATED description of the same action `label` summarizes —
   * real user report (2026-08-01 QA): a launch_mission's compact label was
   * cut mid-sentence in the DOM itself ("...stack réel (") with no way to
   * see the rest, asking the user to approve something he could not fully
   * read. Optional (falls back to rendering `label` alone, e.g. an older
   * caller/test that doesn't supply it) — every real caller today
   * (LazyManagerMessageList.tsx) always provides it via
   * agentsStore.tsx's describePendingActionDetail. Revealed by this card's
   * own expand affordance, never shown unconditionally (most labels are
   * already short and full — expanding would just repeat them).
   */
  detail?: string;
  turnId: string;
  /** Set when the STORE already knows this entry's last approval attempt
   *  failed (mirrors agentsStore.tsx's PendingApprovalAction.lastFailure) —
   *  seeds this card's own `decisions` state so a failure is reflected
   *  correctly even if this component only sees the item for the first time
   *  after it already failed (e.g. a remount). */
  lastFailure?: PendingApprovalFailureDetail;
}

/**
 * One reviewer/judge line for the verdict-detail expand (real founder
 * directive, 2026-08-05: "le lazymanager devrait savoir ce que c'est et
 * nous aider dans la decision" — a blocked approval must let the human see
 * WHAT the evaluators actually said, not just a single flattened reason
 * string). `outcome` is presentation-ready (never re-derives verdict logic
 * here — that stays in evaluator.ts, out of this file's scope).
 */
export interface PendingApprovalVerdictReviewer {
  role: string;
  outcome: 'passed' | 'failed' | 'unavailable';
  /** One-line, verbatim (never paraphrased) summary from that reviewer. */
  summary: string;
}

/**
 * Shared shape for a failed approval attempt's detail — used by both
 * `PendingApprovalItem.lastFailure` (store-seeded) and the outcome objects
 * `onApprove`/`onForce`/`onApproveAll` resolve to (PendingApprovalOutcome
 * below), so the honesty-detection helpers work identically regardless of
 * which path produced the failure.
 *
 * HONESTY FIX (founder directive, 2026-08-05, DeepSeek 402 incident): a
 * blocked approve_mission used to render ONLY the flattened judge-gate
 * string ("Le juge a rejeté cette mission (score indisponible)...") even
 * when the judges never actually ran (evaluator provider exhausted) — the
 * label lied and gave zero context to decide. `judgeUnavailable` and
 * `verdictReviewers` are the two additional, OPTIONAL signals this card
 * now knows how to render honestly when present (see
 * isJudgeUnavailableFailure below) — neither is populated by any real
 * caller TODAY (agentsStore.tsx only ever sets `reason`/`canForce`, out of
 * this file's edit scope); see this file's own module doc comment / the
 * accompanying task report for exactly what agentsStore.tsx would need to
 * add for these to activate end-to-end. Until then, this card still does
 * its own best-effort detection straight from `reason` (see
 * isJudgeUnavailableFailure) so the honest wording already applies
 * wherever the marker text is present.
 */
export interface PendingApprovalFailureDetail {
  reason: string;
  canForce?: boolean;
  /** True when `reason` reflects an evaluation that never actually ran
   *  (judge/evaluator provider unavailable), never a genuine rejection. */
  judgeUnavailable?: boolean;
  /** Per-reviewer breakdown (judge/security/reviewer roles) — absent means
   *  "no structured verdict data reached this card", in which case the
   *  detail-expand section below simply does not render (see
   *  PendingApprovalCard's own render — never a fabricated empty list). */
  verdictReviewers?: PendingApprovalVerdictReviewer[];
}

/** Real outcome of one approval attempt — structurally mirrors (never
 *  imports) agentsStore.tsx's own PendingApprovalOutcome, same convention
 *  PendingApprovalItem above already uses for PendingApprovalAction. */
export interface PendingApprovalOutcome {
  ok: boolean;
  /** Present when `ok` is false — the system's own reason, verbatim. Never
   *  a generic/paraphrased message. */
  reason?: string;
  /** True when a force retry (approve_mission's judge/proof bypass) might
   *  resolve this failure — renders the "Merger quand même" button. */
  canForce?: boolean;
  /** See PendingApprovalFailureDetail's own doc comment (HONESTY FIX,
   *  2026-08-05) — same optional, best-effort signals, present when `ok`
   *  is false and the caller happens to supply them. */
  judgeUnavailable?: boolean;
  verdictReviewers?: PendingApprovalVerdictReviewer[];
}

export interface PendingApprovalCardProps {
  /** Currently-live pending actions for this message — empty once every
   *  action queued under it has resolved SUCCESSFULLY (a failed attempt
   *  stays in this list — see the module doc comment for why). */
  pending: PendingApprovalItem[];
  /** Resolves to the REAL outcome — never assumed to be a success just
   *  because the call was made (see the module doc comment's HONESTY FIX). */
  onApprove: (id: string) => Promise<PendingApprovalOutcome>;
  onReject: (id: string) => void;
  onApproveAll: (turnId: string) => Promise<Array<{ id: string } & PendingApprovalOutcome>>;
  onRejectAll: (turnId: string) => void;
  /** Retries a failed approve_mission bypassing the judge/proof gate — same
   *  primitive as the human's "Merger quand même" button. Optional: only
   *  rendered for a failure whose own `canForce` says a retry might help,
   *  and only when the caller actually wires it up. */
  onForce?: (id: string) => Promise<PendingApprovalOutcome>;
}

type DecisionState =
  | { kind: 'resolving' }
  | { kind: 'approved' }
  | { kind: 'rejected' }
  // Reuses PendingApprovalFailureDetail's shape (reason/canForce plus the
  // optional judgeUnavailable/verdictReviewers honesty-fix fields) so every
  // site that builds a 'failed' state — from an outcome or from
  // `item.lastFailure` — carries the SAME fields, never a subset.
  | ({ kind: 'failed' } & PendingApprovalFailureDetail);

/**
 * HONESTY FIX (founder directive, 2026-08-05, DeepSeek 402 incident): true
 * when a failed decision's own data says the judge/evaluator never actually
 * ran, as opposed to running and genuinely rejecting the mission. Checks
 * every signal that might carry that distinction, most-structured first:
 * 1. `judgeUnavailable` — an explicit flag, when a caller supplies one.
 * 2. `verdictReviewers` — a structured per-reviewer breakdown containing a
 *    `judge` line marked `unavailable`.
 * 3. `reason` — best-effort text match for evaluator.ts's own stable
 *    JUDGE_UNAVAILABLE_PROVIDER_REASON marker, for the (today: only) real
 *    path, where neither of the above is populated yet — see this file's
 *    PendingApprovalFailureDetail doc comment for exactly what's missing
 *    upstream for (1)/(2) to ever fire in production.
 */
function isJudgeUnavailableFailure(failure: PendingApprovalFailureDetail): boolean {
  if (failure.judgeUnavailable) return true;
  if (failure.verdictReviewers?.some((r) => r.role === 'judge' && r.outcome === 'unavailable')) return true;
  return failure.reason.includes(JUDGE_UNAVAILABLE_PROVIDER_REASON);
}

const cardStyle: React.CSSProperties = {
  marginTop: 10,
  borderRadius: 10,
  border: '1px solid var(--color-border-2)',
  background: 'rgba(124,92,255,0.06)',
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const smallButtonStyle = (variant: 'accent' | 'outline'): React.CSSProperties => ({
  padding: '5px 12px',
  fontSize: 11.5,
  fontWeight: 700,
  borderRadius: 7,
  cursor: 'pointer',
  fontFamily: 'inherit',
  border: variant === 'accent' ? '1px solid var(--color-accent-border, rgba(124,92,255,0.4))' : '1px solid var(--color-border-2)',
  background: variant === 'accent' ? 'rgba(124,92,255,0.18)' : 'transparent',
  color: variant === 'accent' ? 'var(--color-accent-pale)' : 'var(--color-text-muted)',
});

const dangerColor = 'var(--color-danger, #dc2626)';

export function PendingApprovalCard({ pending, onApprove, onReject, onApproveAll, onRejectAll, onForce }: PendingApprovalCardProps) {
  const { t } = useI18n();
  const [known, setKnown] = useState<PendingApprovalItem[]>([]);
  const [decisions, setDecisions] = useState<Record<string, DecisionState>>({});
  // Expand affordance (real user report, 2026-08-01 QA) — which items are
  // currently showing their full, untruncated `detail` below the compact
  // `label`. Per-item, not global: approving/rejecting several deferred
  // actions at once must not force every card open just because one was
  // expanded to check its full text.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // Verdict-detail expand (founder directive, 2026-08-05: "le lazymanager
  // devrait savoir ce que c'est et nous aider dans la decision") — SEPARATE
  // Set from `expandedIds` above: the action-description expand and this
  // verdict-breakdown expand are two independent affordances on the SAME
  // item id, and must not toggle together just because they share an id.
  const [expandedVerdictIds, setExpandedVerdictIds] = useState<Set<string>>(new Set());
  function toggleVerdictExpanded(id: string) {
    setExpandedVerdictIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // Captured once from the first batch seen — bulk actions need SOME
  // turnId, and by the time every action resolves `pending` is empty so it
  // can no longer be read from there.
  const turnIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (pending.length === 0) return;
    turnIdRef.current = pending[0].turnId;
    setKnown((prev) => {
      const seen = new Set(prev.map((k) => k.id));
      const additions = pending.filter((p) => !seen.has(p.id));
      return additions.length > 0 ? [...prev, ...additions] : prev;
    });
    // HONESTY FIX: the store is the source of truth for a failure — an item
    // reporting `lastFailure` must be reflected as failed even if this card
    // never itself triggered the attempt that failed (e.g. it already
    // failed before this card mounted). Never overwrites a LOCAL decision
    // that already agrees, so this stays a no-op on every unrelated render.
    const failing = pending.filter((p) => p.lastFailure);
    if (failing.length > 0) {
      setDecisions((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const item of failing) {
          const failure = item.lastFailure!;
          const current = next[item.id];
          if (
            current?.kind === 'failed' &&
            current.reason === failure.reason &&
            current.canForce === failure.canForce &&
            current.judgeUnavailable === failure.judgeUnavailable &&
            current.verdictReviewers === failure.verdictReviewers
          ) continue;
          next[item.id] = { kind: 'failed', ...failure };
          changed = true;
        }
        return changed ? next : prev;
      });
    }
  }, [pending]);

  if (known.length === 0) return null;

  const undecided = known.filter((k) => !decisions[k.id]);

  // Shared by approve/force/approveAll below — keeps the judgeUnavailable/
  // verdictReviewers passthrough (HONESTY FIX, 2026-08-05) in exactly one
  // place instead of duplicated across all three call sites.
  function toFailedState(outcome: PendingApprovalOutcome): DecisionState {
    return {
      kind: 'failed',
      reason: outcome.reason ?? t('lazyManager.approval.unknownError'),
      canForce: outcome.canForce,
      judgeUnavailable: outcome.judgeUnavailable,
      verdictReviewers: outcome.verdictReviewers,
    };
  }

  async function approve(id: string) {
    setDecisions((prev) => ({ ...prev, [id]: { kind: 'resolving' } }));
    const outcome = await onApprove(id);
    setDecisions((prev) => ({
      ...prev,
      [id]: outcome.ok ? { kind: 'approved' } : toFailedState(outcome),
    }));
  }

  function reject(id: string) {
    // Rejection is a local, synchronous queue-drop — it cannot itself fail,
    // so (unlike approve) marking it resolved on click is honest, not
    // optimistic.
    setDecisions((prev) => ({ ...prev, [id]: { kind: 'rejected' } }));
    onReject(id);
  }

  async function force(id: string) {
    if (!onForce) return;
    setDecisions((prev) => ({ ...prev, [id]: { kind: 'resolving' } }));
    const outcome = await onForce(id);
    setDecisions((prev) => ({
      ...prev,
      [id]: outcome.ok ? { kind: 'approved' } : toFailedState(outcome),
    }));
  }

  async function approveAll() {
    const turnId = turnIdRef.current;
    if (!turnId) return;
    const ids = undecided.map((item) => item.id);
    setDecisions((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = { kind: 'resolving' };
      return next;
    });
    const outcomes = await onApproveAll(turnId);
    setDecisions((prev) => {
      const next = { ...prev };
      for (const outcome of outcomes) {
        next[outcome.id] = outcome.ok ? { kind: 'approved' } : toFailedState(outcome);
      }
      return next;
    });
  }

  function rejectAll() {
    const turnId = turnIdRef.current;
    if (!turnId) return;
    setDecisions((prev) => {
      const next = { ...prev };
      for (const item of undecided) next[item.id] = { kind: 'rejected' };
      return next;
    });
    onRejectAll(turnId);
  }

  return (
    <div data-testid="pending-approval-card" style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
          {t('lazyManager.approval.title')}
        </span>
        {undecided.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" data-testid="pending-approval-approve-all" onClick={() => void approveAll()} style={smallButtonStyle('accent')}>
              {t('lazyManager.approval.approveAll')}
            </button>
            <button type="button" data-testid="pending-approval-reject-all" onClick={rejectAll} style={smallButtonStyle('outline')}>
              {t('lazyManager.approval.rejectAll')}
            </button>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {known.map((item) => {
          const decision = decisions[item.id];
          // LAYOUT FIX (real user report, 2026-08-01 QA): the description
          // used to share ONE row with the approve/reject buttons — on a
          // long task/path, the buttons' own `flexShrink:0` left the text a
          // ~12-character-wide column. Approve/reject now render on their
          // OWN row below (see the block after this one), so the label gets
          // the full card width; `flex:1`+`minWidth:0` here (rather than a
          // fixed width) keeps it responsive to the card's own width.
          const hasDetail = !!item.detail && item.detail !== item.label;
          const isExpanded = expandedIds.has(item.id);
          return (
            <div
              key={item.id}
              data-testid={`pending-approval-item-${item.id}`}
              style={{ display: 'flex', flexDirection: 'column', gap: 5 }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <span
                  style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--color-text-secondary)', lineHeight: 1.4, overflowWrap: 'break-word', wordBreak: 'break-word' }}
                  title={item.detail ?? item.label}
                >
                  {item.label}
                </span>
                {decision && (
                  <span
                    data-testid={`pending-approval-status-${item.id}`}
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      flexShrink: 0,
                      color: decision.kind === 'approved' ? 'var(--color-success)'
                        : decision.kind === 'resolving' ? 'var(--color-text-muted)'
                        : dangerColor,
                    }}
                  >
                    {decision.kind === 'approved' ? t('lazyManager.approval.approved')
                      : decision.kind === 'rejected' ? t('lazyManager.approval.rejected')
                      : decision.kind === 'resolving' ? t('lazyManager.approval.resolving')
                      : t('lazyManager.approval.failed')}
                  </span>
                )}
              </div>
              {/* Expand affordance (real user report, 2026-08-01 QA): the
                  `title` tooltip above is a first, immediate way to read the
                  full text, but a hover-only tooltip is easy to miss — this
                  click-to-reveal is the discoverable counterpart, so "a
                  human must be able to read exactly what he is approving"
                  holds even without hovering. Only rendered when `detail`
                  actually carries MORE than `label` already shows (the
                  overwhelming majority of action types, whose label is
                  already the full text — see describePendingActionDetail's
                  doc comment). */}
              {hasDetail && (
                <div>
                  <button
                    type="button"
                    data-testid={`pending-approval-expand-${item.id}`}
                    onClick={() => toggleExpanded(item.id)}
                    style={{
                      background: 'transparent', border: 'none', padding: 0, margin: 0,
                      fontSize: 11, fontWeight: 600, color: 'var(--color-accent-pale)',
                      cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
                    }}
                  >
                    {isExpanded ? t('lazyManager.approval.showLess') : t('lazyManager.approval.showFull')}
                  </button>
                  {isExpanded && (
                    <div
                      data-testid={`pending-approval-detail-${item.id}`}
                      style={{ marginTop: 4, fontSize: 11.5, color: 'var(--color-text-muted)', lineHeight: 1.4, overflowWrap: 'break-word', wordBreak: 'break-word' }}
                    >
                      {item.detail}
                    </div>
                  )}
                </div>
              )}
              {/* Approve/reject — own row (see this map callback's own
                  layout-fix comment above for why). */}
              {!decision && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" data-testid={`pending-approval-approve-${item.id}`} onClick={() => void approve(item.id)} style={smallButtonStyle('accent')}>
                    {t('lazyManager.approval.approve')}
                  </button>
                  <button type="button" data-testid={`pending-approval-reject-${item.id}`} onClick={() => reject(item.id)} style={smallButtonStyle('outline')}>
                    {t('lazyManager.approval.reject')}
                  </button>
                </div>
              )}
              {/* HONESTY FIX: a refused/failed attempt shows the system's OWN
                  reason verbatim (never a generic message) and, when it might
                  still be resolved, stays actionable — never a dead-end
                  "Approuvée" lie.

                  FOUNDER DIRECTIVE (2026-08-05, DeepSeek 402 incident): "on
                  sait meme pas ce que c'est... le lazymanager devrait savoir
                  ce que c'est et nous aider dans la decision" — a blocked
                  approval whose judge/evaluator never actually RAN (provider
                  exhausted) used to render the SAME "Le juge a rejeté cette
                  mission" wording as a genuine rejection, lying about what
                  happened. isJudgeUnavailableFailure distinguishes the two;
                  only the genuine-rejection case still shows the system's
                  raw reason string verbatim. */}
              {decision?.kind === 'failed' && (
                <div data-testid={`pending-approval-reason-${item.id}`} style={{ fontSize: 11.5, color: dangerColor, lineHeight: 1.4 }}>
                  {isJudgeUnavailableFailure(decision) ? t('lazyManager.approval.judgeUnavailable') : decision.reason}
                </div>
              )}
              {/* VERDICT DETAIL (founder directive, 2026-08-05) — compact
                  per-reviewer breakdown, same expand convention as the
                  action-description one above (`pending-approval-expand-*`),
                  under its own `pending-approval-verdict-expand-*`/
                  `-verdict-detail-*` testids. Only renders when this
                  decision actually carries `verdictReviewers` — see
                  PendingApprovalFailureDetail's doc comment: no real caller
                  populates it today, so this section is dormant in
                  production until agentsStore.tsx is extended (see this
                  task's report), but is fully functional the moment it is. */}
              {decision?.kind === 'failed' && decision.verdictReviewers && decision.verdictReviewers.length > 0 && (
                <div>
                  <button
                    type="button"
                    data-testid={`pending-approval-verdict-expand-${item.id}`}
                    onClick={() => toggleVerdictExpanded(item.id)}
                    style={{
                      background: 'transparent', border: 'none', padding: 0, margin: 0,
                      fontSize: 11, fontWeight: 600, color: 'var(--color-accent-pale)',
                      cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline',
                    }}
                  >
                    {expandedVerdictIds.has(item.id) ? t('lazyManager.approval.hideVerdictDetail') : t('lazyManager.approval.showVerdictDetail')}
                  </button>
                  {expandedVerdictIds.has(item.id) && (
                    <div
                      data-testid={`pending-approval-verdict-detail-${item.id}`}
                      style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 }}
                    >
                      {decision.verdictReviewers.map((reviewer, index) => (
                        <div
                          key={`${reviewer.role}-${index}`}
                          data-testid={`pending-approval-verdict-line-${item.id}-${reviewer.role}`}
                          style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4, overflowWrap: 'break-word', wordBreak: 'break-word' }}
                        >
                          <strong style={{ color: 'var(--color-text-secondary)' }}>{reviewer.role}</strong>
                          {' — '}
                          {reviewer.outcome === 'passed' ? t('lazyManager.approval.verdictPassed')
                            : reviewer.outcome === 'unavailable' ? t('lazyManager.approval.verdictUnavailableShort')
                            : t('lazyManager.approval.verdictFailed')}
                          {reviewer.summary ? `: ${reviewer.summary}` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {decision?.kind === 'failed' && (
                <div style={{ display: 'flex', gap: 6 }}>
                  {decision.canForce && onForce && (
                    <button type="button" data-testid={`pending-approval-force-${item.id}`} onClick={() => void force(item.id)} style={smallButtonStyle('accent')}>
                      {t('agents.detail.forceApprove')}
                    </button>
                  )}
                  <button type="button" data-testid={`pending-approval-abandon-${item.id}`} onClick={() => reject(item.id)} style={smallButtonStyle('outline')}>
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
