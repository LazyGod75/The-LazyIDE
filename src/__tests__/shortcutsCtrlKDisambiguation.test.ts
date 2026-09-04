import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createShortcutRegistry, type ShortcutRegistry } from '../lib/shortcuts/registry';
import { SHORTCUT_PRIORITY } from '../lib/shortcuts/priorities';

function dispatchKeyDown(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

// Reproduces the exact Mod+K registration pair used in production —
// AppShell.tsx's 'palette.toggleK' (SHORTCUT_PRIORITY.GLOBAL, always
// eligible) and EditorPane.tsx's 'editor.inlineEdit' (SHORTCUT_PRIORITY.
// SCOPED, eligible only while the editor reports focus) — to pin the
// disambiguation this migration must preserve exactly: "editor-focused
// Ctrl+K -> inline edit; otherwise -> palette" (previously implemented via
// AppShell's `event.target.closest('.cm-editor')` DOM check plus
// EditorPane's independent `view.hasFocus` check; now implemented as a
// single `view.hasFocus`-equivalent scope predicate arbitrated by priority).
describe('Ctrl+K palette vs. editor inline-edit disambiguation', () => {
  let registry: ShortcutRegistry;
  let editorHasFocus: boolean;
  let paletteToggle: ReturnType<typeof vi.fn>;
  let editorInlineEdit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = createShortcutRegistry();
    editorHasFocus = false;
    paletteToggle = vi.fn();
    editorInlineEdit = vi.fn();

    registry.register({
      id: 'palette.toggleK',
      combo: 'Mod+K',
      priority: SHORTCUT_PRIORITY.GLOBAL,
      handler: paletteToggle,
    });
    registry.register({
      id: 'palette.toggleP',
      combo: 'Mod+P',
      priority: SHORTCUT_PRIORITY.GLOBAL,
      handler: paletteToggle,
    });
    registry.register({
      id: 'editor.inlineEdit',
      combo: 'Mod+K',
      when: () => editorHasFocus,
      priority: SHORTCUT_PRIORITY.SCOPED,
      handler: editorInlineEdit,
    });
  });

  afterEach(() => {
    registry.destroy();
  });

  it('opens inline edit — not the palette — when the editor has focus', () => {
    editorHasFocus = true;

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(editorInlineEdit).toHaveBeenCalledTimes(1);
    expect(paletteToggle).not.toHaveBeenCalled();
  });

  it('opens the palette — not inline edit — when the editor does not have focus', () => {
    editorHasFocus = false;

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(paletteToggle).toHaveBeenCalledTimes(1);
    expect(editorInlineEdit).not.toHaveBeenCalled();
  });

  it('re-evaluates focus on every keydown — no stale disambiguation across repeated presses', () => {
    editorHasFocus = true;
    dispatchKeyDown({ key: 'k', ctrlKey: true });
    expect(editorInlineEdit).toHaveBeenCalledTimes(1);

    editorHasFocus = false;
    dispatchKeyDown({ key: 'k', ctrlKey: true });
    expect(paletteToggle).toHaveBeenCalledTimes(1);
    expect(editorInlineEdit).toHaveBeenCalledTimes(1); // unchanged from the first assertion
  });

  it('Mod+P always toggles the palette regardless of editor focus (no competing registration on P)', () => {
    editorHasFocus = true;
    dispatchKeyDown({ key: 'p', ctrlKey: true });

    expect(paletteToggle).toHaveBeenCalledTimes(1);
    expect(editorInlineEdit).not.toHaveBeenCalled();
  });

  it('preserves the exact modifier requirement — Mod+Shift+K matches neither registration', () => {
    editorHasFocus = true;
    dispatchKeyDown({ key: 'K', ctrlKey: true, shiftKey: true });

    expect(editorInlineEdit).not.toHaveBeenCalled();
    expect(paletteToggle).not.toHaveBeenCalled();
  });

  it('calls preventDefault exactly once for whichever side wins, matching the original single-dispatch behavior', () => {
    editorHasFocus = true;
    const focused = dispatchKeyDown({ key: 'k', ctrlKey: true });
    expect(focused.defaultPrevented).toBe(true);

    editorHasFocus = false;
    const unfocused = dispatchKeyDown({ key: 'k', ctrlKey: true });
    expect(unfocused.defaultPrevented).toBe(true);
  });
});
