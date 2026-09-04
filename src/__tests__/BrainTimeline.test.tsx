import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { BrainTimeline } from '../components/brain/BrainTimeline';
import type { AdaptedNode } from '../lib/brain/brainAdapter';

// Passthrough t() — mirrors the convention already used by
// BrainContextBanner.test.tsx for components that call useI18n()
// unconditionally, without needing a real I18nProvider ancestor.
vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string) => key,
  }),
}));

const LAST_SEEN_KEY = 'lazy:brain-last-seen:solo';

function makeNode(id: string, name: string, created: string): AdaptedNode {
  return {
    id,
    name,
    type: 'concept',
    cluster: 'editor',
    val: 1,
    dateIdx: 0,
    created,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('BrainTimeline — first-launch honesty (no recorded visit)', () => {
  it('renders nothing on a profile that has never visited this brain, even with thousands of pre-existing notes', () => {
    // Regression guard: lastSeenAt used to default to 0 (Unix epoch) when
    // nothing was stored, so every note ever created compared as "newer
    // than last visit" — a brand-new user saw "6702 new items". A missing
    // lastSeenAt now means "never visited", not "visited at the epoch".
    const nodes = Array.from({ length: 6702 }, (_, i) =>
      makeNode(`n${i}`, `Neuron ${i}`, '2020-01-01T00:00:00.000Z'),
    );
    expect(localStorage.getItem(LAST_SEEN_KEY)).toBeNull();

    const { container } = render(<BrainTimeline nodes={nodes} />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(/brain\.timeline\.newSince/)).toBeNull();
    expect(screen.queryByText(/6702/)).toBeNull();
  });

  it('records a visit timestamp on first mount, so a later visit can compute a real delta', () => {
    const nodes = [makeNode('n1', 'Neuron 1', '2020-01-01T00:00:00.000Z')];
    render(<BrainTimeline nodes={nodes} />);

    const stored = localStorage.getItem(LAST_SEEN_KEY);
    expect(stored).not.toBeNull();
    expect(Number(stored)).toBeGreaterThan(0);
  });
});

describe('BrainTimeline — real delta once a visit has been recorded', () => {
  it('shows only notes created after the recorded lastSeenAt, not the whole brain', () => {
    const lastSeenAt = Date.parse('2026-08-01T00:00:00.000Z');
    localStorage.setItem(LAST_SEEN_KEY, String(lastSeenAt));

    const nodes = [
      makeNode('old-1', 'Ancient neuron', '2020-01-01T00:00:00.000Z'),
      makeNode('old-2', 'Recent-ish neuron', '2026-07-31T00:00:00.000Z'),
      makeNode('new-1', 'Fresh neuron A', '2026-08-05T00:00:00.000Z'),
      makeNode('new-2', 'Fresh neuron B', '2026-08-10T00:00:00.000Z'),
    ];

    render(<BrainTimeline nodes={nodes} />);

    expect(screen.getByText(/^2 /)).toBeInTheDocument();
    expect(screen.getByText('Fresh neuron A')).toBeInTheDocument();
    expect(screen.getByText('Fresh neuron B')).toBeInTheDocument();
    expect(screen.queryByText('Ancient neuron')).toBeNull();
    expect(screen.queryByText('Recent-ish neuron')).toBeNull();
  });

  it('does not claim anything new when nothing changed since lastSeenAt', () => {
    const lastSeenAt = Date.now();
    localStorage.setItem(LAST_SEEN_KEY, String(lastSeenAt));

    const nodes = [makeNode('n1', 'Neuron 1', '2020-01-01T00:00:00.000Z')];
    const { container } = render(<BrainTimeline nodes={nodes} />);

    expect(container.firstChild).toBeNull();
  });
});

describe('BrainTimeline — capped phrasing for very large deltas', () => {
  it('caps the displayed headline count at "500+" instead of the exact large number, after a long absence', () => {
    localStorage.setItem(LAST_SEEN_KEY, String(Date.parse('2020-01-01T00:00:00.000Z')));

    const nodes = Array.from({ length: 800 }, (_, i) =>
      makeNode(`n${i}`, `Neuron ${i}`, '2026-08-01T00:00:00.000Z'),
    );

    render(<BrainTimeline nodes={nodes} />);

    expect(screen.getByText(/^500\+ /)).toBeInTheDocument();
    expect(screen.queryByText(/^800 /)).toBeNull();
  });
});
