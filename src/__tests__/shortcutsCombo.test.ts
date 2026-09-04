import { describe, it, expect } from 'vitest';
import { comboIdentity, matchesCombo, parseCombo } from '../lib/shortcuts/combo';

function keyEvent(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

describe('parseCombo', () => {
  it('resolves Mod to Meta on macOS', () => {
    expect(parseCombo('Mod+K', true)).toEqual({ key: 'k', ctrl: false, meta: true, shift: false, alt: false });
  });

  it('resolves Mod to Ctrl elsewhere', () => {
    expect(parseCombo('Mod+K', false)).toEqual({ key: 'k', ctrl: true, meta: false, shift: false, alt: false });
  });

  it('parses multiple modifiers together', () => {
    expect(parseCombo('Mod+Shift+O', false)).toEqual({ key: 'o', ctrl: true, meta: false, shift: true, alt: false });
  });

  it('accepts modifier aliases (control/cmd/command/win/option)', () => {
    expect(parseCombo('Control+K', false).ctrl).toBe(true);
    expect(parseCombo('Cmd+K', false).meta).toBe(true);
    expect(parseCombo('Command+K', false).meta).toBe(true);
    expect(parseCombo('Win+K', false).meta).toBe(true);
    expect(parseCombo('Option+F', false).alt).toBe(true);
  });

  it('lowercases the key and applies known key aliases', () => {
    expect(parseCombo('Esc', false).key).toBe('escape');
    expect(parseCombo('Mod+K', false).key).toBe('k');
  });

  it('is case-insensitive for modifier tokens', () => {
    expect(parseCombo('mod+shift+o', false)).toEqual(parseCombo('MOD+SHIFT+O', false));
  });

  it('trims whitespace around tokens', () => {
    expect(parseCombo(' Mod + Shift + O ', false)).toEqual(parseCombo('Mod+Shift+O', false));
  });

  it('throws on an empty combo', () => {
    expect(() => parseCombo('', false)).toThrow();
  });

  it('throws when the combo has no non-modifier key', () => {
    expect(() => parseCombo('Mod+Shift', false)).toThrow();
  });
});

describe('matchesCombo', () => {
  it('matches when modifiers and key line up exactly', () => {
    const combo = parseCombo('Mod+K', false);
    expect(matchesCombo(keyEvent({ key: 'k', ctrlKey: true }), combo)).toBe(true);
  });

  it('is case-insensitive on the key (Shift-produced uppercase still matches a lowercase combo key)', () => {
    const combo = parseCombo('Mod+K', false);
    expect(matchesCombo(keyEvent({ key: 'K', ctrlKey: true }), combo)).toBe(true);
  });

  it('rejects when an unspecified modifier is also held (exact match, not "at least")', () => {
    const combo = parseCombo('Mod+K', false); // no Shift in the combo
    expect(matchesCombo(keyEvent({ key: 'K', ctrlKey: true, shiftKey: true }), combo)).toBe(false);
  });

  it('rejects when the required modifier is missing', () => {
    const combo = parseCombo('Mod+K', false);
    expect(matchesCombo(keyEvent({ key: 'k', ctrlKey: false }), combo)).toBe(false);
  });

  it('rejects a different key with the same modifiers', () => {
    const combo = parseCombo('Mod+K', false);
    expect(matchesCombo(keyEvent({ key: 'p', ctrlKey: true }), combo)).toBe(false);
  });

  it('matches bare keys with no modifiers required', () => {
    const combo = parseCombo('Escape', false);
    expect(matchesCombo(keyEvent({ key: 'Escape' }), combo)).toBe(true);
  });

  it('rejects a bare-key combo when a modifier is held', () => {
    const combo = parseCombo('Escape', false);
    expect(matchesCombo(keyEvent({ key: 'Escape', ctrlKey: true }), combo)).toBe(false);
  });
});

describe('comboIdentity', () => {
  it('is identical for combos parsed from equivalent strings', () => {
    expect(comboIdentity(parseCombo('Mod+K', false))).toBe(comboIdentity(parseCombo('Ctrl+K', false)));
  });

  it('differs when a modifier differs', () => {
    expect(comboIdentity(parseCombo('Mod+K', false))).not.toBe(comboIdentity(parseCombo('Mod+Shift+K', false)));
  });

  it('differs when the key differs', () => {
    expect(comboIdentity(parseCombo('Mod+K', false))).not.toBe(comboIdentity(parseCombo('Mod+P', false)));
  });
});
