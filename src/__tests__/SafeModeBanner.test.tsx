/**
 * SafeModeBanner — honesty fix (real user report, 2026-08-01 QA): the
 * banner told the user to "libérez de l'espace disque ou de la mémoire"
 * while the machine had 46 GB free — a diagnosis the app never actually
 * measured. The message now reports only the MEASURED fact (a real
 * consecutive-crash count from the backend) and never asserts an unverified
 * disk/memory cause.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { SafeModeBanner } from '../components/SafeModeBanner';

function renderBanner(consecutiveCrashes: number) {
  return render(
    <I18nProvider>
      <SafeModeBanner onRestart={vi.fn()} onDismiss={vi.fn()} consecutiveCrashes={consecutiveCrashes} />
    </I18nProvider>,
  );
}

describe('SafeModeBanner — honest crash-count wording, no unverified disk/memory diagnosis', () => {
  it('reports the REAL measured crash count, not a vague "several times"', () => {
    renderBanner(4);
    expect(screen.getByRole('alert')).toHaveTextContent('4');
  });

  it('never asserts disk/memory as THE cause — phrases it as a conditional check, not a diagnosis', () => {
    renderBanner(3);
    const text = screen.getByRole('alert').textContent ?? '';
    // The old wording flatly said "Fix: free up disk space / memory" as if
    // that were the established cause. The new wording must not assert
    // "the cause is disk/memory" — it may still MENTION disk/memory as
    // something to check, but only conditionally ("if this keeps
    // happening..."), never as a stated fact the app never measured.
    expect(text.toLowerCase()).not.toMatch(/fix:\s*free up/);
    expect(text).toContain('If this keeps happening');
  });

  it('a different consecutive count renders that exact number, not a hardcoded placeholder', () => {
    renderBanner(9);
    expect(screen.getByRole('alert')).toHaveTextContent('9');
  });
});
