/* planActionErrors.ts — logging for Cockpit's plan-card actions (err-2 fix,
   silent-failure audit).

   Cockpit.tsx wires GraphProposalCard's Approve/Reject/Revise buttons to
   agentsStore's executePlan/rejectPlan/revisePlan via
   `<action>(id).catch(() => {})`. executePlan already routes every real
   failure through its own revertToPendingWithError (toast + card state —
   see agentsStore.tsx), so its outer catch is a documented best-effort
   guard. rejectPlan and revisePlan do NOT self-report: a thrown
   resolveOrchestratorRoot/getOrchestrator/deleteOrchestrator/
   updateOrchestrator left the user with a card that silently stayed
   'pending' and nothing else — no log, no toast, no visible reason.

   Kept as one small named function (not inlined at each call site) so it is
   independently testable without mounting the full Cockpit tree.
*/

export type PlanAction = 'rejectPlan' | 'revisePlan';

/**
 * Logs a plan-card action failure with enough context to diagnose it
 * (which action, which plan, the original error) without changing the
 * nominal (success) behavior of either action.
 */
export function logPlanActionFailure(action: PlanAction, planId: string, error: unknown): void {
  console.error(`Cockpit: ${action} failed`, { planId, error });
}
