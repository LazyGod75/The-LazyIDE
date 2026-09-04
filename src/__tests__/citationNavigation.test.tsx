/* Regression test — citation chip -> nav:focusBrainNode navigation contract.
   Locks the behaviour: clicking a CitationChip inside BrainContextBanner
   must emit 'nav:focusBrainNode' with the correct nodeId via the bus.
   If this test breaks, the citation->neuron navigation is silently broken.
*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// Import the REAL bus so the component and the test share the same module.
// We do NOT mock the bus here — that is the point of this regression test.
import { on } from '../lib/bus';
import { BrainContextBanner } from '../components/assistant/BrainContextBanner';

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({ name: 'web' })),
}));

// BrainContextBanner now calls useI18n()/useToast() unconditionally (FIX 1b —
// surfaces capture-retry give-up notices). Mocked minimally here — this
// test's whole point is the bus wiring, not i18n or toasts — so it can keep
// rendering the real component without a full I18nProvider/ToastProvider tree.
vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({ t: (key: string) => key }),
}));
vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const RECALL_WITH_NODE = {
  nodes: [
    {
      id: 'auth-oauth',
      title: 'OAuth PKCE Strategy',
      snippet: 'Decision to use PKCE after bug #342.',
      score: 0.95,
      cluster: 'Auth',
    },
  ],
  tokensSaved: 4200,
  tokensInjected: 3,
  injectedContext: '1 decision',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('Citation chip -> nav:focusBrainNode (regression)', () => {
  it('emits nav:focusBrainNode with the correct nodeId when chip is clicked', () => {
    const received: string[] = [];
    const unsubscribe = on('nav:focusBrainNode', (id) => { received.push(id); });

    render(<BrainContextBanner recall={RECALL_WITH_NODE} />);

    const chip = screen.getByText(/#auth-oauth/);
    fireEvent.click(chip);

    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('auth-oauth');
  });

  it('emits nav:focusBrainNode on Enter keypress', () => {
    const received: string[] = [];
    const unsubscribe = on('nav:focusBrainNode', (id) => { received.push(id); });

    render(<BrainContextBanner recall={RECALL_WITH_NODE} />);

    const chip = screen.getByText(/#auth-oauth/);
    fireEvent.keyDown(chip, { key: 'Enter', code: 'Enter' });

    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('auth-oauth');
  });

  it('emits nav:focusBrainNode on Space keypress', () => {
    const received: string[] = [];
    const unsubscribe = on('nav:focusBrainNode', (id) => { received.push(id); });

    render(<BrainContextBanner recall={RECALL_WITH_NODE} />);

    const chip = screen.getByText(/#auth-oauth/);
    fireEvent.keyDown(chip, { key: ' ', code: 'Space' });

    unsubscribe();

    expect(received).toHaveLength(1);
    expect(received[0]).toBe('auth-oauth');
  });
});
