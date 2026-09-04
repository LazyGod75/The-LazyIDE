/* CostChip.tsx — per-mission live cost chip (canvas cost visibility wave).

   Extracted into its own file rather than added to chrome/nodeChrome.tsx
   (already at 815 lines, over this repo's 800-line file-size ceiling — see
   that file's own header comment) so this addition never pushes an
   already-oversized shared module further over budget. Mirrors
   nodeChrome.tsx's MetaChip/ModelTierChip footprint and conventions (same
   font-mono/10.5px chip shell, same warning-amber palette VerdictChip
   already uses) so it reads as part of the same visual family despite
   living in a sibling file.

   fix/canvas-cost-credits (David's measured repro, 2026-08-14: a
   claude-haiku-4-5 mission — routed on the user's OWN Claude CLI
   subscription — showed "$0.07") — the owner's standing rule, already
   established elsewhere in this codebase (types.ts's
   ManagerMessage.proposal.estimatedCreditsByModel doc comment, item 7 fix:
   "the owner's standing rule is credits per model, never a dollar figure,
   and an explicit 'no credits charged' statement whenever the run actually
   goes through a CLI subscription rather than managed/Pro credits") was
   never applied to this PER-MISSION chip, only to the plan-proposal
   estimate. `costUsd` here is real, exact spend either way (agentMetrics)
   — but which UNIT is honest to show depends on which rail actually paid
   for it: `runtime.ts`'s `classifyMissionModel(model)` is the SAME
   dispatch-time classification the run itself was routed through (never a
   second guess) — 'native' (no '/', not a BYOK provider id) means the
   user's own Claude CLI subscription, the one rail this product's rule
   says incurs ZERO Lazy debit; every other rail (managed/byok) converts the
   real spend into credits using `usdToCredits` (billing/credits.ts — the
   single "1 credit == 1 USD cent" conversion every credits display in this
   app now shares, this module's own former private copy included).

   2026-08-19 dollar-kill incident follow-up: the native branch below used
   to hide the number entirely (just the "no debit" pill) — it now shows the
   SAME credits-equivalent number MissionNode.tsx's liveMetricsLabel chip
   shows right next to it (both converted via the one shared usdToCredits),
   worded as a non-debited EQUIVALENT rather than omitted, so the two chips
   never contradict each other (one used to imply a real amount while the
   other said "no debit" — the exact flagged inconsistency).
*/

import { classifyBudget, classifyMissionModel } from '../../../../lib/agents/runtime';
import { usdToCredits } from '../../../../lib/billing/credits';
import type { AgentMetrics } from '../../../../lib/agents/types';
import { useI18nSafe } from '../../../../i18n';

export interface CostChipProps {
  /** Real per-run spend (Mission.agentMetrics.costUsd). Undefined or 0 hides
   *  the chip entirely — nothing to show yet, never a fabricated "$0.00"/
   *  "0 credits". */
  costUsd: number | undefined;
  /** Honesty marker mirrored from AgentMetrics.tokensSource — an 'estimated'
   *  or 'mixed' run prefixes the amount with '≈' (this codebase's existing
   *  convention for "not exact": never present an estimate as exact, see
   *  JudgeVerdict.scoreUnavailable's doc comment in lib/agents/types.ts for
   *  the same rule applied to judge scores). Never shown at all on the
   *  no-debit subscription state — nothing here is even a spend estimate. */
  tokensSource?: AgentMetrics['tokensSource'];
  /** Mission.contract.budgetCapUsd, when set — drives the warning accent at
   *  >=90% of cap via the SAME classifyBudget threshold runtime.ts's own
   *  budget enforcer pauses a mission at (never a re-implemented cutoff).
   *  Meaningless (and unused) on the no-debit subscription state — a run
   *  that incurs zero Lazy debit cannot near a Lazy budget cap. */
  budgetCapUsd?: number;
  /** Mission.model — the SAME field runtime.ts's own dispatch already
   *  classified this run's billing rail from (`classifyMissionModel`).
   *  Absent (fixture render with no live Mission) falls back to the
   *  credits-shown branch — the historical default, and the only one that
   *  doesn't require knowing the rail. */
  model?: string;
  testId?: string;
}

/** Compact cost chip — CREDITS, never €/$ (see this module's own header for
 *  the owner's standing rule), honest about estimates, near-cap spend, and
 *  the one rail (the user's own CLI subscription) that incurs no Lazy debit
 *  at all. Hidden entirely when there is no real cost yet (costUsd undefined
 *  or 0) — the same "absence over fabrication" rule this canvas already
 *  applies elsewhere (VerdictChip.scoreUnavailable,
 *  AgentMetrics.cacheReadInputTokens). Caller (MissionNode.tsx) is
 *  responsible for LOD-gating this to the 'full' zoom tier only, same
 *  convention as ModelTierChip/VerdictChip there. */
export function CostChip({ costUsd, tokensSource, budgetCapUsd, model, testId }: CostChipProps) {
  const { t } = useI18nSafe();
  if (!costUsd) return null;

  if (classifyMissionModel(model) === 'native') {
    // Fix D (2026-08-19 dollar-kill incident) — shows the SAME credits
    // number as the real-spend branch below (usdToCredits, one shared
    // formula), never budget-warning-colored (budgetCapUsd is meaningless
    // here — no real spend can ever near a Lazy budget cap on this rail),
    // always prefixed "≈" and titled as an equivalent, never a debit.
    const equivalentCredits = usdToCredits(costUsd);
    return (
      <span
        data-testid={testId}
        title={t('canvas.node.costNoDebitTitle')}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          background: 'var(--color-panel-3)',
          border: '1px solid var(--color-border-3)',
          borderRadius: 5,
          padding: '1px 6px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 0,
        }}
      >
        {`≈${equivalentCredits.toLocaleString()} ${t('canvas.node.creditsUnit')} · ${t('canvas.node.costNoDebit')}`}
      </span>
    );
  }

  const isEstimate = tokensSource === 'estimated' || tokensSource === 'mixed';
  const isWarning = classifyBudget(costUsd, budgetCapUsd) !== 'ok';
  // THE single cents-per-dollar credits conversion every real-spend display
  // in this app shares (billing/credits.ts's usdToCredits) — never a
  // second, independently-tunable formula.
  const credits = usdToCredits(costUsd);
  const label = `${isEstimate ? '≈' : ''}${credits.toLocaleString()} ${t('canvas.node.creditsUnit')}`;
  return (
    <span
      data-testid={testId}
      data-cost-warning={isWarning ? 'true' : undefined}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        fontWeight: 600,
        color: isWarning ? 'var(--color-warning-text)' : 'var(--color-text-muted)',
        background: isWarning ? 'rgba(251,185,36,0.14)' : 'var(--color-panel-3)',
        border: `1px solid ${isWarning ? 'rgba(251,185,36,0.32)' : 'var(--color-border-3)'}`,
        borderRadius: 5,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}
