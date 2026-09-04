/* EmptyStateProposals.test.tsx — cockpit empty-state proposal cards (T2.6).

   Covers:
   1. Loading state while generateProposals() is pending.
   2. Ready state: renders real proposals returned by generateProposals()
      (title/description/quote all driven by the proposal's own data, not a
      hardcoded list) and launches with the proposal's real taskText on click.
   3. Honest empty state when generateProposals() resolves to [] — asserts
      the OLD static proposal cards never render.
   4. Never crashes (falls back to the same honest empty state) if
      generateProposals() ever rejects, even though it is documented to
      never throw — belt and suspenders on the UI side.
*/

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EmptyStateProposals } from '../components/agents/EmptyStateProposals';
import { I18nProvider } from '../i18n';
import { fr } from '../i18n/locales/fr';
import { generateProposals } from '../lib/agents/proposals';
import type { MissionProposal } from '../lib/agents/proposals';

vi.mock('../app/AppContext', () => ({
  useAppContext: () => ({ projectRoot: '/proj' }),
}));

vi.mock('../lib/agents/proposals', () => ({
  generateProposals: vi.fn(),
}));

const mockGenerateProposals = vi.mocked(generateProposals);

function interpolate(template: string, params: Record<string, string | number>): string {
  let out = template;
  for (const [k, v] of Object.entries(params)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return out;
}

function renderComponent(onLaunch = vi.fn()) {
  render(
    <I18nProvider>
      <EmptyStateProposals onLaunch={onLaunch} />
    </I18nProvider>,
  );
  return onLaunch;
}

function makeProposal(overrides: Partial<MissionProposal> = {}): MissionProposal {
  return {
    id: 'todoFixme',
    source: 'todoFixme',
    icon: '🔍',
    accent: '#7C5CFF',
    titleKey: 'agents.proposals.todoFixme.title',
    titleParams: { count: 3 },
    descKey: 'agents.proposals.todoFixme.desc',
    descParams: { files: 'a.ts, b.ts' },
    taskText: 'Resolve the following TODO/FIXME markers found while scanning...\n- /proj/src/a.ts:2 — TODO fix',
    quote: { costUsd: [0.4, 1.1], durationMin: [5, 15], agents: 1 },
    sizeClass: 'xs',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
});

describe('EmptyStateProposals — loading', () => {
  it('shows a loading state while generateProposals() is pending, then clears it', async () => {
    let resolvePending!: (v: MissionProposal[]) => void;
    mockGenerateProposals.mockReturnValue(
      new Promise((resolve) => {
        resolvePending = resolve;
      }),
    );

    renderComponent();
    expect(screen.getByText(fr['agents.proposals.loading'])).toBeInTheDocument();

    resolvePending([]);
    await waitFor(() =>
      expect(screen.queryByText(fr['agents.proposals.loading'])).not.toBeInTheDocument(),
    );
  });

  it('calls generateProposals with the current project root', async () => {
    mockGenerateProposals.mockResolvedValue([]);
    renderComponent();
    await waitFor(() => expect(mockGenerateProposals).toHaveBeenCalledWith('/proj'));
  });
});

describe('EmptyStateProposals — real proposals', () => {
  it('renders a real proposal card (title, description, quote) and launches with its real taskText on click', async () => {
    const proposal = makeProposal();
    mockGenerateProposals.mockResolvedValue([proposal]);
    const onLaunch = renderComponent();

    await waitFor(() => expect(screen.getByTestId('proposal-todoFixme')).toBeInTheDocument());

    expect(
      screen.getByText(interpolate(fr['agents.proposals.todoFixme.title'], proposal.titleParams)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(interpolate(fr['agents.proposals.todoFixme.desc'], proposal.descParams)),
    ).toBeInTheDocument();
    expect(screen.getByTestId('proposal-quote')).toHaveTextContent(
      interpolate(fr['agents.proposals.quoteLine'], {
        costLo: '0.40',
        costHi: '1.10',
        durLo: '5',
        durHi: '15',
      }),
    );

    fireEvent.click(screen.getByTestId('proposal-todoFixme'));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith(proposal.taskText);
  });

  it('renders every proposal generateProposals() returns, side by side', async () => {
    const todo = makeProposal();
    const missingTests = makeProposal({
      id: 'missingTests',
      source: 'missingTests',
      titleKey: 'agents.proposals.missingTests.title',
      titleParams: { count: 2 },
      descKey: 'agents.proposals.missingTests.desc',
      descParams: { files: 'b.ts, c.ts' },
      taskText: 'Add unit tests for the following source file(s)...\n- /proj/src/b.ts',
      sizeClass: 's',
    });
    mockGenerateProposals.mockResolvedValue([todo, missingTests]);
    renderComponent();

    await waitFor(() => expect(screen.getByTestId('proposal-todoFixme')).toBeInTheDocument());
    expect(screen.getByTestId('proposal-missingTests')).toBeInTheDocument();
  });
});

describe('EmptyStateProposals — honest empty state', () => {
  it('renders the honest empty state when generateProposals() finds nothing — never the old static cards', async () => {
    mockGenerateProposals.mockResolvedValue([]);
    renderComponent();

    await waitFor(() =>
      expect(screen.getByText(fr['agents.proposals.emptyTitle'])).toBeInTheDocument(),
    );
    expect(screen.getByText(fr['agents.proposals.emptySubtitle'])).toBeInTheDocument();
    expect(screen.queryByTestId('proposal-todoFixme')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proposal-missingTests')).not.toBeInTheDocument();
    // Old hardcoded copy must never appear again.
    expect(screen.queryByText('Code Review')).not.toBeInTheDocument();
    expect(screen.queryByText(fr['agents.proposals.title'])).not.toBeInTheDocument();
  });

  it('falls back to the honest empty state if generateProposals() ever rejects', async () => {
    mockGenerateProposals.mockRejectedValue(new Error('boom'));
    renderComponent();

    await waitFor(() =>
      expect(screen.getByText(fr['agents.proposals.emptyTitle'])).toBeInTheDocument(),
    );
  });
});
