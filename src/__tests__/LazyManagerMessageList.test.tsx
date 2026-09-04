/**
 * LazyManagerMessageList — fleet signals strip (bug fix: a new conversation
 * used to be flooded with every open fleet signal, rendered interleaved
 * before the first message even arrived). Signals now render in their own
 * collapsible strip pinned above the thread, collapsed by default on a
 * fresh (empty) thread and expanded once the thread has messages, with a
 * manual toggle that reverts once the thread empties again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React, { createRef } from 'react';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/locales/en';
import { LazyManagerMessageList, type PendingApprovalAction } from '../components/lazyManager/LazyManagerMessageList';
import type { ManagerSignal } from '../components/agents/cockpit/managerSignals';
import type { FleetMission } from '../lib/agents/fleetMissions';
import type { ManagerMessage } from '../lib/agents/types';
import { WAKEUP_MARKER_PREFIX } from '../lib/agents/managerWakeup';
import {
  charterActionKey,
  proposalActionKey,
  regimeActionKey,
  retryActionKey,
} from '../components/lazyManager/useManagerActionQueue';
import { on } from '../lib/bus';
import type { CharterProposal, MissionCharter, RegimeStatus } from '../components/lazyManager/missionCharter';

function fleetMission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'refactor-auth',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: Date.now(),
    urgent: true,
    ...overrides,
  };
}

function reviewSignal(): ManagerSignal {
  return {
    id: 'review:m1',
    kind: 'review',
    mission: fleetMission({ status: 'review' }),
    projectId: 'p1',
    projectName: 'demo-shop',
    buttons: [{ key: 'merge', labelKey: 'cockpit.action.merge', variant: 'primary' }],
  };
}

function userMessage(id: string): ManagerMessage {
  return { id, role: 'user', content: 'hello', timestamp: new Date().toISOString() };
}

function renderList(props: Partial<React.ComponentProps<typeof LazyManagerMessageList>> = {}) {
  const scrollRef = createRef<HTMLDivElement>();
  return render(
    <I18nProvider>
      <LazyManagerMessageList
        scrollRef={scrollRef}
        mode="orchestrator"
        busy={false}
        phase="idle"
        signals={[]}
        onAnswerSignal={vi.fn()}
        onSignalAction={vi.fn()}
        managerMessages={[]}
        assistantMessages={[]}
        onFocusModel={vi.fn()}
        onRetry={vi.fn()}
        onAcceptProposal={vi.fn()}
        onRejectProposal={vi.fn()}
        brainRecall={null}
        brainError={null}
        brainEnabled={false}
        onRetryBrain={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  );
}

describe('LazyManagerMessageList — fleet signals strip', () => {
  it('renders no strip at all when there are no open signals', () => {
    renderList({ signals: [] });
    expect(screen.queryByTestId('manager-signals-strip-toggle')).not.toBeInTheDocument();
  });

  it('collapses the strip by default on a fresh (empty) thread', () => {
    renderList({ signals: [reviewSignal()], managerMessages: [] });
    expect(screen.getByTestId('manager-signals-strip-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('manager-signals-strip-body')).not.toBeInTheDocument();
    // the thread's own clean empty-state still shows, unpolluted by signals.
    // Read the copy from the locale rather than duplicating it: this test is
    // about the empty state being rendered, not about its exact wording.
    expect(screen.getByText(en['lazyManager.emptyOrchestrator'])).toBeInTheDocument();
  });

  it('expands the strip by default once the thread has messages', () => {
    renderList({ signals: [reviewSignal()], managerMessages: [userMessage('u1')] });
    expect(screen.getByTestId('manager-signals-strip-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('manager-signals-strip-body')).toBeInTheDocument();
    expect(screen.getByTestId('manager-signal-review:m1')).toBeInTheDocument();
  });

  it('a manual click toggles the strip open/closed regardless of the derived default', () => {
    renderList({ signals: [reviewSignal()], managerMessages: [userMessage('u1')] });
    const toggle = screen.getByTestId('manager-signals-strip-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('manager-signals-strip-body')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('manager-signals-strip-body')).toBeInTheDocument();
  });

  it('reverts a manual override once the thread transitions back to empty (a real new session)', () => {
    const { rerender } = render(
      <I18nProvider>
        <LazyManagerMessageList
          scrollRef={createRef<HTMLDivElement>()}
          mode="orchestrator"
          busy={false}
          phase="idle"
          signals={[reviewSignal()]}
          onAnswerSignal={vi.fn()}
          onSignalAction={vi.fn()}
          managerMessages={[userMessage('u1')]}
          assistantMessages={[]}
          onFocusModel={vi.fn()}
          onRetry={vi.fn()}
          onAcceptProposal={vi.fn()}
          onRejectProposal={vi.fn()}
          brainRecall={null}
          brainError={null}
          brainEnabled={false}
          onRetryBrain={vi.fn()}
        />
      </I18nProvider>,
    );

    // Manually collapse it while the thread has messages.
    fireEvent.click(screen.getByTestId('manager-signals-strip-toggle'));
    expect(screen.getByTestId('manager-signals-strip-toggle')).toHaveAttribute('aria-expanded', 'false');

    // newSession clears the thread back to empty — the override should
    // reset, and the strip should fall back to its collapsed-on-empty default.
    rerender(
      <I18nProvider>
        <LazyManagerMessageList
          scrollRef={createRef<HTMLDivElement>()}
          mode="orchestrator"
          busy={false}
          phase="idle"
          signals={[reviewSignal()]}
          onAnswerSignal={vi.fn()}
          onSignalAction={vi.fn()}
          managerMessages={[]}
          assistantMessages={[]}
          onFocusModel={vi.fn()}
          onRetry={vi.fn()}
          onAcceptProposal={vi.fn()}
          onRejectProposal={vi.fn()}
          brainRecall={null}
          brainError={null}
          brainEnabled={false}
          onRetryBrain={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('manager-signals-strip-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('never interleaves signal bubbles inside the scrollable thread', () => {
    const scrollRef = createRef<HTMLDivElement>();
    render(
      <I18nProvider>
        <LazyManagerMessageList
          scrollRef={scrollRef}
          mode="orchestrator"
          busy={false}
          phase="idle"
          signals={[reviewSignal()]}
          onAnswerSignal={vi.fn()}
          onSignalAction={vi.fn()}
          managerMessages={[userMessage('u1')]}
          assistantMessages={[]}
          onFocusModel={vi.fn()}
          onRetry={vi.fn()}
          onAcceptProposal={vi.fn()}
          onRejectProposal={vi.fn()}
          brainRecall={null}
          brainError={null}
          brainEnabled={false}
          onRetryBrain={vi.fn()}
        />
      </I18nProvider>,
    );
    // The signal bubble lives in the strip body, never inside the scrollable
    // thread container (scrollRef) alongside conversation messages.
    expect(screen.getByTestId('manager-signals-strip-body')).toContainElement(
      screen.getByTestId('manager-signal-review:m1'),
    );
    expect(scrollRef.current).toContainElement(screen.getByTestId('manager-message-user'));
    expect(scrollRef.current).not.toContainElement(screen.getByTestId('manager-signal-review:m1'));
  });
});

describe('LazyManagerMessageList — manager wakeup chip (managerWakeup.ts)', () => {
  function wakeupMessage(id: string, content: string): ManagerMessage {
    return { id, role: 'user', content, timestamp: new Date().toISOString() };
  }

  it('renders a wakeup-marked user message as the small system-chip style, not a normal user bubble', () => {
    renderList({ managerMessages: [wakeupMessage('w1', `${WAKEUP_MARKER_PREFIX}Réveil : Mission M42 mergée`)] });
    expect(screen.getByTestId('manager-wakeup-chip')).toHaveTextContent('Mission M42 mergée');
    expect(screen.queryByTestId('manager-message-user')).not.toBeInTheDocument();
  });

  it('still renders an ordinary user message as the normal user bubble (no false positive)', () => {
    renderList({ managerMessages: [userMessage('u1')] });
    expect(screen.getByTestId('manager-message-user')).toBeInTheDocument();
    expect(screen.queryByTestId('manager-wakeup-chip')).not.toBeInTheDocument();
  });

  it('renders the assistant reply that follows a wakeup chip as a normal assistant bubble', () => {
    renderList({
      managerMessages: [
        wakeupMessage('w1', `${WAKEUP_MARKER_PREFIX}Réveil : Mission M42 mergée`),
        { id: 'a1', role: 'assistant', content: 'Rien à signaler.', timestamp: new Date().toISOString() },
      ],
    });
    expect(screen.getByTestId('manager-wakeup-chip')).toBeInTheDocument();
    expect(screen.getByTestId('manager-message-assistant')).toHaveTextContent('Rien à signaler.');
  });

  it('shows a real-result chip instead of hiding displayContent:empty honesty rows', () => {
    renderList({
      managerMessages: [{
        id: 'rr1',
        role: 'assistant',
        content: 'Real outcome: list_lazybots:\nbot_1 ("SolariTest")',
        displayContent: '',
        timestamp: new Date().toISOString(),
      }],
    });
    expect(screen.getByTestId('manager-real-result')).toHaveTextContent('list_lazybots');
    expect(screen.getByTestId('manager-real-result')).toHaveTextContent('SolariTest');
  });

  it('shows a compact notice above the assistant reply when compactNotice is set', () => {
    renderList({
      managerMessages: [{
        id: 'a1',
        role: 'assistant',
        content: 'Done.',
        timestamp: new Date().toISOString(),
        compactNotice: 'Context compacted: 4 earlier turns folded into verbatim excerpts (48000 → 9000 chars).',
      }],
    });
    expect(screen.getByTestId('manager-compact-notice')).toHaveTextContent('Context compacted: 4');
  });

  // displayContent fix (real user report, 2026-08-01 QA): a wakeup turn's
  // `content` also carries the internal "réponds en français" directive the
  // MODEL needs — a human must never see that in the chip. See
  // ManagerMessage.displayContent's own doc comment.
  it('renders displayContent instead of content when both are present on a wakeup chip', () => {
    renderList({
      managerMessages: [{
        id: 'w2',
        role: 'user',
        content: `${WAKEUP_MARKER_PREFIX}Réveil : Verdict du juge prêt pour M60 (rejeté) — vérifie l'aval et informe l'utilisateur si besoin. Réponds en français.`,
        displayContent: `${WAKEUP_MARKER_PREFIX}Réveil : Verdict du juge prêt pour M60 (rejeté)`,
        timestamp: new Date().toISOString(),
      }],
    });
    const chip = screen.getByTestId('manager-wakeup-chip');
    expect(chip).toHaveTextContent('Verdict du juge prêt pour M60 (rejeté)');
    expect(chip).not.toHaveTextContent('Réponds en français');
    expect(chip).not.toHaveTextContent("vérifie l'aval");
  });

  it('falls back to content when displayContent is absent (every ordinary wakeup chip, unchanged behavior)', () => {
    renderList({ managerMessages: [wakeupMessage('w3', `${WAKEUP_MARKER_PREFIX}Réveil : Mission M42 mergée`)] });
    expect(screen.getByTestId('manager-wakeup-chip')).toHaveTextContent('Mission M42 mergée');
  });

  // 2026-08-15 coordinator follow-up: sanitizeManagerDisplayText /
  // stripVerbatimPrefixesInText only ever ran at INGEST time (inside
  // runManagerTurn / at the ApproveBlockedError throw site) — a message
  // already sitting in state (loaded from managerPersistence.ts, exactly
  // like a message that existed before either fix shipped) never got
  // re-sanitized, so its raw leak rendered forever. This wakeup chip
  // reproduces the real repro verbatim: a `\\?\`-prefixed worktree path
  // embedded mid-sentence inside a wakeup fact's reason suffix (the shape
  // managerWakeup.ts's formatWakeupFact/wakeupReasonSuffix produces from an
  // old mission.approve_blocked journal row) — never freshly ingested here,
  // just handed straight to the list as already-persisted state.
  it('renders a \\\\?\\-prefixed path embedded mid-sentence clean, even on a message already in state (not freshly ingested)', () => {
    const leakedReason =
      "Rien à fusionner — le dossier worktree n'existe plus sur le disque " +
      '(\\\\?\\C:\\Users\\user\\Documents\\cerveau\\LazySite-internet\\.lazy\\worktrees\\agent-x).';
    renderList({
      managerMessages: [{
        id: 'w4',
        role: 'user',
        content: `${WAKEUP_MARKER_PREFIX}Réveil : approbation bloquée : ${leakedReason}`,
        timestamp: new Date().toISOString(),
      }],
    });
    const chip = screen.getByTestId('manager-wakeup-chip');
    expect(chip).toHaveTextContent('LazySite-internet');
    expect(chip.textContent).not.toContain('\\\\?\\');
  });
});

// Markdown rendering fix (real user report, 2026-08-01 QA): the manager
// writes markdown constantly ("je dois clarifier une **SHAPE**") but it used
// to display as raw asterisks. The assistant side now renders through the
// shared MarkdownRenderer (lib/markdown) — same renderer already used by the
// coder chat (MessageList.tsx) — while the user side stays plain text.
describe('LazyManagerMessageList — markdown rendering in assistant bubbles', () => {
  function assistantMessage(id: string, content: string): ManagerMessage {
    return { id, role: 'assistant', content, timestamp: new Date().toISOString() };
  }

  it('renders **bold** as a <strong>, not literal asterisks', () => {
    renderList({ managerMessages: [assistantMessage('a1', 'je dois clarifier une **SHAPE**')] });
    const bubble = screen.getByTestId('manager-message-assistant');
    expect(bubble.querySelector('strong')).toHaveTextContent('SHAPE');
    expect(bubble.textContent).not.toContain('**SHAPE**');
  });

  it('renders an ordered list as real <li> items, not literal "1. " text', () => {
    renderList({
      managerMessages: [assistantMessage('a2', '1. **Electron** (vraie appli native)\n2. Autre option')],
    });
    const bubble = screen.getByTestId('manager-message-assistant');
    const items = bubble.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Electron');
    expect(bubble.querySelector('strong')).toHaveTextContent('Electron');
  });

  it('renders inline `code` as a <code> element', () => {
    renderList({ managerMessages: [assistantMessage('a3', 'Utilise `npm run typecheck` avant de committer.')] });
    const bubble = screen.getByTestId('manager-message-assistant');
    expect(bubble.querySelector('code')).toHaveTextContent('npm run typecheck');
  });

  it('never interprets raw HTML in the model output as markup (XSS safety)', () => {
    renderList({ managerMessages: [assistantMessage('a4', 'Regarde <img src=x onerror="window.__pwned=true">')] });
    const bubble = screen.getByTestId('manager-message-assistant');
    expect(bubble.querySelector('img')).not.toBeInTheDocument();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('strips nested Error: Error: LazyManager wrappers on already-persisted bubbles', () => {
    renderList({
      managerMessages: [assistantMessage(
        'a-err',
        "Error: Error: LazyManager error: Error: There's an issue with the selected model (deepseek-chat).",
      )],
    });
    const bubble = screen.getByTestId('manager-message-assistant');
    expect(bubble).toHaveTextContent("There's an issue with the selected model (deepseek-chat).");
    expect(bubble.textContent).not.toMatch(/LazyManager error/i);
    expect(bubble.textContent).not.toMatch(/^Error: Error:/);
  });

  it('a plain user message is still rendered as raw text, never parsed as markdown', () => {
    renderList({ managerMessages: [{ id: 'u2', role: 'user', content: 'j\'aime **ce plan**', timestamp: new Date().toISOString() }] });
    const bubble = screen.getByTestId('manager-message-user');
    expect(bubble.querySelector('strong')).not.toBeInTheDocument();
    expect(bubble).toHaveTextContent("j'aime **ce plan**");
  });

  // 2026-08-15 coordinator follow-up: artifactEnvelopeLeak.ts's
  // stripArtifactEnvelope only ran once, at ingest (sanitizeManagerDisplayText
  // inside runManagerTurn) — a message already sitting in state (loaded from
  // managerPersistence.ts, exactly like every conversation persisted before
  // that fix shipped) was never re-sanitized, so the raw envelope kept
  // rendering forever even on a rebuilt binary. This message is handed
  // straight to the list as already-persisted state (never run through
  // runManagerTurn in this test), reproducing the confirmed live repro
  // verbatim (mission id `query-m7`).
  it('strips a leaked <artifact> envelope even on a message already in state (not freshly ingested)', () => {
    renderList({
      managerMessages: [{
        id: 'a5',
        role: 'assistant',
        content:
          "Voici ce qui n'a pas fonctionné et ce qui doit être corrigé. " +
          '<artifact type="application/json" id="query-m7"> {"type": "query_miss", "missionId": "M7"} </artifact>' +
          ' Peux-tu relancer la mission ?',
        timestamp: new Date().toISOString(),
      }],
    });
    const bubble = screen.getByTestId('manager-message-assistant');
    expect(bubble).toHaveTextContent("Voici ce qui n'a pas fonctionné et ce qui doit être corrigé.");
    expect(bubble).toHaveTextContent('Peux-tu relancer la mission ?');
    expect(bubble.textContent).not.toContain('artifact');
    expect(bubble.textContent).not.toContain('query_miss');
  });
});

// Real user report fix: "j'ai des trucs echoues que je ne peux jamais
// supprimer donc ca pollue" — a per-card dismiss button, a strip-wide
// "tout effacer", and auto-collapse beyond 8 signals.
describe('LazyManagerMessageList — signal acknowledgment (dismiss / clear all)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  function failedSignal(id: string, missionId: string): ManagerSignal {
    return {
      id,
      kind: 'failed',
      mission: fleetMission({ id: missionId, status: 'failed' }),
      projectId: 'p1',
      projectName: 'demo-shop',
      buttons: [{ key: 'retry', labelKey: 'cockpit.action.retry', variant: 'primary' }],
    };
  }

  it('renders a dismiss ("x") button on every signal card', () => {
    renderList({ signals: [reviewSignal()], managerMessages: [userMessage('u1')] });
    expect(screen.getByTestId('manager-signal-dismiss-review:m1')).toBeInTheDocument();
  });

  it('clicking a signal\'s dismiss button removes ONLY that card, keeping the others', () => {
    const other = failedSignal('failed:m9', 'm9');
    renderList({ signals: [reviewSignal(), other], managerMessages: [userMessage('u1')] });
    expect(screen.getByTestId('manager-signal-review:m1')).toBeInTheDocument();
    expect(screen.getByTestId('manager-signal-failed:m9')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('manager-signal-dismiss-review:m1'));

    expect(screen.queryByTestId('manager-signal-review:m1')).not.toBeInTheDocument();
    expect(screen.getByTestId('manager-signal-failed:m9')).toBeInTheDocument();
  });

  it('a dismissed signal stays dismissed across a re-render even if the same fleet snapshot keeps reporting it (the reported "keeps coming back" defect)', () => {
    const { rerender } = renderList({ signals: [reviewSignal()], managerMessages: [userMessage('u1')] });
    fireEvent.click(screen.getByTestId('manager-signal-dismiss-review:m1'));
    expect(screen.queryByTestId('manager-signal-review:m1')).not.toBeInTheDocument();

    // Same signal, same id, recomputed fresh (as deriveManagerSignals would
    // on the next poll while the mission stays failed) — must NOT resurface.
    rerender(
      <I18nProvider>
        <LazyManagerMessageList
          scrollRef={createRef<HTMLDivElement>()}
          mode="orchestrator"
          busy={false}
          phase="idle"
          signals={[reviewSignal()]}
          onAnswerSignal={vi.fn()}
          onSignalAction={vi.fn()}
          managerMessages={[userMessage('u1')]}
          assistantMessages={[]}
          onFocusModel={vi.fn()}
          onRetry={vi.fn()}
          onAcceptProposal={vi.fn()}
          onRejectProposal={vi.fn()}
          brainRecall={null}
          brainError={null}
          brainEnabled={false}
          onRetryBrain={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.queryByTestId('manager-signal-review:m1')).not.toBeInTheDocument();
  });

  it('"tout effacer" dismisses every currently-visible signal at once', () => {
    renderList({
      signals: [reviewSignal(), failedSignal('failed:m9', 'm9')],
      managerMessages: [userMessage('u1')],
    });
    fireEvent.click(screen.getByTestId('manager-signals-strip-clear-all'));
    expect(screen.queryByTestId('manager-signal-review:m1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('manager-signal-failed:m9')).not.toBeInTheDocument();
    // Every signal now acknowledged — the strip itself has nothing left to show.
    expect(screen.queryByTestId('manager-signals-strip-toggle')).not.toBeInTheDocument();
  });

  it('the strip is collapsed by default beyond 8 visible signals, even on a non-empty thread', () => {
    const many = Array.from({ length: 9 }, (_, i) => failedSignal(`failed:m${i}`, `m${i}`));
    renderList({ signals: many, managerMessages: [userMessage('u1')] });
    expect(screen.getByTestId('manager-signals-strip-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('stays expanded by default at exactly 8 or fewer visible signals on a non-empty thread', () => {
    const eight = Array.from({ length: 8 }, (_, i) => failedSignal(`failed:m${i}`, `m${i}`));
    renderList({ signals: eight, managerMessages: [userMessage('u1')] });
    expect(screen.getByTestId('manager-signals-strip-toggle')).toHaveAttribute('aria-expanded', 'true');
  });
});

// Approval surface that did not exist before this fix (real user test,
// 2026-07-28): every gate-deferred action rendered only a toast, then
// vanished with nothing anywhere in the app to approve it.
describe('LazyManagerMessageList — pending approval card', () => {
  // Pins the locale so the "Approuvée"/"Rejetée" status copy is
  // deterministic regardless of jsdom's own default ('en-US').
  beforeEach(() => localStorage.setItem('lazy.locale', 'fr'));
  afterEach(() => localStorage.removeItem('lazy.locale'));

  function pendingAction(overrides: Partial<PendingApprovalAction> = {}): PendingApprovalAction {
    return {
      id: 'pending-1',
      action: { type: 'clear_canvas', scope: 'terminated', mode: 'archive' },
      label: 'Vider le canvas : missions terminées',
      turnId: 'turn-1',
      messageId: 'a1',
      actionIndex: 0,
      model: 'sonnet',
      aliasMap: new Map(),
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function assistantMsg(id: string): ManagerMessage {
    return { id, role: 'assistant', content: 'Je m\'en occupe.', timestamp: new Date().toISOString() };
  }

  it('renders no approval card when there is nothing pending', () => {
    renderList({ managerMessages: [assistantMsg('a1')], pendingApprovals: [] });
    expect(screen.queryByTestId('pending-approval-card')).not.toBeInTheDocument();
  });

  it('renders the pending action with its plain-language label and Approve/Reject buttons', () => {
    renderList({ managerMessages: [assistantMsg('a1')], pendingApprovals: [pendingAction()] });
    expect(screen.getByTestId('pending-approval-card')).toBeInTheDocument();
    expect(screen.getByTestId('pending-approval-item-pending-1')).toHaveTextContent('Vider le canvas : missions terminées');
    expect(screen.getByTestId('pending-approval-approve-pending-1')).toBeInTheDocument();
    expect(screen.getByTestId('pending-approval-reject-pending-1')).toBeInTheDocument();
  });

  it('only attaches a pending action\'s card to ITS OWN origin message, never a different one', () => {
    renderList({
      managerMessages: [assistantMsg('a1'), assistantMsg('a2')],
      pendingApprovals: [pendingAction({ messageId: 'a1' })],
    });
    const cards = screen.getAllByTestId('pending-approval-card');
    // Only one message actually has a pending item; the OTHER message's card
    // renders nothing (component returns null internally) — see the module
    // doc comment on the "always mount, decide internally" contract.
    expect(cards).toHaveLength(1);
  });

  // Truncation-reachability + layout fix (real user report, 2026-08-01 QA):
  // the approval card showed a description cut mid-sentence in the DOM
  // itself, in a column squeezed to ~12 characters by the approve/reject
  // buttons. The full text must be reachable (title tooltip + expand
  // affordance) and the buttons must never crowd the text.
  it('a long launch_mission label gets a full-text tooltip and an expand affordance revealing the untruncated task', () => {
    const longTask = 'Audite le projet C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON : stack réel (Electron + JS + Python), routes IPC, et propose un plan de modernisation';
    renderList({
      managerMessages: [assistantMsg('a1')],
      pendingApprovals: [pendingAction({
        action: { type: 'launch_mission', task: longTask },
        label: `Lancer la mission : ${longTask.slice(0, 60)}…`,
      })],
    });

    const item = screen.getByTestId('pending-approval-item-pending-1');
    // title tooltip carries the full text immediately (hover path).
    const labelSpan = item.querySelector('span[title]');
    expect(labelSpan).not.toBeNull();
    expect(labelSpan?.getAttribute('title')).toContain(longTask.slice(0, 40));

    // Click path: the expand affordance reveals the FULL, untruncated text.
    const expandBtn = screen.getByTestId('pending-approval-expand-pending-1');
    expect(screen.queryByTestId('pending-approval-detail-pending-1')).not.toBeInTheDocument();
    fireEvent.click(expandBtn);
    expect(screen.getByTestId('pending-approval-detail-pending-1')).toHaveTextContent(longTask);

    // The approve/reject buttons never shared the label's own row — this is
    // structural (own sibling block), not a pixel-measurement assertion.
    expect(screen.getByTestId('pending-approval-approve-pending-1')).toBeInTheDocument();
  });

  it('a short label (already full) shows no expand affordance — nothing extra to reveal', () => {
    renderList({
      managerMessages: [assistantMsg('a1')],
      pendingApprovals: [pendingAction({ action: { type: 'stop_all' }, label: 'Arrêter toutes les missions' })],
    });
    expect(screen.queryByTestId('pending-approval-expand-pending-1')).not.toBeInTheDocument();
  });

  it('reflects an entry the STORE already reports as failed (e.g. inherited on mount) without requiring a fresh click', () => {
    renderList({
      managerMessages: [assistantMsg('a1')],
      pendingApprovals: [pendingAction({ lastFailure: { reason: 'Mission M9 introuvable', canForce: false } })],
    });
    expect(screen.getByTestId('pending-approval-reason-pending-1')).toHaveTextContent('Mission M9 introuvable');
    expect(screen.queryByTestId('pending-approval-approve-pending-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pending-approval-force-pending-1')).not.toBeInTheDocument();
  });

  // HONESTY FIX (real user test, 2026-07-28): three approve_mission actions
  // blocked by `mission.approve_blocked` still showed "Approuvée" — clicking
  // Approve must NEVER flip the row to a resolved-positive state on the
  // mere fact that the click happened; only the REAL outcome (once it
  // resolves) decides what the row shows.
  it('Approve calls onApprovePendingAction and, once the REAL outcome confirms success, flips the row to "Approved" — never optimistically', async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: true });
    renderList({
      managerMessages: [assistantMsg('a1')],
      pendingApprovals: [pendingAction()],
      onApprovePendingAction: onApprove,
    });
    fireEvent.click(screen.getByTestId('pending-approval-approve-pending-1'));
    expect(onApprove).toHaveBeenCalledWith('pending-1');
    await waitFor(() => {
      expect(screen.getByTestId('pending-approval-status-pending-1')).toHaveTextContent('Approuvée');
    });
    expect(screen.queryByTestId('pending-approval-approve-pending-1')).not.toBeInTheDocument();
  });

  // Regression test for the exact defect (BILAN-NUIT.md, Défaut 1): the
  // judge-gate reason verbatim, still shown as "Approuvée" before this fix.
  it('a REFUSED approval never shows "Approuvée" — shows the exact system reason and stays actionable via "Merger quand même"', async () => {
    const reason = 'Le juge a rejeté cette mission (score indisponible). Corrigez les problèmes ou utilisez "Merger quand même" pour forcer.';
    const onApprove = vi.fn().mockResolvedValue({ ok: false, reason, canForce: true });
    const onForce = vi.fn().mockResolvedValue({ ok: true });
    renderList({
      managerMessages: [assistantMsg('a1')],
      pendingApprovals: [pendingAction({
        action: { type: 'approve_mission', missionId: 'M44' },
        label: 'Approuver la mission M44',
      })],
      onApprovePendingAction: onApprove,
      onForcePendingAction: onForce,
    });
    fireEvent.click(screen.getByTestId('pending-approval-approve-pending-1'));

    await waitFor(() => {
      expect(screen.getByTestId('pending-approval-status-pending-1')).not.toHaveTextContent('Approuvée');
    });
    expect(screen.getByTestId('pending-approval-reason-pending-1')).toHaveTextContent(reason);
    const forceButton = screen.getByTestId('pending-approval-force-pending-1');

    fireEvent.click(forceButton);
    expect(onForce).toHaveBeenCalledWith('pending-1');
    await waitFor(() => {
      expect(screen.getByTestId('pending-approval-status-pending-1')).toHaveTextContent('Approuvée');
    });
  });

  it('a refused approval with no force option still stays actionable via Reject (abandon)', async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: false, reason: 'Mission M12 introuvable' });
    const onReject = vi.fn();
    renderList({
      managerMessages: [assistantMsg('a1')],
      pendingApprovals: [pendingAction()],
      onApprovePendingAction: onApprove,
      onRejectPendingAction: onReject,
    });
    fireEvent.click(screen.getByTestId('pending-approval-approve-pending-1'));
    await waitFor(() => {
      expect(screen.getByTestId('pending-approval-reason-pending-1')).toHaveTextContent('Mission M12 introuvable');
    });
    expect(screen.queryByTestId('pending-approval-force-pending-1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pending-approval-abandon-pending-1'));
    expect(onReject).toHaveBeenCalledWith('pending-1');
  });

  it('Reject calls onRejectPendingAction and flips the row to a "Rejected" status', () => {
    const onReject = vi.fn();
    renderList({
      managerMessages: [assistantMsg('a1')],
      pendingApprovals: [pendingAction()],
      onRejectPendingAction: onReject,
    });
    fireEvent.click(screen.getByTestId('pending-approval-reject-pending-1'));
    expect(onReject).toHaveBeenCalledWith('pending-1');
    expect(screen.getByTestId('pending-approval-status-pending-1')).toHaveTextContent('Rejetée');
  });

  it('the card SURVIVES the store removing the action from pendingApprovals — it keeps showing the resolved status, never disappears without a trace', async () => {
    const onApprove = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = renderList({
      managerMessages: [assistantMsg('a1')],
      pendingApprovals: [pendingAction()],
      onApprovePendingAction: onApprove,
    });
    fireEvent.click(screen.getByTestId('pending-approval-approve-pending-1'));
    await waitFor(() => {
      expect(screen.getByTestId('pending-approval-status-pending-1')).toHaveTextContent('Approuvée');
    });

    // The store removes it from pendingApprovals the instant it resolves
    // SUCCESSFULLY (see agentsStore.tsx's approvePendingAction) — simulate
    // that here.
    rerender(
      <I18nProvider>
        <LazyManagerMessageList
          scrollRef={createRef<HTMLDivElement>()}
          mode="orchestrator"
          busy={false}
          phase="idle"
          signals={[]}
          onAnswerSignal={vi.fn()}
          onSignalAction={vi.fn()}
          managerMessages={[assistantMsg('a1')]}
          assistantMessages={[]}
          onFocusModel={vi.fn()}
          onRetry={vi.fn()}
          onAcceptProposal={vi.fn()}
          onRejectProposal={vi.fn()}
          brainRecall={null}
          brainError={null}
          brainEnabled={false}
          onRetryBrain={vi.fn()}
          pendingApprovals={[]}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('pending-approval-card')).toBeInTheDocument();
    expect(screen.getByTestId('pending-approval-status-pending-1')).toHaveTextContent('Approuvée');
  });

  it('"Tout approuver" calls onApproveAllPendingActions with the batch turnId and reflects each item\'s OWN real outcome — never a blanket success', async () => {
    const reason = 'Le juge a rejeté cette mission (score indisponible).';
    const onApproveAll = vi.fn().mockResolvedValue([
      { id: 'p1', ok: true },
      { id: 'p2', ok: false, reason, canForce: true },
    ]);
    renderList({
      managerMessages: [assistantMsg('a1')],
      pendingApprovals: [
        pendingAction({ id: 'p1', actionIndex: 0, turnId: 'turn-9' }),
        pendingAction({ id: 'p2', actionIndex: 1, turnId: 'turn-9', label: 'Chaîner les agents' }),
      ],
      onApproveAllPendingActions: onApproveAll,
    });
    fireEvent.click(screen.getByTestId('pending-approval-approve-all'));
    expect(onApproveAll).toHaveBeenCalledWith('turn-9');
    await waitFor(() => {
      expect(screen.getByTestId('pending-approval-status-p1')).toHaveTextContent('Approuvée');
    });
    expect(screen.getByTestId('pending-approval-status-p2')).not.toHaveTextContent('Approuvée');
    expect(screen.getByTestId('pending-approval-reason-p2')).toHaveTextContent(reason);
  });

  it('"Tout rejeter" calls onRejectAllPendingActions with the batch turnId', () => {
    const onRejectAll = vi.fn();
    renderList({
      managerMessages: [assistantMsg('a1')],
      pendingApprovals: [
        pendingAction({ id: 'p1', actionIndex: 0, turnId: 'turn-9' }),
        pendingAction({ id: 'p2', actionIndex: 1, turnId: 'turn-9', label: 'Chaîner les agents' }),
      ],
      onRejectAllPendingActions: onRejectAll,
    });
    fireEvent.click(screen.getByTestId('pending-approval-reject-all'));
    expect(onRejectAll).toHaveBeenCalledWith('turn-9');
    expect(screen.getByTestId('pending-approval-status-p1')).toHaveTextContent('Rejetée');
    expect(screen.getByTestId('pending-approval-status-p2')).toHaveTextContent('Rejetée');
  });
});

// Diagnosed manager stutter (real user report, verbatim, 2026-07-28): the
// same sentence rendered twice back-to-back in one bubble. Display-side
// mitigation — see dedupeMessageText.ts's own doc comment for the diagnosed
// (out-of-perimeter) root cause.
describe('LazyManagerMessageList — no duplicated text in an assistant bubble', () => {
  it('collapses an exact-duplicate adjacent paragraph before rendering (the reported defect, verbatim)', () => {
    const sentence = "Carrousel d'images ou vraie vidéo Remotion animée ? Ça détermine tout le pipeline de production.";
    renderList({
      managerMessages: [
        { id: 'a1', role: 'assistant', content: `${sentence}\n\n${sentence}`, timestamp: new Date().toISOString() },
      ],
    });
    const bubble = screen.getByTestId('manager-message-assistant');
    const occurrences = bubble.textContent?.split(sentence).length ?? 0;
    // split() on N occurrences yields N+1 parts — exactly 1 occurrence means
    // exactly 2 parts (before/after), not 3 (which two occurrences would give).
    expect(occurrences).toBe(2);
  });

  it('renders a normal (non-duplicated) message completely unchanged', () => {
    renderList({
      managerMessages: [{ id: 'a1', role: 'assistant', content: 'Une réponse normale.', timestamp: new Date().toISOString() }],
    });
    expect(screen.getByTestId('manager-message-assistant')).toHaveTextContent('Une réponse normale.');
  });

  it('never applies dedup to a USER message (typed verbatim by the human, never touched)', () => {
    const sentence = 'Je répète exprès la même phrase.';
    renderList({
      managerMessages: [{ id: 'u1', role: 'user', content: `${sentence}\n\n${sentence}`, timestamp: new Date().toISOString() }],
    });
    const bubble = screen.getByTestId('manager-message-user');
    const occurrences = bubble.textContent?.split(sentence).length ?? 0;
    expect(occurrences).toBe(3); // both copies preserved verbatim
  });
});

// Real, observed QA defect (2026-08-12): the "Open project" action chip
// truncated a long path with a bare `.slice(0, 32)` — no ellipsis, no
// marker — so `C:\Users\user\Documents\cerveau\scratchpad\uc-smoke-2026-08-12`
// rendered as "Open project: C:\Users\user\Documents\cerveau", a real,
// different, plausible-looking (but WRONG) directory. See truncateLabel.ts
// for the fix (truncatePathLabel: middle-truncation keeping the final
// segment visible) — this is the end-to-end render-level regression test.
describe('LazyManagerMessageList — action chip truncation never hides ambiguity (2026-08-12 QA)', () => {
  it('never renders a long open_project path as a DIFFERENT, valid-looking directory with no indicator', () => {
    const longPath = String.raw`C:\Users\user\Documents\cerveau\scratchpad\uc-smoke-2026-08-12`;
    renderList({
      managerMessages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'Ouverture du projet.',
          timestamp: new Date().toISOString(),
          actions: [{ type: 'open_project', path: longPath }],
        },
      ],
    });
    const bubble = screen.getByTestId('manager-message-assistant');
    // The exact real-repro defect: naive slice(0, 32) produced precisely
    // this different, real-looking directory — must never appear again.
    expect(bubble.textContent).not.toMatch(/Open project: C:\\Users\\user\\Documents\\cerveau(?![\w\\])/);
    // The final path segment (what the user actually asked to open) must
    // stay visible, and a truncation indicator must be present.
    expect(bubble.textContent).toContain('uc-smoke-2026-08-12');
    expect(bubble.textContent).toContain('\u2026');
  });

  it('renders a short open_project path completely unchanged (no false-positive truncation)', () => {
    renderList({
      managerMessages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'Ouverture du projet.',
          timestamp: new Date().toISOString(),
          actions: [{ type: 'open_project', path: String.raw`C:\proj` }],
        },
      ],
    });
    expect(screen.getByTestId('manager-message-assistant').textContent).toContain(String.raw`C:\proj`);
  });

  it('always shows a truncation indicator on a truncated launch_mission task label', () => {
    const longTask =
      "Dans index.js à la racine du projet actif, ajoute une fonction sum(a, b) et affiche son résultat au démarrage.";
    renderList({
      managerMessages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'Je lance la mission.',
          timestamp: new Date().toISOString(),
          actions: [{ type: 'launch_mission', task: longTask }],
        },
      ],
    });
    const bubble = screen.getByTestId('manager-message-assistant');
    // Real-repro defect: "Launched: Dans index.js à la racine du pro" — cut
    // mid-word with no indicator at all.
    expect(bubble.textContent).not.toMatch(/Dans index\.js à la racine du pro(?![a-zàâäéèêëïîôöùûüÿçœ])/i);
    expect(bubble.textContent).toContain('\u2026');
  });
});

// Optimistic-tense fix (real user report, 2026-08-15 -- "hourglass Lancee"
// repro): a SENSITIVE action (launch_mission, in 'supervised' autonomy) that
// the gate deferred to `pendingApprovals` was rendering its chip with the
// exact same completed-past-tense text ("Lancee : ...") as a genuinely
// EXECUTED action -- only the hourglass icon + amber color hinted it was
// still waiting. The founder read that combination as "already launched" and
// concluded (wrongly) the system had silently dropped the action; the action
// was in fact queued correctly the whole time (confirmed: the
// pending-approval bar/card already showed the SAME action with the honest,
// present-tense "Lancer la mission : ..." label -- describePendingAction,
// agentsStore.tsx). This fixes the CHAT BUBBLE's own chip to reuse that same
// honest label instead of actionSummary's optimistic one, so the two
// surfaces never disagree about whether the mission actually started.
describe('LazyManagerMessageList \u2014 pending action chip reflects real state, not optimistic past tense (2026-08-15 fix)', () => {
  // Pins the locale so the "Lancer la mission" / "Lanc\u00e9e" copy asserted
  // below is deterministic regardless of jsdom's own default ('en-US') --
  // mirrors the 'pending approval card' describe block above.
  beforeEach(() => localStorage.setItem('lazy.locale', 'fr'));
  afterEach(() => localStorage.removeItem('lazy.locale'));

  function launchMissionMsg(task: string): ManagerMessage {
    return {
      id: 'a1',
      role: 'assistant',
      content: 'Mission en cours.',
      timestamp: new Date().toISOString(),
      actions: [{ type: 'launch_mission', task }],
      actionStatuses: [false],
    };
  }

  it('a gate-deferred (pending-approval) launch_mission chip shows the honest "Lancer la mission" wording, never the completed "Lanc\u00e9e" text', () => {
    const task = 'Corrige messages/fr/pricing.json : price du plan Pro';
    renderList({
      managerMessages: [launchMissionMsg(task)],
      pendingApprovals: [
        {
          id: 'pending-1',
          action: { type: 'launch_mission', task },
          label: `Lancer la mission : ${task}`,
          turnId: 'turn-1',
          messageId: 'a1',
          actionIndex: 0,
          model: 'sonnet',
          aliasMap: new Map(),
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const chip = screen.getByTestId('manager-action-chip-pending-0');
    // The real, present-tense wording the approval bar/card already shows
    // honestly for the SAME action \u2014 never the completed "Lanc\u00e9e" verb.
    expect(chip.textContent).toContain('Lancer la mission');
    expect(chip.textContent).not.toContain('Lanc\u00e9e');
  });

  it('a genuinely EXECUTED launch_mission (actionStatuses true, no matching pendingApprovals entry) still shows the completed "Lanc\u00e9e" text \u2014 regression guard', () => {
    renderList({
      managerMessages: [
        {
          id: 'a1',
          role: 'assistant',
          content: 'Mission lanc\u00e9e.',
          timestamp: new Date().toISOString(),
          actions: [{ type: 'launch_mission', task: 'Fix the bug' }],
          actionStatuses: [true],
        },
      ],
      pendingApprovals: [],
    });
    const bubble = screen.getByTestId('manager-message-assistant');
    expect(bubble.textContent).toContain('Lanc\u00e9e');
  });

  it('a genuinely DENIED launch_mission (failed, no matching pendingApprovals entry) keeps the crossed-out denial style, not the pending wording', () => {
    const task = 'Fix the bug';
    renderList({
      managerMessages: [launchMissionMsg(task)],
      pendingApprovals: [],
    });
    expect(screen.queryByTestId('manager-action-chip-pending-0')).not.toBeInTheDocument();
    const bubble = screen.getByTestId('manager-message-assistant');
    // Denied still uses actionSummary's own wording ("Lanc\u00e9e" is the only
    // copy that action type has today) \u2014 this guard only proves the denial
    // path was NOT rerouted to the pending label by mistake.
    expect(bubble.textContent).toContain('Lanc\u00e9e');
  });
});

// CONSENT-BYPASS FIX (agentsStore.tsx's sendManagerMessage/executePlan): a
// mutative action bundled in the SAME turn as `generate_plan` used to render
// with `actionStatuses: [true]` — an outright completed-SUCCESS chip — while
// sitting untouched on `proposal.deferredActions`, never executed nor gated.
// It now gets the honest, distinct `'deferred'` status (types.ts's
// ActionStatus), which this chip renders with its own testid and wording,
// never the plain accent "success" style a genuinely executed action gets.
describe('LazyManagerMessageList — deferred action chip (consent-bypass fix)', () => {
  function deferredActionMsg(): ManagerMessage {
    return {
      id: 'a1',
      role: 'assistant',
      content: 'Plan proposé.',
      timestamp: new Date().toISOString(),
      actions: [{ type: 'create_project', path: '/root/new-project' }],
      actionStatuses: ['deferred'],
    };
  }

  it('renders a distinct "deferred" chip, with its own data-testid, for an action awaiting plan validation', () => {
    renderList({ managerMessages: [deferredActionMsg()] });
    expect(screen.getByTestId('manager-action-chip-deferred-0')).toBeInTheDocument();
  });

  it('never renders the plain success accent style for a deferred action', () => {
    renderList({ managerMessages: [deferredActionMsg()] });
    // Neither the plain "success" accent chip NOR a pending-approval chip
    // (nothing is queued in pendingApprovals yet — it is still pre-validation)
    // — only the dedicated deferred chip.
    expect(screen.queryByTestId('manager-action-chip-pending-0')).not.toBeInTheDocument();
    const chip = screen.getByTestId('manager-action-chip-deferred-0');
    expect(chip.textContent).not.toContain('✗');
  });
});

// Item 5 fix (real user QA, 2026-08-01, verbatim: "Focus canvas" does
// nothing — a dead button next to two working ones): a SUCCESSFUL
// focus_canvas action used to always get its own inert `<span>` chip in
// the action-chip row, visually indistinguishable from the REAL, clickable
// "Voir sur le canvas" button (manager-canvas-focus-chip) rendered right
// above it — but clicking the chip did nothing (no onClick at all). See
// isVisibleActionChip's own doc comment (LazyManagerMessageList.tsx).
describe('LazyManagerMessageList — focus_canvas action chip (item 5 fix)', () => {
  function assistantMessageWithActions(
    id: string,
    actions: NonNullable<ManagerMessage['actions']>,
    actionStatuses?: boolean[],
  ): ManagerMessage {
    return { id, role: 'assistant', content: 'Voici.', timestamp: new Date().toISOString(), actions, actionStatuses };
  }

  it('does not render a separate inert chip for a SUCCESSFUL focus_canvas action — "Voir sur le canvas" already represents it', () => {
    renderList({
      managerMessages: [assistantMessageWithActions('fc1', [{ type: 'focus_canvas', ref: 'mission:M12' }], [true])],
    });
    // The real, working button is still there.
    expect(screen.getByTestId('manager-canvas-focus-chip')).toBeInTheDocument();
    // The redundant, non-clickable lookalike chip is gone.
    expect(screen.queryByText('Focus canvas')).not.toBeInTheDocument();
  });

  it('does not render a separate chip when actionStatuses is absent (undefined never reads as "failed")', () => {
    renderList({
      managerMessages: [assistantMessageWithActions('fc2', [{ type: 'focus_canvas', ref: 'mission:M13' }])],
    });
    expect(screen.queryByText('Focus canvas')).not.toBeInTheDocument();
  });

  it('still shows the chip for a FAILED focus_canvas action — a real failure is never hidden', () => {
    renderList({
      managerMessages: [assistantMessageWithActions('fc3', [{ type: 'focus_canvas', ref: 'mission:M99' }], [false])],
    });
    // The chip also carries a "✗ " denial prefix, so match on the label
    // substring rather than the chip's full (multi-text-node) content.
    expect(screen.getByText(/Focus canvas/)).toBeInTheDocument();
  });

  it('other action types keep their own chip unchanged (only focus_canvas/info are special-cased)', () => {
    renderList({
      managerMessages: [assistantMessageWithActions('fc4', [{ type: 'arrange_canvas' }], [true])],
    });
    expect(screen.getByText('Arrange canvas')).toBeInTheDocument();
  });
});

// NEVER DEGRADE IN SILENCE (real user test, 2026-07-28 — see
// useManagerActionQueue.ts's own doc comment for the full repro): every
// card action wired here now carries the owning message's id through to
// LazyManager.tsx's handlers (so the queue can key each action uniquely),
// and reads `isActionQueued` back to show an explicit waiting state instead
// of ever silently dropping a click. These tests cover the WIRING itself —
// each card component's own queued/idle rendering contract is covered in
// its own test file (MissionCharterCard.test.tsx, ArtifactProposalCard.
// test.tsx, DecisionCard.test.tsx, GraphProposalCard.test.tsx,
// RegimeStatusCard.test.tsx).
describe('LazyManagerMessageList — action queue wiring (messageId threading + isActionQueued)', () => {
  function charterMessage(id: string, overrides: Partial<MissionCharter> = {}): ManagerMessage {
    const charter: MissionCharter = {
      objective: 'Grow the audience',
      nature: { kind: 'unique' },
      decisions: [],
      validationGates: { frozenOnce: [], superviseFirstN: undefined },
      learning: { measure: 'engagement', measureSource: 'analytics', influences: 'topics', killSwitch: 'drop' },
      ...overrides,
    };
    const charterProposal: CharterProposal = { state: 'pending', charterId: `${id}-charter`, charter };
    return { id, role: 'assistant', content: 'Here is the charter.', timestamp: new Date().toISOString(), charterProposal };
  }

  function proposalMessage(id: string, planId: string): ManagerMessage {
    return {
      id,
      role: 'assistant',
      content: 'Here is a plan.',
      timestamp: new Date().toISOString(),
      proposal: { state: 'pending', planId, objective: 'Ship it', steps: [] },
    };
  }

  it('calls onValidateCharter with the owning message id as the third argument', () => {
    const onValidateCharter = vi.fn();
    renderList({ managerMessages: [charterMessage('msg-charter-1')], onValidateCharter });

    fireEvent.click(screen.getByTestId('mission-charter-validate'));

    expect(onValidateCharter).toHaveBeenCalledTimes(1);
    const [, , messageId] = onValidateCharter.mock.calls[0];
    expect(messageId).toBe('msg-charter-1');
  });

  it('calls onRejectCharter with the owning message id (not a possibly-absent business charterId)', () => {
    const onRejectCharter = vi.fn();
    renderList({ managerMessages: [charterMessage('msg-charter-2')], onRejectCharter });

    fireEvent.click(screen.getByTestId('mission-charter-reject'));

    expect(onRejectCharter).toHaveBeenCalledWith('msg-charter-2');
  });

  it('passes the real queued status down to MissionCharterCard via charterActionKey(messageId)', () => {
    // Simulates the real queue: the manager is busy, so dispatch() marks
    // this exact key as queued — `isActionQueued` reflects that on every
    // render, in the same pass as the click (React batches both updates).
    const onValidateCharter = vi.fn().mockReturnValue('queued');
    const isActionQueued = (key: string) => key === charterActionKey('msg-charter-3');
    renderList({ managerMessages: [charterMessage('msg-charter-3')], onValidateCharter, isActionQueued });

    fireEvent.click(screen.getByTestId('mission-charter-validate'));

    // Taken in charge (queued) — never a false final result, buttons hidden.
    expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Queued');
    expect(screen.queryByTestId('mission-charter-validate')).not.toBeInTheDocument();
  });

  it('calls onRetry with the owning message id, and shows a queued note when the retry is queued', () => {
    const onRetry = vi.fn();
    const msg: ManagerMessage = {
      id: 'msg-retry-1',
      role: 'assistant',
      content: 'Timed out.',
      timestamp: new Date().toISOString(),
      timedOut: true,
      retryText: 'the original long task',
    };
    const isActionQueued = (key: string) => key === retryActionKey('msg-retry-1');
    renderList({ managerMessages: [msg], onRetry, isActionQueued });

    expect(screen.getByTestId('manager-retry')).toBeDisabled();
    expect(screen.getByTestId('manager-retry-queued')).toBeInTheDocument();
  });

  it('passes proposalActionKey(planId)-based queued status down to GraphProposalCard', () => {
    const isActionQueued = (key: string) => key === proposalActionKey('plan-9');
    renderList({ managerMessages: [proposalMessage('msg-plan-1', 'plan-9')], isActionQueued });

    expect(screen.getByTestId('graph-proposal-validate')).toBeDisabled();
    expect(screen.getByTestId('graph-proposal-queued')).toBeInTheDocument();
  });

  it('passes regimeActionKey-based queued status down to RegimeStatusCard (persistent strip, not a message bubble)', () => {
    const regime: RegimeStatus = { id: 'regime-1', label: 'Daily posting', state: 'validated', trialApproved: 3, trialThreshold: 3 };
    const isActionQueued = (key: string) => key === regimeActionKey('regime-1', 'stop');
    renderList({ activeRegimes: [regime], isActionQueued });

    expect(screen.getByTestId('regime-stop-regime-1')).toBeDisabled();
    expect(screen.getByTestId('regime-queued-regime-1')).toBeInTheDocument();
  });
});

describe('LazyManagerMessageList — live streaming bubble', () => {
  it('renders a streaming caret instead of a second thinking bubble when a draft is in flight', () => {
    renderList({
      busy: true,
      phase: 'streaming',
      managerMessages: [
        { id: 'u1', role: 'user', content: 'hello', timestamp: new Date().toISOString() },
        { id: 'a1', role: 'assistant', content: 'Bonjour', timestamp: new Date().toISOString(), isStreaming: true },
      ],
    });
    expect(screen.getByTestId('manager-stream-caret')).toBeInTheDocument();
    expect(screen.queryByTestId('manager-typing-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('manager-message-assistant')).toHaveAttribute('data-streaming', 'true');
  });
});

describe('LazyManagerMessageList — unsigned free-model session card', () => {
  it('Sign in navigates to Settings (AuthScreen), not the billing popover', () => {
    const nav: unknown[] = [];
    const pop: unknown[] = [];
    const offNav = on('nav:navigateSpace', (payload) => { nav.push(payload); });
    const offPop = on('nav:openAccountPopover', () => { pop.push(true); });
    const msg: ManagerMessage = {
      id: 'msg-session',
      role: 'assistant',
      content: 'The free model needs a Lazy account.',
      timestamp: new Date().toISOString(),
      sessionBlocked: true,
    };
    renderList({ managerMessages: [msg] });
    fireEvent.click(screen.getByTestId('manager-session-signin'));
    expect(nav).toEqual([{ space: 'account', tab: 'signin' }]);
    expect(pop).toEqual([]);
    offNav();
    offPop();
  });
});
