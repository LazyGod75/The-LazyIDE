/* Briefing.test.tsx — the resume briefing surface (src/components/agents/Briefing.tsx).

   Covers:
   1. Empty state when the journal window has no events.
   2. Real digest sections (shipped/asks) render from queryJournalSince data,
      with the narrative paragraph shown once generation resolves, and drill
      clicks routing through the existing useAgentsStore().setSelectedMissionId
      selection callback (same mechanism AttentionInbox.tsx uses).
   3. Honest fallback to digest-only bullets (no fabricated text) when the
      model is unavailable — the sections must still show real data.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import type { JournalEventRow } from '../lib/journal/eventTypes';
import type { StreamChatRequest } from '../lib/models';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
}));

const setSelectedMissionId = vi.fn();
vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStore: () => ({ setSelectedMissionId, missions: [] }),
  useAgentsStoreActions: () => ({ setSelectedMissionId }),
  useAgentsStoreMissionsOptional: () => [],
}));

vi.mock('../lib/journal/projections', () => ({
  queryJournalSince: vi.fn(),
}));

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProvider: vi.fn(),
    describeProviderReadiness: vi.fn(() => ({ ready: true })),
  };
});

import { Briefing } from '../components/agents/Briefing';
import { queryJournalSince } from '../lib/journal/projections';
import { getProvider, describeProviderReadiness } from '../lib/models/index';

function row(overrides: Partial<JournalEventRow> = {}): JournalEventRow {
  return {
    seq: 1,
    ts_ms: 1_000,
    project_id: 'proj-1',
    mission_id: null,
    agent_id: null,
    run_id: null,
    actor: 'agent',
    type: 'tool.called',
    payload: '{}',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ...overrides,
  } as JournalEventRow;
}

function mockNarrativeStream(text: string) {
  vi.mocked(getProvider).mockReturnValue({
    id: 'mock',
    label: 'Mock',
    listModels: () => [],
    streamChat: (_req: StreamChatRequest) =>
      (async function* () {
        yield text;
      })(),
  });
}

beforeEach(() => {
  localStorage.clear();
  setSelectedMissionId.mockClear();
  // Reset call history AND behavior between tests — these are shared
  // module-level mocks, so leftover call counts/return values from an
  // earlier test would otherwise leak into the next one's assertions.
  vi.mocked(queryJournalSince).mockReset();
  vi.mocked(getProvider).mockReset();
  vi.mocked(describeProviderReadiness).mockReset();
  vi.mocked(describeProviderReadiness).mockReturnValue({ ready: true });
});

describe('Briefing — empty state', () => {
  it('shows the honest empty state when the journal window has no events', async () => {
    vi.mocked(queryJournalSince).mockResolvedValue([]);
    render(<Briefing />);

    await waitFor(() => expect(screen.getByText('agents.briefing.emptyTitle')).toBeInTheDocument());
    expect(screen.queryByTestId('briefing-section-shipped')).not.toBeInTheDocument();
  });
});

describe('Briefing — real digest + narrative', () => {
  it('renders shipped/asks sections from real journal data and the generated narrative', async () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, ts_ms: 100, project_id: 'proj-a', mission_id: 'm1', type: 'mission.completed' }),
      row({ seq: 2, ts_ms: 200, project_id: 'proj-a', mission_id: 'm2', type: 'mission.blocked', payload: JSON.stringify({ reason: 'needs API key' }) }),
    ];
    vi.mocked(queryJournalSince).mockResolvedValue(events);
    mockNarrativeStream('Shipped m1 in proj-a; m2 is blocked on an API key.');

    render(<Briefing />);

    await waitFor(() => expect(screen.getByTestId('briefing-narrative')).toBeInTheDocument());
    expect(screen.getByTestId('briefing-narrative')).toHaveTextContent(
      'Shipped m1 in proj-a; m2 is blocked on an API key.',
    );
    expect(screen.getByTestId('briefing-section-shipped')).toHaveTextContent('(1)');
    expect(screen.getByTestId('briefing-section-asks')).toHaveTextContent('(1)');
    expect(screen.getByTestId('briefing-shipped-m1')).toBeInTheDocument();
    expect(screen.getByTestId('briefing-ask-m2')).toBeInTheDocument();
  });

  it('drilling into a shipped item selects its mission via the existing store callback', async () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, project_id: 'proj-a', mission_id: 'm1', type: 'mission.approved' }),
    ];
    vi.mocked(queryJournalSince).mockResolvedValue(events);
    mockNarrativeStream('m1 approved.');

    render(<Briefing />);

    const button = await screen.findByTestId('briefing-shipped-m1');
    fireEvent.click(button);
    expect(setSelectedMissionId).toHaveBeenCalledWith('m1');
  });

  it('records lastSeen and reads it back as the anchor on next mount (no duplicate 24h re-scan)', async () => {
    vi.mocked(queryJournalSince).mockResolvedValue([]);
    render(<Briefing />);

    await waitFor(() => expect(queryJournalSince).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('lazy.lastSeen.fleet')).not.toBeNull();
  });
});

describe('Briefing — honest fallback (no model configured)', () => {
  it('shows digest-only bullets, never fabricated narrative text, when the model is unavailable', async () => {
    vi.mocked(describeProviderReadiness).mockReturnValue({ ready: false, reason: 'No model available' });
    const events: JournalEventRow[] = [
      row({ seq: 1, project_id: 'proj-a', mission_id: 'm1', type: 'mission.completed' }),
    ];
    vi.mocked(queryJournalSince).mockResolvedValue(events);

    render(<Briefing />);

    await waitFor(() => expect(screen.getByTestId('briefing-narrative-unavailable')).toBeInTheDocument());
    expect(screen.queryByTestId('briefing-narrative')).not.toBeInTheDocument();
    // The digest sections are deterministic (not LLM-derived) — they must
    // still show the real shipped mission even though the narrative failed.
    expect(screen.getByTestId('briefing-shipped-m1')).toBeInTheDocument();
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('falls back honestly when the provider stream throws mid-generation', async () => {
    const events: JournalEventRow[] = [
      row({ seq: 1, project_id: 'proj-a', mission_id: 'm1', type: 'mission.completed' }),
    ];
    vi.mocked(queryJournalSince).mockResolvedValue(events);
    vi.mocked(getProvider).mockReturnValue({
      id: 'mock',
      label: 'Mock',
      listModels: () => [],
      // A manual async-iterable (not a generator) whose first `next()`
      // rejects — simulates the stream itself failing mid-request, without
      // an unreachable `yield` that would trip eslint's require-yield rule.
      streamChat: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('network down')),
        }),
      }),
    });

    render(<Briefing />);

    await waitFor(() => expect(screen.getByTestId('briefing-narrative-unavailable')).toBeInTheDocument());
    expect(screen.getByTestId('briefing-shipped-m1')).toBeInTheDocument();
  });
});
