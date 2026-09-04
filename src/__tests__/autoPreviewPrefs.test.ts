/**
 * autoPreviewPrefs.test.ts — preview lifecycle fix: the auto-preview
 * dismissal blacklist is now TTL-scoped rather than a permanent one-way
 * blacklist (see the module's own header for the "closing one dead card
 * silenced this project forever" bug this replaces).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isAutoPreviewDismissed, dismissAutoPreview } from '../components/agents/canvas/hooks/autoPreviewPrefs';

const STORAGE_KEY = 'lazy.canvas.autoPreviewDismissed';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('isAutoPreviewDismissed', () => {
  it('is false for a project that was never dismissed', () => {
    expect(isAutoPreviewDismissed('p1')).toBe(false);
  });

  it('is true right after dismissAutoPreview', () => {
    dismissAutoPreview('p1');
    expect(isAutoPreviewDismissed('p1')).toBe(true);
  });

  it('only affects the dismissed project, never others', () => {
    dismissAutoPreview('p1');
    expect(isAutoPreviewDismissed('p2')).toBe(false);
  });

  // Preview lifecycle fix — the core behavior change: a dismissal used to
  // be permanent; it now expires.
  it('expires after DISMISS_TTL_MS (24h) — no longer a permanent blacklist', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    dismissAutoPreview('p1');
    expect(isAutoPreviewDismissed('p1')).toBe(true);

    vi.setSystemTime(DAY_MS - 1);
    expect(isAutoPreviewDismissed('p1')).toBe(true);

    vi.setSystemTime(DAY_MS);
    expect(isAutoPreviewDismissed('p1')).toBe(false);
  });

  it('re-dismissing after expiry restarts the TTL window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    dismissAutoPreview('p1');
    vi.setSystemTime(DAY_MS); // expired
    expect(isAutoPreviewDismissed('p1')).toBe(false);

    dismissAutoPreview('p1'); // dismissed again, right now
    expect(isAutoPreviewDismissed('p1')).toBe(true);
    vi.setSystemTime(DAY_MS + DAY_MS - 1);
    expect(isAutoPreviewDismissed('p1')).toBe(true);
  });

  // Legacy migration — a pre-fix (flat array of ids) blacklist must still
  // be honored, never silently dropped, but is treated as "dismissed just
  // now" (a fresh TTL window) rather than permanent.
  it('migrates a pre-fix (array-shaped) blacklist instead of discarding it', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['p1', 'p2']));
    expect(isAutoPreviewDismissed('p1')).toBe(true);
    expect(isAutoPreviewDismissed('p2')).toBe(true);
    expect(isAutoPreviewDismissed('p3')).toBe(false);
  });

  it('a migrated legacy entry still expires after the TTL, same as a fresh one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['p1']));
    expect(isAutoPreviewDismissed('p1')).toBe(true);

    vi.setSystemTime(DAY_MS);
    expect(isAutoPreviewDismissed('p1')).toBe(false);
  });

  it('degrades to "not dismissed" for corrupted localStorage rather than throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    expect(() => isAutoPreviewDismissed('p1')).not.toThrow();
    expect(isAutoPreviewDismissed('p1')).toBe(false);
  });

  it('degrades to "not dismissed" for a non-array, non-object value', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
    expect(isAutoPreviewDismissed('p1')).toBe(false);
  });

  it('ignores a non-numeric value for a project key rather than throwing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ p1: 'not-a-number' }));
    expect(isAutoPreviewDismissed('p1')).toBe(false);
  });
});
