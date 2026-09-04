/**
 * Tests for the GOAL LOOP (managerEngine.ts) — founder directive: "le
 * LazyIDE doit être capable de lancer un plan, et en temps réel voir si le
 * plan suffit ou s'il faut rajouter des étapes ... jusqu'à arriver à
 * l'objectif". Covers the pure, unit-testable core only: goal capture
 * (createConversationGoal), the per-turn instruction block
 * (buildGoalStatusContext + its rendering in buildManagerDynamicContext),
 * the budget/escalation/anti-procrastination state machine
 * (applyGoalEvaluationOutcome + isResearchOnlyActionSet), and the
 * user-visible notices. The STATEFUL wiring (WHEN a goal is captured/
 * evaluated across real turns, the module-level Map) lives in
 * agentsStore.tsx's sendManagerMessage and is exercised indirectly by the
 * full agentsStore/managerEngine regression suite (no LLM call needed to
 * reach any of these functions — see each function's own doc comment,
 * managerEngine.ts).
 */

import { describe, it, expect } from 'vitest';
import {
  detectUserActionRequest,
  createConversationGoal,
  buildGoalStatusContext,
  applyGoalEvaluationOutcome,
  isResearchOnlyActionSet,
  buildGoalTrackedNotice,
  buildGoalAchievedNotice,
  buildGoalExhaustedNotice,
  buildManagerDynamicContext,
  MAX_GOAL_EXTENSIONS,
  RESEARCH_ONLY_STREAK_BUDGET,
  GOAL_TEXT_MAX_CHARS,
  type ConversationGoal,
  type ManagerContext,
} from '../lib/agents/managerEngine';
import type { ManagerAction } from '../lib/agents/types';

function baseGoal(overrides: Partial<ConversationGoal> = {}): ConversationGoal {
  return {
    goalText: 'Real data in the dashboard',
    createdAt: 0,
    extensionsUsed: 0,
    status: 'active',
    researchOnlyStreak: 0,
    ...overrides,
  };
}

// (a) user action-request message → goal recorded ─────────────────────────
describe('GOAL LOOP — capture (createConversationGoal)', () => {
  it('a clear action-request message produces an active, zero-budget goal record', () => {
    const text = 'Lance la mission qui met de vraies données dans le dashboard.';
    expect(detectUserActionRequest(text)).toBe(true);

    const goal = createConversationGoal(text, 1000);
    expect(goal).toEqual({
      goalText: text,
      createdAt: 1000,
      extensionsUsed: 0,
      status: 'active',
      researchOnlyStreak: 0,
    });
  });

  it('a non-action message is not detected as a trigger (goal capture is gated on detectUserActionRequest)', () => {
    expect(detectUserActionRequest('Merci, à demain.')).toBe(false);
    expect(detectUserActionRequest("Quel est l'état du projet ?")).toBe(false);
  });

  it('truncates a goal longer than GOAL_TEXT_MAX_CHARS, marking the cut with an ellipsis', () => {
    const long = `lance ${'x'.repeat(600)}`;
    const goal = createConversationGoal(long, 0);
    expect(goal.goalText.length).toBe(GOAL_TEXT_MAX_CHARS + 1);
    expect(goal.goalText.endsWith('…')).toBe(true);
  });
});

// (b) wakeup with active goal → evaluation block present in the built context
describe('GOAL LOOP — evaluation block rendering (buildManagerDynamicContext)', () => {
  it('renders the Goal Evaluation section with the goal text and remaining-extensions count when goalStatusContext is set', () => {
    const goal = baseGoal();
    const content = buildGoalStatusContext({ goal, budgetExhausted: false, researchBudgetExhausted: false });
    const ctx: ManagerContext = { agents: [], missions: [], goalStatusContext: content };

    const rendered = buildManagerDynamicContext(ctx);

    expect(rendered).toContain('### Goal Evaluation');
    expect(rendered).toContain('Real data in the dashboard');
    expect(rendered).toContain(`You have ${MAX_GOAL_EXTENSIONS} extension(s) left.`);
    expect(rendered).toMatch(/never just research/i);
  });

  it('omits the Goal Evaluation section entirely when no goal is active (undefined goalStatusContext) — zero behavior change', () => {
    const ctx: ManagerContext = { agents: [], missions: [] };
    expect(buildManagerDynamicContext(ctx)).not.toContain('### Goal Evaluation');
  });
});

// (c) launch action during evaluation → extensionsUsed increments ─────────
describe('GOAL LOOP — applyGoalEvaluationOutcome: progress', () => {
  it('a non-research action emitted during evaluation increments extensionsUsed and resets the research streak', () => {
    const goal = baseGoal({ extensionsUsed: 1, researchOnlyStreak: 2 });
    const outcome = applyGoalEvaluationOutcome({
      goal,
      wasBudgetExhausted: false,
      actionsThisTurn: [{ type: 'launch_mission', task: 'wire real Supabase data into the dashboard' } as ManagerAction],
    });

    expect(outcome.kind).toBe('advanced');
    expect(outcome.goal.extensionsUsed).toBe(2);
    expect(outcome.goal.researchOnlyStreak).toBe(0);
    expect(outcome.goal.status).toBe('active');
  });

  it('a mixed batch (research + a real action) still counts as progress, not research-only', () => {
    const goal = baseGoal();
    const mixed: ManagerAction[] = [
      { type: 'brain_query', query: 'dashboard data source' } as ManagerAction,
      { type: 'launch_mission', task: 'fix dashboard' } as ManagerAction,
    ];
    expect(isResearchOnlyActionSet(mixed)).toBe(false);

    const outcome = applyGoalEvaluationOutcome({ goal, wasBudgetExhausted: false, actionsThisTurn: mixed });
    expect(outcome.kind).toBe('advanced');
    expect(outcome.goal.extensionsUsed).toBe(1);
  });

  it('zero actions during an evaluation turn marks the goal achieved-claimed (simple, observable heuristic)', () => {
    const goal = baseGoal();
    const outcome = applyGoalEvaluationOutcome({ goal, wasBudgetExhausted: false, actionsThisTurn: [] });
    expect(outcome.kind).toBe('achieved-claimed');
    expect(outcome.goal.status).toBe('achieved-claimed');
  });
});

// (d) 5 extensions → escalation instruction + status exhausted ────────────
describe('GOAL LOOP — budget exhaustion + escalation', () => {
  it(`buildGoalStatusContext switches to the honest-report-and-stop escalation once extensionsUsed reaches MAX_GOAL_EXTENSIONS (${MAX_GOAL_EXTENSIONS})`, () => {
    const goal = baseGoal({ extensionsUsed: MAX_GOAL_EXTENSIONS });
    const block = buildGoalStatusContext({ goal, budgetExhausted: true, researchBudgetExhausted: false });

    expect(block).toMatch(new RegExp(`all ${MAX_GOAL_EXTENSIONS} extensions`, 'i'));
    expect(block).toMatch(/honestly report status/i);
    expect(block).toMatch(/do not launch or plan any further action/i);
    // Must never ALSO contain the ordinary evaluate/re-evaluate instruction —
    // the model gets exactly one instruction per turn, never both mixed.
    expect(block).not.toMatch(/Evaluate: is this goal now FULLY achieved/);
  });

  it('applyGoalEvaluationOutcome settles an exhausted-budget evaluation turn to a terminal "exhausted" status regardless of what the model emitted', () => {
    const goal = baseGoal({ extensionsUsed: MAX_GOAL_EXTENSIONS });
    const outcome = applyGoalEvaluationOutcome({ goal, wasBudgetExhausted: true, actionsThisTurn: [] });
    expect(outcome.kind).toBe('exhausted');
    expect(outcome.goal.status).toBe('exhausted');

    // Even if the model tried to launch something anyway, exhaustion wins.
    const outcomeWithAction = applyGoalEvaluationOutcome({
      goal,
      wasBudgetExhausted: true,
      actionsThisTurn: [{ type: 'launch_mission', task: 'one more try' } as ManagerAction],
    });
    expect(outcomeWithAction.kind).toBe('exhausted');
    expect(outcomeWithAction.goal.status).toBe('exhausted');
  });
});

// (e) 2 research-only turns → anti-procrastination clause appears ─────────
describe('GOAL LOOP — anti-procrastination (research-only streak)', () => {
  const researchActions: ManagerAction[] = [{ type: 'brain_query', query: 'dashboard data source' } as ManagerAction];

  it('isResearchOnlyActionSet is true only for a non-empty, ALL-read-only action batch', () => {
    expect(isResearchOnlyActionSet(researchActions)).toBe(true);
    expect(isResearchOnlyActionSet([])).toBe(false);
    expect(isResearchOnlyActionSet([{ type: 'launch_mission', task: 'x' } as ManagerAction])).toBe(false);
  });

  it(`after ${RESEARCH_ONLY_STREAK_BUDGET} consecutive research-only evaluation turns, the NEXT built context carries the anti-procrastination clause`, () => {
    let goal = baseGoal();

    for (let i = 0; i < RESEARCH_ONLY_STREAK_BUDGET; i += 1) {
      const outcome = applyGoalEvaluationOutcome({ goal, wasBudgetExhausted: false, actionsThisTurn: researchActions });
      expect(outcome.kind).toBe('research-streak');
      goal = outcome.goal;

      // Before the budget is reached, the clause must NOT appear yet.
      const block = buildGoalStatusContext({
        goal,
        budgetExhausted: false,
        researchBudgetExhausted: goal.researchOnlyStreak >= RESEARCH_ONLY_STREAK_BUDGET,
      });
      if (i < RESEARCH_ONLY_STREAK_BUDGET - 1) {
        expect(block).not.toMatch(/Research budget exhausted/);
      } else {
        expect(block).toMatch(/Research budget exhausted for this goal/);
        expect(block).toMatch(/MUST include a non-research action or an honest final report/);
      }
    }
    expect(goal.researchOnlyStreak).toBe(RESEARCH_ONLY_STREAK_BUDGET);
  });

  it('a real action after a research streak resets it back to 0', () => {
    const streaking = baseGoal({ researchOnlyStreak: RESEARCH_ONLY_STREAK_BUDGET });
    const outcome = applyGoalEvaluationOutcome({
      goal: streaking,
      wasBudgetExhausted: false,
      actionsThisTurn: [{ type: 'launch_mission', task: 'actually fix it' } as ManagerAction],
    });
    expect(outcome.goal.researchOnlyStreak).toBe(0);
  });
});

// User-visible notices (locale-aware, same convention as the PROMISE-STALL nudge) ──
describe('GOAL LOOP — user-visible notices', () => {
  it('buildGoalTrackedNotice is French by default locale, English otherwise', () => {
    expect(buildGoalTrackedNotice('lance la mission dashboard', 'fr')).toMatch(/^\[objectif\] Suivi activé : «/);
    expect(buildGoalTrackedNotice('launch the dashboard mission', 'en')).toMatch(/^\[goal\] Tracking enabled: "/);
  });

  it('buildGoalAchievedNotice surfaces the model\'s own first response line as evidence', () => {
    const fr = buildGoalAchievedNotice('Le dashboard affiche maintenant les vraies données Supabase.\nDétails...', 'fr');
    expect(fr).toMatch(/^\[objectif\] Atteint —/);
    expect(fr).toContain('vraies données Supabase');

    const en = buildGoalAchievedNotice('The dashboard now shows real Supabase data.', 'en');
    expect(en).toMatch(/^\[goal\] Achieved —/);
  });

  it('buildGoalExhaustedNotice matches the exact founder-specified wording', () => {
    expect(buildGoalExhaustedNotice('fr')).toBe('[objectif] Budget épuisé — rapport final ci-dessous.');
    expect(buildGoalExhaustedNotice('en')).toBe('[goal] Budget exhausted — final report below.');
  });
});
