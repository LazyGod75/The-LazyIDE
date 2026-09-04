/**
 * FIX 2 — Noise defence-in-depth tests.
 *
 * (a) detectNoise now calls isConfigurableNoise (demo-fixture + LAZYBRAIN_IGNORE_PATTERNS)
 *     and isBuildOutputNoise at the note level, not just at chunk level.
 *
 * (b) Stub notes (factCount <= 1) whose id reduces to a datetime + hex suffix
 *     are skipped entirely (never written to disk).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectNoise, isStubDatetimeHexId } from '../src/commands/dream.js';

// ---------------------------------------------------------------------------
// FIX 2a — detectNoise wires isConfigurableNoise and isBuildOutputNoise
// ---------------------------------------------------------------------------

describe('FIX 2a — detectNoise: configurable noise gate (demo-fixture)', () => {
  it('drops a note whose text contains an acme-conv- fixture reference', () => {
    // This chunk passes old structural gates (not too short, not JSON, not session metadata)
    // but must be caught by the demo-fixture check wired into detectNoise.
    const text =
      'The acme-conv-db-transaction-bug-2026-05-28 note was read from demo/data/notes. ' +
      'The acme-project-alpha fixture shows the correct rendering. See attached for context. ' +
      'Processing was completed successfully with all checks passing.';
    expect(detectNoise(text)).toBe(true);
  });

  it('drops a note whose text contains a demo/data/notes path segment', () => {
    const text =
      'Read file demo/data/notes/acme-conv-auth-session.html to understand the flow. ' +
      'The authentication session note describes the full OAuth dance. ' +
      'All edge cases are covered by the integration tests.';
    expect(detectNoise(text)).toBe(true);
  });

  it('keeps a legitimate note that does not reference demo fixtures', () => {
    const text =
      'We decided to use Supabase for the authentication layer because of built-in ' +
      'row-level security policies. The migration was completed and tested with vitest. ' +
      'No issues found during the review.';
    expect(detectNoise(text)).toBe(false);
  });
});

describe('FIX 2a — detectNoise: configurable noise gate (LAZYBRAIN_IGNORE_PATTERNS)', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.LAZYBRAIN_IGNORE_PATTERNS;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LAZYBRAIN_IGNORE_PATTERNS;
    else process.env.LAZYBRAIN_IGNORE_PATTERNS = savedEnv;
  });

  it('drops a note matching a user-configured ignore pattern', () => {
    process.env.LAZYBRAIN_IGNORE_PATTERNS = 'confidential-project';
    const text =
      'This note contains details about confidential-project internal roadmap. ' +
      'The architecture decision was made based on scalability requirements. ' +
      'Implementation is planned for next quarter.';
    expect(detectNoise(text)).toBe(true);
  });

  it('keeps a note that does not match any ignore pattern', () => {
    process.env.LAZYBRAIN_IGNORE_PATTERNS = 'confidential-project';
    const text =
      'We decided to add caching with Redis to reduce database load by 80 percent. ' +
      'The LRU cache uses a 1000-item limit and a 5-minute TTL for session data. ' +
      'This improved p99 latency from 400ms to 45ms in production.';
    expect(detectNoise(text)).toBe(false);
  });
});

describe('FIX 2a — detectNoise: build output gate', () => {
  it('drops a note dominated by CI exit-code output (passes old structural checks)', () => {
    // This chunk has 8+ alphanumeric words and is not a JSON dump or session meta,
    // so the old structural gates allowed it. The build-output gate must catch it.
    // Multi-line form with 3+ exit codes and no prose lines.
    const text = ['build_exit=0', 'typecheck_exit=0', 'lint_exit=1', 'tests_exit=0'].join('\n');
    expect(detectNoise(text)).toBe(true);
  });

  it('drops a numbered build-step dump with no prose (5+ steps)', () => {
    const text = [
      '1. install-deps',
      '2. typecheck',
      '3. lint',
      '4. build',
      '5. test-unit',
      '6. test-integration',
    ].join('\n');
    expect(detectNoise(text)).toBe(true);
  });

  it('keeps a note with real prose alongside build status', () => {
    const text =
      'We decided to add a typecheck gate because silent type errors were reaching production. ' +
      'The pipeline now runs: typecheck, lint, test. build_exit=0 confirms the fix works. ' +
      'All existing tests continued to pass after the refactor.';
    expect(detectNoise(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX 2b — isStubDatetimeHexId: skip stub notes with datetime-hex ids
// ---------------------------------------------------------------------------

describe('FIX 2b — isStubDatetimeHexId', () => {
  it('matches id that is date prefix + nothing meaningful + hex suffix', () => {
    // The annotator produced a title that was just a datetime; slug produces:
    // 2026-06-10-2026-06-10t14-23-a1b2c3d4
    expect(isStubDatetimeHexId('2026-06-10-2026-06-10t14-23-a1b2c3d4')).toBe(true);
  });

  it('matches id that is date prefix + bare time + hex suffix', () => {
    expect(isStubDatetimeHexId('2026-06-10-14-23-00-a1b2c3d4')).toBe(true);
  });

  it('matches id that is date only + hex suffix', () => {
    expect(isStubDatetimeHexId('2026-06-10-a1b2c3d4')).toBe(true);
  });

  it('does NOT match an id with a real semantic title between date and hex', () => {
    // "we-decided-to-use-supabase-for-auth" is not a datetime
    expect(isStubDatetimeHexId('2026-06-10-we-decided-to-use-supabase-for-auth-a1b2c3d4')).toBe(
      false,
    );
  });

  it('does NOT match an id with only a date and no hex suffix', () => {
    expect(isStubDatetimeHexId('2026-06-10-session-note')).toBe(false);
  });

  it('does NOT match an empty string', () => {
    expect(isStubDatetimeHexId('')).toBe(false);
  });

  it('does NOT match a legitimate note id whose title contains digits but is not a datetime', () => {
    expect(isStubDatetimeHexId('2026-06-10-fix-issue-123-error-in-auth-a1b2c3d4')).toBe(false);
  });
});
