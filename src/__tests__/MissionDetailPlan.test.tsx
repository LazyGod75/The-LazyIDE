/**
 * MissionDetailPlan.test.tsx
 *
 * The active ("in_progress") plan step must never show a fabricated
 * sub-progress bar — PlanStep/StageContract carry no real per-step
 * progress fraction anywhere in the system, so none should be rendered.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { MissionDetailPlan } from '../components/agents/MissionDetailPlan';
import type { PlanStep } from '../lib/agents/types';

describe('MissionDetailPlan — no fabricated sub-progress', () => {
  it('does not render a progress bar for the active step', () => {
    const steps: PlanStep[] = [
      { label: 'Analyze', state: 'done' },
      { label: 'Implement', state: 'in_progress', meta: 'editing 3 files' },
      { label: 'Test', state: 'todo' },
    ];
    const { container } = render(<MissionDetailPlan planSteps={steps} />);
    expect(container.querySelector('.agent-progress-bar')).toBeNull();
    expect(container.querySelector('.agent-progress-track')).toBeNull();
  });

  it('never renders the old hardcoded 45% width anywhere in the DOM', () => {
    const steps: PlanStep[] = [{ label: 'Implement', state: 'in_progress' }];
    const { container } = render(<MissionDetailPlan planSteps={steps} />);
    const widths = Array.from(container.querySelectorAll<HTMLElement>('[style]')).map(
      (el) => el.style.width,
    );
    expect(widths).not.toContain('45%');
  });

  it('still renders step labels and the done/todo states normally', () => {
    const steps: PlanStep[] = [
      { label: 'Analyze', state: 'done' },
      { label: 'Implement', state: 'in_progress' },
      { label: 'Test', state: 'todo' },
    ];
    const { getByText } = render(<MissionDetailPlan planSteps={steps} />);
    expect(getByText('Analyze')).toBeInTheDocument();
    expect(getByText('Implement')).toBeInTheDocument();
    expect(getByText('Test')).toBeInTheDocument();
  });
});
