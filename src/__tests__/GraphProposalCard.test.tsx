/**
 * GraphProposalCard — tests for proposal state rendering, overlay expand/shrink
 * bus events, step checkboxes, and accept/reject button interactions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { GraphProposalCard, resolveStepModelId } from '../components/lazyManager/GraphProposalCard';
import type { ManagerMessage, OrchestratorPlanStepInput } from '../lib/agents/types';
import { repairPlanSteps } from '../lib/agents/graph/planStepRepair';
import * as bus from '../lib/bus';
import { getProviderMode } from '../lib/models/index';
import { DEFAULT_MODEL } from '../lib/models/registry';

// Item 7 fix — same "mock only getProviderMode, keep everything else in
// models/index real" convention as managerCreditsHonesty.test.tsx/
// managerEngine.test.ts: the estimate row now branches on the real engine
// (credits-metered vs a CLI subscription that never charges credits).
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(),
  };
});

// GraphProposalCard calls detectModelEntitlements() then buildModelPickerOptions().
// Unsigned jsdom is free-only (honest 2026-08-28); Feature E still asserts
// native-rail grouping when a Claude subscription is present.
vi.mock('../lib/models/modelPickerOptions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/modelPickerOptions')>();
  return {
    ...actual,
    detectModelEntitlements: () => ({
      claudeSub: true,
      pro: 'inactive' as const,
      codexManaged: false,
      byok: null,
    }),
  };
});

const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;

// OUT-OF-SCOPE-AT-PROPOSAL-TIME FIX — same "mock just this one export"
// convention agentsStore.nightlyDogfoodFixes.test.tsx already establishes
// for this exact hook: the card reads `openProjects` via the SAFE optional
// variant (see useAppContextOptional's own doc comment, AppContext.tsx), so
// every pre-existing test in this suite (none of which ever touches
// `proposal.targetProjectRoot`) keeps rendering exactly as before with the
// default `null` return below — only the new describe block further down
// overrides it.
const { mockUseAppContextOptional } = vi.hoisted(() => ({
  mockUseAppContextOptional: vi.fn(),
}));
vi.mock('../app/AppContext', () => ({
  useAppContextOptional: mockUseAppContextOptional,
}));

function makeProposalMessage(
  state: 'pending' | 'launching' | 'accepted' | 'rejected' = 'pending',
  planId = 'orch-test-1',
): ManagerMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Here is a plan.',
    timestamp: new Date().toISOString(),
    proposal: {
      state,
      planId,
      objective: 'Add Stripe checkout to the API',
      steps: [
        { description: 'Create checkout session endpoint', agentName: 'api-agent' },
        { description: 'Add webhook handler', agentName: 'webhook-agent' },
        { description: 'Test end-to-end flow' },
      ],
      estimatedCostUsd: 2.5,
      estimatedDurationMs: 600000,
    },
  };
}

function renderCard(
  msg: ManagerMessage,
  onAccept = vi.fn(),
  onReject = vi.fn(),
  isActionQueued = false,
) {
  return render(
    <I18nProvider>
      <GraphProposalCard msg={msg} onAccept={onAccept} onReject={onReject} isActionQueued={isActionQueued} />
    </I18nProvider>,
  );
}

describe('GraphProposalCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Credits-metered by default (Lazy Pro/managed) — matches this suite's
    // pre-existing fixtures, which never set proposal.estimatedCreditsByModel
    // and expect a plain estimate. Individual tests override this for the
    // subscription ("no credits") branch.
    mockedGetProviderMode.mockReturnValue('pro');
    // No AppProvider ancestor by default (matches every pre-existing test
    // in this suite) — the out-of-scope describe block below overrides this
    // per test with a real openProjects fixture.
    mockUseAppContextOptional.mockReturnValue(null);
  });

  it('renders the proposal card with objective and steps', () => {
    const msg = makeProposalMessage();
    renderCard(msg);
    expect(screen.getByTestId('graph-proposal-card')).toBeInTheDocument();
    expect(screen.getByText('Add Stripe checkout to the API')).toBeInTheDocument();
    // Step descriptions appear in both the mini-graph SVG and the step list
    expect(screen.getAllByText(/Create checkout session endpoint/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Add webhook handler/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Test end-to-end flow/).length).toBeGreaterThan(0);
  });

  // CONSENT-BYPASS FIX (agentsStore.tsx's sendManagerMessage/executePlan):
  // the card used to never mention `proposal.deferredActions` at all — the
  // user had no way to see, before clicking "Valider & lancer", that doing
  // so would also run other actions from the same turn (one of which may
  // itself still require a separate approval). Labeled with the EXACT SAME
  // describePendingAction() strings the pending-approval card/chip row
  // already use.
  it('lists deferred actions that will run when the plan is validated', () => {
    const msg = makeProposalMessage();
    msg.proposal!.deferredActions = [
      { type: 'create_project', path: '/root/new-project' },
    ];
    renderCard(msg);
    expect(screen.getByTestId('graph-proposal-deferred-actions')).toBeInTheDocument();
    expect(screen.getByTestId('graph-proposal-deferred-action-0')).toHaveTextContent('Create project: /root/new-project');
  });

  it('renders no deferred-actions block when the proposal has none', () => {
    const msg = makeProposalMessage();
    renderCard(msg);
    expect(screen.queryByTestId('graph-proposal-deferred-actions')).not.toBeInTheDocument();
  });

  // Fix E (2026-08-19 incident) — warn BEFORE launch when a step's own
  // estimate already exceeds the cap that will be applied to it. Real
  // incident: a 6-step plan where every step carried the manager prompt's
  // own example value (budgetCapUsd: 5.0) regardless of the step's actual
  // model/effort — five of the six steps then ran 100%-274% over that cap
  // with nothing having said so at proposal time.
  describe('per-step budget-cap warning (Fix E)', () => {
    it('warns on a step whose estimated cost exceeds its own budgetCapUsd', () => {
      const msg = makeProposalMessage();
      msg.proposal!.steps = [
        {
          id: 'step-1',
          description: 'Design the internal API',
          model: 'opus',
          budgetCapUsd: 5,
          estimatedCostUsd: 8.17,
        },
      ];
      renderCard(msg);
      const warning = screen.getByTestId('graph-proposal-step-budget-warning-step-1');
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveTextContent('8.17');
      expect(warning).toHaveTextContent('5.00');
    });

    it('does NOT warn when the estimate is within the step\'s own cap', () => {
      const msg = makeProposalMessage();
      msg.proposal!.steps = [
        {
          id: 'step-1',
          description: 'Small doc fix',
          model: 'haiku',
          budgetCapUsd: 5,
          estimatedCostUsd: 0.6,
        },
      ];
      renderCard(msg);
      expect(screen.queryByTestId('graph-proposal-step-budget-warning-step-1')).not.toBeInTheDocument();
    });

    it('does NOT warn when the step never declared a budgetCapUsd (nothing to compare against)', () => {
      const msg = makeProposalMessage();
      msg.proposal!.steps = [
        { id: 'step-1', description: 'Undeclared cap', model: 'opus', estimatedCostUsd: 8.17 },
      ];
      renderCard(msg);
      expect(screen.queryByTestId('graph-proposal-step-budget-warning-step-1')).not.toBeInTheDocument();
    });

    it('warns independently per step — only the offending step shows the warning', () => {
      const msg = makeProposalMessage();
      msg.proposal!.steps = [
        { id: 'step-ok', description: 'Fits its cap', model: 'haiku', budgetCapUsd: 5, estimatedCostUsd: 0.6 },
        { id: 'step-over', description: 'Blows its cap', model: 'opus', budgetCapUsd: 5, estimatedCostUsd: 8.17 },
      ];
      renderCard(msg);
      expect(screen.queryByTestId('graph-proposal-step-budget-warning-step-ok')).not.toBeInTheDocument();
      expect(screen.getByTestId('graph-proposal-step-budget-warning-step-over')).toBeInTheDocument();
    });
  });

  // OUT-OF-SCOPE-AT-PROPOSAL-TIME FIX (2026-08-19 incident: a 7-step plan
  // whose every writing step's task text named an absolute path inside
  // ANOTHER open project — engine/, ~971 files — while the plan itself
  // targeted a DIFFERENT project, and no step declared
  // `extraReadableProjectIds` for it; missionScopeGuard.ts's
  // findOutOfScopeTaskPath only ever caught this at LAUNCH time, one
  // mission at a time — six missions were created and blocked instantly
  // before anything was said). Moves that same guard's verdict to proposal
  // time, reused verbatim (see computeOutOfScopeStepWarnings,
  // graphProposalGraph.ts) rather than a second heuristic.
  describe('per-step out-of-scope-path warning', () => {
    const TARGET_ROOT = 'C:\\Users\\user\\Documents\\cerveau\\Lazy-Docs';
    const OTHER_OPEN_ROOT = 'C:\\Users\\user\\Documents\\cerveau\\Lazy';

    function withOpenProjects() {
      mockUseAppContextOptional.mockReturnValue({
        openProjects: [
          { id: 'p-target', root: TARGET_ROOT, brainId: null, active: true },
          { id: 'p-other', root: OTHER_OPEN_ROOT, brainId: null, active: false },
        ],
        activeProjectId: 'p-target',
      });
    }

    it('warns on a step whose task text names a path in another OPEN project and declares nothing, naming both the path and the owning project', () => {
      withOpenProjects();
      const msg = makeProposalMessage();
      msg.proposal!.targetProjectRoot = TARGET_ROOT;
      msg.proposal!.steps = [
        {
          id: 'step-1',
          description: 'Lis directement sur disque les sources reelles de C:\\Users\\user\\Documents\\cerveau\\Lazy\\engine\\ et documente-les.',
        },
      ];
      renderCard(msg);
      const warning = screen.getByTestId('graph-proposal-step-scope-warning-step-1');
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveTextContent('C:\\Users\\user\\Documents\\cerveau\\Lazy\\engine');
      // Names the OWNING project, not just any substring of the path —
      // exact phrase from lazyManager.proposal.stepScopeWarningKnownProject.
      expect(warning).toHaveTextContent('project "Lazy"');
    });

    // THE REGRESSION THAT MATTERS — a step covering the exact same mention
    // via a DECLARED extraReadableProjectIds must render no warning at all;
    // this is the exact fix the mission scope guard already shipped
    // (missionScopeGuard.ts's "EXTRA-READABLE-ROOTS FIX") and this proposal
    // -time check must never contradict it.
    it('does NOT warn when the same mention is covered by a declared extraReadableProjectIds', () => {
      withOpenProjects();
      const msg = makeProposalMessage();
      msg.proposal!.targetProjectRoot = TARGET_ROOT;
      msg.proposal!.steps = [
        {
          id: 'step-1',
          description: 'Lis directement sur disque les sources reelles de C:\\Users\\user\\Documents\\cerveau\\Lazy\\engine\\ et documente-les.',
          extraReadableProjectIds: ['Lazy'],
        },
      ];
      renderCard(msg);
      expect(screen.queryByTestId('graph-proposal-step-scope-warning-step-1')).not.toBeInTheDocument();
    });

    it('does NOT warn when the step only names paths inside the plan\'s own target project', () => {
      withOpenProjects();
      const msg = makeProposalMessage();
      msg.proposal!.targetProjectRoot = TARGET_ROOT;
      msg.proposal!.steps = [
        {
          id: 'step-1',
          description: `Update the docs at ${TARGET_ROOT}\\README.md to reflect the new API.`,
        },
      ];
      renderCard(msg);
      expect(screen.queryByTestId('graph-proposal-step-scope-warning-step-1')).not.toBeInTheDocument();
    });

    it('warns, worded for the case, when the mentioned path belongs to no currently open project', () => {
      withOpenProjects();
      const msg = makeProposalMessage();
      msg.proposal!.targetProjectRoot = TARGET_ROOT;
      msg.proposal!.steps = [
        {
          id: 'step-1',
          description: 'Compare with the approach at C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON\\src\\index.ts',
        },
      ];
      renderCard(msg);
      const warning = screen.getByTestId('graph-proposal-step-scope-warning-step-1');
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveTextContent('C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON\\src\\index.ts');
      // Worded for "belongs to no open project" (exact phrase from
      // lazyManager.proposal.stepScopeWarningUnknownProject) — never claims
      // an owning project it does not actually know, unlike the known-
      // project wording asserted in the first test above.
      expect(warning).toHaveTextContent('outside every currently open project');
      expect(warning).not.toHaveTextContent('project "');
    });

    // Validate-disable decision (see GraphProposalCard.tsx's own comment at
    // both the warning's render site and `canValidate`'s definition): this
    // warning is informational only, same as the pre-existing dependency
    // warning right above it in this same card — it must NEVER disable
    // "Valider & lancer". The affected step's own launch failure is loud
    // and recoverable (missionScopeGuard.ts's own header), and partial
    // approval already lets the user route around just the offending step.
    it('does NOT disable "Valider & lancer" despite an out-of-scope warning being shown', () => {
      withOpenProjects();
      const msg = makeProposalMessage();
      msg.proposal!.targetProjectRoot = TARGET_ROOT;
      msg.proposal!.steps = [
        {
          id: 'step-1',
          description: 'Lis directement sur disque les sources reelles de C:\\Users\\user\\Documents\\cerveau\\Lazy\\engine\\ et documente-les.',
        },
      ];
      renderCard(msg);
      expect(screen.getByTestId('graph-proposal-step-scope-warning-step-1')).toBeInTheDocument();
      expect(screen.getByTestId('graph-proposal-validate')).not.toBeDisabled();
    });

    it('renders no warning at all when proposal.targetProjectRoot is not yet known (brief pre-patch window)', () => {
      withOpenProjects();
      const msg = makeProposalMessage();
      // targetProjectRoot deliberately left unset.
      msg.proposal!.steps = [
        {
          id: 'step-1',
          description: 'Lis directement sur disque les sources reelles de C:\\Users\\user\\Documents\\cerveau\\Lazy\\engine\\ et documente-les.',
        },
      ];
      renderCard(msg);
      expect(screen.queryByTestId('graph-proposal-step-scope-warning-step-1')).not.toBeInTheDocument();
    });
  });

  it('shows pending state label when proposal is pending', () => {
    const msg = makeProposalMessage('pending');
    renderCard(msg);
    expect(screen.getByTestId('graph-proposal-state')).toHaveTextContent('Pending validation');
  });

  it('shows accepted state label when proposal is accepted', () => {
    const msg = makeProposalMessage('accepted');
    renderCard(msg);
    expect(screen.getByTestId('graph-proposal-state')).toHaveTextContent('Accepted');
  });

  it('shows rejected state label when proposal is rejected', () => {
    const msg = makeProposalMessage('rejected');
    renderCard(msg);
    expect(screen.getByTestId('graph-proposal-state')).toHaveTextContent('Rejected');
  });

  // B2 fix — "launching" is a real, distinct in-flight state: the card must
  // never read a bare "accepted" before agentsStore.tsx's executePlan has
  // confirmed materialization + execution actually produced a real effect.
  it('shows a "launching" state label — never "accepted" — while the plan is in flight', () => {
    const msg = makeProposalMessage('launching');
    renderCard(msg);
    expect(screen.getByTestId('graph-proposal-state')).toHaveTextContent('Launching');
    expect(screen.getByTestId('graph-proposal-state')).not.toHaveTextContent('Accepted');
  });

  it('does not render action buttons while launching (same as accepted/rejected)', () => {
    const msg = makeProposalMessage('launching');
    renderCard(msg);
    expect(screen.queryByTestId('graph-proposal-validate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graph-proposal-reject')).not.toBeInTheDocument();
  });

  // B3 fix — a real, persistent error banner (never just a toast the user
  // can miss) when a launch attempt reverted the proposal back to pending.
  it('renders a persistent error banner when proposal.errorMessage is set', () => {
    const msg = makeProposalMessage('pending');
    msg.proposal!.errorMessage = 'Some steps could not be materialized on the canvas (content) — launch cancelled.';
    renderCard(msg);
    expect(screen.getByTestId('graph-proposal-error')).toHaveTextContent(/could not be materialized/);
  });

  it('renders no error banner when proposal.errorMessage is absent', () => {
    const msg = makeProposalMessage('pending');
    renderCard(msg);
    expect(screen.queryByTestId('graph-proposal-error')).not.toBeInTheDocument();
  });

  it('emits manager:expandOverlay on mount when pending', () => {
    const emitSpy = vi.spyOn(bus, 'emit');
    const msg = makeProposalMessage('pending');
    renderCard(msg);
    expect(emitSpy).toHaveBeenCalledWith('manager:expandOverlay', undefined);
  });

  it('emits manager:shrinkOverlay when proposal is resolved (accepted)', () => {
    const emitSpy = vi.spyOn(bus, 'emit');
    // A REAL resolution transitions an ALREADY-MOUNTED card from 'pending'
    // to 'accepted' (a proposal is always CREATED pending — see
    // GraphProposalCard.tsx's own `hasEmittedOnceRef` doc comment) —
    // `rerender`, not a fresh `renderCard`, so this exercises the actual
    // update path a real launch goes through, not the (deliberately
    // different, see the next test) fresh-mount-already-resolved case.
    const msg = makeProposalMessage('pending');
    const { rerender } = renderCard(msg);
    emitSpy.mockClear();
    rerender(
      <I18nProvider>
        <GraphProposalCard msg={makeProposalMessage('accepted')} onAccept={vi.fn()} onReject={vi.fn()} />
      </I18nProvider>,
    );
    expect(emitSpy).toHaveBeenCalledWith('manager:shrinkOverlay', undefined);
  });

  // 2026-08 fifth verification pass (ManagerOverlay.tsx's own header,
  // GraphProposalCard.tsx's `hasEmittedOnceRef` doc comment) — multi-
  // conversation switches the WHOLE `agents.managerMessages` array,
  // unmounting every card for the old conversation and mounting fresh ones
  // for the new one, including an OLDER, already-resolved proposal earlier
  // in that conversation's OWN history. That fresh mount must NOT re-emit
  // shrink — it is old news, not a live transition, and a stale shrink
  // landing after a genuinely NEW pending proposal's expand (elsewhere in
  // the same render pass) would silently leave the panel docked next to a
  // plan the user cannot read — the exact reported symptom.
  it('does NOT emit manager:shrinkOverlay when a card mounts FRESH already resolved (stale historical remount, not a live transition)', () => {
    const emitSpy = vi.spyOn(bus, 'emit');
    const msg = makeProposalMessage('accepted');
    renderCard(msg);
    expect(emitSpy).not.toHaveBeenCalledWith('manager:shrinkOverlay', undefined);
  });

  it('renders a graph preview with every plan step', async () => {
    const msg = makeProposalMessage();
    renderCard(msg);
    // The preview resolves the REAL elkjs layout asynchronously: a skeleton
    // placeholder is shown while elkjs runs (the "never degrade in silence"
    // loading state — exactly ONE visible transition instead of the old
    // fallback-then-real double paint). The graph itself is therefore
    // queried with findByTestId, which waits for the async layout to land
    // rather than asserting against the still-loading skeleton.
    expect(await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(await screen.findByTestId('graph-proposal-node-0')).toBeInTheDocument();
    expect(await screen.findByTestId('graph-proposal-node-1')).toBeInTheDocument();
    expect(await screen.findByTestId('graph-proposal-node-2')).toBeInTheDocument();
  });

  it('renders the canonical join node for a parallel cohort before validation', async () => {
    const msg = makeProposalMessage();
    msg.proposal!.steps = [
      { id: 'research', description: 'Research the current architecture', joinGroup: 'review' },
      { id: 'audit', description: 'Audit the risk surface', joinGroup: 'review' },
      { id: 'deliver', description: 'Deliver the implementation', dependsOn: ['research', 'audit'] },
    ];
    renderCard(msg);

    // Same async-layout wait as the plain graph test above (see its
    // comment): the join node and the join's step nodes only exist in the
    // DOM once elkjs has resolved the layout and the real SVG rendered.
    expect(await screen.findByTestId('graph-proposal-node-research')).toBeInTheDocument();
    expect(await screen.findByTestId('graph-proposal-node-audit')).toBeInTheDocument();
    expect(await screen.findByTestId('graph-proposal-node-deliver')).toBeInTheDocument();
    expect(await screen.findByTestId('graph-proposal-join-join:review')).toBeInTheDocument();
  });

  it('renders step checkboxes when pending', () => {
    const msg = makeProposalMessage('pending');
    renderCard(msg);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    // All selected by default
    checkboxes.forEach((cb) => expect(cb).toBeChecked());
  });

  it('toggles step checkbox off and on', () => {
    const msg = makeProposalMessage('pending');
    renderCard(msg);
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(checkboxes[0]).not.toBeChecked();
    fireEvent.click(checkboxes[0]);
    expect(checkboxes[0]).toBeChecked();
  });

  it('does not render checkboxes when proposal is not pending', () => {
    const msg = makeProposalMessage('accepted');
    renderCard(msg);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('renders validate and reject buttons when pending', () => {
    const msg = makeProposalMessage('pending');
    renderCard(msg);
    expect(screen.getByTestId('graph-proposal-validate')).toBeInTheDocument();
    expect(screen.getByTestId('graph-proposal-reject')).toBeInTheDocument();
    expect(screen.getByTestId('graph-proposal-modify')).toBeInTheDocument();
  });

  it('does not render action buttons when accepted', () => {
    const msg = makeProposalMessage('accepted');
    renderCard(msg);
    expect(screen.queryByTestId('graph-proposal-validate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graph-proposal-reject')).not.toBeInTheDocument();
  });

  it('calls onAccept with planId when validate is clicked', () => {
    const onAccept = vi.fn();
    const msg = makeProposalMessage('pending', 'orch-abc');
    renderCard(msg, onAccept);
    fireEvent.click(screen.getByTestId('graph-proposal-validate'));
    expect(onAccept).toHaveBeenCalledWith('orch-abc', undefined);
  });

  it('calls onReject when reject is clicked', () => {
    const onReject = vi.fn();
    const msg = makeProposalMessage('pending');
    renderCard(msg, vi.fn(), onReject);
    fireEvent.click(screen.getByTestId('graph-proposal-reject'));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it('emits manager:shrinkOverlay when modify is clicked', () => {
    const emitSpy = vi.spyOn(bus, 'emit');
    const msg = makeProposalMessage('pending');
    renderCard(msg);
    fireEvent.click(screen.getByTestId('graph-proposal-modify'));
    expect(emitSpy).toHaveBeenCalledWith('manager:shrinkOverlay', undefined);
  });

  // Item 7 fix — the estimate is credits, never a dollar figure, on a
  // credits-metered engine (Pro/managed).
  it('renders estimated credits and duration on a credits-metered engine', () => {
    const msg = makeProposalMessage();
    renderCard(msg);
    expect(screen.getByText(/Estimated cost/)).toBeInTheDocument();
    expect(screen.getByTestId('graph-proposal-estimated-credits')).toHaveTextContent(/~250 credits/);
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.getByText(/Estimated duration/)).toBeInTheDocument();
    expect(screen.getByText(/~10min/)).toBeInTheDocument();
  });

  // Item 7 fix — per-model credits breakdown when the plan carries one.
  it('renders a per-model credits breakdown when the proposal carries one', () => {
    const msg = makeProposalMessage();
    msg.proposal!.estimatedCreditsByModel = { 'sonnet 4.6': 150, 'haiku 4.5': 50 };
    renderCard(msg);
    const byModel = screen.getByTestId('graph-proposal-estimated-credits-by-model');
    expect(byModel).toHaveTextContent(/sonnet 4\.6.*~150 credits/);
    expect(byModel).toHaveTextContent(/haiku 4\.5.*~50 credits/);
    expect(screen.getByTestId('graph-proposal-estimated-credits')).toHaveTextContent(/~200 credits/);
  });

  // Item 7 fix — the owner's standing rule: a plan running via a CLI
  // subscription (Claude/Codex) must say explicitly it costs no credits,
  // never show a dollar figure or a credits number that was never charged.
  it('states explicitly that a subscription-routed plan costs no credits', () => {
    mockedGetProviderMode.mockReturnValue('claude-code');
    const msg = makeProposalMessage();
    renderCard(msg);
    const notice = screen.getByTestId('graph-proposal-no-credits');
    expect(notice).toHaveTextContent(/no credits/i);
    expect(screen.queryByTestId('graph-proposal-estimated-credits')).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('renders without crashing when proposal has no steps', () => {
    const msg: ManagerMessage = {
      id: 'msg-2',
      role: 'assistant',
      content: 'Empty plan',
      timestamp: new Date().toISOString(),
      proposal: {
        state: 'pending',
        planId: 'orch-empty',
        objective: 'Do nothing',
        steps: [],
      },
    };
    renderCard(msg);
    expect(screen.getByTestId('graph-proposal-card')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-proposal-minigraph')).not.toBeInTheDocument();
  });

  it('returns null when message has no proposal', () => {
    const msg: ManagerMessage = {
      id: 'msg-3',
      role: 'assistant',
      content: 'No proposal here',
      timestamp: new Date().toISOString(),
    };
    const { container } = renderCard(msg);
    expect(container.firstChild).toBeNull();
  });

  // NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — Accept/Modify/
  // Reject used to silently no-op when clicked while the manager was busy
  // (`if (!store.busy) void agents?.executePlan(...)` in LazyManager.tsx).
  // This card has no local optimistic resolution of its own (it reflects
  // the real `proposal.state`), so the fix here is simpler: never drop the
  // click (covered by useManagerActionQueue.test.ts), and make the wait
  // visible instead of the buttons just quietly doing nothing.
  // Founder's #1 complaint, end-to-end repro (layers 1+2 combined) —
  // reproduces the EXACT real-world case: orch-1785607094724-3g7hs61's
  // `installer` step depended on a step whose id the LLM reused (an
  // "audit"/"audit" collision, matching planStepRepair.ts's own header),
  // repairPlanSteps renamed the second occurrence and rewired the
  // dependent's `dependsOn`. Before this fix, GraphProposalCard's proposal
  // was built from the RAW pre-repair steps (see agentsStore.tsx's old
  // `id: s.id ?? ${idx}` fallback) while the persisted orchestrator used
  // the REPAIRED ids — the mismatch fed elkjs a dangling edge and the
  // whole 12-step preview degraded to the broken fallback. This test
  // builds `msg.proposal.steps` the way agentsStore.tsx now does — from
  // repairPlanSteps' REAL output, not a raw echo — and asserts the card
  // renders the fully connected REAL graph, never the degraded banner.
  describe('dangling-edge / plan-repair regression (founder repro)', () => {
    it('a step-id collision repaired by repairPlanSteps still renders a fully connected, laid-out graph (not the degraded fallback)', async () => {
      const rawSteps: OrchestratorPlanStepInput[] = [
        { id: 'audit', description: 'First audit pass' },
        { id: 'audit', description: 'Second audit pass (model id collision)' },
        { id: 'installer', description: 'Install the fix', dependsOn: ['audit'] },
      ];
      const { steps: repairedSteps } = repairPlanSteps(rawSteps, new Set());

      // Sanity: the repair actually renamed the second step and rewired
      // its dependent — otherwise this test would not exercise the real
      // bug at all.
      expect(repairedSteps[1]!.id).not.toBe('audit');
      expect(repairedSteps[2]!.dependsOn).toEqual([repairedSteps[1]!.id]);

      // Same field mapping agentsStore.tsx's `assistantMsg.proposal.steps`
      // construction uses, fed from the REPAIRED steps (the fix) instead
      // of a raw echo of `action.steps`.
      const msg: ManagerMessage = {
        id: 'msg-repair-repro',
        role: 'assistant',
        content: 'Here is a plan.',
        timestamp: new Date().toISOString(),
        proposal: {
          state: 'pending',
          planId: 'orch-repair-repro',
          objective: 'Fix the thing',
          steps: repairedSteps.map((s) => ({
            id: s.id,
            description: s.description,
            agentName: s.agentName,
            model: s.model,
            dependsOn: s.dependsOn,
          })),
        },
      };

      renderCard(msg);

      expect(await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 })).toBeInTheDocument();
      expect(screen.getByTestId(`graph-proposal-node-${repairedSteps[0]!.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`graph-proposal-node-${repairedSteps[1]!.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`graph-proposal-node-${repairedSteps[2]!.id}`)).toBeInTheDocument();
      // The real elkjs layout resolved — the honest-degraded fallback
      // banner (what the founder actually saw) must be absent.
      expect(screen.queryByTestId('graph-proposal-layout-degraded')).not.toBeInTheDocument();
    });

    it('backstop: a plan that STILL carries a dangling dependsOn (e.g. a future repair gap) never crashes the whole preview — the phantom edge alone is dropped, the real graph still resolves', async () => {
      // Deliberately the OLD, unrepaired shape — `installer` depends on
      // "audit" but nothing in this steps list defines that id (as if the
      // rename above had never happened). Before layer 1 (layout.ts's
      // dangling-edge guard), this exact shape is what made elkjs throw
      // and degraded the WHOLE 12-step preview to the broken fallback.
      const msg: ManagerMessage = {
        id: 'msg-unrepaired',
        role: 'assistant',
        content: 'Here is a plan.',
        timestamp: new Date().toISOString(),
        proposal: {
          state: 'pending',
          planId: 'orch-unrepaired',
          objective: 'Fix the thing',
          steps: [
            { id: 'step-abc123', description: 'Renamed audit step (no longer called "audit")' },
            { id: 'installer', description: 'Install the fix', dependsOn: ['audit'] }, // dangling: "audit" no longer exists
          ],
        },
      };

      renderCard(msg);

      // Never crashes, never a perpetual skeleton, and — since a
      // malformed edge now only ever costs itself — never even needs the
      // degraded fallback: both real nodes still resolve through the REAL
      // elkjs layout, just without the one phantom edge.
      expect(await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 5_000 })).toBeInTheDocument();
      expect(screen.getByTestId('graph-proposal-node-step-abc123')).toBeInTheDocument();
      expect(screen.getByTestId('graph-proposal-node-installer')).toBeInTheDocument();
      expect(screen.queryByTestId('graph-proposal-layout-degraded')).not.toBeInTheDocument();
    });
  });

  describe('queued action feedback (bug fix: silent drop while busy)', () => {
    it('disables Validate/Modify/Reject and shows a queued note while the action is queued', () => {
      const msg = makeProposalMessage('pending');
      renderCard(msg, vi.fn(), vi.fn(), true);
      expect(screen.getByTestId('graph-proposal-validate')).toBeDisabled();
      expect(screen.getByTestId('graph-proposal-modify')).toBeDisabled();
      expect(screen.getByTestId('graph-proposal-reject')).toBeDisabled();
      expect(screen.getByTestId('graph-proposal-queued')).toBeInTheDocument();
    });

    it('keeps the buttons enabled and shows no queued note when nothing is queued', () => {
      const msg = makeProposalMessage('pending');
      renderCard(msg, vi.fn(), vi.fn(), false);
      expect(screen.getByTestId('graph-proposal-validate')).not.toBeDisabled();
      expect(screen.queryByTestId('graph-proposal-queued')).not.toBeInTheDocument();
    });
  });

  // NO-PLANID PROPOSAL FIX (agentsStore.tsx's sendManagerMessage/executePlan
  // — see that fix's own "NO-PLANID PROPOSAL FIX" doc comments): a proposal
  // can reach this component `pending` with NO `planId` at all (generate_plan
  // denied, asked for approval, failed without throwing, or thrown). Before
  // this fix, the card rendered "Valider & lancer" fully enabled
  // (`disabled: false`) even though the click handler's own `if
  // (proposal.planId)` guard meant clicking it did literally nothing — no
  // toast, no error, no journal entry. The UI must never lie: a proposal
  // that cannot be validated must never render an enabled Validate control.
  describe('no planId — proposal cannot be validated (real user repro: enabled button, silent no-op click)', () => {
    it('disables Validate and shows why when the proposal has no planId', () => {
      const onAccept = vi.fn();
      const msg = makeProposalMessage('pending');
      msg.proposal!.planId = undefined;
      renderCard(msg, onAccept);

      expect(screen.getByTestId('graph-proposal-validate')).toBeDisabled();
      expect(screen.getByTestId('graph-proposal-no-planid')).toBeInTheDocument();

      // The button must not merely LOOK disabled — clicking it must never
      // reach onAccept, same guarantee the pre-existing `if (proposal.planId)`
      // click guard already gave, now backed by a real disabled attribute.
      fireEvent.click(screen.getByTestId('graph-proposal-validate'));
      expect(onAccept).not.toHaveBeenCalled();
    });

    it('shows the store-recorded errorMessage as the reason when one was set', () => {
      const msg = makeProposalMessage('pending');
      msg.proposal!.planId = undefined;
      msg.proposal!.errorMessage = 'Action generate_plan requires approval before execution.';
      renderCard(msg);

      expect(screen.getByTestId('graph-proposal-no-planid')).toHaveTextContent(
        'Action generate_plan requires approval before execution.',
      );
      // The generic top-of-card error banner (B3 fix, pre-existing) renders
      // the SAME reason too — this is the exact mechanism the "N action(s)…
      // still need your approval" message already uses, reused verbatim
      // rather than inventing a second, possibly-diverging story.
      expect(screen.getByTestId('graph-proposal-error')).toHaveTextContent(
        'Action generate_plan requires approval before execution.',
      );
    });

    it('falls back to a generic translated reason when no errorMessage was recorded', () => {
      const msg = makeProposalMessage('pending');
      msg.proposal!.planId = undefined;
      renderCard(msg);

      expect(screen.getByTestId('graph-proposal-no-planid')).toHaveTextContent(
        'Cannot validate — this plan was never created',
      );
      expect(screen.queryByTestId('graph-proposal-error')).not.toBeInTheDocument();
    });

    it('does not disable Validate, and does not render the no-planId reason, once a real planId is set', () => {
      const msg = makeProposalMessage('pending', 'orch-real-1');
      renderCard(msg);

      expect(screen.getByTestId('graph-proposal-validate')).not.toBeDisabled();
      expect(screen.queryByTestId('graph-proposal-no-planid')).not.toBeInTheDocument();
    });
  });

  // Feature E (founder, verbatim: "une chip avec le modèle... pour choisir
  // le LLM de chaque agent avant de lancer le graphe") — per-step model
  // chip. onStepModelChange is intentionally NOT passed by the shared
  // renderCard() helper above (every pre-existing test must keep rendering
  // the read-only step list exactly as before), so this block renders the
  // card directly with the handler wired.
  describe('per-step model chip (Feature E rail-grouping)', () => {
    function renderWithStepModelHandler(msg: ManagerMessage, onStepModelChange = vi.fn()) {
      render(
        <I18nProvider>
          <GraphProposalCard msg={msg} onAccept={vi.fn()} onReject={vi.fn()} onStepModelChange={onStepModelChange} />
        </I18nProvider>,
      );
      return onStepModelChange;
    }

    it('resolveStepModelId falls back to the picker default when the step has no explicit model and no override', () => {
      const fallback = { allModels: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], defaultModelId: 'a' };
      expect(resolveStepModelId({}, undefined, fallback)).toBe('a');
    });

    it('resolveStepModelId prioritizes override > step.modelId > label lookup > default', () => {
      const fallback = { allModels: [{ id: 'byok-x', label: 'DeepSeek Chat' }], defaultModelId: 'claude-sonnet-5' };
      // Label-only step (no modelId) resolves through the label lookup.
      expect(resolveStepModelId({ model: 'DeepSeek Chat' }, undefined, fallback)).toBe('byok-x');
      // An explicit modelId wins over a label lookup.
      expect(resolveStepModelId({ modelId: 'claude-opus-5', model: 'DeepSeek Chat' }, undefined, fallback)).toBe('claude-opus-5');
      // A live (not-yet-persisted) override wins over everything else.
      expect(resolveStepModelId({ modelId: 'claude-opus-5' }, 'claude-haiku-4-5', fallback)).toBe('claude-haiku-4-5');
    });

    it('renders the chip with the default model id when the step has no explicit model', () => {
      const msg = makeProposalMessage('pending');
      msg.proposal!.steps = [{ id: 'step-1', description: 'Do the thing' }];
      renderWithStepModelHandler(msg);
      const select = screen.getByTestId('graph-proposal-step-model-step-1') as HTMLSelectElement;
      // jsdom/non-Tauri detectModelEntitlements() default is claudeSub=true,
      // pro='inactive', byok=null — defaultModelId falls back to the native
      // registry's own DEFAULT_MODEL. Never blank, per resolveStepModelId's
      // own contract.
      expect(select.value).toBe(DEFAULT_MODEL.id);
      expect(select.value).not.toBe('');
    });

    it('renders the chip with the step’s own persisted model and reports (planId, stepId, modelId) on change', () => {
      const msg = makeProposalMessage('pending', 'plan-xyz');
      msg.proposal!.steps = [{ id: 'step-1', description: 'Do the thing', modelId: 'claude-opus-5', model: 'Claude Opus 5' }];
      const onStepModelChange = renderWithStepModelHandler(msg);
      const select = screen.getByTestId('graph-proposal-step-model-step-1') as HTMLSelectElement;
      expect(select.value).toBe('claude-opus-5');

      fireEvent.change(select, { target: { value: 'claude-haiku-4-5' } });
      // The plan record's setter (agentsStore.tsx's setStepModel) is called
      // with the exact catalog id, not a label — this is the id that
      // ultimately threads through compileOrchestrator.ts's stepToNode /
      // sgrOrchestratorRunner.ts's launchOptsFromNode into the mission's
      // own contract.modelId at launch time.
      expect(onStepModelChange).toHaveBeenCalledWith('plan-xyz', 'step-1', 'claude-haiku-4-5');
      // The chip reflects the pick immediately (local override), before the
      // store's async mirror would land in a real app.
      expect(select.value).toBe('claude-haiku-4-5');
    });

    it('keeps two steps on two independently different models after one is changed', () => {
      const msg = makeProposalMessage('pending', 'plan-multi');
      msg.proposal!.steps = [
        { id: 'step-a', description: 'First agent', modelId: 'claude-opus-5' },
        { id: 'step-b', description: 'Second agent', modelId: 'claude-haiku-4-5' },
      ];
      const onStepModelChange = renderWithStepModelHandler(msg);
      const selectA = screen.getByTestId('graph-proposal-step-model-step-a') as HTMLSelectElement;
      const selectB = screen.getByTestId('graph-proposal-step-model-step-b') as HTMLSelectElement;
      expect(selectA.value).toBe('claude-opus-5');
      expect(selectB.value).toBe('claude-haiku-4-5');

      fireEvent.change(selectA, { target: { value: 'claude-fable-5' } });
      expect(onStepModelChange).toHaveBeenCalledWith('plan-multi', 'step-a', 'claude-fable-5');
      // step-b must stay untouched — a multi-LLM graph needs each step's
      // chip to be fully independent, never a single shared selection.
      expect(selectA.value).toBe('claude-fable-5');
      expect(selectB.value).toBe('claude-haiku-4-5');
    });

    it('lists ONLY the rails actually available — jsdom default (Claude CLI detected, Pro inactive, no BYOK key) shows the free group plus the Claude group, and no disabled/locked option is ever rendered — 2026-08-06 (founder: "je devrais juste voir les options quand elles sont selectionnable, exemple claude cli seulement si je suis connecte")', () => {
      const msg = makeProposalMessage('pending');
      msg.proposal!.steps = [{ id: 'step-1', description: 'Do the thing' }];
      renderWithStepModelHandler(msg);
      const select = screen.getByTestId('graph-proposal-step-model-step-1');
      // jsdom/non-Tauri default entitlements: claudeSub=true, pro='inactive',
      // byok=null — the Claude subscription rail is available, PLUS the
      // always-present free group (ox alpha, no entitlement required — see
      // modelPickerOptions.ts). No Pro/BYOK rail: those stay absent.
      const optgroups = select.querySelectorAll('optgroup');
      expect(optgroups.length).toBe(2);
      const labels = Array.from(optgroups).map((g) => g.getAttribute('label'));
      expect(labels.some((l) => l?.includes('Claude'))).toBe(true);
      expect(labels.some((l) => l?.toLowerCase().includes('gratuit') || l?.toLowerCase().includes('free'))).toBe(true);
      // No disabled/locked option anywhere — an unavailable rail is absent,
      // never shown greyed out.
      const options = select.querySelectorAll('option');
      expect(options.length).toBeGreaterThan(0);
      const disabled = Array.from(options).filter((o) => o.disabled);
      expect(disabled.length).toBe(0);
    });
  });
});
