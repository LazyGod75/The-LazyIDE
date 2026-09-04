/* aiCompletion.ts — CodeMirror 6 inline AI ghost text extension.
   Provides tab-to-accept inline completions using the model provider.
   Shows greyed-out ghost text that can be accepted with Tab.
*/

import { EditorView, WidgetType, keymap, Decoration, ViewPlugin, ViewUpdate } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { StateEffect, StateField, Annotation } from '@codemirror/state';
import type { Extension } from '@codemirror/state';

// ── State ────────────────────────────────────────────────────────

interface GhostTextState {
  text: string;
  from: number;
  to: number;
}

const setGhostText = StateEffect.define<GhostTextState | null>();
const clearGhostText = StateEffect.define<void>();

const ghostField = StateField.define<GhostTextState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    if (tr.effects.some(e => e.is(setGhostText))) {
      const eff = tr.effects.find(e => e.is(setGhostText));
      return eff ? (eff.value as GhostTextState) : null;
    }
    if (tr.effects.some(e => e.is(clearGhostText))) return null;
    if (tr.docChanged) return null;
    return value;
  },
});

// ── Widget ───────────────────────────────────────────────────────

class GhostTextWidget extends WidgetType {
  private _text: string;

  constructor(text: string) {
    super();
    this._text = text;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ghost-text';
    span.textContent = this._text;
    span.style.cssText = 'color: rgba(255,255,255,0.25); font-style: italic; pointer-events: none;';
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

const ghostDecoration = EditorView.baseTheme({
  '.cm-ghost-text': {
    color: 'rgba(255,255,255,0.25)',
    fontStyle: 'italic',
    pointerEvents: 'none',
  },
});

// ── Decoration plugin ────────────────────────────────────────────

const ghostPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.transactions.some(tr => tr.effects.length > 0)) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const ghost = view.state.field(ghostField, false);
      if (!ghost || !ghost.text) return Decoration.none;

      const hasSelection = view.state.selection.ranges.some(r => r.from !== r.to);
      if (hasSelection) return Decoration.none;

      const widget = Decoration.widget({
        widget: new GhostTextWidget(ghost.text),
        side: 1,
      });

      return Decoration.set([widget.range(ghost.to)]);
    }
  },
  { decorations: v => v.decorations },
);

// ── Completion fetcher ───────────────────────────────────────────

export interface AiCompletionConfig {
  fetchCompletion: (opts: {
    textBefore: string;
    textAfter: string;
    language: string;
    filename: string;
    signal: AbortSignal;
  }) => Promise<string>;
  language: string;
  filename: string;
  debounceMs?: number;
}

const tabAcceptAnnotation = Annotation.define<boolean>();

export function aiCompletion(config: AiCompletionConfig): Extension {
  const debounceMs = config.debounceMs ?? 600;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentAbort: AbortController | null = null;

  function fetchGhost(view: EditorView) {
    if (timer) clearTimeout(timer);
    if (currentAbort) currentAbort.abort();

    timer = setTimeout(async () => {
      const state = view.state;
      const pos = state.selection.main.head;
      const hasSelection = state.selection.ranges.some(r => r.from !== r.to);
      if (hasSelection) return;

      const doc = state.doc.toString();
      const textBefore = doc.slice(0, pos);
      const textAfter = doc.slice(pos);

      const lineBefore = textBefore.split('\n').pop() ?? '';
      if (lineBefore.trim().length === 0 && pos === 0) return;

      const abort = new AbortController();
      currentAbort = abort;

      try {
        const completion = await config.fetchCompletion({
          textBefore,
          textAfter,
          language: config.language,
          filename: config.filename,
          signal: abort.signal,
        });

        if (abort.signal.aborted) return;
        if (!completion || completion.length === 0) return;

        const currentPos = view.state.selection.main.head;
        if (currentPos !== pos) return;

        view.dispatch({
          effects: [setGhostText.of({ text: completion, from: pos, to: pos })],
        });
      } catch {
        // ignore — completion failed silently
      }
    }, debounceMs);
  }

  const ghostKeymap = keymap.of([
    {
      key: 'Tab',
      run(view: EditorView): boolean {
        const ghost = view.state.field(ghostField, false);
        if (!ghost || !ghost.text) return false;
        const insertText = ghost.text;
        view.dispatch({
          changes: { from: ghost.from, to: ghost.to, insert: insertText },
          selection: { anchor: ghost.from + insertText.length },
          effects: [clearGhostText.of()],
          annotations: [tabAcceptAnnotation.of(true)],
        });
        return true;
      },
    },
    {
      key: 'Escape',
      run(view: EditorView): boolean {
        const ghost = view.state.field(ghostField, false);
        if (!ghost) return false;
        view.dispatch({ effects: [clearGhostText.of()] });
        return true;
      },
    },
  ]);

  const updateListener = EditorView.updateListener.of(update => {
    if (update.docChanged || update.selectionSet) {
      const isTabAccept = update.transactions.some(tr =>
        tr.annotation(tabAcceptAnnotation) !== undefined
      );
      if (isTabAccept) return;
      update.view.dispatch({ effects: [clearGhostText.of()] });
      fetchGhost(update.view);
    }
  });

  return [
    ghostField,
    ghostPlugin,
    ghostDecoration,
    ghostKeymap,
    updateListener,
  ];
}
