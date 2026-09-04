/**
 * Precedence-matrix tests for the unified resolveExtractorBackend().
 *
 * Both src/annotator/llm.ts and src/commands/extract.ts now delegate to the
 * same exported function (llm.ts is canonical; extract.ts re-exports it).
 * resolveLlmBackend is a deprecated alias that must return identical results.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ExtractorBackend,
  resolveExtractorBackend,
  resolveLlmBackend,
} from '../src/annotator/llm.js';

// Also verify the re-export from extract.ts is the same function reference
import { resolveExtractorBackend as resolveFromExtract } from '../src/commands/extract.js';

// Snapshot the env before each test group and restore afterwards
const savedEnv = { ...process.env };
afterEach(() => {
  // Restore only the keys the resolver reads; reassigning process.env entirely
  // can break the test runner's internal references.
  for (const k of ['LAZYBRAIN_EXTRACTOR', 'ANTHROPIC_API_KEY'] as const) {
    if (savedEnv[k] !== undefined) {
      process.env[k] = savedEnv[k];
    } else {
      delete process.env[k];
    }
  }
});

function withEnv(
  vars: Partial<Record<'LAZYBRAIN_EXTRACTOR' | 'ANTHROPIC_API_KEY', string | undefined>>,
  fn: () => void,
): void {
  const backup: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    backup[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

describe('resolveExtractorBackend — unified canonical resolver (precedence matrix)', () => {
  // --- Explicit overrides always win ---

  it('LAZYBRAIN_EXTRACTOR=vibe → vibe', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: 'vibe' }, () => {
      expect(resolveExtractorBackend()).toBe<ExtractorBackend>('vibe');
    });
  });

  it('LAZYBRAIN_EXTRACTOR=devstral → openai', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: 'devstral' }, () => {
      expect(resolveExtractorBackend()).toBe<ExtractorBackend>('openai');
    });
  });

  it('LAZYBRAIN_EXTRACTOR=anthropic → anthropic', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: 'anthropic' }, () => {
      expect(resolveExtractorBackend()).toBe<ExtractorBackend>('anthropic');
    });
  });

  it('LAZYBRAIN_EXTRACTOR=haiku (legacy alias) → anthropic', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: 'haiku' }, () => {
      expect(resolveExtractorBackend()).toBe<ExtractorBackend>('anthropic');
    });
  });

  it('LAZYBRAIN_EXTRACTOR=claude (legacy alias) → anthropic', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: 'claude' }, () => {
      expect(resolveExtractorBackend()).toBe<ExtractorBackend>('anthropic');
    });
  });

  it('LAZYBRAIN_EXTRACTOR=claude-cli → claude-cli (explicit only)', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: 'claude-cli' }, () => {
      expect(resolveExtractorBackend()).toBe<ExtractorBackend>('claude-cli');
    });
  });

  // --- When LAZYBRAIN_EXTRACTOR is unset, ANTHROPIC_API_KEY drives the decision ---

  it('no LAZYBRAIN_EXTRACTOR, ANTHROPIC_API_KEY set → anthropic', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: undefined, ANTHROPIC_API_KEY: 'sk-test' }, () => {
      expect(resolveExtractorBackend()).toBe<ExtractorBackend>('anthropic');
    });
  });

  it('no LAZYBRAIN_EXTRACTOR, no ANTHROPIC_API_KEY → openai (sovereign local devstral)', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: undefined, ANTHROPIC_API_KEY: undefined }, () => {
      expect(resolveExtractorBackend()).toBe<ExtractorBackend>('openai');
    });
  });

  // --- claude-cli is NEVER auto-selected (must be explicit) ---

  it('claude-cli is not the auto-fallback even when ANTHROPIC_API_KEY is absent', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: undefined, ANTHROPIC_API_KEY: undefined }, () => {
      expect(resolveExtractorBackend()).not.toBe('claude-cli');
    });
  });

  // --- Backward compat: re-export from extract.ts is the same function ---

  it('extract.ts re-exports the same resolver as llm.ts', () => {
    expect(resolveFromExtract).toBe(resolveExtractorBackend);
  });

  // --- resolveLlmBackend is a deprecated alias returning identical results ---

  it('resolveLlmBackend alias: vibe', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: 'vibe' }, () => {
      expect(resolveLlmBackend()).toBe(resolveExtractorBackend());
    });
  });

  it('resolveLlmBackend alias: openai default', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: undefined, ANTHROPIC_API_KEY: undefined }, () => {
      expect(resolveLlmBackend()).toBe(resolveExtractorBackend());
    });
  });

  it('resolveLlmBackend alias: anthropic with key', () => {
    withEnv({ LAZYBRAIN_EXTRACTOR: undefined, ANTHROPIC_API_KEY: 'key' }, () => {
      expect(resolveLlmBackend()).toBe(resolveExtractorBackend());
    });
  });
});
