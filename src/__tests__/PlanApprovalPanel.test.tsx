import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlanApprovalPanel } from '../components/agents/orchestrator/PlanApprovalPanel';
import { planConfirmSummary, planCostRollup, stepMetaLine, stepScopeLine } from '../lib/agents/planApprovalMeta';
import type { OrchestratorPlanStep, OrchestratorState } from '../lib/agents/types';

function step(partial: Partial<OrchestratorPlanStep> & Pick<OrchestratorPlanStep, 'id' | 'description'>): OrchestratorPlanStep {
  return {
    status: 'pending',
    missionIds: [],
    dependsOn: [],
    autonomyLevel: 'supervised',
    ...partial,
  };
}

function plan(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    id: 'orch-1',
    name: 'Ship recall',
    projectId: 'proj-1',
    targetProjectIds: ['proj-1'],
    objective: 'Measure /_api/recall then ship',
    steps: [
      step({
        id: 's1',
        description: 'Index the corpus',
        agentName: 'indexer',
        model: 'claude-sonnet',
        effort: 'high',
        budgetCapUsd: 0.5,
      }),
      step({ id: 's2', description: 'Verify hits', dependsOn: ['s1'] }),
    ],
    currentStep: 0,
    status: 'planning',
    budget: { spentCents: 0 },
    childMissionIds: [],
    createdAt: 1,
    updatedAt: 1,
    autonomyLevel: 'supervised',
    ...overrides,
  };
}

describe('stepMetaLine', () => {
  it('joins only real fields — never a placeholder', () => {
    const steps = plan().steps;
    const byId = new Map(steps.map((s, i) => [s.id, i] as const));
    expect(stepMetaLine(steps[0]!, byId)).toContain('@indexer');
    expect(stepMetaLine(steps[0]!, byId)).toContain('claude-sonnet');
    expect(stepMetaLine(steps[0]!, byId)).toContain('credits max');
    expect(stepMetaLine(steps[1]!, byId)).toBe('after #1');
  });

  it('prefers exact modelId over a display-label model field', () => {
    const s = step({
      id: 'm',
      description: 'x',
      model: 'Claude Sonnet',
      modelId: 'anthropic/claude-sonnet-5',
    });
    expect(stepMetaLine(s, new Map())).toContain('anthropic/claude-sonnet-5');
    expect(stepMetaLine(s, new Map())).not.toContain('Claude Sonnet');
  });
});

describe('stepScopeLine', () => {
  it('is null when no paths were declared', () => {
    expect(stepScopeLine(step({ id: 's', description: 'x' }))).toBeNull();
  });

  it('lists declared paths and a remainder, never invented files', () => {
    const s = step({
      id: 's',
      description: 'x',
      scopePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
    });
    expect(stepScopeLine(s)).toBe('touches src/a.ts, src/b.ts, src/c.ts, src/d.ts +1');
  });
});

describe('PlanApprovalPanel', () => {
  it('uses design-system tokens instead of leftover Tailwind greens', () => {
    render(<PlanApprovalPanel orchestrator={plan()} onApprove={vi.fn()} onRevise={vi.fn()} onReject={vi.fn()} />);
    const approve = screen.getByTestId('plan-approval-approve');
    expect(approve.className).not.toMatch(/bg-green-700/);
    expect(approve.style.background).toContain('--color-success-soft');
    expect(screen.getByTestId('plan-approval-panel').style.background).toContain('--color-panel');
    expect(screen.getByTestId('plan-approval-step-meta-s1').textContent).toContain('@indexer');
  });

  it('wires Revise / Reject on the review step without touching onApprove', () => {
    const onApprove = vi.fn();
    const onRevise = vi.fn();
    const onReject = vi.fn();
    render(<PlanApprovalPanel orchestrator={plan()} onApprove={onApprove} onRevise={onRevise} onReject={onReject} />);
    fireEvent.click(screen.getByTestId('plan-approval-revise'));
    fireEvent.click(screen.getByTestId('plan-approval-reject'));
    expect(onApprove).not.toHaveBeenCalled();
    expect(onRevise).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('does not fire onApprove until the two-click confirm', () => {
    const onApprove = vi.fn();
    render(<PlanApprovalPanel orchestrator={plan()} onApprove={onApprove} onRevise={vi.fn()} onReject={vi.fn()} />);
    fireEvent.click(screen.getByTestId('plan-approval-approve'));
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByTestId('plan-approval-confirm-summary').textContent).toContain('2 steps');
    expect(screen.getByTestId('plan-approval-confirm-summary').textContent).toContain('50');
    fireEvent.click(screen.getByTestId('plan-approval-confirm'));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('Back leaves the plan unapproved', () => {
    const onApprove = vi.fn();
    render(<PlanApprovalPanel orchestrator={plan()} onApprove={onApprove} onRevise={vi.fn()} onReject={vi.fn()} />);
    fireEvent.click(screen.getByTestId('plan-approval-approve'));
    fireEvent.click(screen.getByTestId('plan-approval-back'));
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByTestId('plan-approval-approve')).toBeTruthy();
  });

  it('renders declared scopePaths and never invents files', () => {
    render(
      <PlanApprovalPanel
        orchestrator={plan({
          steps: [
            step({ id: 's1', description: 'Index the corpus', scopePaths: ['src/auth.ts'] }),
            step({ id: 's2', description: 'Verify hits' }),
          ],
        })}
        onApprove={vi.fn()}
        onRevise={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByTestId('plan-approval-step-scope-s1').textContent).toBe('touches src/auth.ts');
    expect(screen.queryByTestId('plan-approval-step-scope-s2')).toBeNull();
  });

  it('renders a real git diff for declared paths and omits empty/error', async () => {
    const loadFileDiff = vi.fn(async (path: string) => {
      if (path === 'src/auth.ts') return 'diff --git a/src/auth.ts b/src/auth.ts\n+export const x = 1';
      return 'No changes';
    });
    render(
      <PlanApprovalPanel
        orchestrator={plan({
          steps: [
            step({ id: 's1', description: 'Index the corpus', scopePaths: ['src/auth.ts'] }),
            step({ id: 's2', description: 'Verify hits', scopePaths: ['src/missing.ts'] }),
          ],
        })}
        loadFileDiff={loadFileDiff}
        onApprove={vi.fn()}
        onRevise={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(await screen.findByTestId('plan-approval-step-diff-s1')).toHaveTextContent('+export const x = 1');
    expect(screen.queryByTestId('plan-approval-step-diff-s2')).toBeNull();
  });
});

describe('planCostRollup', () => {
  it('sums only steps that actually have a budgetCapUsd', () => {
    const rollup = planCostRollup(plan().steps);
    expect(rollup).toEqual({ totalSteps: 2, cappedSteps: 1, creditsMax: 50 });
    expect(planConfirmSummary(rollup)).toBe('2 steps · 50 credits max on 1 step');
    expect(planConfirmSummary({ totalSteps: 3, cappedSteps: 0, creditsMax: null })).toBe(
      '3 steps · no per-step credit caps',
    );
  });
});
