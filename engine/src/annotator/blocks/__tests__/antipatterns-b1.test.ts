/**
 * B1 audit fix tests — quality gate for anti-pattern rendering.
 *
 * Garbage facts that appeared in production warnings:
 *   "20:15.", "16:45." — bare timestamps
 *   "=== demo/graph.html has static meta? === NO STAT" — tool-output fragments
 *   "s === ### LINT > lazybrain@0.2.0 lint bin\lazybr" — tool-output fragments
 *
 * Legitimate facts that must still be rendered:
 *   "avoid using floats for money amounts in invoices"
 *   "build failed because esbuild banner conflicted with shebang" (kind=error)
 */

import { describe, expect, it } from 'vitest';
import { renderAntipatterns } from '../antipatterns.js';

// ---------------------------------------------------------------------------
// Rejected by quality gate
// ---------------------------------------------------------------------------

describe('B1 — quality gate rejects garbage anti-patterns', () => {
  it('rejects bare timestamp "16:45."', () => {
    const html = renderAntipatterns({
      facts: [{ text: '16:45.', confidence: 0.5, kind: 'error' }],
    });
    expect(html).toBe('');
  });

  it('rejects bare timestamp "20:15."', () => {
    const html = renderAntipatterns({
      facts: [{ text: '20:15.', confidence: 0.5, kind: 'error' }],
    });
    expect(html).toBe('');
  });

  it('rejects bare timestamp without trailing dot "16:45"', () => {
    const html = renderAntipatterns({
      facts: [{ text: '16:45', confidence: 0.5, kind: 'error' }],
    });
    expect(html).toBe('');
  });

  it('rejects tool-output fragment starting with "==="', () => {
    const html = renderAntipatterns({
      facts: [
        {
          text: '=== demo/graph.html has static meta? === NO STAT',
          confidence: 0.5,
          kind: 'error',
        },
      ],
    });
    expect(html).toBe('');
  });

  it('rejects tool-output fragment with 2+ occurrences of "==="', () => {
    const html = renderAntipatterns({
      facts: [
        {
          text: 's === ### LINT > lazybrain@0.2.0 lint bin lazybr === done',
          confidence: 0.5,
          kind: 'error',
        },
      ],
    });
    expect(html).toBe('');
  });

  it('rejects tool-output fragment starting with "---"', () => {
    const html = renderAntipatterns({
      facts: [
        { text: '--- build output start --- errors found ---', confidence: 0.5, kind: 'error' },
      ],
    });
    expect(html).toBe('');
  });

  it('rejects facts shorter than 20 characters even with keyword', () => {
    const html = renderAntipatterns({
      facts: [{ text: "don't do it", confidence: 0.9, kind: 'decision' }],
    });
    expect(html).toBe('');
  });

  it('rejects error-kind fact with fewer than 4 words and no failure verb', () => {
    const html = renderAntipatterns({
      facts: [{ text: 'Something went terribly wrong here', confidence: 0.8, kind: 'error' }],
    });
    // "went wrong" matches the keyword "was wrong" pattern via different words,
    // but let's use a fact with no keyword AND no failure verb to verify rejection.
    // Actually "Something went terribly wrong here" has no failure verb and no keyword.
    // It has 5 words >= 4, but kind=error without failure verb → should be rejected.
    expect(html).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Kept by quality gate
// ---------------------------------------------------------------------------

describe('B1 — quality gate keeps legitimate anti-patterns', () => {
  it('keeps "avoid using floats for money amounts in invoices"', () => {
    const html = renderAntipatterns({
      facts: [
        {
          text: 'avoid using floats for money amounts in invoices',
          confidence: 0.9,
          kind: 'decision',
        },
      ],
    });
    expect(html).toContain('data-section="antipatterns"');
    expect(html).toContain('avoid using floats');
  });

  it('keeps "never use synchronous file reads in hot code paths performance"', () => {
    const html = renderAntipatterns({
      facts: [
        {
          text: 'never use synchronous file reads in hot code paths performance',
          confidence: 0.9,
          kind: 'decision',
        },
      ],
    });
    expect(html).toContain('data-section="antipatterns"');
  });

  it('keeps error-kind fact with failure verb: "build failed because esbuild banner conflicted"', () => {
    const html = renderAntipatterns({
      facts: [
        {
          text: 'build failed because esbuild banner conflicted with shebang',
          confidence: 0.8,
          kind: 'error',
        },
      ],
    });
    expect(html).toContain('data-section="antipatterns"');
    expect(html).toContain('esbuild');
  });

  it('keeps error-kind fact with "crashed" verb', () => {
    const html = renderAntipatterns({
      facts: [
        {
          text: 'The server crashed because the connection pool was exhausted under load',
          confidence: 0.8,
          kind: 'error',
        },
      ],
    });
    expect(html).toContain('data-section="antipatterns"');
  });

  it('keeps error-kind fact with "error" keyword', () => {
    const html = renderAntipatterns({
      facts: [
        {
          text: 'TypeError in production error caused by missing null check on user object',
          confidence: 0.8,
          kind: 'error',
        },
      ],
    });
    expect(html).toContain('data-section="antipatterns"');
  });

  it('keeps "don\'t mutate shared state — always return new objects" (keyword + length)', () => {
    const html = renderAntipatterns({
      facts: [
        {
          text: "don't mutate shared state — always return new objects to prevent side effects",
          confidence: 0.9,
          kind: 'decision',
        },
      ],
    });
    expect(html).toContain('data-section="antipatterns"');
  });
});
