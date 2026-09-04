import { describe, it, expect } from 'vitest';
import { sanitizeModelCodeOutput } from '../lib/ai/codeOutputSanitizer';

// Regression coverage for the Ctrl+K inline-edit HIGH defect: under the
// "Claude Code (abonnement)" backend, the model answered a code-transform
// request with agentic tool-call narration instead of code, and the app
// applied that narration as if it were the replacement code — corrupting
// the file. sanitizeModelCodeOutput is the fail-safe gate that must catch
// this before the narration ever reaches the diff/apply path.

describe('sanitizeModelCodeOutput — pure code (no fence, no narration)', () => {
  it('returns the trimmed code unchanged', () => {
    const raw = 'export function add(a: number, b: number): number {\n  return a + b;\n}';
    expect(sanitizeModelCodeOutput(raw)).toEqual({ ok: true, code: raw });
  });

  it('trims surrounding whitespace/newlines', () => {
    const result = sanitizeModelCodeOutput('\n\n  const x = 1;\n\n');
    expect(result).toEqual({ ok: true, code: 'const x = 1;' });
  });

  it('keeps a short expression with no braces/semicolons (no false-positive prose rejection)', () => {
    expect(sanitizeModelCodeOutput('(a + b)')).toEqual({ ok: true, code: '(a + b)' });
  });
});

describe('sanitizeModelCodeOutput — fenced code', () => {
  it('extracts the code from a ```lang fence', () => {
    const raw = '```typescript\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n```';
    expect(sanitizeModelCodeOutput(raw)).toEqual({
      ok: true,
      code: 'export function add(a: number, b: number): number {\n  return a + b;\n}',
    });
  });

  it('extracts a fence with no language tag', () => {
    expect(sanitizeModelCodeOutput('```\nconst x = 1;\n```')).toEqual({ ok: true, code: 'const x = 1;' });
  });

  it('extracts the fenced block even when the model added narration around it', () => {
    const raw = "Here's the fix:\n```ts\nconst x = 1;\n```\nDone.";
    expect(sanitizeModelCodeOutput(raw)).toEqual({ ok: true, code: 'const x = 1;' });
  });

  it('rejects an empty fenced block instead of applying nothing silently', () => {
    const result = sanitizeModelCodeOutput('```ts\n\n```');
    expect(result.ok).toBe(false);
  });
});

describe('sanitizeModelCodeOutput — agentic narration (fails safe, never corrupts)', () => {
  it('rejects the exact QA-captured Claude Code CLI narration', () => {
    // Real captured result from QA: user selected `export function add(a,b)
    // {return a+b}` and asked "add a short comment above this" — the model
    // narrated tool calls instead of returning code.
    const raw = [
      '→ Read `qa-ctrlk-select-fixture.ts`',
      "The file already has the function on line 3. I'll add a short comment above it:",
      '→ Edit `qa-ctrlk-select-fixture.ts`',
      'Done. Added a short comment "Returns the sum of two numbers" above the `add()` function.',
    ].join('\n');

    const result = sanitizeModelCodeOutput(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/narration|explanation/i);
    }
  });

  it('rejects narration that never mentions a tool (no code shape, no fence)', () => {
    const result = sanitizeModelCodeOutput("I'll add a short comment above the function.\nDone.");
    expect(result.ok).toBe(false);
  });

  it('rejects a plain-English refusal from a non-tool-using backend (BYOK/managed)', () => {
    const result = sanitizeModelCodeOutput(
      'The requested change cannot be made because the selection is ambiguous.',
    );
    expect(result.ok).toBe(false);
  });

  it('rejects an empty response', () => {
    expect(sanitizeModelCodeOutput('').ok).toBe(false);
    expect(sanitizeModelCodeOutput('   \n  ').ok).toBe(false);
  });

  it('rejects narration even when it is wrapped in a fence', () => {
    const raw = '```\nI\'ll go ahead and fix this now.\n```';
    expect(sanitizeModelCodeOutput(raw).ok).toBe(false);
  });
});

describe('sanitizeModelCodeOutput — false-positive guards (legitimate code must survive)', () => {
  it('does not reject code containing a narration-like phrase inside a string literal', () => {
    const raw = 'export function status(): string {\n  return "Done.";\n}';
    expect(sanitizeModelCodeOutput(raw)).toEqual({ ok: true, code: raw });
  });

  it('does not reject code with a stray comment that happens to start like narration', () => {
    const raw = [
      'export function add(a: number, b: number): number {',
      "  // I'll clean this up later",
      '  return a + b;',
      '}',
    ].join('\n');
    expect(sanitizeModelCodeOutput(raw)).toEqual({ ok: true, code: raw });
  });

  it('does not reject a multi-line code block that has no semicolons/braces at all (e.g. Python)', () => {
    const raw = 'def add(a, b):\n    return a + b';
    expect(sanitizeModelCodeOutput(raw)).toEqual({ ok: true, code: raw });
  });
});
