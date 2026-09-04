import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  computeInlineEditRange,
  cursorPositionFromState,
  altClickAddsSelectionRange,
  offsetToLspPosition,
} from '../components/editor/EditorPane';

function stateWithSelection(doc: string, from: number, to: number = from): EditorState {
  return EditorState.create({ doc, selection: { anchor: from, head: to } });
}

// ── DEFECT #2: Ctrl+K no-selection range ────────────────────────────
// Ctrl+K without a selection used to pass the WHOLE FILE as the edit range
// (selFrom === selTo === cursor offset). Because InlineEditBar.handleSubmit
// branches on `selFrom !== selTo`, that equal-offsets case replaced the
// ENTIRE document with nothing but the model's raw output — and, separately,
// left an ambiguous window where typed instruction keystrokes could leak
// into the document instead of the prompt (see InlineEditBar.test.tsx).
// computeInlineEditRange now scopes the no-selection case to the current
// line instead.

describe('computeInlineEditRange (DEFECT #2)', () => {
  it('uses the explicit selection as-is when one exists', () => {
    const doc = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const state = stateWithSelection(doc, 6, 12); // "a = 1;" inside line 1
    const range = computeInlineEditRange(state);

    expect(range.selFrom).toBe(6);
    expect(range.selTo).toBe(12);
    expect(range.selectedCode).toBe(doc.slice(6, 12));
    expect(range.fullContent).toBe(doc);
  });

  it('falls back to the current line — not the whole file — when there is no selection', () => {
    const doc = 'function foo() {\n  return 1;\n}';
    // Cursor sits inside line 2 ("  return 1;"), no selection.
    const line2Start = doc.indexOf('  return 1;');
    const cursorOffset = line2Start + 4; // somewhere mid-line
    const state = stateWithSelection(doc, cursorOffset);

    const range = computeInlineEditRange(state);

    expect(range.selectedCode).toBe('  return 1;');
    expect(range.selFrom).toBe(line2Start);
    expect(range.selTo).toBe(line2Start + '  return 1;'.length);
    // The critical data-loss guard: selFrom !== selTo means InlineEditBar's
    // handleSubmit takes the splice branch (replace only this line) instead
    // of the whole-file-replace branch.
    expect(range.selFrom).not.toBe(range.selTo);
    expect(range.fullContent).toBe(doc);
  });

  it('picks the line the cursor is actually on, not always line 1', () => {
    const doc = 'line1\nline2\nline3';
    const line3Start = doc.indexOf('line3');
    const state = stateWithSelection(doc, line3Start + 2);

    const range = computeInlineEditRange(state);

    expect(range.selectedCode).toBe('line3');
    expect(range.selFrom).toBe(line3Start);
  });

  it('does not crash on an empty document (edge case: selFrom === selTo is unavoidable here)', () => {
    const state = stateWithSelection('', 0);
    const range = computeInlineEditRange(state);

    expect(range.selectedCode).toBe('');
    expect(range.selFrom).toBe(0);
    expect(range.selTo).toBe(0);
  });
});

// ── DEFECT #4: status bar cursor tracking ───────────────────────────

describe('cursorPositionFromState (DEFECT #4)', () => {
  it('reports line 1, col 1 at the start of the document', () => {
    const state = stateWithSelection('hello world', 0);
    expect(cursorPositionFromState(state)).toEqual({ line: 1, col: 1 });
  });

  it('reports the correct 1-based column mid-line', () => {
    const state = stateWithSelection('hello world', 5);
    expect(cursorPositionFromState(state)).toEqual({ line: 1, col: 6 });
  });

  it('reports the correct line/col after moving to a later line', () => {
    const doc = 'line1\nline2\nline3';
    const target = doc.indexOf('line3') + 3; // "lin[e]3" -> col 4
    const state = stateWithSelection(doc, target);
    expect(cursorPositionFromState(state)).toEqual({ line: 3, col: 4 });
  });

  it('uses the selection HEAD (not anchor) so a backward selection reports the caret end', () => {
    const doc = 'abcdef';
    // Anchor at 5, head at 2 — a backward selection; head determines the caret.
    const state = EditorState.create({ doc, selection: { anchor: 5, head: 2 } });
    expect(cursorPositionFromState(state)).toEqual({ line: 1, col: 3 });
  });
});

// ── DEFECT #3: Alt+Click adds a caret ────────────────────────────────
// CodeMirror 6's own default for "does this click add a selection range" is
// Ctrl+Click (Cmd+Click on Mac) — NOT Alt+Click — see addsSelectionRange()
// in node_modules/@codemirror/view. allowMultipleSelections alone (already
// present) does not remap this gesture, which is why Ctrl+D (keyboard,
// unrelated facet) worked while Alt+Click silently did nothing.

describe('altClickAddsSelectionRange (DEFECT #3)', () => {
  it('returns true for Alt+Click', () => {
    expect(altClickAddsSelectionRange({ altKey: true } as MouseEvent)).toBe(true);
  });

  it('returns false for a plain click', () => {
    expect(altClickAddsSelectionRange({ altKey: false } as MouseEvent)).toBe(false);
  });

  it('returns false for Ctrl+Click — the CM6 default this intentionally replaces', () => {
    expect(altClickAddsSelectionRange({ altKey: false, ctrlKey: true } as MouseEvent)).toBe(false);
  });

  it('resolves correctly through the real clickAddsSelectionRange facet when wired into an EditorState', () => {
    // Integration check: prove the predicate is actually reachable via the
    // exact facet EditorPane configures, not just correct in isolation.
    const state = EditorState.create({
      doc: 'hello',
      extensions: [EditorView.clickAddsSelectionRange.of(altClickAddsSelectionRange)],
    });
    const predicate = state.facet(EditorView.clickAddsSelectionRange)[0];
    expect(predicate({ altKey: true } as MouseEvent)).toBe(true);
    expect(predicate({ altKey: false, ctrlKey: true } as MouseEvent)).toBe(false);
  });
});

// ── Alt+F12 Peek Definition trigger ─────────────────────────────────
// offsetToLspPosition converts the CM6 cursor offset into the LSP-style
// {line, character} position sent as textDocument/definition's `position`
// param when Alt+F12 fires (see EditorPane's onKeyDown handler) — the same
// conversion Ctrl/Cmd-click's go-to-definition performs via lspClient.ts's
// own (unexported) offsetToPos, kept in sync here by construction.

describe('offsetToLspPosition (Alt+F12 Peek Definition trigger)', () => {
  it('reports 0-based line/character at the start of the document', () => {
    const view = new EditorView({ state: EditorState.create({ doc: 'hello world' }) });
    expect(offsetToLspPosition(view, 0)).toEqual({ line: 0, character: 0 });
  });

  it('reports the correct character offset mid-line', () => {
    const view = new EditorView({ state: EditorState.create({ doc: 'hello world' }) });
    expect(offsetToLspPosition(view, 6)).toEqual({ line: 0, character: 6 });
  });

  it('reports the correct 0-based line after later lines', () => {
    const doc = 'line1\nline2\nline3';
    const view = new EditorView({ state: EditorState.create({ doc }) });
    const target = doc.indexOf('line3') + 3; // "lin[e]3" on the 3rd line
    expect(offsetToLspPosition(view, target)).toEqual({ line: 2, character: 3 });
  });
});
