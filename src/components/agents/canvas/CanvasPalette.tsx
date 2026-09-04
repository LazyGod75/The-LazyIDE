/* CanvasPalette.tsx — collapsible right-inside-canvas drawer (W2a, spec §5
   "palette drawer (existing agent library) → drag onto a project zone drops
   a Draft node pre-filled from the agent def").

   REUSES the agent library's own data source (`agentsStorage.listAgents()`)
   rather than duplicating AgentLibrary.tsx's full editing UI — this is a
   read-only picker: name, model tier, one-line description, drag or click
   to spawn a Draft. Full agent authoring stays in the existing library
   drawer (`onOpenLibrary`, CanvasToolbar's "Bibliothèque" chip).

   Rendered as a child of `<ReactFlow>` via `<Panel>` (same seam as
   CanvasToolbar — `Panel` positions itself against the RF viewport without
   any prop drilling for layout). Drag payload is a plain JSON string on a
   dedicated MIME type; CanvasView.tsx's onDrop handler (canvas pane level)
   reads it back and resolves the drop position via
   `screenToFlowPosition`/hit-testing against the current project zones —
   this component only knows how to LIST agents and START a drag, never how
   to place a node (that needs live node geometry this component doesn't
   have).
*/

import { memo, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Panel } from '@xyflow/react';
import { useI18n } from '../../../i18n';
import { listAgents, type StoredAgent } from '../../../lib/agents/agentsStorage';
import { MetaChip } from './chrome/nodeChrome';
import type { MacroSpec } from './canvasTypes';

/** MIME type carrying the drag payload — read back by CanvasView.tsx's
 *  onDrop handler. Namespaced so a stray drag from elsewhere in the app (or
 *  the OS) never accidentally matches. */
export const PALETTE_DRAG_MIME = 'application/x-lazy-canvas-palette-item';

/** Group macros — a SEPARATE MIME type (carries a bare macro id, not a
 *  PaletteDraftPayload) so useCanvasDnd.ts's onDrop can tell a macro drag
 *  apart from a normal agent-item drag without parsing JSON to guess. */
export const MACRO_DRAG_MIME = 'application/x-lazy-canvas-palette-macro';

/** What a palette entry contributes to a freshly-created DraftSpec — every
 *  field here maps 1:1 onto DraftSpec's own optional fields (canvasTypes.ts)
 *  minus `id`/`projectId`, which the drop/click handler assigns. */
export interface PaletteDraftPayload {
  title: string;
  task: string;
  agentName?: string;
  model?: string;
}

interface PaletteItem {
  id: string;
  title: string;
  description: string;
  model?: string;
  payload: PaletteDraftPayload;
}

/** Generic entry always present regardless of what the library holds (spec
 *  §5: "+ a generic « Agent vierge » entry"). A function (not a module-level
 *  constant) since its labels need `t()` — i18n only resolves inside a
 *  component render, never at module load. */
function blankItem(t: (key: string) => string): PaletteItem {
  return {
    id: '__blank__',
    title: t('canvas.palette.blankTitle'),
    description: t('canvas.palette.blankDescription'),
    payload: { title: t('canvas.draft.untitled'), task: '' },
  };
}

function storedAgentToItem(stored: StoredAgent): PaletteItem {
  const { agent } = stored;
  return {
    id: agent.id,
    title: agent.displayName || agent.name,
    description: agent.description,
    model: agent.modelTier,
    payload: { title: agent.displayName || agent.name, task: '', agentName: agent.name, model: agent.modelTier },
  };
}

/** R7 — shared dashed-entry button style for the terminal/preview
 *  click-to-add rows, matching the router entry's own inline style above
 *  (kept as a separate constant rather than editing that pre-existing
 *  literal, to minimize risk to the already-shipped router entry). */
const dashedButtonStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  width: '100%',
  padding: '6px 8px',
  borderRadius: 7,
  border: '1px dashed var(--color-border-3)',
  background: 'transparent',
  color: 'var(--color-text-muted)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'left',
} as const;

function matchesSearch(item: PaletteItem, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    item.title.toLowerCase().includes(needle) ||
    item.description.toLowerCase().includes(needle) ||
    (item.model ?? '').toLowerCase().includes(needle)
  );
}

interface CanvasPaletteProps {
  open: boolean;
  onToggle: () => void;
  /** Click-to-add target — drops the draft into the active project zone
   *  (undefined -> Transverse, matching the drop-on-empty-pane rule). */
  activeProjectId?: string;
  onAddDraft: (payload: PaletteDraftPayload, projectId?: string) => void;
  /**
   * W8c deliverable #3 (additive, optional) — click-to-add a router node at
   * the active project zone (undefined -> Transverse), same target rule as
   * `onAddDraft`. Optional so every EXISTING caller of this component (this
   * wave cannot touch CanvasView.tsx, which owns building this component's
   * props) keeps compiling unchanged; the palette degrades to simply not
   * rendering the router entry when this prop is absent, rather than
   * crashing on a missing handler. Flagged for whoever wires CanvasView.tsx
   * next — see this wave's report.
   */
  onAddRouter?: (projectId?: string) => void;
  /** W-JOIN (additive, optional — same "absent -> section doesn't render"
   *  convention as `onAddRouter` above) — click-to-add a join (fan-in) node
   *  at the active project zone. */
  onAddJoin?: (projectId?: string) => void;
  /** R7 (living surfaces, additive, optional — same pattern as `onAddRouter`
   *  above) — click-to-add a terminal node, cwd'd to the active project
   *  root. */
  onAddTerminal?: (projectId?: string) => void;
  /** R7 (additive, optional) — click-to-add a preview node (empty URL —
   *  the node's own URL bar fills it in, restricted to localhost). */
  onAddPreview?: (projectId?: string) => void;
  /** Group macros (additive, optional — same "absent -> section doesn't
   *  render" convention as `onAddRouter` etc. above) — saved macro
   *  templates, listed in insertion order. */
  macros?: MacroSpec[];
  /** Click OR drag-drop instantiates a fresh copy — click targets
   *  `activeProjectId` (undefined -> Transverse), drag targets whatever
   *  zone the drop landed in (useCanvasDnd.ts resolves that). */
  onInstantiateMacro?: (macroId: string, projectId?: string) => void;
  onDeleteMacro?: (macroId: string) => void;
  onRenameMacro?: (macroId: string, name: string) => void;
  /**
   * W-BYO row 1 (additive, optional — same "absent -> section doesn't
   * render" convention as `onAddRouter` etc. above) — receives the raw
   * `File` a native file-picker returned. CanvasPalette only owns the
   * `<input type="file">` DOM plumbing (identical shape to
   * CanvasToolbar.tsx's `onImportCanvasFile`); CanvasView.tsx parses/
   * validates/registers it via agentsStorage, then this drawer's own
   * `listAgents()` effect (above) picks up the freshly-imported agent on
   * its next open/refresh.
   */
  onImportAgentFile?: (file: File) => Promise<void>;
}

/** The open/close TRIGGER lives on CanvasToolbar.tsx (single source of
 *  truth for the toggle, spec §5 "Open/close from toolbar button + Tab
 *  shortcut") — this component only renders the drawer body while open,
 *  returning null otherwise rather than duplicating a second floating
 *  toggle button. */
export const CanvasPalette = memo(function CanvasPalette({
  open,
  onToggle,
  activeProjectId,
  onAddDraft,
  onAddRouter,
  onAddJoin,
  onAddTerminal,
  onAddPreview,
  macros,
  onInstantiateMacro,
  onDeleteMacro,
  onRenameMacro,
  onImportAgentFile,
}: CanvasPaletteProps) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<StoredAgent[]>([]);
  const [query, setQuery] = useState('');
  const [renamingMacroId, setRenamingMacroId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listAgents().then((result) => {
      if (!cancelled) setAgents(result);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Escape closes the palette (a11y sweep, W5a) — same "own window listener,
  // active only while open" shape as CanvasContextMenu.tsx's identical
  // pattern. `onToggle` doubles as the close primitive here (this component
  // has no separate onClose prop — see the doc comment above), matching the
  // × button's own onClick.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onToggle();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onToggle]);

  const items = useMemo<PaletteItem[]>(() => {
    const all = [blankItem(t), ...agents.map(storedAgentToItem)];
    return all.filter((item) => matchesSearch(item, query));
  }, [agents, query, t]);

  function handleDragStart(event: DragEvent<HTMLDivElement>, item: PaletteItem): void {
    event.dataTransfer.setData(PALETTE_DRAG_MIME, JSON.stringify(item.payload));
    event.dataTransfer.effectAllowed = 'copy';
  }

  if (!open) return null;

  return (
    <Panel position="top-right">
      <div
        data-testid="canvas-palette"
        style={{
          width: 240,
          maxHeight: 420,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 10,
          background: 'var(--color-panel-2)',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 8px 6px' }}>
          <input
            type="text"
            data-testid="canvas-palette-search"
            className="nodrag"
            placeholder={t('canvas.palette.searchPlaceholder')}
            aria-label={t('canvas.palette.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              padding: '5px 8px',
              borderRadius: 6,
              border: '1px solid var(--color-border-3)',
              background: 'var(--color-panel-3)',
              color: 'var(--color-text)',
              fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            data-testid="canvas-palette-close"
            onClick={onToggle}
            aria-label={t('canvas.palette.close')}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-disabled)',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            ×
          </button>
        </div>

        {/* W-BYO row 1 — « Importer un agent » (absent when no handler is
            wired, same convention every other optional palette section
            below already follows). Registers the imported agent via the
            SAME agentsStorage.saveAgent every other write goes through
            (CanvasView.tsx owns that call); this palette only owns the
            file-picker DOM plumbing and refreshes its own list once the
            promise resolves. */}
        {onImportAgentFile && (
          <div style={{ padding: '0 8px 6px' }}>
            <button
              type="button"
              data-testid="canvas-palette-import-agent"
              className="nodrag"
              onClick={() => importInputRef.current?.click()}
              style={dashedButtonStyle}
            >
              <span style={{ fontSize: 12, fontWeight: 700 }}>{t('canvas.palette.importAgent')}</span>
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json,.lazyagent.json"
              data-testid="canvas-palette-import-agent-input"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) {
                  void onImportAgentFile(file).then(() => {
                    void listAgents().then(setAgents);
                  });
                }
              }}
            />
          </div>
        )}

        {onAddRouter && (
          <div style={{ padding: '0 8px 6px' }}>
            <button
              type="button"
              data-testid="canvas-palette-item-router"
              onClick={() => onAddRouter(activeProjectId)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                width: '100%',
                padding: '6px 8px',
                borderRadius: 7,
                border: '1px dashed var(--color-border-3)',
                background: 'transparent',
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 700 }}>{t('canvas.palette.routerTitle')}</span>
              <span style={{ fontSize: 10.5 }}>{t('canvas.palette.routerDescription')}</span>
            </button>
          </div>
        )}

        {onAddJoin && (
          <div style={{ padding: '0 8px 6px' }}>
            <button
              type="button"
              data-testid="canvas-palette-item-join"
              onClick={() => onAddJoin(activeProjectId)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                width: '100%',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px dashed var(--color-border-3)',
                background: 'transparent',
                color: 'var(--color-text)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 700 }}>{t('canvas.palette.joinTitle')}</span>
              <span style={{ fontSize: 10.5 }}>{t('canvas.palette.joinDescription')}</span>
            </button>
          </div>
        )}

        {/* R7 (living surfaces, additive, optional) — terminal/preview
            click-to-add entries, same dashed-button shape as the router
            entry above. `onAddTerminal`'s cwd is the ACTIVE PROJECT ROOT
            (spec: "pane/palette « Terminal » (cwd = active project root)"),
            resolved by whoever wires this prop (useCanvasEditing.ts), never
            here — this component only knows how to LIST/START creation. */}
        {(onAddTerminal || onAddPreview) && (
          <div style={{ padding: '0 8px 6px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {onAddTerminal && (
              <button
                type="button"
                data-testid="canvas-palette-item-terminal"
                onClick={() => onAddTerminal(activeProjectId)}
                style={dashedButtonStyle}
              >
                <span style={{ fontSize: 12, fontWeight: 700 }}>{t('canvas.palette.terminalTitle')}</span>
                <span style={{ fontSize: 10.5 }}>{t('canvas.palette.terminalDescription')}</span>
              </button>
            )}
            {onAddPreview && (
              <button
                type="button"
                data-testid="canvas-palette-item-preview"
                onClick={() => onAddPreview(activeProjectId)}
                style={dashedButtonStyle}
              >
                <span style={{ fontSize: 12, fontWeight: 700 }}>{t('canvas.palette.previewTitle')}</span>
                <span style={{ fontSize: 10.5 }}>{t('canvas.palette.previewDescription')}</span>
              </button>
            )}
          </div>
        )}

        {/* Group macros (additive, optional — same "absent -> section
            doesn't render" convention as the router/terminal/preview
            sections above). Click OR drag instantiates a fresh copy;
            each row also carries a rename (✎) and delete (×) affordance
            — this palette's own "context" for a saved macro, since a
            drag/click target has no separate right-click menu of its
            own. */}
        {macros && macros.length > 0 && (
          <div style={{ padding: '0 8px 6px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              {t('canvas.palette.macrosTitle')}
            </span>
            {/* W-CLOSE row 3 (scorecard "AutoGen Studio Gallery" gap) — macros
                are already stored in the GLOBAL chains.json (canvasPersistence.ts's
                own header: "GLOBAL PERSISTENCE ... project-INDEPENDENT"), so this
                whole section already renders regardless of which project is
                active. The one real gap was DISCOVERABILITY: nothing on screen
                told the user a macro saved from project A would show up (and
                instantiate) in project B too — this line makes that explicit
                rather than leaving it as an undocumented implementation detail. */}
            <span data-testid="canvas-palette-macros-hint" style={{ fontSize: 9.5, color: 'var(--color-text-disabled)', fontStyle: 'italic' }}>
              {t('canvas.palette.macrosHint')}
            </span>
            {macros.map((macro) => (
              <div
                key={macro.id}
                data-testid={`canvas-palette-macro-${macro.id}`}
                draggable={renamingMacroId !== macro.id}
                className="nodrag"
                onDragStart={(e) => {
                  e.dataTransfer.setData(MACRO_DRAG_MIME, macro.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 7,
                  border: '1px dashed var(--color-border-3)',
                  background: 'transparent',
                  cursor: renamingMacroId === macro.id ? 'default' : 'grab',
                }}
              >
                {renamingMacroId === macro.id ? (
                  <input
                    type="text"
                    autoFocus
                    className="nodrag"
                    data-testid={`canvas-palette-macro-rename-input-${macro.id}`}
                    aria-label={t('canvas.palette.macroRenameLabel')}
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const trimmed = renameDraft.trim();
                        if (trimmed.length > 0) onRenameMacro?.(macro.id, trimmed);
                        setRenamingMacroId(null);
                      } else if (e.key === 'Escape') {
                        setRenamingMacroId(null);
                      }
                    }}
                    onBlur={() => setRenamingMacroId(null)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      padding: '3px 6px',
                      borderRadius: 5,
                      border: '1px solid var(--color-border-3)',
                      background: 'var(--color-panel-3)',
                      color: 'var(--color-text)',
                      fontFamily: 'inherit',
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    data-testid={`canvas-palette-macro-instantiate-${macro.id}`}
                    onClick={() => onInstantiateMacro?.(macro.id, activeProjectId)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      textAlign: 'left',
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--color-text)',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: 12,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={macro.description}
                  >
                    {macro.name}
                  </button>
                )}
                {renamingMacroId !== macro.id && onRenameMacro && (
                  <button
                    type="button"
                    data-testid={`canvas-palette-macro-rename-${macro.id}`}
                    aria-label={t('canvas.palette.macroRename')}
                    onClick={() => {
                      setRenamingMacroId(macro.id);
                      setRenameDraft(macro.name);
                    }}
                    style={{ border: 'none', background: 'transparent', color: 'var(--color-text-disabled)', cursor: 'pointer', fontSize: 11.5 }}
                  >
                    ✎
                  </button>
                )}
                {onDeleteMacro && (
                  <button
                    type="button"
                    data-testid={`canvas-palette-macro-delete-${macro.id}`}
                    aria-label={t('canvas.palette.macroDelete')}
                    onClick={() => onDeleteMacro(macro.id)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--color-text-disabled)', cursor: 'pointer', fontSize: 13 }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div data-testid="canvas-palette-list" style={{ overflowY: 'auto', padding: '0 6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.length === 0 && (
            <p style={{ margin: '8px 6px', fontSize: 11.5, color: 'var(--color-text-disabled)' }}>
              {t('canvas.palette.empty')}
            </p>
          )}
          {items.map((item) => (
            <div
              key={item.id}
              data-testid={`canvas-palette-item-${item.id}`}
              draggable
              className="nodrag"
              onDragStart={(e) => handleDragStart(e, item)}
              onClick={() => onAddDraft(item.payload, activeProjectId)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onAddDraft(item.payload, activeProjectId);
                }
              }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                padding: '6px 8px',
                borderRadius: 7,
                border: '1px solid var(--color-border-3)',
                background: 'var(--color-panel-3)',
                cursor: 'grab',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--color-text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {item.title}
                </span>
                {item.model && <MetaChip testId={`canvas-palette-model-${item.id}`}>{item.model}</MetaChip>}
              </div>
              <span
                style={{
                  fontSize: 10.5,
                  color: 'var(--color-text-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {item.description}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
});
