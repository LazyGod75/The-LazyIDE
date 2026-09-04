/**
 * truncateLabel.ts — regression coverage for a real, observed UI bug
 * (LazyManager action-chip rendering, 2026-08-12 QA): every action-chip
 * label in LazyManagerMessageList.tsx's actionSummary() used a bare
 * `.slice(0, N)` with NO truncation indicator. For a filesystem path this is
 * actively misleading, not just cosmetic — `C:\Users\user\Documents\cerveau\
 * scratchpad\uc-smoke-2026-08-12`.slice(0, 32) produces EXACTLY
 * `C:\Users\user\Documents\cerveau`, a real, different, plausible-looking
 * directory with no ellipsis or marker at all. A human reading the chip has
 * no way to tell the label was cut short, let alone that a whole different
 * (and wrong) path is implied. Same class of bug on a task description
 * truncating to "Dans index.js à la racine du pro" (mid-word, no indicator).
 */
import { describe, it, expect } from 'vitest';
import { truncateLabel, truncatePathLabel } from '../components/lazyManager/truncateLabel';

describe('truncateLabel', () => {
  it('returns text unchanged when it already fits within maxLen', () => {
    expect(truncateLabel('short text', 32)).toBe('short text');
  });

  it('truncates long text and ALWAYS appends a visible ellipsis indicator', () => {
    const text = 'Dans index.js à la racine du projet actif uc-smoke-2026-08-12';
    const result = truncateLabel(text, 32);
    expect(result.length).toBeLessThanOrEqual(32);
    expect(result.endsWith('\u2026')).toBe(true);
    // Must never silently look like a complete, different, valid sentence —
    // the real repro cut mid-word with zero indicator at all.
    expect(result).not.toBe('Dans index.js à la racine du pro');
  });

  it('never produces a result longer than maxLen', () => {
    expect(truncateLabel('x'.repeat(100), 10).length).toBeLessThanOrEqual(10);
  });

  it('is idempotent — truncating an already-truncated label changes nothing', () => {
    const once = truncateLabel('a very long piece of text indeed', 20);
    const twice = truncateLabel(once, 20);
    expect(twice).toBe(once);
  });
});

describe('truncatePathLabel', () => {
  const longPath = String.raw`C:\Users\user\Documents\cerveau\scratchpad\uc-smoke-2026-08-12`;

  it('returns the path unchanged when it already fits within maxLen', () => {
    expect(truncatePathLabel(String.raw`C:\short\path`, 60)).toBe(String.raw`C:\short\path`);
  });

  it('never returns a DIFFERENT, valid-looking path with no truncation marker (the real bug)', () => {
    const result = truncatePathLabel(longPath, 32);
    // The exact real-repro defect: naive slice(0, 32) on longPath produces
    // precisely this different, real-looking directory with zero indicator.
    expect(result).not.toBe(String.raw`C:\Users\user\Documents\cerveau`);
  });

  it('always shows a truncation indicator when the path is cut', () => {
    const result = truncatePathLabel(longPath, 60);
    expect(result).not.toBe(longPath);
    expect(result).toContain('\u2026');
  });

  it('keeps the final path segment fully visible (middle-truncation)', () => {
    const result = truncatePathLabel(longPath, 60);
    expect(result.endsWith('uc-smoke-2026-08-12')).toBe(true);
  });

  it('keeps a recognizable path root/prefix before the ellipsis', () => {
    const result = truncatePathLabel(longPath, 60);
    expect(result.startsWith('C:\\')).toBe(true);
  });

  it('never exceeds maxLen even when the final segment itself is long', () => {
    const path = `C:\\Users\\user\\${'x'.repeat(80)}`;
    const result = truncatePathLabel(path, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toContain('\u2026');
  });

  it('falls back to plain ellipsis truncation for a single-segment string with no separators', () => {
    const result = truncatePathLabel('x'.repeat(80), 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('handles forward-slash paths (POSIX) the same way', () => {
    const posix = '/Users/david/Documents/cerveau/scratchpad/uc-smoke-2026-08-12';
    const result = truncatePathLabel(posix, 40);
    expect(result.endsWith('uc-smoke-2026-08-12')).toBe(true);
    expect(result).toContain('\u2026');
  });
});
