/* canvasClipboard.ts — module-level clipboard for Ctrl+C/Ctrl+V (spec §5
   "copy/paste (Ctrl+C/V) of draft specs"). Deliberately plain module state,
   NOT canvasStore: the clipboard is ephemeral UI state (never persisted,
   never part of undo/redo history, cleared on full page reload) —
   canvasStore.ts is a hard boundary this wave and its own header is
   explicit that it owns only geometry + canvas-owned FACTS (positions,
   drafts, chains, notes, prefs), not transient "what's on the clipboard
   right now" UI state that has no business surviving a session restart or
   being undoable.
*/

import type { DraftSpec, NoteData } from './canvasTypes';

export type ClipboardEntry =
  | { kind: 'draft'; spec: Omit<DraftSpec, 'id'> }
  | { kind: 'note'; spec: Omit<NoteData, 'id'> };

let clipboard: ClipboardEntry[] = [];

export function writeClipboard(entries: ClipboardEntry[]): void {
  clipboard = entries;
}

export function readClipboard(): readonly ClipboardEntry[] {
  return clipboard;
}

export function hasClipboardContent(): boolean {
  return clipboard.length > 0;
}

/** Test-only reset — mirrors canvasStore.ts's _resetCanvasStoreForTests
 *  convention (module-level state needs an explicit reset between tests
 *  that assert on clipboard content). */
export function _resetClipboardForTests(): void {
  clipboard = [];
}
