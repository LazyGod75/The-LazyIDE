import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { I18nProvider } from '../i18n';
import { BudgetBurn } from '../components/agents/orchestrator/BudgetBurn';

function wrap(ui: ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe('BudgetBurn', () => {
  it('uses design-system tokens instead of leftover Tailwind greens', () => {
    wrap(<BudgetBurn spentCents={50} limitCents={100} />);
    const fill = screen.getByTestId('budget-burn-fill');
    expect(fill.className).not.toMatch(/bg-green-500/);
    expect(fill.style.background).toContain('--color-success');
    expect(screen.getByTestId('budget-burn-label').textContent).toBeTruthy();
  });

  it('turns warning then danger from real spend ratio', () => {
    const { rerender } = wrap(<BudgetBurn spentCents={90} limitCents={100} />);
    expect(screen.getByTestId('budget-burn-fill').style.background).toContain('--color-warning');
    rerender(
      <I18nProvider>
        <BudgetBurn spentCents={100} limitCents={100} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('budget-burn-fill').style.background).toContain('--color-danger');
  });
});
