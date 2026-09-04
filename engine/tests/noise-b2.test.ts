/**
 * B2 audit fix tests — demo-fixture exclusion and LAZYBRAIN_IGNORE_PATTERNS.
 *
 * Production brain had 7 acme-* notes because dev sessions that read the
 * demo/data/notes/ fixture files produced conversation chunks containing
 * fixture content, and dream ingested them into the real brain.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractConversationChunks } from '../src/sources/claude-code.js';
import {
  buildIgnorePatterns,
  isConfigurableNoise,
  isDemoFixtureContent,
  matchesIgnorePattern,
} from '../src/sources/noise.js';

// ---------------------------------------------------------------------------
// B2.1 — isDemoFixtureContent
// ---------------------------------------------------------------------------

describe('B2 — isDemoFixtureContent', () => {
  it('drops chunk containing "acme-conv-" reference', () => {
    expect(
      isDemoFixtureContent(
        'see demo/data/notes/acme-conv-db-transaction-bug-2026-05-28.html for the full context',
      ),
    ).toBe(true);
  });

  it('drops chunk containing "acme-project-" reference', () => {
    expect(isDemoFixtureContent('the acme-project-alpha demo shows the feature')).toBe(true);
  });

  it('drops chunk containing "demo/data/notes" path segment', () => {
    expect(isDemoFixtureContent('reading file demo/data/notes/some-fixture.html')).toBe(true);
  });

  it('keeps a real note that does not mention demo fixtures', () => {
    expect(
      isDemoFixtureContent(
        'we decided to use vitest for all new tests because jest was flaky in this repo',
      ),
    ).toBe(false);
  });

  it('demo-fixture check applies even when LAZYBRAIN_DREAM_INCLUDE_SELF=1', () => {
    // The self-include flag opts in to ingesting LazyBrain dev sessions — it does NOT
    // opt out of the demo-fixture filter.  Verify the filter function itself ignores
    // the env var (the env var is handled at a higher level).
    const prev = process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
    process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = '1';
    try {
      expect(isDemoFixtureContent('reading acme-conv-auth demo fixture')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LAZYBRAIN_DREAM_INCLUDE_SELF;
      else process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// B2.2 — LAZYBRAIN_IGNORE_PATTERNS
// ---------------------------------------------------------------------------

describe('B2 — LAZYBRAIN_IGNORE_PATTERNS', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.LAZYBRAIN_IGNORE_PATTERNS;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LAZYBRAIN_IGNORE_PATTERNS;
    else process.env.LAZYBRAIN_IGNORE_PATTERNS = savedEnv;
  });

  it('drops a chunk matching a user pattern', () => {
    process.env.LAZYBRAIN_IGNORE_PATTERNS = 'secret-project';
    expect(matchesIgnorePattern('this note is about secret-project work')).toBe(true);
  });

  it('drops a chunk matching a regex pattern with quantifiers', () => {
    process.env.LAZYBRAIN_IGNORE_PATTERNS = 'foo\\d+';
    expect(matchesIgnorePattern('testing foo123 in production')).toBe(true);
  });

  it('keeps a chunk that does not match any pattern', () => {
    process.env.LAZYBRAIN_IGNORE_PATTERNS = 'secret-project,foo\\d+';
    expect(matchesIgnorePattern('vitest is used for all tests in this repo')).toBe(false);
  });

  it('invalid regex in the list is skipped without crashing', () => {
    // buildIgnorePatterns must not throw on invalid patterns
    const patterns = buildIgnorePatterns('valid-pattern,[[[invalid,another-valid');
    // Should have 2 valid patterns compiled (skipping [[[invalid)
    expect(patterns).toHaveLength(2);
    expect(patterns[0].source).toBe('valid-pattern');
    expect(patterns[1].source).toBe('another-valid');
  });

  it('empty LAZYBRAIN_IGNORE_PATTERNS produces no patterns', () => {
    const patterns = buildIgnorePatterns('');
    expect(patterns).toHaveLength(0);
  });

  it('LAZYBRAIN_IGNORE_PATTERNS with only commas produces no patterns', () => {
    const patterns = buildIgnorePatterns(',,,');
    expect(patterns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B2.3 — isConfigurableNoise (combined check)
// ---------------------------------------------------------------------------

describe('B2 — isConfigurableNoise', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.LAZYBRAIN_IGNORE_PATTERNS;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LAZYBRAIN_IGNORE_PATTERNS;
    else process.env.LAZYBRAIN_IGNORE_PATTERNS = savedEnv;
  });

  it('drops demo-fixture content via isConfigurableNoise', () => {
    expect(
      isConfigurableNoise(
        'see demo/data/notes/acme-conv-db-transaction-bug-2026-05-28.html for the full context',
      ),
    ).toBe(true);
  });

  it('drops user-pattern match via isConfigurableNoise', () => {
    process.env.LAZYBRAIN_IGNORE_PATTERNS = 'secret-project';
    expect(isConfigurableNoise('this chunk is about secret-project internal work')).toBe(true);
  });

  it('keeps real content that is neither demo nor pattern-matched', () => {
    delete process.env.LAZYBRAIN_IGNORE_PATTERNS;
    expect(
      isConfigurableNoise(
        'we decided to use supabase for auth because of built-in row-level security policies',
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B2.4 — Integration: demo chunks are dropped at extractConversationChunks level
// ---------------------------------------------------------------------------

describe('B2 — integration: demo-fixture chunks dropped in extractConversationChunks', () => {
  it('chunk containing acme-conv- reference is not emitted', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content:
          'See demo/data/notes/acme-conv-db-transaction-bug-2026-05-28.html for the session. ' +
          'The acme-project-alpha demo shows how the graph renders correctly. ' +
          'acme-conv-auth-session shows the auth flow. We decided to keep this pattern.',
      },
    });
    const chunks = extractConversationChunks(line, 'C:/proj/myapp');
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/acme-conv-/i);
      expect(chunk.text).not.toMatch(/acme-project-/i);
      expect(chunk.text).not.toMatch(/demo\/data\/notes/i);
    }
  });

  it('a conversation that contains only real content is kept even when demo content exists elsewhere', () => {
    // A pure real-knowledge conversation (no demo fixture refs) must pass through.
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          content:
            'We decided to use Supabase for authentication because of built-in row-level security.',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content:
            'The migration was planned and tested thoroughly using vitest integration tests. ' +
            'Row-level security policies scope all reads and writes to the authenticated user.',
        },
      }),
    ].join('\n');

    const chunks = extractConversationChunks(lines, 'C:/proj/myapp');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const hasRealContent = chunks.some(
      (c) => c.text.includes('Supabase') || c.text.includes('row-level'),
    );
    expect(hasRealContent).toBe(true);
  });
});
