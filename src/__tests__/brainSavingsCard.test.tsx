/* brainSavingsCard.test.tsx — src/components/agents/report/BrainSavingsCard.tsx's
   rendering: hidden with no real brain activity (honest zero-state), shown
   with real counts, honest dash on a tile with no activity while its
   sibling has real data. */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { BrainSavingsCard } from '../components/agents/report/BrainSavingsCard';
import type { BrainSavingsSummary } from '../lib/journal/brainSavings';

function renderCard(summary: BrainSavingsSummary | null) {
  return render(
    <I18nProvider>
      <BrainSavingsCard summary={summary} />
    </I18nProvider>,
  );
}

describe('BrainSavingsCard', () => {
  it('renders nothing while summary is still loading (null)', () => {
    renderCard(null);
    expect(screen.queryByTestId('brain-savings-card')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no real brain activity (honest zero-state, never a fabricated card)', () => {
    renderCard({ recallCount: 0, cacheReadTokens: 0, hasActivity: false });
    expect(screen.queryByTestId('brain-savings-card')).not.toBeInTheDocument();
  });

  it('shows the real recall count and cache tokens when both are present', () => {
    renderCard({ recallCount: 4, cacheReadTokens: 12500, hasActivity: true });
    expect(screen.getByTestId('brain-savings-card')).toBeInTheDocument();
    expect(screen.getByTestId('brain-savings-recalls')).toHaveTextContent('4');
    // Regex (any non-digit as the thousands separator) rather than a
    // hardcoded 'en-US'-style comma — the test environment's default locale
    // may format toLocaleString()'s grouping separator differently (e.g. a
    // narrow no-break space under a French locale).
    expect(screen.getByTestId('brain-savings-cache')).toHaveTextContent(/12\D?500/);
  });

  it('shows an honest dash on the tile with no activity while its sibling has real data', () => {
    renderCard({ recallCount: 0, cacheReadTokens: 8000, hasActivity: true });
    expect(screen.getByTestId('brain-savings-card')).toBeInTheDocument();
    expect(screen.getByTestId('brain-savings-recalls')).toHaveTextContent('—');
    expect(screen.getByTestId('brain-savings-cache')).toHaveTextContent(/8\D?000/);
  });
});
