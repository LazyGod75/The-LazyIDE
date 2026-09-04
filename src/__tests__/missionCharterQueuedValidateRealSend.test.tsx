/**
 * missionCharterQueuedValidateRealSend.test.tsx — real audit finding
 * (2026-07-28): "l'audit a observe un cas ou la carte est passee a acceptee
 * sans qu'aucun message utilisateur n'apparaisse" — a mission-charter card
 * flipped to "Accepted" while the conversation itself never grew by the
 * Validate message.
 *
 * useManagerActionQueue.test.ts and MissionCharterCard.test.tsx already
 * cover this at the hook/component level (mocked `run`/`onValidate`). This
 * file closes the gap between those unit tests and the real app: it drives
 * the REAL component tree (AgentsStoreProvider + LazyManager, same harness
 * as LazyManager.test.tsx) end to end and asserts on the actual number of
 * rendered user-message bubbles (`manager-message-user`, LazyManagerMessageList.
 * tsx) — the observable, real signal a founder would see — rather than
 * trusting the card's own "Accepted" label.
 *
 * Sequence reproduced: manager busy (mid-turn on an unrelated message) at
 * the exact moment "Valider" is clicked on an already-rendered charter card
 * -> the click is queued -> the busy turn resolves -> the queued Validate
 * message is REALLY sent (a new runManagerTurn call fires) -> only THEN
 * does the card settle on "Accepted", in lockstep with a real new user
 * bubble actually appearing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
// The REAL orchestrator LazyManager (queue/MissionCharterCard-wired) — same
// component the shipped app actually mounts (CodeSpace.tsx / ManagerOverlay.
// tsx both import from here). NOT components/agents/LazyManager.tsx, a
// separate, older plain-bubble component with no charter/queue wiring at
// all that some pre-existing tests (LazyManager.test.tsx) exercise instead —
// see this file's own report note on that mismatch.
import { LazyManager } from '../components/lazyManager/LazyManager';
import { LazyManagerStoreProvider } from '../components/lazyManager/lazyManagerStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import type { ManagerTurnResult } from '../lib/agents/managerEngine';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', () => ({
  runMission: vi.fn().mockResolvedValue(undefined),
  mergeWorktree: vi.fn().mockResolvedValue(undefined),
  discardWorktree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

const mockRunManagerTurn = vi.mocked(runManagerTurn);

function Harness() {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>
          <LazyManagerStoreProvider>
            <LazyManager />
          </LazyManagerStoreProvider>
        </AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

function sendComposerMessage(text: string) {
  const input = screen.getByTestId('manager-input');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByTestId('manager-send'));
}

function userBubbleCount(): number {
  return screen.queryAllByTestId('manager-message-user').length;
}

/** A promise the test can resolve on demand, standing in for a manager
 *  turn that's still in flight (busy) at the moment the user clicks Validate. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => {
  mockRunManagerTurn.mockReset();
});

describe('mission charter Validate clicked while busy: real send, not just a card label', () => {
  it('never shows Accepted before a real new user message lands — and shows it the instant one does', async () => {
    // Turn 1: proposes a charter with no decisions (keeps this test focused
    // on the queue/send mechanics, not the decision-answering flow).
    mockRunManagerTurn.mockResolvedValue({
      responseText: 'Bien recu.',
      actions: [],
      rawResponse: '',
    } as ManagerTurnResult);
    mockRunManagerTurn.mockResolvedValueOnce({
      responseText: 'Voici la charte.',
      actions: [
        {
          type: 'propose_mission_charter',
          objective: 'Grow the audience on a social surface',
          nature: { kind: 'recurring', cadence: '1d' },
          decisions: [],
          validationGates: { frozenOnce: [], superviseFirstN: undefined },
          learning: {
            measure: 'engagement rate',
            measureSource: 'external analytics',
            influences: 'timing',
            killSwitch: '3 failures',
          },
        },
      ],
      rawResponse: '',
    } as ManagerTurnResult);

    render(<Harness />);

    sendComposerMessage('lance ma mission carrousel');
    await waitFor(() => expect(screen.getByTestId('mission-charter-card')).toBeInTheDocument());
    expect(userBubbleCount()).toBe(1);

    // Turn 2: an unrelated second message the test keeps in flight on
    // purpose, so the manager is genuinely busy at the exact moment the
    // charter card's Validate button gets clicked below.
    const turn2 = deferred<ManagerTurnResult>();
    mockRunManagerTurn.mockReturnValueOnce(turn2.promise);

    sendComposerMessage('autre chose en parallele');
    await waitFor(() => expect(screen.getByTestId('manager-stop')).toBeInTheDocument()); // busy indicator
    expect(userBubbleCount()).toBe(2);

    // Turn 3: what the QUEUED Validate click will trigger once it actually
    // flushes and reaches the manager.
    mockRunManagerTurn.mockResolvedValueOnce({
      responseText: 'Bien recu.',
      actions: [],
      rawResponse: '',
    } as ManagerTurnResult);

    // Click Validate WHILE busy — must be queued, never dropped, and must
    // NOT claim a real message was sent yet.
    fireEvent.click(screen.getByTestId('mission-charter-validate'));
    expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Queued');
    expect(screen.getByTestId('mission-charter-state')).not.toHaveTextContent('Accepted');
    // The real, observable signal: still exactly 2 user bubbles — the
    // queued click has produced NO third message yet.
    expect(userBubbleCount()).toBe(2);

    // The busy turn now resolves — this is what lets the queue flush.
    turn2.resolve({ responseText: 'ok', actions: [], rawResponse: '' } as ManagerTurnResult);

    // Only once a REAL third user bubble appears does the card settle on
    // Accepted — never the other way around.
    await waitFor(() => expect(userBubbleCount()).toBe(3));
    await waitFor(() => expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Accepted'));
  });
});
