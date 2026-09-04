import { describe, expect, it } from 'vitest';
import { parseVibeCliOutput } from '../src/util/vibe-cli.js';

/**
 * Unit tests for vibe-cli.ts.
 *
 * We do NOT spawn the real vibe binary here — that would require Vibe to be
 * installed and authenticated, which is not a CI precondition. Instead:
 *
 *   - parseVibeCliOutput() is extracted as a pure function and tested directly.
 *     This covers the output-cleaning logic for all output shapes we observed
 *     in the vibe source (TextOutputFormatter.finalize → plain assistant text).
 *
 *   - The JSON array round-trip is implicitly tested via parseJsonArrayLoose,
 *     which has its own test suite (json-loose.test.ts). callVibeCliJsonArray
 *     is a thin composition of callVibeCli + parseJsonArrayLoose; no extra
 *     unit test is added here.
 *
 * Spawn-level integration (real vibe binary) is intentionally left out of the
 * automated test suite. The opts.binary injection point can be used in manual
 * integration tests or future fixture-based tests.
 */

describe('parseVibeCliOutput', () => {
  it('returns the raw text unchanged when it is clean', () => {
    const input = '[{"for":"id1","text":"fact one.","kind":"fact","confidence":0.9}]';
    expect(parseVibeCliOutput(input)).toBe(input);
  });

  it('trims surrounding whitespace and newlines', () => {
    expect(parseVibeCliOutput('  hello\n')).toBe('hello');
    expect(parseVibeCliOutput('\n\n[1,2,3]\n\n')).toBe('[1,2,3]');
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(parseVibeCliOutput('')).toBeNull();
    expect(parseVibeCliOutput('   ')).toBeNull();
    expect(parseVibeCliOutput('\n\t\r')).toBeNull();
  });

  it('strips Rich markup tags that may leak from vibe output', () => {
    // In practice --output text + headless suppresses Rich; strip defensively.
    const raw = '[bold]Some text[/bold]';
    const result = parseVibeCliOutput(raw);
    expect(result).not.toContain('[bold]');
    expect(result).not.toContain('[/bold]');
    expect(result).toBe('Some text');
  });

  it('strips Rich markup with attributes', () => {
    const raw = '[yellow]Warning:[/] normal text';
    const result = parseVibeCliOutput(raw);
    expect(result).not.toContain('[yellow]');
    expect(result).not.toContain('[/]');
    expect(result?.trim()).toBe('Warning: normal text');
  });

  it('preserves JSON arrays with no markup', () => {
    const arr = '[{"for":"n1","text":"decision was made.","kind":"decision","confidence":0.85}]';
    expect(parseVibeCliOutput(arr)).toBe(arr);
  });

  it('handles multi-line responses', () => {
    const raw = 'line one\nline two\nline three';
    expect(parseVibeCliOutput(raw)).toBe('line one\nline two\nline three');
  });
});
