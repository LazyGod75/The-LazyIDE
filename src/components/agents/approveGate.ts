/* approveGate.ts — ApproveBlockedError + checkApproveGate pure logic.
   Separated into a .ts file to satisfy erasableSyntaxOnly (no class in .tsx).
*/

import type { ApprovalMode, Mission, JudgeVerdict, ReviewerVerdict } from '../../lib/agents/types';
import { hasRequiredProofs, missingProofKinds } from '../../lib/agents/proofs';
import { formatVerdictScoreLine, JUDGE_UNAVAILABLE_PROVIDER_REASON } from '../../lib/agents/evaluator';

/** Matches useI18n()'s own `t` signature — approveGate.ts is a plain .ts
 *  module (no hooks), so callers thread their own `t` through explicitly
 *  (same convention as runtime.ts's TFunc/lib/brain/brainAdapter.ts's TFunc).
 *  Optional everywhere it's accepted: every message below still has an
 *  honest, un-i18n'd fallback for a non-component caller (tests, or any
 *  future non-UI consumer) — see each call site's own comment. */
type TFunc = (key: string, params?: Record<string, string | number>) => string;

// ── Error type ────────────────────────────────────────────────────

/** One reviewer/judge line, reduced to the presentation-ready shape
 *  PendingApprovalCard.tsx's own `PendingApprovalVerdictReviewer` already
 *  declares (mirrored structurally, not imported — approveGate.ts must not
 *  depend on a component under src/components/lazyManager/**, which is
 *  actively owned by another task). Built once here, from the real
 *  JudgeVerdict, so every caller that wants a per-reviewer breakdown for a
 *  blocked approval (agentsStore.tsx today) gets the SAME honest data
 *  instead of re-deriving it. */
export interface ApproveGateVerdictReviewer {
  role: string;
  outcome: 'passed' | 'failed' | 'unavailable';
  summary: string;
}

function toVerdictReviewers(verdict: JudgeVerdict): ApproveGateVerdictReviewer[] {
  return verdict.reviewers.map((r: ReviewerVerdict) => ({
    role: r.role,
    outcome: r.inconclusive === true ? 'unavailable' : r.verdict === 'approve' ? 'passed' : 'failed',
    summary: r.summary,
  }));
}

export class ApproveBlockedError extends Error {
  public readonly reason: string;
  /**
   * R14 (manual-approve honesty fix) — true when this block reflects an
   * evaluation that never actually produced a usable verdict (provider
   * unreachable, OR aggregateVerdict's own `scoreUnavailable` — see
   * evaluator.ts's JudgeVerdict doc comment), NEVER a genuine judge
   * rejection. Lets a caller (agentsStore.tsx) render the honest "could not
   * evaluate" wording/state instead of a "the judge rejected this" claim
   * the system never actually made. Absent/false means either there's no
   * verdict-related block at all, or the block IS a real, judged rejection.
   */
  public readonly judgeUnavailable?: boolean;
  /** Per-reviewer breakdown for the SAME verdict `reason` describes — see
   *  ApproveGateVerdictReviewer's own doc comment. Absent when the block
   *  isn't verdict-related (e.g. missing proofs, missing worktree). */
  public readonly verdictReviewers?: ApproveGateVerdictReviewer[];

  constructor(reason: string, opts?: { judgeUnavailable?: boolean; verdictReviewers?: ApproveGateVerdictReviewer[] }) {
    super(reason);
    this.name = 'ApproveBlockedError';
    this.reason = reason;
    this.judgeUnavailable = opts?.judgeUnavailable;
    this.verdictReviewers = opts?.verdictReviewers;
  }
}

/**
 * A "Merger" click's real git merge left the target repo in a conflict —
 * git.rs's agent_merge_worktree_inner always aborts the merge before this
 * can surface (see its own doc comment), so the working tree is guaranteed
 * clean again; this error only carries the honest "it conflicted" signal so
 * the caller can flip the mission's signal card to an explicit conflict
 * state (Diff button only — never a fake retry path) instead of the generic
 * error toast every other merge failure gets.
 */
export class MergeConflictError extends Error {
  public readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'MergeConflictError';
    this.reason = reason;
  }
}

// ── Gate logic ─────────────────────────────────────────────────────

/**
 * checkApproveGate — pure function encoding the judge-gate AND proof-of-work
 * gate contracts (spec §8).
 *
 * Returns null when merge is allowed, or an ApproveBlockedError when blocked.
 *
 * Rules (checked in order — the first failing rule's message wins):
 *   - force === true → always allowed
 *   - judgeVerdict absent → blocked (evaluation required)
 *   - judgeVerdict.passed === false, evaluation genuinely ran and rejected
 *     → blocked (judge rejected)
 *   - judgeVerdict.passed === false, but the evaluator rail itself never
 *     produced a usable verdict (provider unreachable, or `scoreUnavailable`)
 *     → blocked ONLY when there's nothing real to merge either (empty diff);
 *     a REAL, non-empty deliverable is let through — see R14 below.
 *   - contract.proofs non-empty AND a required kind has no matching
 *     produced artifact → blocked (proof-of-work gate, T1.4) — see
 *     lib/agents/proofs.ts's hasRequiredProofs/missingProofKinds
 *   - otherwise → allowed
 *
 * Exported for unit testing. The store delegates to this function.
 *
 * `opts.t` — optional i18n `t()` (useI18n()'s own signature) so the thrown
 * message respects the user's active locale; every branch below still falls
 * back to an honest, hardcoded string when no `t` is supplied (this module
 * has no hook access of its own — see TFunc's own doc comment).
 */
export function checkApproveGate(
  mission: Pick<Mission, 'judgeVerdict' | 'contract' | 'proofs' | 'diffAdded' | 'diffRemoved'>,
  opts?: { force?: boolean; t?: TFunc },
): ApproveBlockedError | null {
  if (opts?.force === true) return null;
  const t = opts?.t;

  if (!mission.judgeVerdict) {
    return new ApproveBlockedError(
      t
        ? t('agents.approveGate.evaluationMissing')
        : 'Évaluation manquante — le verdict du juge est requis avant de merger. ' +
          'Utilisez "Merger quand même" pour forcer.',
    );
  }
  if ((mission.judgeVerdict as JudgeVerdict).passed === false) {
    const verdict = mission.judgeVerdict as JudgeVerdict;
    // BRIDGE (2026-08-05 DeepSeek 402 incident): aggregateVerdict can settle
    // `passed: false` purely because the judge sub-agent's OWN provider call
    // hit a definitive error (see evaluator.ts's JUDGE_UNAVAILABLE_PROVIDER_
    // REASON doc comment) — never a real code review. This gate is the ONLY
    // place that builds the merge-block message, so the judge reviewer's
    // marked summary must be forwarded into the thrown reason here, or every
    // downstream consumer (PendingApprovalCard.tsx's isJudgeUnavailableFailure,
    // MissionNode.tsx) has no way to ever see it — they only see this
    // string. Check BEFORE building the genuine-rejection message below so a
    // real rejection's wording stays byte-identical.
    const judgeReviewer = verdict.reviewers?.find((r) => r.role === 'judge');
    if (judgeReviewer?.summary?.startsWith(`${JUDGE_UNAVAILABLE_PROVIDER_REASON}:`)) {
      return new ApproveBlockedError(
        t
          ? t('agents.approveGate.providerUnavailable')
          : `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: l'évaluation n'a pas pu s'exécuter (fournisseur indisponible) — ` +
            `le code n'a pas été jugé. Utilisez "Merger quand même" après vérification manuelle, ou relancez l'évaluation.`,
        { judgeUnavailable: true, verdictReviewers: toVerdictReviewers(verdict) },
      );
    }
    // R14 (manual-approve honesty fix, this task) — `scoreUnavailable` means
    // the evaluator RAIL failed (no judge/reviewer ever produced a real,
    // parsable score — see evaluator.ts's aggregateVerdict/
    // buildUnavailableVerdict), never a real code review that said no. This
    // is the EXACT case reported live (mission M2: a correct, complete
    // deliverable, evaluator infra failure, and this gate used to say "Le
    // juge a rejeté cette mission (score indisponible)" — a fabricated
    // accusation the system never actually made).
    //
    // BEHAVIOUR CHOICE: evaluateAutoMerge (below, same file) already treats
    // this exact shape as safe to auto-merge for auto_green/full_auto — "a
    // REAL, non-empty deliverable whose verdict is TECHNICALLY unavailable...
    // auto-merges with force... ONLY when there is genuinely something to
    // merge" (its own doc comment, the "lazy floor"). Blocking the EXPLICIT,
    // human-requested manual approve in that exact same shape would be
    // STRICTER than the automatic path — backwards: a human who clicked
    // "Approve" after looking at the work themselves is asking for LESS
    // friction than an unattended auto-merge, not more. So: mirror the same
    // floor here — a real, non-empty diff with an unavailable score is let
    // straight through, not behind a "force"-labelled bypass (there is
    // nothing to force past: no verdict was ever reached to overrule). Only
    // when there's ALSO nothing to merge (empty diff — no real deliverable
    // to have even looked at) does this stay blocked, with the honest
    // "could not evaluate" reason instead of a fabricated rejection.
    if (verdict.scoreUnavailable === true) {
      if (!isDiffEmpty(mission)) {
        return null;
      }
      return new ApproveBlockedError(
        t
          ? t('agents.approveGate.scoreUnavailableEmptyDiff')
          : "Évaluation indisponible — aucun juge n'a pu produire de score, et il n'y a rien à merger (diff vide). " +
            'Vérifiez manuellement, ou utilisez "Merger quand même".',
        { judgeUnavailable: true, verdictReviewers: toVerdictReviewers(verdict) },
      );
    }
    // Genuine rejection: verdict.scoreUnavailable is NOT true here, so
    // formatVerdictScoreLine below is guaranteed to render a REAL number,
    // never the 'score indisponible' placeholder — the two states (rejected
    // vs unavailable) are now mutually exclusive at this call site.
    return new ApproveBlockedError(
      t
        ? t('agents.approveGate.judgeRejected', { score: formatVerdictScoreLine(verdict) })
        : `Le juge a rejeté cette mission (${formatVerdictScoreLine(verdict)}). ` +
          'Corrigez les problèmes ou utilisez "Merger quand même" pour forcer.',
      { verdictReviewers: toVerdictReviewers(verdict) },
    );
  }
  if (!hasRequiredProofs(mission)) {
    const missing = missingProofKinds(mission);
    return new ApproveBlockedError(
      t
        ? t('agents.approveGate.proofsMissing', { missing: missing.join(', ') })
        : `Preuves manquantes avant de passer en Terminé : ${missing.join(', ')}. ` +
          'Utilisez "Merger quand même" pour forcer.',
    );
  }
  return null;
}

// ── QA fixes: merge ──────────────────────────────────────────────

/**
 * True when the mission's OWN diff-stat fields report nothing to merge
 * (both falsy — absent or exactly 0). Pure/mission-fields-only: this alone
 * is never sufficient grounds to BLOCK a force-merge (see B10's root cause
 * below) — it's only the cheap first half of the two-part check
 * approveMission (agentsStore.tsx) runs before trusting it.
 *
 * B10 root cause: mission M10 (judges 0/3, fabricated proof) force-merged
 * silently because checkApproveGate's `force === true` branch above returns
 * `null` UNCONDITIONALLY — force is designed to bypass the judge/proof
 * gates, but it never checked whether there was anything to merge at all,
 * and the underlying Rust merge ALSO reports success on a vacuous "Already
 * up to date" no-op (see agentsStore.tsx's approveMission doc comment for
 * that other half of the fix). isDiffEmpty is checked-only-when-empty
 * because mission.diffAdded/diffRemoved can themselves be stale or
 * fabricated (exactly M10's case) — approveMission additionally verifies
 * against the REAL worktree git diff before actually blocking; this
 * function only decides whether that extra async round-trip is worth
 * making.
 */
export function isDiffEmpty(mission: Pick<Mission, 'diffAdded' | 'diffRemoved'>): boolean {
  return !mission.diffAdded && !mission.diffRemoved;
}

/**
 * True for a mission still sitting in 'review' whose judge verdict came
 * back rejected (passed === false) — the realistic, common "needs another
 * look" case in this codebase's design: a rejected judge verdict does NOT
 * transition status to 'failed' (that status is reserved for genuine run
 * failures — a crash, an exception), it leaves the mission in 'review'
 * awaiting a human decision (force-merge or discard). B15: Retry/
 * "Promouvoir en sonnet"/"Avis du manager" used to be gated on
 * `status === 'failed'` only, which this exact, far more common case never
 * reaches — making that gate "effectively unreachable" in practice. Shared
 * here (rather than duplicated per call site) so the cockpit card, the
 * MissionDetail drawer, and the manager-advice gate all agree on the exact
 * same definition.
 */
export function isJudgeRejected(mission: Pick<Mission, 'status' | 'judgeVerdict'>): boolean {
  return mission.status === 'review' && mission.judgeVerdict?.passed === false;
}

// ── W-MODES: auto-merge eligibility (approval modes) ────────────────

/** The subset of Mission fields evaluateAutoMerge needs — same
 *  Pick-narrowing convention as checkApproveGate/proofs.ts's GateMission, so
 *  a caller can pass a partial/mock mission in tests without assembling a
 *  full Mission. */
export type AutoMergeMission = Pick<
  Mission,
  'status' | 'judgeVerdict' | 'contract' | 'proofs' | 'cost' | 'totalCost' | 'judgesApproved' | 'diffAdded' | 'diffRemoved'
>;

export interface AutoMergeDecision {
  eligible: boolean;
  /**
   * When eligible, whether approveMission must be called with
   * `{ force: true }` to bypass checkApproveGate's judge/proof gates —
   * full_auto's documented bypass for a genuinely MISSING/unusable
   * evaluation signal (absent verdict, or scoreUnavailable). Never set when
   * the green path itself already satisfies checkApproveGate on its own
   * (verdict present, passed, proofs present) — no bypass is needed there.
   */
  useForce: boolean;
  /** Non-user-facing — logs/journal/tests only, never shown as UI copy. */
  reason: string;
}

/**
 * BUG FIX (W-PROVE replay audit, autoMergeSafetyReplay.test.ts): true only
 * once runtime.ts's native evaluation pipeline (Step F) has ITSELF reached a
 * terminal, no-verdict-is-ever-coming outcome — `evaluateMission()` threw
 * (an evaluator-INFRASTRUCTURE crash, never a code rejection), and its own
 * catch block stamped this exact marker (runtime.ts's Step F catch: "judge
 * Verdict stays undefined intentionally — gate will require force").
 *
 * This is the ONE signal that distinguishes "no evaluation is EVER coming"
 * from "the evaluation simply hasn't reported back yet" — a distinction
 * `evaluateAutoMerge` used to not make at all (see its own doc comment
 * below for the concrete bug this caused): runtime.ts's Step D (diff
 * computed -> status 'review', `judgesApproved: undefined`) and the START
 * of Step F ("Évaluation en cours…", still no verdict) BOTH patch the
 * mission with `judgeVerdict === undefined` well BEFORE `evaluateMission()`
 * ever resolves — that call spawns real tester/reviewer/security/judge
 * sub-agent runs and can take real wall-clock time. Treating "hasn't
 * reported back yet" the same as "genuinely inconclusive" force-merged
 * EVERY full_auto mission the instant its diff was computed, before a
 * single evaluator sub-agent had even run — making the documented hard
 * floor (never a security reject, never a real conclusive rejection)
 * unreachable in practice, since the merge would already have happened
 * before that verdict could ever land.
 */
function isEvaluationSettledUnavailable(mission: AutoMergeMission): boolean {
  return mission.judgesApproved === 'évaluation indisponible';
}

/** True when a CONCLUSIVE security reviewer verdict is 'reject' — an
 *  `inconclusive` security sub-agent (an evaluator-infra failure, never a
 *  real finding — see evaluator.ts's aggregateVerdict DEFECT 1) is not a
 *  rejection and never blocks here, same non-vote rule aggregateVerdict
 *  itself already applies when computing `passed`. */
export function hasSecurityRejection(verdict: JudgeVerdict | undefined): boolean {
  if (!verdict) return false;
  return verdict.reviewers.some((r) => r.role === 'security' && r.verdict === 'reject' && r.inconclusive !== true);
}

/**
 * Best-effort parse of Mission.totalCost/.cost's already-formatted spend
 * string (e.g. "$1.23") back into a number, for the budget-cap floor check
 * below. Absent/unparseable is treated as UNKNOWN spend, never a fabricated
 * 0 and never a false block — mirrors runtime.ts's classifyBudget's own
 * "0/absent cap => ok" fail-open philosophy for the same reason: an honest
 * "cannot prove this is over budget" must never masquerade as "under
 * budget" OR as "over budget" — it simply does not gate.
 */
function parseSpentUsd(mission: AutoMergeMission): number | undefined {
  const raw = mission.totalCost ?? mission.cost;
  if (!raw) return undefined;
  const n = Number(raw.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && raw.trim() !== '' ? n : undefined;
}

/** True only when spend is BOTH known and known to have crossed the cap —
 *  see parseSpentUsd's doc comment for why "unknown" never counts as
 *  exceeded (fail-open on a missing/unparseable signal). */
function isBudgetExceeded(mission: AutoMergeMission): boolean {
  const cap = mission.contract?.budgetCapUsd;
  if (!cap || cap <= 0) return false;
  const spent = parseSpentUsd(mission);
  if (spent === undefined) return false;
  return spent >= cap;
}

/**
 * The auto-merge safety matrix for approval modes (W-MODES, types.ts's
 * `ApprovalMode`) — decides whether agentsStore.tsx's
 * `triggerAutoMergeIfEligible` should call the REAL `approveMission` for a
 * mission that just landed (or is still sitting) in 'review'. Checked in
 * order — the first disqualifying rule wins, mirroring checkApproveGate's
 * own ordered-rules convention above.
 *
 * Rule order (both auto modes):
 *   1. mode 'manual', or mission.status !== 'review' → never eligible (this
 *      function's own entry guard — 'review' is the only status it ever
 *      evaluates; a defensive floor item in its own right, not merely an
 *      early return, since a genuine run FAILURE (status 'failed') must
 *      never reach auto-merge through this path either).
 *   2. contract.gates.humanApprove === true → never eligible, in EITHER
 *      auto mode — the mission's own explicit per-mission opt-out always
 *      wins over the project-level mode (spec: "always wins").
 *   3. Budget cap exceeded (isBudgetExceeded) → never eligible, in EITHER
 *      auto mode — "budget caps still enforced" is a hard floor, not a
 *      green-path-only rule.
 *   4. A CONCLUSIVE security-reviewer rejection (hasSecurityRejection) →
 *      never eligible, in EITHER auto mode — full_auto's "even inconclusive"
 *      permissiveness never extends to an explicit reject.
 *   5. A REAL, conclusive judge rejection (`judgeVerdict.passed === false`
 *      AND NOT scoreUnavailable — a genuine score/consensus said no, as
 *      opposed to no usable signal at all) → never eligible, in EITHER auto
 *      mode. This is the line between "inconclusive" (full_auto proceeds)
 *      and "rejected" (neither mode ever does) the design calls for.
 *   6. The GREEN path — judgeVerdict present, passed === true, and
 *      hasRequiredProofs — eligible in BOTH auto_green and full_auto,
 *      useForce: false (checkApproveGate already allows this unassisted).
 *   7. Otherwise (verdict absent, or scoreUnavailable, or proofs missing,
 *      and none of the floor rules above fired): eligible ONLY in
 *      full_auto, via the documented `force: true` bypass — auto_green
 *      requires the strict green path and stops here for a human, matching
 *      its own "failures/rejections/inconclusive still stop" contract.
 *      EXCEPTION (bug fix, see isEvaluationSettledUnavailable's own doc
 *      comment): when the verdict is entirely ABSENT, full_auto's bypass
 *      fires ONLY once runtime.ts's evaluation pipeline has itself settled
 *      on "no verdict is coming" — an absent verdict alone, with no such
 *      marker, means Step F simply hasn't reported back YET and is NOT
 *      eligible (mirrors auto_green here) — this is the one case this
 *      function distinguishes "pending" from "inconclusive" rather than
 *      collapsing them, because collapsing them defeated full_auto's own
 *      hard floor in the common native-mission timeline (Step D always
 *      precedes Step F's real verdict by a real, often long, gap).
 */
// ── Retroactive fix: legacy pre-1acd6bb missions stuck in 'review' ─────

/** A mission as loaded from persistence — same field subset as
 *  AutoMergeMission, plus `id` so the caller can address the patch back to
 *  the right mission (AutoMergeMission itself has no id — see its own doc
 *  comment on why it's a narrow Pick). */
export type LegacyReviewMission = AutoMergeMission & Pick<Mission, 'id'>;

export interface LegacyMigrationResult {
  missionId: string;
  /**
   * True only when the mission clears the STRICT green path (judge passed +
   * required proofs present) once the erroneous humanApprove floor is
   * removed — safe for the caller to persist `contract.gates.humanApprove:
   * false` on this mission and re-run it through the normal
   * triggerAutoMergeIfEligible/evaluateAutoMerge choke point, which will
   * then merge it for real.
   *
   * False means: leave the mission's contract untouched. It stays exactly
   * as blocked/pending as it is today — this function never removes the
   * floor for a mission it isn't confident is safe to unblock.
   */
  eligible: boolean;
}

/**
 * Root-cause retroactive fix (2026-08-02, phase 2 of the "review missions
 * never resolve" incident — 1acd6bb only fixed NEW mission creation).
 *
 * Every mission-creation path hardcoded `contract.gates.humanApprove: true`
 * until 1acd6bb. evaluateAutoMerge's rule #2 treats that as an unconditional
 * per-mission auto-merge opt-out — correct BY DESIGN for a real, deliberate
 * opt-out, but every mission created before that fix landed carries this
 * baked-in `true` forever, and 1acd6bb only changed what NEW missions get.
 * Without this function, those missions are stuck in 'review' for the life
 * of the project regardless of the project's own auto_green/full_auto mode.
 *
 * PROVENANCE COMPROMISE (documented, not hidden): `GateConfig` (types.ts)
 * has no field recording WHY `humanApprove` is `true` — a buggy hardcoded
 * default and a deliberate per-mission opt-out are bit-for-bit
 * indistinguishable in the persisted data today. This function's
 * precondition is a repo-wide fact checked at the time it was written
 * (2026-08-02): zero production code paths ever set `humanApprove: true`
 * intentionally — no UI toggle for it exists anywhere (NewMissionModal's own
 * doc comment says so directly). So today, every persisted `true` on a
 * 'review' mission IS the bug, with no exception to silently paper over. If
 * a future UI ever adds a real per-mission opt-out toggle, this precondition
 * breaks and this function must be revisited first (e.g. a
 * `gates.humanApproveExplicit` marker set only by that toggle) — it must not
 * keep running unconditionally past that point.
 *
 * SAFETY — deliberately STRICTER than evaluateAutoMerge's own full_auto
 * floor: only ever proposes unblocking a mission on the STRICT green path
 * (`eligible === true && useForce === false`, i.e. rule #6 in
 * evaluateAutoMerge's own doc comment — real passed verdict, real proofs).
 * full_auto's documented "inconclusive evaluation, force-merge" floor
 * (`useForce === true`) is intentionally NEVER applied by this migration,
 * even in a full_auto project: a one-time batch retroactive pass must never
 * be the thing that force-merges a mission whose evaluation a human never
 * actually looked at. A rejected verdict, a missing verdict, missing proofs,
 * an exceeded budget, or `mode === 'manual'` all fall through to `eligible:
 * false` here (evaluateAutoMerge's own rules already cover 'manual' and the
 * hard floors) — the mission is left exactly as pending as it was, per this
 * task's own "never silently change a security decision" constraint.
 */
export function planLegacyHumanApproveMigration(
  missions: readonly LegacyReviewMission[],
  mode: ApprovalMode,
): LegacyMigrationResult[] {
  return missions
    .filter((m) => m.status === 'review' && m.contract?.gates?.humanApprove === true)
    .map((m): LegacyMigrationResult => {
      const candidate: LegacyReviewMission = {
        ...m,
        contract: m.contract ? { ...m.contract, gates: { ...m.contract.gates, humanApprove: false } } : m.contract,
      };
      const decision = evaluateAutoMerge(candidate, mode);
      return { missionId: m.id, eligible: decision.eligible && decision.useForce === false };
    });
}

export function evaluateAutoMerge(mission: AutoMergeMission, mode: ApprovalMode): AutoMergeDecision {
  if (mode === 'manual') {
    return { eligible: false, useForce: false, reason: 'manual mode never auto-merges' };
  }
  if (mission.status !== 'review') {
    return { eligible: false, useForce: false, reason: 'mission is not in review' };
  }
  if (mission.contract?.gates?.humanApprove === true) {
    return { eligible: false, useForce: false, reason: 'contract.gates.humanApprove opts this mission out' };
  }
  if (isBudgetExceeded(mission)) {
    return { eligible: false, useForce: false, reason: 'budget cap exceeded' };
  }
  const verdict = mission.judgeVerdict;
  if (hasSecurityRejection(verdict)) {
    return { eligible: false, useForce: false, reason: 'security reviewer rejected' };
  }
  if (verdict && verdict.passed === false && verdict.scoreUnavailable !== true) {
    return { eligible: false, useForce: false, reason: 'judge conclusively rejected' };
  }

  const greenPath = verdict !== undefined && verdict.passed === true && hasRequiredProofs(mission);
  if (greenPath) {
    return { eligible: true, useForce: false, reason: 'green: verdict passed, proofs present' };
  }
  // Lazy-mode floor (real-user feedback 2026-08-03: "le mode lazy accepte
  // direct" — Cursor/Windsurf apply real work without a per-mission merge
  // prompt): a REAL, non-empty deliverable whose verdict is TECHNICALLY
  // unavailable (scoreUnavailable — the evaluator rail failed with an API
  // error, never a code rejection) auto-merges with force, exactly like
  // full_auto's floor, but ONLY when there is genuinely something to
  // merge. An empty deliverable (no diff) or a CONCLUSIVE rejection still
  // blocks and asks the human.
  if (verdict && verdict.scoreUnavailable === true && !isDiffEmpty(mission)) {
    return {
      eligible: true,
      useForce: true,
      reason: 'lazy floor: real deliverable, evaluation technically unavailable (scoreUnavailable)',
    };
  }
  if (mode === 'full_auto') {
    // Bug fix — see isEvaluationSettledUnavailable's own doc comment: an
    // absent verdict alone (no settled-unavailable marker) means the
    // evaluation pipeline hasn't reported back YET, not that it never will.
    if (verdict === undefined && !isEvaluationSettledUnavailable(mission)) {
      return { eligible: false, useForce: false, reason: 'full_auto: evaluation still pending, not yet inconclusive' };
    }
    return {
      eligible: true,
      useForce: true,
      reason: 'full_auto floor: inconclusive/no-signal evaluation, forcing merge',
    };
  }
  return { eligible: false, useForce: false, reason: 'auto_green: green conditions not met' };
}
