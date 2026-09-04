/**
 * D2 audit fix tests — CI/build-output fragments as stub notes.
 *
 * Production [STUBS] had notes like "#gates-done-build_exit-0-typechec" because
 * the chunk gate accepted chunks like:
 *   "build_exit=0 typecheck_exit=0 lint_exit=1 tests_exit=0"
 * They have >=8 alphanumeric words but contain zero knowledge.
 */

import { describe, expect, it } from 'vitest';
import { extractConversationChunks } from '../src/sources/claude-code.js';
import {
  isBuildExitDump,
  isBuildOutputNoise,
  isNumberedBuildStepDump,
} from '../src/sources/noise.js';

// ---------------------------------------------------------------------------
// D2.1 — isBuildExitDump
// ---------------------------------------------------------------------------

describe('D2 — isBuildExitDump', () => {
  it('drops "build_exit=0 typecheck_exit=0 lint_exit=1 tests_exit=0 gates done"', () => {
    expect(
      isBuildExitDump('build_exit=0 typecheck_exit=0 lint_exit=1 tests_exit=0 gates done'),
    ).toBe(true);
  });

  it('drops a multi-line exit-code dump with no prose', () => {
    const text = ['build_exit=0', 'typecheck_exit=0', 'lint_exit=1', 'tests_exit=0'].join('\n');
    expect(isBuildExitDump(text)).toBe(true);
  });

  it('keeps a paragraph of real prose containing one "exit=0" mention', () => {
    const text =
      'We decided to keep the CI pipeline simple. The build step returns exit=0 on success. ' +
      'Integration tests run after the build and the linter checks code style. ' +
      'All three gates must pass before the PR can be merged to main.';
    expect(isBuildExitDump(text)).toBe(false);
  });

  it('keeps a chunk with 2 exit codes but real prose alongside', () => {
    const text =
      'The pipeline ran: build_exit=0 and lint_exit=0. ' +
      'We decided to add a typecheck step because TypeScript errors were reaching production.';
    expect(isBuildExitDump(text)).toBe(false);
  });

  it('drops a chunk with exactly 3 exit codes and no prose', () => {
    expect(isBuildExitDump('build_exit=0 lint_exit=1 tests_exit=0')).toBe(true);
  });

  it('keeps a chunk with only 2 exit codes (below threshold of 3)', () => {
    expect(isBuildExitDump('build_exit=0 lint_exit=0 everything looks fine here')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D2.2 — isNumberedBuildStepDump
// ---------------------------------------------------------------------------

describe('D2 — isNumberedBuildStepDump', () => {
  it('drops a 5+ line numbered step list with no prose', () => {
    const text = [
      '1. install-deps',
      '2. typecheck',
      '3. lint',
      '4. build',
      '5. test-unit',
      '6. test-integration',
    ].join('\n');
    expect(isNumberedBuildStepDump(text)).toBe(true);
  });

  it('keeps a numbered list with prose lines mixed in', () => {
    const text = [
      '1. install-deps — We always run this first to ensure reproducibility.',
      '2. typecheck — TypeScript strict mode catches silent type errors early.',
      '3. lint — Biome enforces consistent code style across the whole codebase.',
      '4. build — esbuild bundles the CLI for distribution.',
      '5. test-unit — Vitest runs the full unit suite with V8 coverage.',
    ].join('\n');
    expect(isNumberedBuildStepDump(text)).toBe(false);
  });

  it('keeps a list with fewer than 5 step lines', () => {
    const text = ['1. install-deps', '2. typecheck', '3. lint', '4. build'].join('\n');
    expect(isNumberedBuildStepDump(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D2.3 — isBuildOutputNoise (combined)
// ---------------------------------------------------------------------------

describe('D2 — isBuildOutputNoise', () => {
  it('returns true for exit-code dump', () => {
    expect(
      isBuildOutputNoise('build_exit=0 typecheck_exit=0 lint_exit=1 tests_exit=0 gates done'),
    ).toBe(true);
  });

  it('returns true for numbered step dump', () => {
    const text = ['1. install', '2. build', '3. lint', '4. test', '5. deploy', '6. verify'].join(
      '\n',
    );
    expect(isBuildOutputNoise(text)).toBe(true);
  });

  it('returns false for real prose', () => {
    const text =
      'We decided to add a caching layer to reduce database queries by 80 percent. ' +
      'The implementation uses an LRU cache with a 1000-item limit and a 5-minute TTL.';
    expect(isBuildOutputNoise(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D2.4 — Integration: build dumps are dropped at extractConversationChunks level
// ---------------------------------------------------------------------------

describe('D2 — integration: build exit dump dropped in extractConversationChunks', () => {
  it('pure exit-code dump message is not emitted as a chunk', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: 'build_exit=0 typecheck_exit=0 lint_exit=1 tests_exit=0 gates done build complete',
      },
    });
    const chunks = extractConversationChunks(line, 'C:/proj/myapp');
    // All chunks must be free of the pure exit-code dump pattern, or no chunks at all.
    for (const chunk of chunks) {
      expect(isBuildOutputNoise(chunk.text)).toBe(false);
    }
  });

  it('real prose chunk is kept even in the same conversation as a build dump', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        message: {
          content:
            'We decided to migrate the authentication layer to Supabase because of built-in ' +
            'row-level security policies that scope all reads and writes automatically.',
        },
      }),
    ].join('\n');

    const chunks = extractConversationChunks(lines, 'C:/proj/myapp');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].text).toContain('Supabase');
  });
});
