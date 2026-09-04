/**
 * SystemPressureBadge.test.tsx — founder north star: "the app adapts the
 * pace automatically, and it TELLS you". Covers every render state of the
 * pill (src/components/agents/cockpit/SystemPressureBadge.tsx): hidden at
 * 'normal', visible at 'elevated'/'high', tooltip content with and without
 * real RAM/CPU numbers, and live updates via subscribeSystemPressure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { SystemPressureBadge } from '../components/agents/cockpit/SystemPressureBadge';
import { setSystemPressureForTests, resetSystemPressureForTests } from '../lib/agents/systemPressure';

function renderBadge() {
  return render(
    <I18nProvider>
      <SystemPressureBadge />
    </I18nProvider>,
  );
}

beforeEach(() => {
  resetSystemPressureForTests();
  localStorage.setItem('lazy.locale', 'fr');
});

afterEach(() => {
  resetSystemPressureForTests();
});

describe('SystemPressureBadge', () => {
  it('renders nothing while pressure is normal', () => {
    renderBadge();
    expect(screen.queryByTestId('system-pressure-badge')).not.toBeInTheDocument();
  });

  it('renders the pill at "elevated" pressure', () => {
    setSystemPressureForTests({ level: 'elevated' });
    renderBadge();

    const badge = screen.getByTestId('system-pressure-badge');
    expect(badge).toHaveAttribute('data-pressure-level', 'elevated');
    expect(badge).toHaveTextContent(/adapte le rythme/i);
  });

  it('renders the pill at "high" pressure', () => {
    setSystemPressureForTests({ level: 'high' });
    renderBadge();

    expect(screen.getByTestId('system-pressure-badge')).toHaveAttribute('data-pressure-level', 'high');
  });

  it('includes real RAM/CPU numbers in the tooltip when the backend supplied them', () => {
    setSystemPressureForTests({ level: 'high', availableMemoryMb: 512, cpuPercent: 97 });
    renderBadge();

    const badge = screen.getByTestId('system-pressure-badge');
    expect(badge.getAttribute('title')).toContain('512');
    expect(badge.getAttribute('title')).toContain('97');
  });

  it('falls back to a generic tooltip when no RAM/CPU numbers were supplied', () => {
    setSystemPressureForTests({ level: 'high' });
    renderBadge();

    const badge = screen.getByTestId('system-pressure-badge');
    expect(badge.getAttribute('title')).toBeTruthy();
    expect(badge.getAttribute('title')).not.toContain('undefined');
  });

  it('disappears again once pressure returns to normal (live update, no remount)', () => {
    setSystemPressureForTests({ level: 'high' });
    renderBadge();
    expect(screen.getByTestId('system-pressure-badge')).toBeInTheDocument();

    act(() => {
      setSystemPressureForTests({ level: 'normal' });
    });

    expect(screen.queryByTestId('system-pressure-badge')).not.toBeInTheDocument();
  });

  it('appears live once pressure trips, with no remount required', () => {
    renderBadge();
    expect(screen.queryByTestId('system-pressure-badge')).not.toBeInTheDocument();

    act(() => {
      setSystemPressureForTests({ level: 'elevated' });
    });

    expect(screen.getByTestId('system-pressure-badge')).toBeInTheDocument();
  });
});
