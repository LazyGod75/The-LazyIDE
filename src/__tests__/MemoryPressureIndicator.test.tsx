/**
 * MemoryPressureIndicator.test.tsx — covers the 2026-08 false-alarm fix: the
 * pill (src/components/MemoryPressureIndicator.tsx) must only claim "low
 * memory" when RAM itself is confirmed High (`snapshot.ramLevel`), never
 * when the overall 'high' level came from a pure CPU spike on an unrelated
 * process. See that component's own header comment for the full rationale.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { MemoryPressureIndicator } from '../components/MemoryPressureIndicator';
import { setSystemPressureForTests, resetSystemPressureForTests } from '../lib/agents/systemPressure';

function renderIndicator() {
  return render(
    <I18nProvider>
      <MemoryPressureIndicator />
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

describe('MemoryPressureIndicator', () => {
  it('renders nothing while pressure is normal', () => {
    renderIndicator();
    expect(screen.queryByTestId('memory-pressure-indicator')).not.toBeInTheDocument();
  });

  it('renders nothing at "elevated" pressure (only "high" shows this pill)', () => {
    setSystemPressureForTests({ level: 'elevated', ramLevel: 'elevated' });
    renderIndicator();
    expect(screen.queryByTestId('memory-pressure-indicator')).not.toBeInTheDocument();
  });

  it('shows the low-memory copy when RAM itself is confirmed High', () => {
    setSystemPressureForTests({ level: 'high', ramLevel: 'high', availableMemoryMb: 900 });
    renderIndicator();

    const pill = screen.getByTestId('memory-pressure-indicator');
    expect(pill).toHaveTextContent(/mémoire/i);
  });

  it('shows a CPU-specific copy, never the low-memory copy, for a pure CPU spike', () => {
    // level is 'high' (CPU alone crossed its threshold) but RAM is fine
    // (ramLevel stays 'normal') — the exact false-alarm scenario the audit
    // traced: a spike on an unrelated process must not blame memory.
    setSystemPressureForTests({ level: 'high', ramLevel: 'normal', cpuPercent: 92 });
    renderIndicator();

    const pill = screen.getByTestId('memory-pressure-indicator');
    expect(pill).not.toHaveTextContent(/mémoire/i);
    expect(pill).toHaveTextContent(/cpu/i);
  });

  it('treats an unconfirmed ramLevel (older/malformed backend) as "not low memory", not as "memory is fine"', () => {
    // ramLevel omitted entirely — must degrade to the CPU/generic copy, the
    // same "never worse than today" contract systemPressure.ts documents,
    // rather than guessing either way.
    setSystemPressureForTests({ level: 'high' });
    renderIndicator();

    const pill = screen.getByTestId('memory-pressure-indicator');
    expect(pill).not.toHaveTextContent(/mémoire/i);
  });

  it('disappears once pressure returns below "high" (live update, no remount)', () => {
    setSystemPressureForTests({ level: 'high', ramLevel: 'high' });
    renderIndicator();
    expect(screen.getByTestId('memory-pressure-indicator')).toBeInTheDocument();

    act(() => {
      setSystemPressureForTests({ level: 'elevated', ramLevel: 'elevated' });
    });

    expect(screen.queryByTestId('memory-pressure-indicator')).not.toBeInTheDocument();
  });

  it('switches copy live if the cause changes from CPU to RAM without unmounting', () => {
    setSystemPressureForTests({ level: 'high', ramLevel: 'normal', cpuPercent: 92 });
    renderIndicator();
    expect(screen.getByTestId('memory-pressure-indicator')).toHaveTextContent(/cpu/i);

    act(() => {
      setSystemPressureForTests({ level: 'high', ramLevel: 'high', availableMemoryMb: 800 });
    });

    expect(screen.getByTestId('memory-pressure-indicator')).toHaveTextContent(/mémoire/i);
  });
});
