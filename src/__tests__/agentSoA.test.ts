/**
 * Tests for SoA pure-function exports from managedAgent:
 *   - parseReflectBlock()         R6 — reflexion buffer
 *   - estimateMessagesTokens()    R7 — context handoff token estimator
 *   - shouldHandoff()             R7 — handoff predicate
 *   - parsePrmVerdict()           R8 — PRM step verifier
 *
 * Tool-policy + persona composition (checkToolPolicy, buildPolicyBlock,
 * buildEffectiveSystemPrompt, resolveAgentPersona) moved to
 * managedAgentPolicy.ts — see managedAgentPolicy.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  parseReflectBlock,
  estimateMessagesTokens,
  shouldHandoff,
  parsePrmVerdict,
} from '../lib/agents/managedAgent';

// ── parseReflectBlock ─────────────────────────────────────────────

describe('parseReflectBlock', () => {
  it('returns the content between <reflect> tags', () => {
    const text = 'Some preamble\n<reflect>The error was a missing semicolon.</reflect>\nSome epilogue';
    expect(parseReflectBlock(text)).toBe('The error was a missing semicolon.');
  });

  it('returns null when no <reflect> tag is present', () => {
    expect(parseReflectBlock('No reflection here.')).toBeNull();
  });

  it('returns null for an empty <reflect> block', () => {
    expect(parseReflectBlock('<reflect>   </reflect>')).toBeNull();
  });

  it('truncates content to 600 chars', () => {
    const long = 'x'.repeat(700);
    const result = parseReflectBlock(`<reflect>${long}</reflect>`);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(600);
  });

  it('handles multiline reflection content', () => {
    const text = '<reflect>Line one\nLine two\nLine three</reflect>';
    const result = parseReflectBlock(text);
    expect(result).toBe('Line one\nLine two\nLine three');
  });

  // R13 — the extracted content is written verbatim into the mission's real
  // journal/timeline (runTurn's `marker: 'reflexion'` emitBuffered call) — a
  // reasoning-model backend can spill a raw `[reasoning]…` line INSIDE the
  // <reflect> block itself. Must be stripped at the producer, same rule
  // reasoningLeak.ts's other two call sites already apply.
  it('strips a leaked bare "[reasoning]" line from inside the reflect block', () => {
    const text = '<reflect>[reasoning]Thinking about the error...\nThe error was a missing semicolon.</reflect>';
    expect(parseReflectBlock(text)).toBe('The error was a missing semicolon.');
  });

  it('strips a leaked ANSI-prefixed "\\x1b[reasoning]" line from inside the reflect block', () => {
    const text = '<reflect>\x1b[reasoning]Thinking...\nReal reflection text.</reflect>';
    expect(parseReflectBlock(text)).toBe('Real reflection text.');
  });
});

// ── estimateMessagesTokens ────────────────────────────────────────

describe('estimateMessagesTokens', () => {
  it('returns 0 for an empty array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('estimates tokens for a single message (ceil(chars/4))', () => {
    // 'abcd' → 4 chars → ceil(4/4) = 1 token
    const messages = [{ role: 'user', content: 'abcd' }];
    expect(estimateMessagesTokens(messages)).toBe(1);
  });

  it('sums tokens across multiple messages', () => {
    // 'aaaabbbb' → 8 chars → ceil(8/4) = 2 tokens each
    // 'eeee' → 4 chars → ceil(4/4) = 1 token
    const messages = [
      { role: 'user', content: 'aaaabbbb' },
      { role: 'assistant', content: 'ccccdddd' },
      { role: 'user', content: 'eeee' },
    ];
    expect(estimateMessagesTokens(messages)).toBe(5);
  });

  it('returns 0 for a message with empty content', () => {
    const messages = [{ role: 'user', content: '' }];
    expect(estimateMessagesTokens(messages)).toBe(0);
  });

  it('handles multiple messages with varying sizes', () => {
    // 'abcdefgh' → 8 chars → ceil(8/4) = 2 tokens
    // 'ijkl' → 4 chars → ceil(4/4) = 1 token
    const messages = [
      { role: 'user', content: 'abcdefgh' },
      { role: 'assistant', content: 'ijkl' },
    ];
    expect(estimateMessagesTokens(messages)).toBe(3);
  });
});

// ── shouldHandoff ─────────────────────────────────────────────────

describe('shouldHandoff', () => {
  it('returns false when total tokens are below threshold', () => {
    const messages = [{ role: 'user', content: 'short message' }];
    expect(shouldHandoff(messages)).toBe(false);
  });

  it('returns true when total tokens equal or exceed default threshold (80000)', () => {
    // 80000 tokens × 4 chars/token = 320000 chars
    const bigContent = 'x'.repeat(320000);
    const messages = [{ role: 'user', content: bigContent }];
    expect(shouldHandoff(messages)).toBe(true);
  });

  it('respects a custom threshold', () => {
    // 'abcd'.repeat(10) = 40 chars → ceil(40/4) = 10 tokens
    const messages = [{ role: 'user', content: 'abcd'.repeat(10) }];
    expect(shouldHandoff(messages, 10)).toBe(true);
    expect(shouldHandoff(messages, 11)).toBe(false);
  });

  it('returns false for an empty messages array', () => {
    expect(shouldHandoff([])).toBe(false);
  });

  it('returns false just below a custom threshold', () => {
    // 'abcd' → ceil(4/4) = 1 token
    const messages = [{ role: 'user', content: 'abcd' }];
    expect(shouldHandoff(messages, 2)).toBe(false);
  });
});

// ── parsePrmVerdict ───────────────────────────────────────────────

describe('parsePrmVerdict', () => {
  it('returns ok=true for standalone "OK"', () => {
    const result = parsePrmVerdict('OK');
    expect(result).toEqual({ ok: true, correction: null });
  });

  it('is case-insensitive for OK', () => {
    expect(parsePrmVerdict('ok').ok).toBe(true);
    expect(parsePrmVerdict('Ok').ok).toBe(true);
    expect(parsePrmVerdict('oK').ok).toBe(true);
  });

  it('returns ok=true when "OK" appears in surrounding text', () => {
    const result = parsePrmVerdict('The trajectory looks OK to me.');
    expect(result.ok).toBe(true);
  });

  it('returns ok=false with correction for specification error', () => {
    const result = parsePrmVerdict('(S) Specification error: The agent is solving the wrong task.');
    expect(result.ok).toBe(false);
    expect(result.correction).not.toBeNull();
    expect(result.correction).toContain('Specification error');
  });

  it('returns ok=false with correction for reasoning error', () => {
    const result = parsePrmVerdict('(R) Reasoning error: The agent is using the wrong algorithm.');
    expect(result.ok).toBe(false);
    expect(result.correction).not.toBeNull();
  });

  it('truncates correction to 300 chars', () => {
    const longText = 'x'.repeat(500);
    const result = parsePrmVerdict(longText);
    expect(result.ok).toBe(false);
    expect(result.correction!.length).toBe(300);
  });

  it('returns ok=false for empty string', () => {
    const result = parsePrmVerdict('');
    expect(result.ok).toBe(false);
    expect(result.correction).toBe('');
  });

  // R13 — `correction` is written verbatim into the mission's real journal
  // (runTurn's `marker: 'prm'` emitBuffered call) — must never carry a raw
  // leaked reasoning-channel line through to that user-visible surface.
  it('strips a leaked bare "[reasoning]" line from the correction text', () => {
    const result = parsePrmVerdict('[reasoning]Evaluating the trajectory...\n(S) Specification error: wrong task.');
    expect(result.ok).toBe(false);
    expect(result.correction).not.toContain('[reasoning]');
    expect(result.correction).toContain('Specification error');
  });

  it('strips a leaked ANSI-prefixed "\\x1b[reasoning]" line from the correction text', () => {
    const result = parsePrmVerdict('\x1b[reasoning]Thinking...\n(R) Reasoning error: wrong algorithm.');
    expect(result.ok).toBe(false);
    expect(result.correction).not.toContain('reasoning]');
    expect(result.correction).toContain('Reasoning error');
  });
});

// checkToolPolicy / buildPolicyBlock / buildEffectiveSystemPrompt /
// resolveAgentPersona tests moved to managedAgentPolicy.test.ts.
