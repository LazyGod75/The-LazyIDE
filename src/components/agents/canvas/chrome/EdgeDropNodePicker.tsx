/* EdgeDropNodePicker.tsx — R2b connectionUx §5 (MANDATORY flagship):
   dragging a connection off a handle and releasing on empty canvas (or a
   node's body, not another handle) opens this small searchable picker at
   the drop position. Selecting an entry creates the target node AND the
   connecting chain in one gesture (CanvasView.tsx's `handleEdgeDropSelect`
   does the actual canvasStore/validateChain work — this component is
   display + search + keyboard nav only, mirroring CanvasCommandBar.tsx's
   own "component decides HOW to search/select, caller decides WHAT a
   selection means" split).

   Deliberately reuses CanvasCommandBar's list internals (module header's
   own instruction: "reuse CanvasCommandBar's list internals") — same
   `listAgents()` read-only source, same debounced-free instant filter,
   same row shape — but scoped to exactly the three groups the brief asks
   for (agents / blank draft / router), never the full command list (this
   is "create something HERE", not "run any canvas command").
*/

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useI18n } from '../../../../i18n';
import { listAgents, type StoredAgent } from '../../../../lib/agents/agentsStorage';
import { typeAccentColor } from './nodeChrome';
import { usePopoverPosition } from './popoverPosition';

export type EdgeDropChoice =
  | { kind: 'draft'; title: string; task: string; agentName?: string; model?: string }
  | { kind: 'router' };

interface PickerEntry {
  id: string;
  kind: 'agent' | 'draft' | 'router';
  label: string;
  hint?: string;
  accent: string;
  choice: EdgeDropChoice;
}

function blankDraftEntry(t: (key: string) => string): PickerEntry {
  return {
    id: 'draft-blank',
    kind: 'draft',
    label: t('canvas.commandBar.blankDraft'),
    accent: typeAccentColor('draft'),
    choice: { kind: 'draft', title: t('canvas.draft.untitled'), task: '' },
  };
}

function routerEntry(t: (key: string) => string): PickerEntry {
  return {
    id: 'router',
    kind: 'router',
    label: t('canvas.node.router'),
    accent: typeAccentColor('router'),
    choice: { kind: 'router' },
  };
}

function agentEntry(stored: StoredAgent): PickerEntry {
  const { agent } = stored;
  const title = agent.displayName || agent.name;
  return {
    id: `agent-${agent.id}`,
    kind: 'agent',
    label: title,
    hint: agent.modelTier,
    accent: typeAccentColor('mission'),
    choice: { kind: 'draft', title, task: '', agentName: agent.name, model: agent.modelTier },
  };
}

function matchesQuery(entry: PickerEntry, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return entry.label.toLowerCase().includes(needle) || (entry.hint ?? '').toLowerCase().includes(needle);
}

export interface EdgeDropNodePickerProps {
  /** Viewport/client coordinates (the drop point) — anchors the popover,
   *  never a flow-space coordinate (this is a screen-space overlay, same
   *  convention as CanvasCommandBar/CanvasContextMenu). */
  screenPosition: { x: number; y: number };
  onSelect: (choice: EdgeDropChoice) => void;
  onCancel: () => void;
}

const POPOVER_WIDTH = 320;

export function EdgeDropNodePicker({ screenPosition, onSelect, onCancel }: EdgeDropNodePickerProps) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<StoredAgent[]>([]);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Debounced-free — same instant-filter convention CanvasCommandBar
    // already uses for this same small, already-in-memory list; the
    // brief's "250ms debounce" applies to the FULL palette's larger
    // agent+category tree (chromePlan's Add-Node FAB), not this narrow
    // three-group picker.
    let cancelled = false;
    void listAgents().then((result) => {
      if (!cancelled) setAgents(result);
    });
    inputRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, []);

  // Click-away cancels the drag cleanly (module header: "Esc or click-away
  // cancels ... no orphan node").
  useEffect(() => {
    function handlePointerDown(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onCancel();
    }
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [onCancel]);

  const entries = useMemo<PickerEntry[]>(() => {
    return [blankDraftEntry(t), routerEntry(t), ...agents.map(agentEntry)];
  }, [t, agents]);

  const filtered = useMemo(() => entries.filter((entry) => matchesQuery(entry, query)), [entries, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function selectEntry(entry: PickerEntry | undefined): void {
    if (!entry) return;
    onSelect(entry.choice);
  }

  function handleKeyDown(e: ReactKeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      selectEntry(filtered[activeIndex]);
    }
  }

  // fix/canvas-ux R6a BLOQUANT #2 — same flip/clamp treatment as
  // GateFeedbackPopover.tsx (this popover only ever clamped the LEFT edge
  // before; a drop near the BOTTOM of the viewport could push its list, and
  // therefore its own options, below the fold). The drop point has zero
  // height (`anchorTop === anchorBottom`), so "below" is simply the old
  // `screenPosition.y + 12` and "above" is measured-height-aware instead of
  // never happening.
  const { left, top } = usePopoverPosition(
    containerRef,
    { anchorTop: screenPosition.y, anchorBottom: screenPosition.y, preferredLeft: screenPosition.x - POPOVER_WIDTH / 2 },
    [screenPosition.x, screenPosition.y],
    { gap: 12 },
  );

  return (
    <div
      ref={containerRef}
      data-testid="edge-drop-node-picker"
      role="dialog"
      aria-modal="true"
      aria-label={t('canvas.edgeDrop.ariaLabel')}
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed',
        left,
        top,
        width: POPOVER_WIDTH,
        maxHeight: '50vh',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 12,
        background: 'var(--canvas-node-bg)',
        border: '1px solid rgba(255,255,255,0.14)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        overflow: 'hidden',
        zIndex: 2200,
      }}
    >
      <input
        ref={inputRef}
        type="text"
        data-testid="edge-drop-node-picker-search"
        placeholder={t('canvas.edgeDrop.searchPlaceholder')}
        aria-label={t('canvas.edgeDrop.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          fontSize: 13,
          padding: '10px 12px',
          border: 'none',
          borderBottom: '1px solid var(--color-border-3)',
          background: 'transparent',
          color: 'var(--color-text)',
          fontFamily: 'inherit',
          outline: 'none',
        }}
      />
      <div data-testid="edge-drop-node-picker-list" role="listbox" style={{ overflowY: 'auto', padding: 6 }}>
        {filtered.length === 0 && (
          <p data-testid="edge-drop-node-picker-empty" style={{ margin: '10px 8px', fontSize: 11.5, color: 'var(--color-text-disabled)' }}>
            {t('canvas.commandBar.empty')}
          </p>
        )}
        {filtered.map((entry, index) => {
          const active = index === activeIndex;
          return (
            <div
              key={entry.id}
              data-testid={`edge-drop-node-picker-item-${entry.id}`}
              role="option"
              aria-selected={active}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectEntry(entry)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 9px 7px 8px',
                borderLeft: `3px solid ${entry.accent}`,
                borderRadius: 6,
                cursor: 'pointer',
                background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'var(--color-text)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {entry.label}
              </span>
              {entry.hint && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--color-text-muted)',
                    background: 'var(--color-panel-3)',
                    border: '1px solid var(--color-border-3)',
                    borderRadius: 5,
                    padding: '1px 5px',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {entry.hint}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
