import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { lineNumbers, keymap, highlightSpecialChars, drawSelection, highlightActiveLine, highlightActiveLineGutter, rectangularSelection, crosshairCursor } from '@codemirror/view';
import { bracketMatching, foldGutter, indentOnInput, indentUnit } from '@codemirror/language';
import { defaultKeymap, historyKeymap, history, indentWithTab } from '@codemirror/commands';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, search, openSearchPanel } from '@codemirror/search';
import { lazyTheme } from './lazyTheme';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEditorStore, type FileDiagnostic } from './editorStore';
import { useAppContext } from '../../app/AppContext';
import {
  createLspClient,
  languageIdFromFilename,
  type LspClientHandle,
} from './lspClient';
import { SymbolPicker } from './SymbolPicker';
import { InlineEditBar } from './InlineEditBar';
import { InlineDiffPreview } from './InlineDiffPreview';
import { BreadcrumbBar } from './BreadcrumbBar';
import { findOwningProject } from '../../lib/agents/projectForPath';
import { GoToLineModal } from './GoToLineModal';
import { MarkdownPreview } from './MarkdownPreview';
import { PeekDefinition } from './PeekDefinition';
import { aiCompletion } from './aiCompletion';
import { emit } from '../../lib/bus';
import type { CursorPosition } from '../../lib/bus';
import { getProvider, describeProviderReadiness, loadAccessSettings } from '../../lib/models';
import { useLazyRules } from '../../lib/ai/lazyRules';
import { useShortcut, SHORTCUT_PRIORITY } from '../../lib/shortcuts';
import { useI18n } from '../../i18n';

interface EditorPaneProps {
  value: string;
  filename: string;
  path: string;
  onChange: (value: string) => void;
  /** Optional initial line to scroll to (1-based). */
  focusLine?: number | null;
}

interface InlineEditState {
  selectedCode: string;
  language: string;
  selFrom: number;
  selTo: number;
  fullContent: string;
}

/** Convert a CodeMirror diagnostic severity to our store severity type. */
function cmSeverityToStore(s: Diagnostic['severity']): FileDiagnostic['severity'] {
  if (s === 'error') return 'error';
  if (s === 'warning') return 'warning';
  return 'info';
}

interface LangAndLinters {
  lang: Extension | null;
  /** Source function for linting (null if no lint support). */
  lintSource: ((view: EditorView) => Diagnostic[] | Promise<Diagnostic[]>) | null;
}

function getLanguageAndLintSource(filename: string): LangAndLinters {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return { lang: javascript({ typescript: true, jsx: true }), lintSource: null };
    case 'json':
      return { lang: json(), lintSource: jsonParseLinter() };
    case 'md':
      return { lang: markdown(), lintSource: null };
    case 'css':
      return { lang: css(), lintSource: null };
    case 'html':
      return { lang: html(), lintSource: null };
    case 'py':
      return { lang: python(), lintSource: null };
    case 'rs':
      return { lang: rust(), lintSource: null };
    default:
      return { lang: null, lintSource: null };
  }
}

function posToOffsetSimple(view: EditorView, pos: { line: number; character: number }): number {
  const line = view.state.doc.line(Math.min(pos.line + 1, view.state.doc.lines));
  return Math.min(line.from + pos.character, line.to);
}

/** Inverse of posToOffsetSimple — CM6 document offset to an LSP-style
 *  0-based {line, character} position, for the Alt+F12 Peek Definition
 *  request below. Exported for unit testing. */
export function offsetToLspPosition(view: EditorView, offset: number): { line: number; character: number } {
  const line = view.state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

/** Ctrl+K target range. An explicit selection is used as-is; with no
 *  selection, falls back to the CURRENT LINE instead of the whole file —
 *  keeps the AI edit scoped to something sensible and closes a data-loss
 *  hole: when selFrom === selTo, InlineEditBar.handleSubmit's
 *  `selFrom !== selTo` check takes the "no selection" branch and replaces
 *  the ENTIRE document with nothing but the model's raw output. Falling
 *  back to the line range instead means selFrom !== selTo in the
 *  overwhelming majority of cases, so the normal splice path is used and
 *  only that line is replaced. Exported for unit testing. */
export function computeInlineEditRange(state: EditorState): {
  selFrom: number;
  selTo: number;
  selectedCode: string;
  fullContent: string;
} {
  const sel = state.selection.main;
  const fullContent = state.doc.toString();
  if (sel.from !== sel.to) {
    return { selFrom: sel.from, selTo: sel.to, selectedCode: state.sliceDoc(sel.from, sel.to), fullContent };
  }
  const line = state.doc.lineAt(sel.from);
  return { selFrom: line.from, selTo: line.to, selectedCode: line.text, fullContent };
}

/** 1-based line/col cursor position for the status bar (see StatusBar.tsx).
 *  Exported for unit testing. */
export function cursorPositionFromState(state: EditorState): CursorPosition {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1 };
}

/** Alt+Click adds a caret (Cursor/VSCode convention). CodeMirror's OWN
 *  default for "does this click add a selection range" is Ctrl+Click
 *  (Cmd+Click on Mac) — see EditorView.clickAddsSelectionRange usage in
 *  staticExtensions below, and addsSelectionRange() in @codemirror/view.
 *  allowMultipleSelections alone (already enabled) is only a prerequisite;
 *  without this facet the click gesture is never remapped, so Alt+Click did
 *  nothing while Ctrl+D (keyboard-only, unaffected by this facet) worked —
 *  DEFECT #3. Exported for unit testing. */
export function altClickAddsSelectionRange(event: MouseEvent): boolean {
  return event.altKey;
}

export function EditorPane({ value, filename, path, onChange, focusLine }: EditorPaneProps) {
  const { t } = useI18n();
  const { setDiagnostics } = useEditorStore();
  const { platform, projectRoot, openProjects } = useAppContext();
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  // The open project that actually owns `path` — NOT necessarily the same
  // as `projectRoot` above (the app's single "current" project from
  // context, used for the LSP workspace root), since a multi-project
  // session can have this tab's file living under a DIFFERENT open
  // project. Drives the breadcrumb's project-relative rendering (see
  // BreadcrumbBar.tsx's `projectRoot` prop) via the same findOwningProject
  // helper CodeSpace.tsx/CodeStatusBar already use for the status bar's
  // project name, so both bars agree on which project a file belongs to.
  const fileProject = findOwningProject(path, openProjects);

  // LSP client handle — null when LSP is unavailable.
  const lspHandleRef = useRef<LspClientHandle | null>(null);
  // Extra CM6 extensions provided by LSP (hover, completion, go-to-def).
  const [lspExtensions, setLspExtensions] = useState<Extension[]>([]);
  // Symbol picker visibility.
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  // Focus line set by symbol picker jump.
  const [symbolFocusLine, setSymbolFocusLine] = useState<number | null>(null);
  // Inline edit bar (Ctrl+K).
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  // Go to line modal (Ctrl+G).
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  // Inline diff preview state.
  const [diffPreview, setDiffPreview] = useState<{ original: string; proposed: string; selFrom: number; selTo: number } | null>(null);
  // Markdown preview toggle.
  const [showMdPreview, setShowMdPreview] = useState(false);
  // Peek Definition overlay (Alt+F12) — distinct from Ctrl/Cmd-click's
  // navigate-to-definition in lspClient.ts, which replaces the open tab.
  const [peek, setPeek] = useState<{ filePath: string; position: { line: number; character: number } } | null>(null);
  // Lazy rules context — injected into AI completions and inline edits.
  const { rules: lazyRules } = useLazyRules(projectRoot);

  // Keep stable refs so extension closures don't need to re-create on every render.
  const setDiagnosticsRef = useRef(setDiagnostics);
  const pathRef = useRef(path);
  const filenameRef = useRef(filename);

  useLayoutEffect(() => {
    setDiagnosticsRef.current = setDiagnostics;
    pathRef.current = path;
    filenameRef.current = filename;
  });

  // ── LSP lifecycle: create / dispose on file change ───────────────

  useEffect(() => {
    let disposed = false;
    let handle: LspClientHandle | null = null;

    const language = languageIdFromFilename(filename);

    createLspClient({
      lsp: platform.lsp,
      repoPath: projectRoot || '.',
      filePath: path,
      language,
      onDiagnostics(diags) {
        if (disposed) return;
        setDiagnosticsRef.current(pathRef.current, filenameRef.current, diags);
      },
    }).then((h) => {
      if (disposed) {
        h?.dispose();
        return;
      }
      handle = h;
      lspHandleRef.current = h;

      if (h) {
        // Wire current view if already mounted.
        const view = editorRef.current?.view ?? null;
        if (view) h.bindView(view);

        // Notify LSP of the file being opened.
        h.didOpen(value);

        setLspExtensions(h.extensions);
      } else {
        setLspExtensions([]);
      }
    }).catch(() => {
      // LSP unavailable — silently continue with no extensions.
      setLspExtensions([]);
    });

    return () => {
      disposed = true;
      handle?.dispose();
      lspHandleRef.current = null;
      setLspExtensions([]);
    };
  // Intentionally depend on path + filename only — re-init when file changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, filename, platform.lsp, projectRoot]);

  // Notify LSP of content changes.
  useEffect(() => {
    lspHandleRef.current?.didChange(value);
  }, [value]);

  // Bind LSP to CM view when it mounts/updates.
  useEffect(() => {
    const view = editorRef.current?.view ?? null;
    if (view && lspHandleRef.current) {
      lspHandleRef.current.bindView(view);
    }
  });

  // ── Static linter (JSON parse, etc.) ────────────────────────────

  const buildLinterExtension = useCallback(
    (lintSource: (view: EditorView) => Diagnostic[] | Promise<Diagnostic[]>): Extension => {
      const wrappedSource = async (view: EditorView): Promise<Diagnostic[]> => {
        const raw = lintSource(view);
        const diags: Diagnostic[] = await Promise.resolve(raw);
        const items = diags.map(d => ({
          line: view.state.doc.lineAt(d.from).number,
          message: d.message,
          severity: cmSeverityToStore(d.severity),
        }));
        setDiagnosticsRef.current(pathRef.current, filenameRef.current, items);
        return diags;
      };
      return linter(wrappedSource, { delay: 300 });
    },
    [],
  );

  const staticExtensions = useMemo(() => {
    const { lang, lintSource } = getLanguageAndLintSource(filename);
    const base: Extension[] = [
      lineNumbers(),
      lintGutter(),
      bracketMatching(),
      foldGutter(),
      closeBrackets(),
      indentOnInput(),
      indentUnit.of('  '),
      history(),
      // Multi-cursor support (Ctrl+D select-next-occurrence, Alt+Click carets).
      // allowMultipleSelections is a PREREQUISITE, not the whole story: off by
      // default in CM6 when basicSetup is disabled, transactions would
      // otherwise silently collapse any multi-range selection to a single
      // range (see EditorState.allowMultipleSelections in @codemirror/state).
      // It does NOT by itself remap the click gesture that ADDS a caret —
      // CodeMirror's own default for "does this click add a range" is
      // Ctrl+Click (Cmd+Click on Mac), via the separate clickAddsSelectionRange
      // facet (see addsSelectionRange in @codemirror/view). Cursor/VSCode use
      // Alt+Click instead, so it is remapped explicitly here.
      EditorState.allowMultipleSelections.of(true),
      EditorView.clickAddsSelectionRange.of(altClickAddsSelectionRange),
      drawSelection(),
      highlightSpecialChars(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      rectangularSelection(),
      crosshairCursor(),
      search({ top: true }),
      // Cursor tracking for the status bar (see StatusBar.tsx). Fires on every
      // selection change, not just document edits — the CodeMirror `onChange`
      // prop below only fires when the document changes, so pure cursor
      // movement (arrow keys, clicking, Home/End, Go to Line) never reached
      // it, leaving "Ln X, Col Y" stuck at the pre-move position (DEFECT #4).
      EditorView.updateListener.of(update => {
        if (!update.docChanged && !update.selectionSet) return;
        emit('editor:cursor', cursorPositionFromState(update.state));
      }),
      keymap.of([
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...closeBracketsKeymap,
        indentWithTab,
      ]),
      ...lazyTheme,
    ];
    if (lang) base.push(lang);
    // eslint-disable-next-line react-hooks/refs
    if (lintSource) base.push(buildLinterExtension(lintSource));
    return base;
  }, [filename, buildLinterExtension]);

  // AI completion extension (ghost text).
  const aiExt = useMemo(() => {
    const langId = languageIdFromFilename(filename);
    return aiCompletion({
      language: langId,
      filename,
      debounceMs: 800,
      async fetchCompletion({ textBefore, textAfter, language: lang, filename: fname, signal }) {
        const readiness = describeProviderReadiness(undefined, t);
        if (!readiness.ready) return '';
        try {
          const provider = getProvider(t);
          const userSettings = loadAccessSettings();
          const completionModelId = userSettings.model ?? 'claude-haiku-4-5';
          const completionModel = {
            id: completionModelId,
            label: 'Completion Model',
            provider: 'anthropic' as const,
          };
          const rulesHint = lazyRules ? `\n\nProject rules:\n${lazyRules.slice(0, 500)}` : '';
          let accumulated = '';
          const stream = provider.streamChat({
            messages: [
              { id: 'ai-comp-u', role: 'user', content: `Complete the code in ${fname} (${lang}). Return ONLY the completion text, no explanation, no markdown fences.\n\nCode before cursor:\n\`${'`'}${'`'}${'`'}${lang}\n${textBefore.slice(-800)}\n${'`'}${'`'}${'`'}\n\nCode after cursor:\n\`${'`'}${'`'}${'`'}\n${textAfter.slice(0, 200)}\n${'`'}${'`'}${'`'}\n\nProvide the text that should be inserted at the cursor position:${rulesHint}` },
            ],
            model: completionModel,
            mode: 'ask',
            signal,
          });
          for await (const token of stream) {
            if (signal.aborted) break;
            accumulated += token;
          }
          return accumulated.replace(/^[\s\n]+/, '').split('\n')[0] ?? '';
        } catch {
          return '';
        }
      },
    });
  }, [filename, lazyRules, t]);

  // Merge static + LSP + AI extensions.
  const extensions = useMemo(
    () => [...staticExtensions, ...lspExtensions, aiExt],
    [staticExtensions, lspExtensions, aiExt],
  );

  // ── Scroll to focusLine (from bus or symbol picker) ─────────────

  const effectiveFocusLine = focusLine ?? symbolFocusLine;

  useEffect(() => {
    if (!effectiveFocusLine || !editorRef.current?.view) return;
    const view = editorRef.current.view;
    const lineCount = view.state.doc.lines;
    const targetLine = Math.min(effectiveFocusLine, lineCount);
    const line = view.state.doc.line(targetLine);
    view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    view.focus();
    setSymbolFocusLine(null);
  }, [effectiveFocusLine]);

  // ── Ctrl+K inline edit ────────────────────────────────────────────
  //
  // Registered on the shared shortcut registry instead of this file's own
  // window keydown listener below, because Mod+K is also the global command
  // palette's shortcut (see AppShell.tsx). The registry's priority system
  // resolves the collision deterministically: this registration only
  // becomes eligible while the CodeMirror view actually has focus (matching
  // the previous `view.hasFocus` guard exactly), and it uses
  // SHORTCUT_PRIORITY.SCOPED so it wins over the palette's
  // SHORTCUT_PRIORITY.GLOBAL registration whenever both are eligible.
  // Previously this disambiguation also relied on a second, independent
  // check in AppShell (`event.target.closest('.cm-editor')`) — that check
  // is now redundant and has been removed there, since `view.hasFocus` is
  // the single source of truth both listeners were really trying to infer.
  useShortcut(
    {
      id: 'editor.inlineEdit',
      combo: 'Mod+K',
      when: () => Boolean(editorRef.current?.view?.hasFocus),
      priority: SHORTCUT_PRIORITY.SCOPED,
    },
    () => {
      const view = editorRef.current?.view;
      if (!view) return;
      const { selFrom, selTo, selectedCode, fullContent } = computeInlineEditRange(view.state);
      // Explicitly release focus from the CodeMirror content element before
      // the prompt bar mounts. CodeMirror still owns DOM focus at this exact
      // point (the shortcut only fires while `view.hasFocus` is true), so
      // without this, any keystroke typed before InlineEditBar's own
      // useLayoutEffect claims focus could land in the document instead of
      // the prompt — see DEFECT #2 in InlineEditBar.tsx.
      view.contentDOM.blur();
      setInlineEdit({
        selectedCode,
        language: languageIdFromFilename(filename),
        selFrom,
        selTo,
        fullContent,
      });
    },
  );

  // ── Keyboard shortcuts (Symbol picker, Go to Line, Search, Ctrl+L send to
  //    chat, formatting, markdown preview) ──────────────────────────
  //
  // Ctrl+K inline edit used to live here too — it moved to the useShortcut()
  // call above so it can be arbitrated against the global command palette by
  // the shared registry instead of an ad-hoc per-file focus guard.

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toUpperCase() === 'O') {
        e.preventDefault();
        setSymbolPickerOpen((prev) => !prev);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        setGoToLineOpen(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        const view = editorRef.current?.view;
        if (!view) return;
        openSearchPanel(view);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        const view = editorRef.current?.view;
        if (!view) return;
        const sel = view.state.selection.main;
        const selectedCode = sel.from !== sel.to
          ? view.state.sliceDoc(sel.from, sel.to)
          : '';
        if (selectedCode) {
          emit('editor:selectionToChat', {
            code: selectedCode,
            filename,
            language: languageIdFromFilename(filename),
          });
        }
        return;
      }
      if (e.key === 'Escape') {
        setSymbolPickerOpen(false);
        setInlineEdit(null);
        setGoToLineOpen(false);
        setDiffPreview(null);
        setShowMdPreview(false);
        setPeek(null);
      }
      // Alt+F12 — Peek Definition (VSCode convention). Distinct from
      // Ctrl/Cmd-click's navigate-to-definition (lspClient.ts:247-282),
      // which is left untouched: that gesture still jumps the open tab to
      // the definition, this one shows it inline without leaving the file.
      if (e.altKey && e.key === 'F12') {
        e.preventDefault();
        const view = editorRef.current?.view;
        if (!view) return;
        const offset = view.state.selection.main.head;
        setPeek({ filePath: pathRef.current, position: offsetToLspPosition(view, offset) });
        return;
      }
      // Shift+Alt+F — Format document via LSP
      if (e.shiftKey && e.altKey && e.key.toUpperCase() === 'F') {
        e.preventDefault();
        const handle = lspHandleRef.current;
        if (!handle) return;
        handle.formatDocument().then(edits => {
          if (!edits || edits.length === 0) return;
          const view = editorRef.current?.view;
          if (!view) return;
          const changes = edits.map(edit => ({
            from: posToOffsetSimple(view, edit.range.start),
            to: posToOffsetSimple(view, edit.range.end),
            insert: edit.newText,
          }));
          view.dispatch({ changes });
        });
      }
      // Shift+Alt+O — Organize imports via LSP
      if (e.shiftKey && e.altKey && e.key.toUpperCase() === 'O') {
        e.preventDefault();
        const handle = lspHandleRef.current;
        if (!handle) return;
        handle.organizeImports().then(edits => {
          if (!edits || edits.length === 0) return;
          const view = editorRef.current?.view;
          if (!view) return;
          const changes = edits.map(edit => ({
            from: posToOffsetSimple(view, edit.range.start),
            to: posToOffsetSimple(view, edit.range.end),
            insert: edit.newText,
          }));
          view.dispatch({ changes });
        });
      }
      // Ctrl+Shift+V — Toggle markdown preview
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toUpperCase() === 'V') {
        e.preventDefault();
        const ext = filename.split('.').pop()?.toLowerCase() ?? '';
        if (ext === 'md' || ext === 'markdown') {
          setShowMdPreview(prev => !prev);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filename]);

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Breadcrumb bar */}
      <BreadcrumbBar
        path={path}
        filename={filename}
        lsp={platform.lsp}
        repoPath={projectRoot || '.'}
        projectRoot={fileProject?.root ?? null}
        language={languageIdFromFilename(filename)}
        onJump={(line) => setSymbolFocusLine(line)}
      />

      {/* Symbol picker overlay */}
      {symbolPickerOpen && (
        <SymbolPicker
          lsp={platform.lsp}
          repoPath={projectRoot || '.'}
          language={languageIdFromFilename(filename)}
          filePath={path}
          onJump={(line) => setSymbolFocusLine(line)}
          onClose={() => setSymbolPickerOpen(false)}
        />
      )}

      {/* Go to line modal */}
      {goToLineOpen && (
        <GoToLineModal
          lineCount={editorRef.current?.view?.state.doc.lines ?? 1}
          onGo={(line) => {
            setSymbolFocusLine(line);
            setGoToLineOpen(false);
          }}
          onClose={() => setGoToLineOpen(false)}
        />
      )}

      {/* Inline edit bar (Ctrl+K) */}
      {inlineEdit && (
        <InlineEditBar
          selectedCode={inlineEdit.selectedCode}
          filename={filename}
          language={inlineEdit.language}
          filePath={path}
          selFrom={inlineEdit.selFrom}
          selTo={inlineEdit.selTo}
          fullContent={inlineEdit.fullContent}
          onDone={() => setInlineEdit(null)}
          onProposeDiff={(proposed) => {
            setDiffPreview({
              original: inlineEdit.fullContent,
              proposed,
              selFrom: inlineEdit.selFrom,
              selTo: inlineEdit.selTo,
            });
            setInlineEdit(null);
          }}
        />
      )}

      {/* Peek Definition overlay (Alt+F12) */}
      {peek && (
        <PeekDefinition
          lsp={platform.lsp}
          repoPath={projectRoot || '.'}
          language={languageIdFromFilename(filename)}
          filePath={peek.filePath}
          position={peek.position}
          onClose={() => setPeek(null)}
        />
      )}

      {/* Inline diff preview */}
      {diffPreview && (
        <InlineDiffPreview
          original={diffPreview.original}
          proposed={diffPreview.proposed}
          filename={filename}
          language={languageIdFromFilename(filename)}
          onAccept={() => {
            emit('editor:applyEdit', {
              proposedContent: diffPreview.proposed,
              path,
              language: languageIdFromFilename(filename),
            });
            setDiffPreview(null);
          }}
          onReject={() => setDiffPreview(null)}
        />
      )}

      {/* Markdown preview */}
      {showMdPreview && (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <CodeMirror
              ref={editorRef}
              value={value}
              height="100%"
              extensions={extensions}
              onChange={(val) => onChange(val)}
              style={{
                flex: 1,
                height: '100%',
                fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
                fontSize: '12px',
              }}
              basicSetup={false}
              theme="none"
            />
          </div>
          <div style={{ flex: 1, borderLeft: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)', fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
              <span>Preview</span>
              <button onClick={() => setShowMdPreview(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 14 }}>×</button>
            </div>
            <MarkdownPreview content={value} filename={filename} />
          </div>
        </div>
      )}

      {!showMdPreview && (
      <CodeMirror
        ref={editorRef}
        value={value}
        height="100%"
        extensions={extensions}
        onChange={(val) => onChange(val)}
        style={{
          flex: 1,
          height: '100%',
          fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
          fontSize: '12px',
        }}
        basicSetup={false}
        theme="none"
      />
      )}
    </div>
  );
}
