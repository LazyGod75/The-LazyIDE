/**
 * MissionDetailJudge.test.tsx — R14 (this task): a verdict whose evaluator
 * rail never produced a usable score (JudgeVerdict.scoreUnavailable) must
 * render an honest "evaluation unavailable" state, never the red "Not
 * passed" label a genuine rejection gets — see approveGate.ts's
 * checkApproveGate doc comment for the same distinction applied to the
 * merge-block message this component's own sibling surface (mission
 * detail) renders.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { MissionDetailJudge } from '../components/agents/MissionDetailJudge';
import type { JudgeVerdict } from '../lib/agents/types';

function renderJudge(verdict: JudgeVerdict | undefined) {
  return render(
    <I18nProvider>
      <MissionDetailJudge verdict={verdict} isRunning={false} onRunReview={() => {}} onRunTests={() => {}} />
    </I18nProvider>,
  );
}

describe('MissionDetailJudge — R14 honesty: scoreUnavailable is never rendered as "Not passed"', () => {
  it('a genuine rejection (real score, scoreUnavailable not set) renders "Not passed"', () => {
    const verdict: JudgeVerdict = {
      score: 20, passed: false, risk: 'high', reviewers: [], createdAt: new Date().toISOString(),
    };
    renderJudge(verdict);
    expect(screen.getByText('Not passed')).toBeInTheDocument();
    expect(screen.queryByText('Evaluation unavailable')).not.toBeInTheDocument();
  });

  it('a scoreUnavailable verdict (passed:false, no real score) renders "Evaluation unavailable", never "Not passed"', () => {
    const verdict: JudgeVerdict = {
      score: 0, passed: false, risk: 'high', reviewers: [], createdAt: new Date().toISOString(), scoreUnavailable: true,
    };
    renderJudge(verdict);
    expect(screen.getByText('Evaluation unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Not passed')).not.toBeInTheDocument();
  });

  it('a genuine pass still renders "Passed" regardless of scoreUnavailable handling', () => {
    const verdict: JudgeVerdict = {
      score: 92, passed: true, risk: 'low', reviewers: [], createdAt: new Date().toISOString(),
    };
    renderJudge(verdict);
    expect(screen.getByText('Passed')).toBeInTheDocument();
  });
});
