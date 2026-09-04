/* harnessLearning.ts — The harness-compiles loop (Phase C).

   Turns recurring journal pathologies (from frictionMiner) into LEARNED
   harness rules, stored as brain neurons in `trial` status, then lets the
   evalGate-style evidence decide promotion to `proven` or eviction.

   This closes the deck's "the harness compounds" loop in Lazy's own data
   model:
     repeated mistake → anti-pattern entry (frictionMiner)
       → NEW rule neuron, status=trial, provenance=missionId
         → injected at the next mission (see harnessRules.ts)
           → brain.recalled carries the rule's nodeId
             → joined to mission.failed of the SAME mission
               → helped/harmed evidence
                 → trial → proven | evicted

   Design contract:
   - A rule is distilled ONLY from candidates backed by real journal
     evidence (frictionMiner's mineFrictionsFromJournal output). No
     synthetic rules.
   - A learned rule that already exists (same body, any status) is never
     duplicated — it is skipped.
   - Eviction is a DATA decision (status=evicted), not a deletion: the
     rule stays in the graph for audit, which is a differentiator.
   - Never throws to callers; a brain failure just means no rule captured.
*/

import { captureRule, listRules, type HarnessRule, type RuleStatus } from './harnessRules.js';
import type { ImprovementCandidate } from './frictionMiner.js';

// ── Constants ──────────────────────────────────────────────────────

/** Evidence threshold before a candidate becomes a learned rule. */
export const MIN_FAILURE_COUNT_FOR_RULE = 2;
/** Severity threshold: only medium+ frictions seed rules. */
export const MIN_SEVERITY_FOR_RULE = 1; // medium = 1 (see frictionMiner severity map)

/** Default priority for learned rules (below manual 90, above imported 50). */
export const LEARNED_RULE_PRIORITY = 70;

// ── Pure: candidate → rule mapping ─────────────────────────────────

/**
 * Convert a friction candidate into a harness rule body. Pure.
 * The body is the actionable rule; the candidate's rationale becomes the
 * `tags` provenance so the brain graph keeps the evidence joinable.
 */
export function candidateToRuleBody(candidate: ImprovementCandidate): string {
  // Prefer the candidate's own suggested task when it is a concrete
  // instruction; otherwise fall back to the rationale.
  const instruction = candidate.suggestedTask.trim();
  return instruction.length >= 12 ? instruction : candidate.rationale.trim();
}

/**
 * Decide whether a candidate is seed-worthy. Pure.
 * Mirrors evalGate's conservatism: a single anecdotal failure never seeds
 * a rule — the journal must show a recurrence (>= MIN_FAILURE_COUNT_FOR_RULE
 * evidence items) and the severity must be medium+.
 */
export function isCandidateSeedWorthy(candidate: ImprovementCandidate): boolean {
  if (candidate.severity === 'low') return false;
  const evidenceCount = candidate.evidence?.length ?? 0;
  if (evidenceCount < MIN_FAILURE_COUNT_FOR_RULE) return false;
  return true;
}

// ── Pure: rule transition decision (evalGate for rules) ────────────

/**
 * Decide the next status of a learned rule from evidence counters.
 * Pure — mirrors lessons/evalGate.ts's thresholds, adapted to rules:
 *   - trial → proven: helped >= 2 AND harmed == 0
 *   - trial → evicted: harmed >= 2
 *   - proven → evicted: harmed >= 3 (recent harm streak)
 */
export function decideRuleTransition(
  current: RuleStatus,
  counters: { helped: number; harmed: number },
): { next: RuleStatus; changed: boolean } {
  const { helped, harmed } = counters;

  if (current === 'trial') {
    if (helped >= 2 && harmed === 0) return { next: 'proven', changed: true };
    if (harmed >= 2) return { next: 'evicted', changed: true };
    return { next: 'trial', changed: false };
  }
  if (current === 'proven') {
    if (harmed >= 3) return { next: 'evicted', changed: true };
    return { next: 'proven', changed: false };
  }
  return { next: 'evicted', changed: false };
}

// ── Async: capture learned rules ───────────────────────────────────

/**
 * Seed learned rules from a set of friction candidates. Fire-and-forget:
 * a brain failure never propagates. Deduplicates against existing rules
 * by body (any status). Returns the number of rules newly captured.
 */
export async function seedLearnedRules(
  candidates: readonly ImprovementCandidate[],
  project?: string,
): Promise<number> {
  try {
    const existing = await listRules({ limit: 500 });
    const existingBodies = new Set(existing.map((r) => r.body.toLowerCase()));

    let seeded = 0;
    for (const candidate of candidates) {
      if (!isCandidateSeedWorthy(candidate)) continue;
      const body = candidateToRuleBody(candidate);
      if (existingBodies.has(body.toLowerCase())) continue;

      const rule: HarnessRule = {
        id: `learned-${candidate.id}-${Date.now().toString(36)}`,
        title: `[rule] ${body.slice(0, 100)}`,
        body,
        scope: 'project',
        project,
        priority: LEARNED_RULE_PRIORITY,
        source: 'learned',
        status: 'trial',
        tags: [`friction:${candidate.why}`, `where:${candidate.where}`, ...(candidate.evidence ?? [])],
        missionId: candidate.evidence?.[0] ?? undefined,
      };

      const id = await captureRule(rule);
      if (id) {
        seeded++;
        existingBodies.add(body.toLowerCase());
      }
    }
    return seeded;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[harnessLearning] seedLearnedRules failed:', msg);
    return 0;
  }
}
