import { describe, it, expect } from 'vitest';
import {
  countAlphanumericWords,
  isBuildOutputNoise,
  isAgentMetaText,
  isNoisyCapture,
} from '../lib/brain/captureNoise';

describe('captureNoise', () => {
  it('filters a short file-save string (< 8 words)', () => {
    expect(isNoisyCapture('Fichier sauvegardé')).toBe(true);
  });

  it('keeps a real decision sentence', () => {
    const text =
      'We decided to use Tauri instead of Electron for better performance and security on macOS and Windows.';
    expect(isNoisyCapture(text)).toBe(false);
  });

  it('filters a git push log line', () => {
    const text =
      'build_exit=0 typecheck_exit=0 lint_exit=1 tests_exit=0 gates done complete build_exit=0';
    expect(isNoisyCapture(text)).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isNoisyCapture('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(isNoisyCapture('   ')).toBe(false);
  });
});

describe('countAlphanumericWords', () => {
  it('counts correctly for simple words', () => {
    expect(countAlphanumericWords('hello world foo')).toBe(3);
  });

  it('returns 0 for empty string', () => {
    expect(countAlphanumericWords('')).toBe(0);
  });

  it('counts alphanumeric tokens including numbers', () => {
    expect(countAlphanumericWords('version 2 released')).toBe(3);
  });

  it('ignores pure punctuation', () => {
    expect(countAlphanumericWords('!!! ??? ...')).toBe(0);
  });
});

describe('isBuildOutputNoise', () => {
  it('catches exit-code dump with 3+ exit codes', () => {
    const dump = 'build_exit=0 typecheck_exit=0 lint_exit=1 tests_exit=0 gates done';
    expect(isBuildOutputNoise(dump)).toBe(true);
  });

  it('keeps text that has exit codes AND prose', () => {
    const text =
      'build_exit=0 typecheck_exit=0 lint_exit=1\nWe decided to refactor the authentication module for better security and maintainability.';
    expect(isBuildOutputNoise(text)).toBe(false);
  });

  it('returns false for normal prose without exit codes', () => {
    const prose =
      'The new architecture separates concerns cleanly and enables independent scaling of each service.';
    expect(isBuildOutputNoise(prose)).toBe(false);
  });

  it('catches numbered step dump with 5+ steps and no prose', () => {
    const dump = [
      '  1. install-deps',
      '  2. lint-check',
      '  3. typecheck',
      '  4. unit-tests',
      '  5. build-prod',
      '  6. deploy-staging',
    ].join('\n');
    expect(isBuildOutputNoise(dump)).toBe(true);
  });
});

describe('isAgentMetaText', () => {
  it('catches SUBAGENT-STOP pattern', () => {
    expect(isAgentMetaText('SUBAGENT-STOP')).toBe(true);
  });

  it('catches fenced banner headers', () => {
    expect(isAgentMetaText('--- PLANNING MODE ---')).toBe(true);
  });

  it('catches XML observation opening tag', () => {
    expect(isAgentMetaText('<observation> some content')).toBe(true);
  });

  it('catches memory-observer instruction template', () => {
    expect(isAgentMetaText('CRITICAL: Record what was learned in this session')).toBe(true);
  });

  it('catches Stop hook feedback line', () => {
    expect(isAgentMetaText('Stop hook feedback: something went wrong')).toBe(true);
  });

  it('catches skill preamble phrase', () => {
    expect(isAgentMetaText('Base directory for this skill: /path/to/skill')).toBe(true);
  });

  it('catches scheduled task boilerplate', () => {
    expect(
      isAgentMetaText('This is an automated run of a scheduled task, please proceed.'),
    ).toBe(true);
  });

  it('catches rate-limit billing residue', () => {
    expect(isAgentMetaText("You've hit your Sonnet limit for today")).toBe(true);
  });

  it('keeps normal technical prose', () => {
    const prose =
      'The migration adds a new index on user_id to improve query performance on the accounts table.';
    expect(isAgentMetaText(prose)).toBe(false);
  });

  it('catches "If you were dispatched as a subagent" preamble', () => {
    expect(isAgentMetaText('If you were dispatched as a subagent, skip the intro.')).toBe(true);
  });
});
