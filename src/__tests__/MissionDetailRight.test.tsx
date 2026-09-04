/**
 * MissionDetailRight.test.tsx
 *
 * Cost/Tokens card: must read mission.agentMetrics (real, emitted by the
 * Rust agent runner) and never the legacy mock-seed-only fields
 * (totalCost / costSegments / totalTokens / tokensSaved). Shows an honest
 * "pending" state when agentMetrics is absent.
 *
 * Brain citations card: must render only when mission.brainCitations holds
 * real (non-empty) data, otherwise it must not render at all.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MissionDetailRight } from '../components/agents/MissionDetailRight';
import type { Mission } from '../lib/agents/types';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
}));

function baseMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm-1',
    title: 'Untitled mission',
    status: 'review',
    model: 'sonnet',
    ...overrides,
  };
}

describe('MissionDetailRight - Cost/Tokens card', () => {
  it('shows an honest pending state when agentMetrics is absent', () => {
    render(<MissionDetailRight mission={baseMission()} />);
    // i18n pass (2026-08): this pending state used to be hardcoded French
    // text rendered even in the English UI — now a real i18n key
    // (agents.detail.awaitingMetrics), same "identity mock echoes the raw
    // key" convention this test file's own useI18n mock above already
    // exercises for the sibling brainContext/proofsTitle assertions below.
    expect(screen.getByText('agents.detail.awaitingMetrics')).toBeInTheDocument();
  });

  it('shows the real cost/tokens numbers derived from agentMetrics', () => {
    const mission = baseMission({
      agentMetrics: { durationMs: 4500, inputTokens: 1200, outputTokens: 300, costUsd: 0.05, toolCount: 7 },
    });
    render(<MissionDetailRight mission={mission} />);
    // costUsd 0.05 -> round(0.05 * 100) = 5 credits (single digit, locale-safe)
    expect(screen.getByText('5')).toBeInTheDocument();
    // 1200 + 300 = 1500 tokens. The thousands separator produced by the
    // default-locale toLocaleString() call varies by environment (comma,
    // regular space, or NBSP) so match on digits with any non-digit
    // separator in between rather than a literal character.
    expect(screen.getByText(/^1\D?500$/)).toBeInTheDocument();
  });

  it('ignores legacy mock-seed-only fields even when present alongside real metrics', () => {
    const mission = baseMission({
      // Legacy mock-only fields - must never be read by the fixed component.
      totalCost: '$999.99',
      totalTokens: '999,999',
      costSegments: [{ label: 'fake', widthPct: 100, color: '#fff' }],
      tokensSaved: '999k saved',
      agentMetrics: { durationMs: 1000, inputTokens: 10, outputTokens: 10, costUsd: 0.01, toolCount: 1 },
    });
    render(<MissionDetailRight mission={mission} />);
    expect(screen.queryByText('$999.99')).not.toBeInTheDocument();
    expect(screen.queryByText('999,999')).not.toBeInTheDocument();
    expect(screen.queryByText('999k saved')).not.toBeInTheDocument();
    // Real metrics still render: round(0.01 * 100) = 1 credit
    expect(screen.getByText('1')).toBeInTheDocument();
  });
});

// QA B14: DiffCard needs a stable DOM id/testId — MissionDetail.tsx's
// focusSection effect (Cockpit urgent card's "Diff" action) scrolls to it
// via document.getElementById('mission-diff-card').
describe('MissionDetailRight - DiffCard id (QA B14 focus target)', () => {
  it('renders nothing (no id to find) when the mission has no diff data', () => {
    render(<MissionDetailRight mission={baseMission()} />);
    expect(screen.queryByTestId('diff-card')).not.toBeInTheDocument();
  });

  it('exposes id="mission-diff-card" when diffFiles is present', () => {
    const mission = baseMission({
      diffFiles: [{ filename: 'src/foo.ts', added: 3, removed: 1 }],
    });
    render(<MissionDetailRight mission={mission} />);
    const card = screen.getByTestId('diff-card');
    expect(card).toHaveAttribute('id', 'mission-diff-card');
  });

  it('exposes id="mission-diff-card" when only diffSnippet is present', () => {
    const mission = baseMission({ diffSnippet: ['+added line', '-removed line'] });
    render(<MissionDetailRight mission={mission} />);
    expect(screen.getByTestId('diff-card')).toHaveAttribute('id', 'mission-diff-card');
  });
});

describe('MissionDetailRight - Brain citations card', () => {
  it('renders nothing when the mission has no brainCitations', () => {
    render(<MissionDetailRight mission={baseMission()} />);
    expect(screen.queryByText('agents.detail.brainContext')).not.toBeInTheDocument();
  });

  it('renders nothing when brainCitations is an empty array', () => {
    render(<MissionDetailRight mission={baseMission({ brainCitations: [] })} />);
    expect(screen.queryByText('agents.detail.brainContext')).not.toBeInTheDocument();
  });

  it('renders the card with real citation labels when brainCitations is populated', () => {
    const mission = baseMission({
      brainCitations: [{ id: 'c1', label: 'auth.ts:42' }],
    });
    render(<MissionDetailRight mission={mission} />);
    expect(screen.getByText('agents.detail.brainContext')).toBeInTheDocument();
    expect(screen.getByText('auth.ts:42')).toBeInTheDocument();
  });
});

describe('MissionDetailRight - Proofs card', () => {
  it('renders nothing when the mission has no proofs', () => {
    render(<MissionDetailRight mission={baseMission()} />);
    expect(screen.queryByTestId('proofs-card')).not.toBeInTheDocument();
  });

  it('renders nothing when proofs is an empty array', () => {
    render(<MissionDetailRight mission={baseMission({ proofs: [] })} />);
    expect(screen.queryByTestId('proofs-card')).not.toBeInTheDocument();
  });

  // Locale independence matters here: this is the exact card the e2e QA
  // harness (_e2e-full-qa.mjs) checks for after a mission reaches review/
  // done — it used to assert on the English text "Proofs", which never
  // matches the French-locale render ("Preuves" — see i18n/locales/fr.ts's
  // 'agents.detail.proofsTitle'), producing a false "card not rendered"
  // even when mission.proofs was genuinely populated (run-7). The stable
  // data-testid is what both this test and the harness key off of instead.
  it('renders a stable data-testid, independent of the translated title, when proofs is populated', () => {
    const mission = baseMission({
      proofs: [
        { kind: 'test_run', command: 'npm test', exitCode: 0, outputPath: '/tmp/wt/test/test_run-1.txt' },
      ],
    });
    render(<MissionDetailRight mission={mission} />);
    expect(screen.getByTestId('proofs-card')).toBeInTheDocument();
    expect(screen.getByText('agents.detail.proofsTitle')).toBeInTheDocument();
    expect(screen.getByText('agents.modal.proof.test_run')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('/tmp/wt/test/test_run-1.txt')).toBeInTheDocument();
  });

  // Run-12/M14 regression: the ticket suspected the done-card badge itself
  // might be mislabeling a proof's kind (badge showing command_output while
  // the tool supposedly stored test_run). Verified false against the real
  // persisted artifact — the badge key is `agents.modal.proof.${proof.kind}`
  // (see ProofsCard in MissionDetailRight.tsx), a direct, unambiguous render
  // of the artifact's own kind with no cross-referencing against
  // contract.proofs — so it always faithfully reflects whatever kind was
  // actually stored. This locks that in with the exact real M14 shape.
  it('renders the exact badge for the real M14 command_output proof (ticket suspected a badge mismatch — verified none exists)', () => {
    const mission = baseMission({
      proofs: [
        {
          kind: 'command_output',
          command: 'type README.md',
          outputPath: String.raw`\\?\C:\...\artifacts\M14\command_output-1.txt`,
        },
      ],
    });
    render(<MissionDetailRight mission={mission} />);
    expect(screen.getByTestId('proofs-card')).toBeInTheDocument();
    expect(screen.getByText('agents.modal.proof.command_output')).toBeInTheDocument();
    expect(screen.queryByText('agents.modal.proof.test_run')).not.toBeInTheDocument();
    expect(screen.getByText('type README.md')).toBeInTheDocument();
  });

  it('renders one row per proof artifact, in order, for mixed kinds', () => {
    const mission = baseMission({
      proofs: [
        { kind: 'screenshot', path: '/tmp/proof.png', label: 'Feature working' },
        { kind: 'behavior_diff', before: 'old behavior', after: 'new behavior' },
      ],
    });
    render(<MissionDetailRight mission={mission} />);
    expect(screen.getByText('Feature working')).toBeInTheDocument();
    expect(screen.getByText('old behavior → new behavior')).toBeInTheDocument();
  });
});
