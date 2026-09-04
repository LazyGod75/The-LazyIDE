import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BrainWiki } from '../components/brain/BrainWiki';
import type { AdaptedNode } from '../lib/brain/brainAdapter';
import type { WikiPayload } from '../lib/mock/brain';

// Mock the event bus so the contradiction link's emit() does not touch Tauri.
vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

// Passthrough i18n: returns the key, interpolating params so we can assert the
// linked note id shows up in the "contradicts" line.
vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

import { emit } from '../lib/bus';

const mockEmit = emit as ReturnType<typeof vi.fn>;

const NODE: AdaptedNode = {
  id: '2026-07-04-decision-db-sqlite',
  name: 'Decision: switch to SQLite',
  type: 'decision',
  cluster: 'brain',
  val: 6,
  dateIdx: 7,
};

function payload(overrides: Partial<WikiPayload> = {}): WikiPayload {
  return {
    title: 'Decision: switch to SQLite',
    type: 'decision',
    status: 'active',
    meta: 'backend · 2026-07-04',
    tags: ['#database'],
    body: 'We now use SQLite.',
    links: [],
    files: [],
    validity: 'active',
    cluster: 'brain' as WikiPayload['cluster'],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('BrainWiki — contradiction badge', () => {
  it('renders a contradiction warning and a link per conflicting note', () => {
    render(
      <BrainWiki
        node={NODE}
        wikiPayload={payload({ conflictWith: ['2026-07-04-decision-db-postgres'] })}
      />,
    );

    // Warning heading (i18n key surfaced by the passthrough mock).
    expect(screen.getByText('brain.contradiction')).toBeTruthy();
    // The conflicting note id is rendered in the link line (prefixed with #).
    expect(
      screen.getByText('brain.contradictionWith:#2026-07-04-decision-db-postgres'),
    ).toBeTruthy();
  });

  it('navigates to the conflicting note when the link is clicked', () => {
    render(
      <BrainWiki
        node={NODE}
        wikiPayload={payload({ conflictWith: ['2026-07-04-decision-db-postgres'] })}
      />,
    );

    fireEvent.click(
      screen.getByText('brain.contradictionWith:#2026-07-04-decision-db-postgres'),
    );
    expect(mockEmit).toHaveBeenCalledWith(
      'nav:focusBrainNode',
      '2026-07-04-decision-db-postgres',
    );
  });

  it('renders no contradiction warning when conflictWith is empty', () => {
    render(<BrainWiki node={NODE} wikiPayload={payload({ conflictWith: [] })} />);
    expect(screen.queryByText('brain.contradiction')).toBeNull();
  });

  it('renders no contradiction warning when conflictWith is absent', () => {
    render(<BrainWiki node={NODE} wikiPayload={payload()} />);
    expect(screen.queryByText('brain.contradiction')).toBeNull();
  });
});

describe('BrainWiki — NoteMeta author / date', () => {
  it('shows author and date chips when the payload carries them', () => {
    render(
      <BrainWiki
        node={NODE}
        wikiPayload={payload({ author: 'Maya Chen', when: '2026-07-04' })}
      />,
    );
    expect(screen.getByTestId('note-meta-author').textContent).toContain('Maya Chen');
    expect(screen.getByTestId('note-meta-when').textContent).toBe('2026-07-04');
    expect(screen.getByTestId('note-kind-pill').textContent).toBe('decision');
  });

  it('omits the author chip when no author is known', () => {
    render(<BrainWiki node={NODE} wikiPayload={payload()} />);
    expect(screen.queryByTestId('note-meta-author')).toBeNull();
  });
});
