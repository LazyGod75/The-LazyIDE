/**
 * lspClient.ts — CodeMirror 6 integration for the platform LSP bridge.
 *
 * Provides:
 *  - Diagnostics (textDocument/publishDiagnostics) wired to @codemirror/lint
 *  - Hover tooltips (textDocument/hover) via CM6 hoverTooltip
 *  - Completion (textDocument/completion) via @codemirror/autocomplete
 *  - Go-to-definition on Ctrl/Cmd-click (textDocument/definition)
 *
 * CRITICAL HONESTY: when lsp.available() returns false (no binary, web mode)
 * this module returns an empty extension array so the editor is completely
 * unaffected. No LSP-dependent UI is shown and no errors are thrown.
 */

import {
  EditorView,
  hoverTooltip,
  keymap,
  Decoration,
  type Tooltip,
} from '@codemirror/view';
import { type Extension, StateEffect } from '@codemirror/state';
import { setDiagnosticsEffect, type Diagnostic } from '@codemirror/lint';
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  type Completion,
} from '@codemirror/autocomplete';
import type { Lsp } from '../../lib/platform/types';
import { stripVerbatimPrefix } from '../../lib/paths';
import { emit } from '../../lib/bus';
import { logLspActionFailure } from './lspActionErrors';

// ── LSP position helpers ───────────────────────────────────────────

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

function posToOffset(view: EditorView, pos: LspPosition): number {
  const lineCount = view.state.doc.lines;
  const lineNum = Math.min(pos.line + 1, lineCount);
  const line = view.state.doc.line(lineNum);
  return Math.min(line.from + pos.character, line.to);
}

function offsetToPos(view: EditorView, offset: number): LspPosition {
  const line = view.state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

// ── Severity mapping ──────────────────────────────────────────────

// LSP DiagnosticSeverity: 1=Error, 2=Warning, 3=Info, 4=Hint
function lspSeverityToCm(s: number): Diagnostic['severity'] {
  if (s === 1) return 'error';
  if (s === 2) return 'warning';
  return 'info';
}

// ── LSP response shapes (minimal) ────────────────────────────────

interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
}

interface LspPublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

interface LspHoverResult {
  contents: { kind?: string; value: string } | string | { value: string }[];
}

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind?: string; value: string };
  insertText?: string;
}

type LspCompletionResponse = LspCompletionItem[] | { items: LspCompletionItem[] } | null;

interface LspLocation {
  uri: string;
  range: LspRange;
}

// ── URI <-> path helpers ──────────────────────────────────────────

function pathToUri(path: string): string {
  // Strip a Windows verbatim (`\\?\`) prefix first — an LSP server has no
  // use for it and it would otherwise survive the backslash normalization
  // below as a doubled leading slash (`//?/C:/...`), producing a malformed
  // `file://` URI for any path sourced from Rust's canonicalize() (see
  // paths.ts's header for this bug class's history across the codebase).
  // Normalize: replace backslashes, add file:// prefix.
  const normalized = stripVerbatimPrefix(path).replace(/\\/g, '/');
  if (normalized.startsWith('/')) return `file://${normalized}`;
  // Windows absolute path like C:/...
  return `file:///${normalized}`;
}

function uriToPath(uri: string): string {
  // file:///C:/... -> C:/...  or  file:///path -> /path
  return uri.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1');
}

// ── Completion kind label mapping ─────────────────────────────────

// LSP CompletionItemKind values 1-25
const LSP_KIND_LABELS: Record<number, Completion['type']> = {
  1: 'text',
  2: 'method',
  3: 'function',
  4: 'constructor',
  5: 'variable',
  6: 'class',
  7: 'interface',
  8: 'module',
  9: 'property',
  10: 'unit',
  11: 'value',
  12: 'enum',
  13: 'keyword',
  14: 'snippet',
  15: 'text',
  16: 'color',
  17: 'file',
  18: 'reference',
  19: 'folder',
  20: 'enum',
  21: 'constant',
  22: 'class',
  23: 'function',
  24: 'variable',
  25: 'variable',
};

function lspKindToCm(kind?: number): Completion['type'] {
  if (!kind) return 'variable';
  return LSP_KIND_LABELS[kind] ?? 'variable';
}

// ── Hover tooltip extension ───────────────────────────────────────

function buildHoverExtension(lsp: Lsp, repoPath: string, language: string, filePath: string): Extension {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    const lspPos = offsetToPos(view, pos);
    let result: unknown;
    try {
      result = await lsp.request(repoPath, language, 'textDocument/hover', {
        textDocument: { uri: pathToUri(filePath) },
        position: lspPos,
      });
    } catch {
      return null;
    }

    if (!result) return null;
    const hover = result as LspHoverResult;

    let text = '';
    if (typeof hover.contents === 'string') {
      text = hover.contents;
    } else if (Array.isArray(hover.contents)) {
      text = hover.contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
    } else if (hover.contents && typeof hover.contents === 'object') {
      text = (hover.contents as { value: string }).value;
    }

    if (!text.trim()) return null;

    return {
      pos,
      above: true,
      create(): { dom: HTMLElement } {
        const dom = document.createElement('div');
        dom.className = 'lazy-lsp-hover';
        dom.style.cssText = [
          'background:#1A1A24',
          'border:1px solid rgba(124,92,255,0.3)',
          'border-radius:6px',
          'padding:6px 10px',
          'font-size:12px',
          'font-family:"JetBrains Mono",monospace',
          'color:#D5D8E0',
          'max-width:480px',
          'white-space:pre-wrap',
          'word-break:break-word',
          'box-shadow:0 4px 16px rgba(0,0,0,0.5)',
        ].join(';');
        dom.textContent = text;
        return { dom };
      },
    };
  });
}

// ── Completion source ─────────────────────────────────────────────

function buildCompletionSource(lsp: Lsp, repoPath: string, language: string, filePath: string) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!ctx.view) return null;
    const lspPos = offsetToPos(ctx.view, ctx.pos);
    let result: unknown;
    try {
      result = await lsp.request(repoPath, language, 'textDocument/completion', {
        textDocument: { uri: pathToUri(filePath) },
        position: lspPos,
        context: { triggerKind: ctx.explicit ? 1 : 2 },
      });
    } catch {
      return null;
    }

    if (!result) return null;
    const raw = result as LspCompletionResponse;
    const items: LspCompletionItem[] = Array.isArray(raw) ? raw : (raw as { items: LspCompletionItem[] }).items ?? [];

    if (!items.length) return null;

    const word = ctx.matchBefore(/\w*/);
    const from = word ? word.from : ctx.pos;

    const options: Completion[] = items.map((item) => ({
      label: item.label,
      type: lspKindToCm(item.kind),
      detail: item.detail,
      info: typeof item.documentation === 'string'
        ? item.documentation
        : item.documentation?.value,
      apply: item.insertText ?? item.label,
    }));

    return { from, options };
  };
}

// ── Go-to-definition on Ctrl/Cmd-click ────────────────────────────

function buildGotoDefinitionExtension(lsp: Lsp, repoPath: string, language: string, filePath: string): Extension {
  return EditorView.domEventHandlers({
    click(event, view) {
      if (!event.ctrlKey && !event.metaKey) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      const lspPos = offsetToPos(view, pos);

      lsp
        .request(repoPath, language, 'textDocument/definition', {
          textDocument: { uri: pathToUri(filePath) },
          position: lspPos,
        })
        .then((res) => {
          if (!res) return;
          // Result can be a Location, Location[], or LocationLink[]
          const locations: LspLocation[] = Array.isArray(res)
            ? (res as LspLocation[])
            : [res as LspLocation];

          const first = locations[0];
          if (!first) return;

          const targetPath = uriToPath(first.uri);
          const targetLine = (first.range?.start?.line ?? 0) + 1; // 1-based
          emit('editor:openFile', { path: targetPath, line: targetLine });
        })
        .catch(() => {
          // Definition unavailable — silently ignore.
        });

      return false; // do not prevent default selection
    },
  });
}

// ── Diagnostics subscription ──────────────────────────────────────

/**
 * Subscribe to publishDiagnostics notifications and push them into the
 * provided CM EditorView.  Returns the unsubscribe function.
 */
function subscribeDiagnostics(
  lsp: Lsp,
  filePath: string,
  getView: () => EditorView | null,
  onDiagnostics: (diags: Array<{ line: number; message: string; severity: 'error' | 'warning' | 'info' }>) => void,
): () => void {
  return lsp.onMessage((msg) => {
    if (msg.method !== 'textDocument/publishDiagnostics') return;

    const params = msg.params as LspPublishDiagnosticsParams;
    const targetPath = uriToPath(params.uri);

    // Only handle messages for the current file.
    if (targetPath !== filePath && params.uri !== pathToUri(filePath)) return;

    const view = getView();
    if (!view) return;

    // Map to store format for the Problems panel.
    const storeDiags = params.diagnostics.map((d) => ({
      line: d.range.start.line + 1,
      message: d.message,
      severity: lspSeverityToCm(d.severity ?? 1) as 'error' | 'warning' | 'info',
    }));
    onDiagnostics(storeDiags);

    // Map to CM6 Diagnostic format.
    const cmDiags: Diagnostic[] = params.diagnostics.map((d) => {
      const from = posToOffset(view, d.range.start);
      const to = Math.max(from + 1, posToOffset(view, d.range.end));
      return {
        from,
        to,
        severity: lspSeverityToCm(d.severity ?? 1),
        message: d.message,
        source: d.source,
      };
    });

    view.dispatch({ effects: [setDiagnosticsEffect.of(cmDiags)] as StateEffect<unknown>[] });
  });
}

// ── LSP types for extended features ─────────────────────────────────

interface TextEdit {
  range: LspRange;
  newText: string;
}

interface DocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: DocumentSymbol[];
}

interface WorkspaceSymbol {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

interface CallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
}

interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: LspRange[];
}

interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: LspRange[];
}

interface LspSignatureHelp {
  signatures: Array<{
    label: string;
    documentation?: string | { value: string };
    parameters?: Array<{ label: string; documentation?: string }>;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

interface LspCodeAction {
  title: string;
  kind?: string;
  edit?: { changes: Record<string, TextEdit[]> };
  command?: { command: string; title: string };
}

// ── Signature help extension ────────────────────────────────────────

function buildSignatureHelpExtension(lsp: Lsp, repoPath: string, language: string, filePath: string): Extension {
  return hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
    const lspPos = offsetToPos(view, pos);
    let result: unknown;
    try {
      result = await lsp.request(repoPath, language, 'textDocument/signatureHelp', {
        textDocument: { uri: pathToUri(filePath) },
        position: lspPos,
      });
    } catch { return null; }

    if (!result) return null;
    const sigHelp = result as LspSignatureHelp;
    if (!sigHelp.signatures?.length) return null;

    const sig = sigHelp.signatures[sigHelp.activeSignature ?? 0];
    if (!sig) return null;

    let text = sig.label;
    if (sig.documentation) {
      text += '\n\n' + (typeof sig.documentation === 'string' ? sig.documentation : sig.documentation.value);
    }

    return {
      pos,
      above: true,
      create(): { dom: HTMLElement } {
        const dom = document.createElement('div');
        dom.className = 'lazy-lsp-signature';
        dom.style.cssText = 'background:#1A1A24;border:1px solid rgba(124,92,255,0.3);border-radius:6px;padding:6px 10px;font-size:12px;font-family:"JetBrains Mono",monospace;color:#D5D8E0;max-width:480px;white-space:pre-wrap;box-shadow:0 4px 16px rgba(0,0,0,0.5)';
        dom.textContent = text;
        return { dom };
      },
    };
  });
}

// ── Code actions (lightbulb) extension ──────────────────────────────

function buildCodeActionExtension(lsp: Lsp, repoPath: string, language: string, filePath: string): Extension {
  return EditorView.domEventHandlers({
    click(event, view) {
      if (!event.ctrlKey && !event.metaKey) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const lspPos = offsetToPos(view, pos);

      lsp
        .request(repoPath, language, 'textDocument/codeAction', {
          textDocument: { uri: pathToUri(filePath) },
          range: { start: lspPos, end: lspPos },
          context: { diagnostics: [] },
        })
        .then((res) => {
          if (!res) return;
          const actions = res as LspCodeAction[];
          if (!actions?.length) return;
          // Apply first quick fix
          const action = actions[0];
          if (action.edit) {
            for (const [uri, edits] of Object.entries(action.edit.changes)) {
              if (uri === pathToUri(filePath)) {
                for (const edit of edits) {
                  const from = posToOffset(view, edit.range.start);
                  const to = posToOffset(view, edit.range.end);
                  view.dispatch({ changes: { from, to, insert: edit.newText } });
                }
              }
            }
          }
        })
        .catch((error: unknown) => {
          // User-initiated (ctrl/cmd-click): a failed request must not be
          // silent — nothing else surfaces this to the user or to logs.
          logLspActionFailure('codeAction', { filePath, language }, error);
        });

      return false;
    },
  });
}

// ── Rename symbol extension (F2) ────────────────────────────────────

function buildRenameExtension(lsp: Lsp, repoPath: string, language: string, filePath: string): Extension {
  return keymap.of([{
    key: 'F2',
    run(view: EditorView): boolean {
      const sel = view.state.selection.main;
      const lspPos = offsetToPos(view, sel.head);

      lsp
        .request(repoPath, language, 'textDocument/prepareRename', {
          textDocument: { uri: pathToUri(filePath) },
          position: lspPos,
        })
        .then((prep) => {
          if (!prep) return null;
          const newName = window.prompt('Rename to:');
          if (!newName) return null;
          return lsp.request(repoPath, language, 'textDocument/rename', {
            textDocument: { uri: pathToUri(filePath) },
            position: lspPos,
            newName,
          });
        })
        .then((res) => {
          if (!res) return;
          const edit = res as { changes: Record<string, TextEdit[]> };
          if (edit.changes) {
            for (const [uri, edits] of Object.entries(edit.changes)) {
              if (uri === pathToUri(filePath)) {
                for (const editItem of edits) {
                  const from = posToOffset(view, editItem.range.start);
                  const to = posToOffset(view, editItem.range.end);
                  view.dispatch({ changes: { from, to, insert: editItem.newText } });
                }
              }
            }
          }
        })
        .catch((error: unknown) => {
          // User-initiated (F2): a failed rename must not be silent — the
          // user pressed a key expecting a visible edit or a visible error.
          logLspActionFailure('rename', { filePath, language }, error);
        });

      return true;
    },
  }]);
}

// ── Inlay hints extension ───────────────────────────────────────────

function buildInlayHintExtension(_lsp: Lsp, _repoPath: string, _language: string, _filePath: string): Extension {
  return EditorView.decorations.of(() => {
    return Decoration.none;
  });
}

// ── Public API ─────────────────────────────────────────────────────

export interface LspClientOptions {
  lsp: Lsp;
  repoPath: string;
  filePath: string;
  language: string;
  /** Called with fresh diagnostics whenever publishDiagnostics arrives. */
  onDiagnostics: (
    diags: Array<{ line: number; message: string; severity: 'error' | 'warning' | 'info' }>
  ) => void;
}

export interface LspClientHandle {
  /** CM6 extensions to include in the editor. */
  extensions: Extension[];
  /** Call when the editor view is ready (or replaced). */
  bindView(view: EditorView): void;
  /** Notify LSP that the file was opened. */
  didOpen(content: string): void;
  /** Notify LSP that the file content changed. */
  didChange(content: string): void;
  /** Request document formatting from LSP. */
  formatDocument(): Promise<TextEdit[] | null>;
  /** Request organize imports from LSP. */
  organizeImports(): Promise<TextEdit[] | null>;
  /** Request document symbols (outline) from LSP. */
  documentSymbols(): Promise<DocumentSymbol[] | null>;
  /** Request workspace symbols from LSP. */
  workspaceSymbols(query: string): Promise<WorkspaceSymbol[] | null>;
  /** Prepare call hierarchy at a position. */
  prepareCallHierarchy(pos: LspPosition): Promise<CallHierarchyItem[] | null>;
  /** Get incoming calls for a call hierarchy item. */
  incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[] | null>;
  /** Get outgoing calls for a call hierarchy item. */
  outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[] | null>;
  /** Find references at a position. */
  references(pos: LspPosition): Promise<LspLocation[] | null>;
  /** Tear down subscriptions and stop the LSP server. */
  dispose(): void;
}

/**
 * Create an LSP client handle.
 *
 * Returns null if lsp.available(language) is false — caller must check and
 * treat null as "LSP not available; use editor without LSP features".
 */
export async function createLspClient(
  opts: LspClientOptions,
): Promise<LspClientHandle | null> {
  const { lsp, repoPath, filePath, language, onDiagnostics } = opts;

  const isAvailable = await lsp.available(language).catch(() => false);
  if (!isAvailable) return null;

  const started = await lsp.start(repoPath, language).catch(() => false);
  if (!started) return null;

  // Send the LSP initialize handshake before any other requests.
  try {
    await lsp.request(repoPath, language, 'initialize', {
      processId: null,
      clientInfo: { name: 'Lazy IDE', version: '0.1.0' },
      rootUri: pathToUri(repoPath),
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ['plaintext'] },
          completion: {
            completionItem: { snippetSupport: false },
          },
          signatureHelp: {
            signatureInformation: {
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'source.organizeImports'],
              },
            },
          },
          rename: { prepareSupport: true },
          formatting: {},
          rangeFormatting: {},
          organizeImports: {},
          inlayHint: {},
          semanticTokens: { dynamicRegistration: false },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: { dynamicRegistration: false },
        },
        workspace: {
          didChangeConfiguration: { dynamicRegistration: false },
          symbol: {},
        },
      },
      trace: 'off',
      workspaceFolders: null,
    });
    await lsp.notify(repoPath, language, 'initialized', {});
  } catch {
    // Server rejected initialize — proceed without LSP features.
    return null;
  }

  let currentView: EditorView | null = null;
  let version = 0;

  const completionSource = buildCompletionSource(lsp, repoPath, language, filePath);

  const extensions: Extension[] = [
    buildHoverExtension(lsp, repoPath, language, filePath),
    autocompletion({ override: [completionSource] }),
    buildGotoDefinitionExtension(lsp, repoPath, language, filePath),
    buildSignatureHelpExtension(lsp, repoPath, language, filePath),
    buildCodeActionExtension(lsp, repoPath, language, filePath),
    buildRenameExtension(lsp, repoPath, language, filePath),
    buildInlayHintExtension(lsp, repoPath, language, filePath),
  ];

  const unsubDiag = subscribeDiagnostics(
    lsp,
    filePath,
    () => currentView,
    onDiagnostics,
  );

  return {
    extensions,

    bindView(view: EditorView): void {
      currentView = view;
    },

    didOpen(content: string): void {
      version += 1;
      lsp
        .notify(repoPath, language, 'textDocument/didOpen', {
          textDocument: {
            uri: pathToUri(filePath),
            languageId: language,
            version,
            text: content,
          },
        })
        // Best-effort: an LSP notification has no response by protocol
        // design — a delivery failure has no distinct recovery action, and
        // this module's own contract (see file header) is that LSP being
        // unavailable/misbehaving degrades features silently, never breaks
        // editing.
        .catch(() => {});
    },

    didChange(content: string): void {
      version += 1;
      lsp
        .notify(repoPath, language, 'textDocument/didChange', {
          textDocument: { uri: pathToUri(filePath), version },
          contentChanges: [{ text: content }],
        })
        // Best-effort, same reasoning as didOpen above — fires on every
        // keystroke, so logging each failure would spam the console for a
        // condition the user cannot act on.
        .catch(() => {});
    },

    async formatDocument(): Promise<TextEdit[] | null> {
      try {
        const result = await lsp.request(repoPath, language, 'textDocument/formatting', {
          textDocument: { uri: pathToUri(filePath) },
          options: { tabSize: 2, insertSpaces: true },
        });
        return (result as TextEdit[] | null);
      } catch { return null; }
    },

    async organizeImports(): Promise<TextEdit[] | null> {
      try {
        const result = await lsp.request(repoPath, language, 'textDocument/organizeImports', {
          textDocument: { uri: pathToUri(filePath) },
          options: {},
        });
        return (result as TextEdit[] | null);
      } catch { return null; }
    },

    async documentSymbols(): Promise<DocumentSymbol[] | null> {
      try {
        const result = await lsp.request(repoPath, language, 'textDocument/documentSymbol', {
          textDocument: { uri: pathToUri(filePath) },
        });
        return (result as DocumentSymbol[] | null);
      } catch { return null; }
    },

    async workspaceSymbols(query: string): Promise<WorkspaceSymbol[] | null> {
      try {
        const result = await lsp.request(repoPath, language, 'workspace/symbol', { query });
        return (result as WorkspaceSymbol[] | null);
      } catch { return null; }
    },

    async prepareCallHierarchy(pos: LspPosition): Promise<CallHierarchyItem[] | null> {
      try {
        const result = await lsp.request(repoPath, language, 'textDocument/prepareCallHierarchy', {
          textDocument: { uri: pathToUri(filePath) },
          position: pos,
        });
        return (result as CallHierarchyItem[] | null);
      } catch { return null; }
    },

    async incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[] | null> {
      try {
        const result = await lsp.request(repoPath, language, 'callHierarchy/incomingCalls', { item });
        return (result as CallHierarchyIncomingCall[] | null);
      } catch { return null; }
    },

    async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[] | null> {
      try {
        const result = await lsp.request(repoPath, language, 'callHierarchy/outgoingCalls', { item });
        return (result as CallHierarchyOutgoingCall[] | null);
      } catch { return null; }
    },

    async references(pos: LspPosition): Promise<LspLocation[] | null> {
      try {
        const result = await lsp.request(repoPath, language, 'textDocument/references', {
          textDocument: { uri: pathToUri(filePath) },
          position: pos,
          context: { includeDeclaration: true },
        });
        return (result as LspLocation[] | null);
      } catch { return null; }
    },

    dispose(): void {
      unsubDiag();
      lsp
        .notify(repoPath, language, 'textDocument/didClose', {
          textDocument: { uri: pathToUri(filePath) },
        })
        // Best-effort cleanup notification during dispose — same reasoning
        // as didOpen/didChange above; the editor is going away regardless.
        .catch(() => {});
      // LSP protocol: shutdown must be a request, then exit is a notification.
      lsp
        .request(repoPath, language, 'shutdown', null)
        .then(() => lsp.notify(repoPath, language, 'exit', {}))
        .catch(() => {
          // Server may already be dead — send exit anyway, best-effort
          // (dispose() has no caller left to report back to either way).
          lsp.notify(repoPath, language, 'exit', {}).catch(() => {});
        });
    },
  };
}

// ── Language detection ────────────────────────────────────────────

/** Derive the LSP languageId from a filename. */
export function languageIdFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    rs: 'rust',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
  };
  return map[ext] ?? ext;
}
