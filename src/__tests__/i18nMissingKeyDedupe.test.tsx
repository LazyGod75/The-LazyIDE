/**
 * i18nMissingKeyDedupe.test.tsx
 *
 * Regression test: t()'s missing-key console.error (src/i18n/index.tsx)
 * used to fire unconditionally on every call, with no dedupe/throttle/rate
 * limit. A component that re-renders on a timer with the same missing key
 * (e.g. FluxFooter's 8s poll — see the sibling FluxFooter memoisation fix)
 * spammed one console.error line per render, forever.
 *
 * Fixed by mirroring crashReporter.ts's dedupe-window pattern (see that
 * file's header): each distinct "locale:key" signature logs at most once
 * per MISSING_KEY_DEDUPE_WINDOW_MS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { shouldLogMissingKey, resetMissingKeyDedupeForTests, I18nProvider, useI18n } from '../i18n';

// ── Pure decision logic ─────────────────────────────────────────────

describe('shouldLogMissingKey', () => {
  it('accepts the first occurrence of a signature', () => {
    expect(shouldLogMissingKey('en:foo.bar', 1000, new Map())).toBe(true);
  });

  it('rejects a repeat of the same signature within the dedupe window', () => {
    const recent = new Map([['en:foo.bar', 1000]]);
    expect(shouldLogMissingKey('en:foo.bar', 1000 + 5_000, recent)).toBe(false);
  });

  it('accepts the same signature again once the dedupe window has elapsed', () => {
    const recent = new Map([['en:foo.bar', 1000]]);
    expect(shouldLogMissingKey('en:foo.bar', 1000 + 30_000, recent)).toBe(true);
  });

  it('treats different signatures independently', () => {
    const recent = new Map([['en:foo.bar', 1000]]);
    expect(shouldLogMissingKey('fr:foo.bar', 1000 + 1, recent)).toBe(true);
    expect(shouldLogMissingKey('en:other.key', 1000 + 1, recent)).toBe(true);
  });
});

// ── Integration: t() dedupes real console.error calls ───────────────

function MissingKeyProbe({ missingKey, renderCount }: { missingKey: string; renderCount: number }) {
  const { t } = useI18n();
  for (let i = 0; i < renderCount; i++) t(missingKey);
  return <span data-testid="probe">ok</span>;
}

describe('t() missing-key logging — deduped', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetMissingKeyDedupeForTests();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs a genuinely missing key exactly once across many calls in the same render', () => {
    render(
      <I18nProvider>
        <MissingKeyProbe missingKey="this.key.does.not.exist" renderCount={20} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('ok');

    const missingKeyLogs = errorSpy.mock.calls.filter(([msg]) =>
      typeof msg === 'string' && msg.includes('this.key.does.not.exist'),
    );
    expect(missingKeyLogs).toHaveLength(1);
  });

  it('does not log anything for a key that actually resolves', () => {
    render(
      <I18nProvider>
        <MissingKeyProbe missingKey="common.loading" renderCount={5} />
      </I18nProvider>,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
