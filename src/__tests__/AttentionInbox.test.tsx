/**
 * AttentionInbox.test.tsx
 *
 * Covers T2.1's inline actions + T3.2's closed decision loop:
 *   - renders all 4 kinds (approval/question/blocked/budget) from fixtures
 *   - approve routes through the real gate (a blocked mission stays visible
 *     with an inline reason + force-approve affordance, never silently drops)
 *   - the answer flow creates a decision, intervenes the mission, and emits
 *     mission.answered
 *   - a question matching an existing decision auto-answers instead of ever
 *     reaching the inbox (the loop this task closes — see decisions.ts's
 *     createDecision, previously zero callers)
 *   - raising the budget cap unblocks (updateMission + resumeMission)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import type { Mission } from '../lib/agents/types';
import type { AttentionItem } from '../lib/journal/projections';
import type { JournalEventRow } from '../lib/journal/eventTypes';
import { ApproveBlockedError } from '../components/agents/approveGate';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en', setLocale: vi.fn(), LOCALES: [] }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({ t: (key: string) => key, locale: 'en', setLocale: vi.fn(), LOCALES: [] }),
}));

const toastSpy = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../lib/platform', () => ({
  isTauri: () => true,
}));

let missionsFixture: Mission[] = [];
const setSelectedMissionIdSpy = vi.fn();
const interveneMissionSpy = vi.fn();
const approveMissionSpy = vi.fn();
const retryMissionSpy = vi.fn();
const takeoverMissionSpy = vi.fn();
const resumeMissionSpy = vi.fn();
const updateMissionSpy = vi.fn();
const resolveProjectRootSpy = vi.fn();

vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStore: () => ({
    missions: missionsFixture,
    setSelectedMissionId: setSelectedMissionIdSpy,
    interveneMission: interveneMissionSpy,
    approveMission: approveMissionSpy,
    retryMission: retryMissionSpy,
    takeoverMission: takeoverMissionSpy,
    resumeMission: resumeMissionSpy,
    updateMission: updateMissionSpy,
  }),
  useAgentsStoreActions: () => ({
    setSelectedMissionId: setSelectedMissionIdSpy,
    interveneMission: interveneMissionSpy,
    approveMission: approveMissionSpy,
    retryMission: retryMissionSpy,
    takeoverMission: takeoverMissionSpy,
    resumeMission: resumeMissionSpy,
    updateMission: updateMissionSpy,
  }),
  useAgentsStoreMissionsOptional: () => missionsFixture,
  resolveProjectRoot: () => resolveProjectRootSpy(),
}));

const queryAttentionInboxSpy = vi.fn();
vi.mock('../lib/journal/projections', () => ({
  queryAttentionInbox: () => queryAttentionInboxSpy(),
}));

const emitEventSpy = vi.fn().mockResolvedValue(undefined);
const journalQuerySpy = vi.fn().mockResolvedValue([]);
vi.mock('../lib/journal/journal', () => ({
  emitEvent: (e: unknown) => emitEventSpy(e),
  journalQuery: (f: unknown) => journalQuerySpy(f),
}));

const lookupDecisionSpy = vi.fn();
const createDecisionSpy = vi.fn();
vi.mock('../lib/brain/decisions', () => ({
  lookupDecision: (q: string) => lookupDecisionSpy(q),
  createDecision: (i: unknown) => createDecisionSpy(i),
}));

import { AttentionInbox } from '../components/agents/AttentionInbox';

// ── Fixtures ─────────────────────────────────────────────────────────

const QUESTION_TEXT = 'Should I use OAuth or sessions?';

function runningMissionWithQuestion(id: string): Mission {
  return {
    id,
    title: `Mission ${id}`,
    status: 'running',
    model: 'sonnet',
    actionTimeline: [
      { time: '10:00', text: 'Read auth.ts' },
      { time: '10:05', text: `Observation: Question for user: ${QUESTION_TEXT}` },
    ],
  } as unknown as Mission;
}

function pausedBudgetMission(id: string, capUsd: number): Mission {
  return {
    id,
    title: `Mission ${id}`,
    status: 'running',
    model: 'sonnet',
    paused: true,
    contract: { budgetCapUsd: capUsd } as Mission['contract'],
  } as unknown as Mission;
}

function budgetWarningRow(missionId: string, pct: number, capUsd: number): JournalEventRow {
  return {
    seq: 1,
    ts_ms: 1_000,
    project_id: 'proj1',
    mission_id: missionId,
    agent_id: null,
    run_id: null,
    actor: 'system',
    type: 'budget.warning',
    payload: JSON.stringify({ pct, capUsd }),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

// ── W-GUARD (duration cap) fixtures — mirror the budget ones above exactly ──

function pausedDurationMission(id: string, capMs: number): Mission {
  return {
    id,
    title: `Mission ${id}`,
    status: 'running',
    model: 'sonnet',
    paused: true,
    contract: { maxDurationMs: capMs } as Mission['contract'],
  } as unknown as Mission;
}

function durationWarningRow(missionId: string, pct: number, capMs: number): JournalEventRow {
  return {
    seq: 1,
    ts_ms: 1_000,
    project_id: 'proj1',
    mission_id: missionId,
    agent_id: null,
    run_id: null,
    actor: 'system',
    type: 'duration.warning',
    payload: JSON.stringify({ pct, capMs }),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
}

function reviewItem(id: string): AttentionItem {
  return { mission_id: id, project_id: 'proj1', status: 'review', reason: 'Ready for review', updated_ms: 500 };
}

function blockedItem(id: string): AttentionItem {
  return { mission_id: id, project_id: 'proj1', status: 'blocked', reason: 'Depth cap exceeded', updated_ms: 400 };
}

beforeEach(() => {
  missionsFixture = [];
  vi.clearAllMocks();
  resolveProjectRootSpy.mockResolvedValue('C:\\proj1');
  queryAttentionInboxSpy.mockResolvedValue([]);
  journalQuerySpy.mockResolvedValue([]);
  lookupDecisionSpy.mockResolvedValue({ found: false });
  createDecisionSpy.mockResolvedValue('decision-1');
  emitEventSpy.mockResolvedValue(undefined);
});

describe('AttentionInbox — renders all 4 kinds', () => {
  it('shows approval, blocked, question and budget items from their respective sources', async () => {
    queryAttentionInboxSpy.mockResolvedValue([reviewItem('M3'), blockedItem('M4')]);
    journalQuerySpy.mockImplementation(async (filter: { missionId?: string }) =>
      filter.missionId === 'M2' ? [budgetWarningRow('M2', 92, 10)] : [],
    );
    missionsFixture = [runningMissionWithQuestion('M1'), pausedBudgetMission('M2', 10)];

    render(<AttentionInbox />);

    expect(await screen.findByTestId('inbox-kind-M1')).toHaveTextContent('agents.inbox.kindQuestion');
    expect(await screen.findByTestId('inbox-kind-M2')).toHaveTextContent('agents.inbox.kindBudget');
    expect(await screen.findByTestId('inbox-kind-M3')).toHaveTextContent('agents.inbox.kindApproval');
    expect(await screen.findByTestId('inbox-kind-M4')).toHaveTextContent('agents.inbox.kindBlocked');
  });
});

describe('AttentionInbox — approve routes through the real gate', () => {
  it('a blocked approve shows the reason inline and offers force-approve, mission stays visible', async () => {
    queryAttentionInboxSpy.mockResolvedValue([reviewItem('M3')]);
    approveMissionSpy.mockRejectedValueOnce(new ApproveBlockedError('Judge verdict required before merge.'));

    render(<AttentionInbox />);

    fireEvent.click(await screen.findByTestId('inbox-approve-M3'));

    await waitFor(() => expect(approveMissionSpy).toHaveBeenCalledWith('M3', 'C:\\proj1', undefined));
    expect(await screen.findByTestId('inbox-blocked-reason-M3')).toHaveTextContent('Judge verdict required before merge.');
    expect(await screen.findByTestId('inbox-force-approve-M3')).toBeInTheDocument();
    // The item never disappears on a blocked approve.
    expect(screen.getByTestId('inbox-item-M3')).toBeInTheDocument();
  });

  it('force-approve calls approveMission with { force: true }', async () => {
    queryAttentionInboxSpy.mockResolvedValue([reviewItem('M3')]);
    approveMissionSpy.mockRejectedValueOnce(new ApproveBlockedError('blocked'));
    approveMissionSpy.mockResolvedValueOnce(undefined);

    render(<AttentionInbox />);
    fireEvent.click(await screen.findByTestId('inbox-approve-M3'));
    fireEvent.click(await screen.findByTestId('inbox-force-approve-M3'));

    await waitFor(() =>
      expect(approveMissionSpy).toHaveBeenLastCalledWith('M3', 'C:\\proj1', { force: true }),
    );
  });
});

describe('AttentionInbox — answer flow closes the decision loop', () => {
  it('submitting an answer intervenes the mission, creates a decision, and emits mission.answered', async () => {
    missionsFixture = [runningMissionWithQuestion('M1')];

    render(<AttentionInbox />);

    const input = await screen.findByTestId('inbox-answer-input-M1');
    fireEvent.change(input, { target: { value: 'Use OAuth with PKCE' } });
    fireEvent.click(screen.getByTestId('inbox-answer-submit-M1'));

    await waitFor(() => expect(interveneMissionSpy).toHaveBeenCalledWith('M1', 'Use OAuth with PKCE'));
    expect(createDecisionSpy).toHaveBeenCalledWith({
      question: QUESTION_TEXT,
      answer: 'Use OAuth with PKCE',
      scope: 'project',
    });

    await waitFor(() => {
      const answeredCalls = emitEventSpy.mock.calls
        .map((c) => c[0] as { type: string; payload: unknown; missionId: string; actor: string })
        .filter((e) => e.type === 'mission.answered');
      expect(answeredCalls).toHaveLength(1);
      expect(answeredCalls[0].missionId).toBe('M1');
      expect(answeredCalls[0].actor).toBe('user');
      expect(answeredCalls[0].payload).toEqual({ answer: 'Use OAuth with PKCE', decisionId: 'decision-1' });
    });

    // The resolved question no longer shows an answer box.
    await waitFor(() => expect(screen.queryByTestId('inbox-answer-input-M1')).not.toBeInTheDocument());
  });

  it('a question matching an existing decision auto-answers and never reaches the inbox', async () => {
    lookupDecisionSpy.mockResolvedValue({ found: true, answer: 'Use OAuth with PKCE', decisionId: 'decision-1' });
    missionsFixture = [runningMissionWithQuestion('M5')];

    render(<AttentionInbox />);

    await waitFor(() => expect(lookupDecisionSpy).toHaveBeenCalledWith(QUESTION_TEXT));
    await waitFor(() => expect(interveneMissionSpy).toHaveBeenCalledWith('M5', 'Use OAuth with PKCE'));

    const answeredCalls = () =>
      emitEventSpy.mock.calls
        .map((c) => c[0] as { type: string; actor: string; missionId: string })
        .filter((e) => e.type === 'mission.answered');
    await waitFor(() => expect(answeredCalls()).toHaveLength(1));
    expect(answeredCalls()[0].actor).toBe('system');

    // Never surfaced as a pending question — no answer box, no inbox item.
    expect(screen.queryByTestId('inbox-answer-input-M5')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-item-M5')).not.toBeInTheDocument();
  });
});

// W-COST (quick-reply wave) — ask_user's own tool schema (toolRegistry.ts)
// already asks the model for "2-4 options when possible", but toolRuntime.ts
// used to silently drop `args.options` — never encoding them into the
// observation text, so they never reached the inbox. Fixed via a
// `missionQuestion.ts`-parseable `\n<<<OPTIONS>>>[...]` suffix (see that
// module's OPTIONS_MARKER doc comment); these fixtures embed that exact
// encoding directly (same convention runningMissionWithQuestion above uses
// for the plain marker) rather than going through the real toolRuntime.ts
// handler, which is out of this component's test scope.
function runningMissionWithOptions(id: string, question: string, options: string[]): Mission {
  return {
    id,
    title: `Mission ${id}`,
    status: 'running',
    model: 'sonnet',
    actionTimeline: [
      { time: '10:00', text: 'Read auth.ts' },
      { time: '10:05', text: `Observation: Question for user: ${question}\n<<<OPTIONS>>>${JSON.stringify(options)}` },
    ],
  } as unknown as Mission;
}

describe('AttentionInbox — quick-reply options (W-COST)', () => {
  it('renders structured ask_user options as numbered buttons, alongside the always-present free-text fallback', async () => {
    missionsFixture = [runningMissionWithOptions('M6', 'OAuth or sessions?', ['OAuth', 'Sessions', 'Both'])];

    render(<AttentionInbox />);

    expect(await screen.findByTestId('inbox-option-M6-0')).toHaveTextContent('OAuth');
    expect(screen.getByTestId('inbox-option-M6-1')).toHaveTextContent('Sessions');
    expect(screen.getByTestId('inbox-option-M6-2')).toHaveTextContent('Both');
    // The free-text fallback is never replaced by the numbered options.
    expect(screen.getByTestId('inbox-answer-input-M6')).toBeInTheDocument();
  });

  it('clicking a numbered option answers directly — no mission-detail navigation, no modal', async () => {
    missionsFixture = [runningMissionWithOptions('M7', 'OAuth or sessions?', ['OAuth', 'Sessions'])];

    render(<AttentionInbox />);

    fireEvent.click(await screen.findByTestId('inbox-option-M7-0'));

    await waitFor(() => expect(interveneMissionSpy).toHaveBeenCalledWith('M7', 'OAuth'));
    expect(createDecisionSpy).toHaveBeenCalledWith({
      question: 'OAuth or sessions?',
      answer: 'OAuth',
      scope: 'project',
    });
    // Answering never opens the mission detail (setSelectedMissionId is the
    // header row's own click handler, not wired to the option buttons).
    expect(setSelectedMissionIdSpy).not.toHaveBeenCalled();
  });

  it('pressing a number key while the item is focused answers with that option', async () => {
    missionsFixture = [runningMissionWithOptions('M9', 'OAuth or sessions?', ['OAuth', 'Sessions', 'Both'])];

    render(<AttentionInbox />);
    const item = await screen.findByTestId('inbox-item-M9');
    fireEvent.keyDown(item, { key: '2' });

    await waitFor(() => expect(interveneMissionSpy).toHaveBeenCalledWith('M9', 'Sessions'));
  });

  it('a question with no options renders only the free-text fallback — no numbered buttons', async () => {
    missionsFixture = [runningMissionWithQuestion('M8')];

    render(<AttentionInbox />);

    await screen.findByTestId('inbox-answer-input-M8');
    expect(screen.queryByTestId('inbox-option-M8-0')).not.toBeInTheDocument();
  });
});

describe('AttentionInbox — raise-cap unblocks a budget-paused mission', () => {
  it('applying a raised cap updates the contract and resumes the mission', async () => {
    missionsFixture = [pausedBudgetMission('M2', 10)];
    journalQuerySpy.mockResolvedValue([budgetWarningRow('M2', 92, 10)]);

    render(<AttentionInbox />);

    const input = (await screen.findByTestId('inbox-raise-cap-input-M2')) as HTMLInputElement;
    // Prefilled at +50% per the task's "+50% or input" requirement.
    expect(input.value).toBe('15.00');

    fireEvent.click(screen.getByTestId('inbox-raise-cap-submit-M2'));

    await waitFor(() =>
      expect(updateMissionSpy).toHaveBeenCalledWith({
        id: 'M2',
        patch: { contract: { budgetCapUsd: 15 } },
      }),
    );
    expect(resumeMissionSpy).toHaveBeenCalledWith('M2');
  });
});

// ── W-GUARD — duration-paused mission card (mirrors the budget card above) ──

describe('AttentionInbox — duration-paused mission (W-GUARD)', () => {
  it('renders a duration card with elapsed vs cap derived from duration.warning', async () => {
    missionsFixture = [pausedDurationMission('M10', 600_000)]; // 10 min cap
    journalQuerySpy.mockImplementation(async (filter: { missionId?: string }) =>
      filter.missionId === 'M10' ? [durationWarningRow('M10', 90, 600_000)] : [],
    );

    render(<AttentionInbox />);

    expect(await screen.findByTestId('inbox-kind-M10')).toHaveTextContent('agents.inbox.kindDuration');
    expect(screen.getByTestId('inbox-item-M10')).toHaveTextContent('9min / 10min (90%)');
  });

  it('« +30 min » extends contract.maxDurationMs by 30 min and resumes the mission', async () => {
    missionsFixture = [pausedDurationMission('M11', 600_000)];
    journalQuerySpy.mockImplementation(async (filter: { missionId?: string }) =>
      filter.missionId === 'M11' ? [durationWarningRow('M11', 92, 600_000)] : [],
    );

    render(<AttentionInbox />);

    fireEvent.click(await screen.findByTestId('inbox-extend-duration-M11'));

    await waitFor(() =>
      expect(updateMissionSpy).toHaveBeenCalledWith({
        id: 'M11',
        patch: { contract: { maxDurationMs: 600_000 + 30 * 60_000 } },
      }),
    );
    expect(resumeMissionSpy).toHaveBeenCalledWith('M11');
  });

  it('a budget-paused and a duration-paused mission can each surface their own card', async () => {
    queryAttentionInboxSpy.mockResolvedValue([]);
    journalQuerySpy.mockImplementation(async (filter: { missionId?: string }) => {
      if (filter.missionId === 'M2') return [budgetWarningRow('M2', 92, 10)];
      if (filter.missionId === 'M12') return [durationWarningRow('M12', 95, 900_000)];
      return [];
    });
    missionsFixture = [pausedBudgetMission('M2', 10), pausedDurationMission('M12', 900_000)];

    render(<AttentionInbox />);

    expect(await screen.findByTestId('inbox-kind-M2')).toHaveTextContent('agents.inbox.kindBudget');
    expect(await screen.findByTestId('inbox-kind-M12')).toHaveTextContent('agents.inbox.kindDuration');
  });
});
