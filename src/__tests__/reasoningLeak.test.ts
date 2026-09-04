import { describe, it, expect } from 'vitest';
import { stripReasoningLines } from '../lib/agents/reasoningLeak';

// Regression coverage for the confirmed LazyManager chat leak (2026-07):
// when the manager ran on Haiku and the user asked "lance le localhost du
// site", the visible chat bubble showed raw internal text — the CLI
// harness's own "...produce a user-visible response." re-prompt glued
// directly to a following "@[reasoning]" marker and the model's own
// reasoning, all on ONE rendered line with no separating newline, followed
// by the real answer. Root cause fixed in chat.rs's
// extract_text_from_stream_json (now guarded to only read "assistant"-typed
// events); this file covers the defense-in-depth hardening in
// reasoningLeak.ts so the same shape never renders even if it reaches the
// UI some other way.

describe('stripReasoningLines — whole-line leaks (pre-existing behavior, regression guard)', () => {
  it('drops a bare [reasoning] line followed by more text on the same line', () => {
    const text = '[reasoning]Checking the diff first.\nHere is the answer.';
    expect(stripReasoningLines(text)).toBe('Here is the answer.');
  });

  it('drops an ANSI-prefixed \\x1b[reasoning] line', () => {
    const text = '\x1b[reasoning]internal notes\nVisible answer.';
    expect(stripReasoningLines(text)).toBe('Visible answer.');
  });

  it('drops an isolated bare [reasoning] line with nothing else on it', () => {
    const text = 'Before.\n[reasoning]\nAfter.';
    expect(stripReasoningLines(text)).toBe('Before.\nAfter.');
  });

  it('keeps blank separator lines that were already blank untouched', () => {
    const text = 'Paragraph one.\n\nParagraph two.';
    expect(stripReasoningLines(text)).toBe(text);
  });
});

describe('stripReasoningLines — mid-line leaks (LazyManager leak hardening)', () => {
  it('truncates at a mid-line ANSI-prefixed marker, keeping the real text before it', () => {
    const text = 'Real answer text.\x1b[reasoning]internal notes not meant to be seen';
    expect(stripReasoningLines(text)).toBe('Real answer text.');
  });

  it('truncates at a mid-line "@[reasoning]" marker, keeping the real text before it', () => {
    const text = 'Voici la reponse.]@[reasoning]Le user demande de lancer le serveur.';
    expect(stripReasoningLines(text)).toBe('Voici la reponse.]');
  });

  it('drops the whole line when "@[reasoning]" is the first thing on it', () => {
    const text = 'Before.\n@[reasoning]internal notes only\nAfter.';
    expect(stripReasoningLines(text)).toBe('Before.\nAfter.');
  });

  it('truncates a bare [reasoning] glued to the preceding word mid-line', () => {
    const text = 'Done reading[reasoning]internal note about the file';
    expect(stripReasoningLines(text)).toBe('Done reading');
  });

  it('truncates a bare [reasoning] glued to the following word, even preceded by whitespace', () => {
    const text = 'Reponse: [reasoning]internal notes leak in mid-sentence';
    expect(stripReasoningLines(text)).toBe('Reponse:');
  });

  it('is idempotent on already mid-line-truncated text', () => {
    const once = stripReasoningLines('Kept text.\x1b[reasoning]dropped tail');
    const twice = stripReasoningLines(once);
    expect(twice).toBe(once);
    expect(once).toBe('Kept text.');
  });
});

describe('stripReasoningLines — harness re-prompt fragments (LazyManager leak hardening)', () => {
  it('drops a line consisting only of the "no visible output" harness re-prompt', () => {
    const text = [
      'response had no visible output. Please continue and produce a user-visible response.',
      'The dev server is starting now.',
    ].join('\n');
    expect(stripReasoningLines(text)).toBe('The dev server is starting now.');
  });

  it('matches the harness fragment case-insensitively (real CLI casing starts with "Please")', () => {
    const text = 'Please continue and produce a user-visible response.\nDone.';
    expect(stripReasoningLines(text)).toBe('Done.');
  });

  it('reproduces the exact confirmed live leak shape end-to-end', () => {
    // Byte-for-byte the reported repro: harness re-prompt text glued to
    // "@[reasoning]" and the model's own reasoning on one line, no
    // separating newline, followed by the real answer on the next line.
    const text = [
      'response had no visible output. Please continue and produce a user-visible ' +
        'response.]@[reasoning]The user is asking me to continue and produce a ' +
        'user-visible response. The Bash command to start the dev server was blocked ' +
        'and requires approval. I should now present this to the user and ask for ' +
        'permission to proceed.',
      'Je dois lancer le serveur de developpement, mais cela necessite ton accord. ' +
        'Puis-je executer la commande ?',
    ].join('\n');
    const result = stripReasoningLines(text);
    expect(result).not.toContain('no visible output');
    expect(result).not.toContain('[reasoning]');
    expect(result).not.toContain('The user is asking me to continue');
    expect(result).toBe(
      'Je dois lancer le serveur de developpement, mais cela necessite ton accord. ' +
        'Puis-je executer la commande ?',
    );
  });
});

describe('stripReasoningLines — false-positive guards (legitimate text must survive)', () => {
  it('keeps a legitimate prose mention of the word reasoning (no brackets)', () => {
    const text = 'Mon raisonnement : la mission est prete. On peut merger.';
    expect(stripReasoningLines(text)).toBe(text);
  });

  it('keeps a backtick-quoted "[reasoning]" mention intact (not glued to a word)', () => {
    const text = 'The literal marker `[reasoning]` is used internally to split channels.';
    expect(stripReasoningLines(text)).toBe(text);
  });

  it('keeps a "[reasoning]" mention surrounded by punctuation and spaces intact', () => {
    const text = 'The internal marker is: [reasoning] and it separates channels.';
    expect(stripReasoningLines(text)).toBe(text);
  });

  it('keeps unrelated bracketed text untouched', () => {
    const text = 'See the config[env].json file for options.';
    expect(stripReasoningLines(text)).toBe(text);
  });

  it('leaves clean multi-line text with no marker untouched', () => {
    const text = 'First line of the answer.\nSecond line of the answer.';
    expect(stripReasoningLines(text)).toBe(text);
  });
});
