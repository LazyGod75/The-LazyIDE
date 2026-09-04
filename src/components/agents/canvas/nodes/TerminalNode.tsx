/* TerminalNode.tsx — R7 "living surfaces": a REAL, interactive terminal
   living on the canvas next to the agent whose worktree it opened (October.dev's
   "watch the agent work, jump in yourself" idea, reimplemented).

   Reuses the app's existing xterm-based `TerminalView` (components/terminal/
   TerminalView.tsx) VERBATIM — this node is a thin canvas-shaped wrapper
   around it, never a re-implementation. TerminalView already abstracts real
   vs. mock PTY through `getPlatform()`:
     - Tauri desktop: a real `portable-pty` process (src/lib/platform/tauri.ts)
       — typing here is a real shell, genuinely "jump in yourself".
     - Browser/harness preview (no Tauri): `WebPlatform`'s in-memory mock shell
       (src/lib/platform/web.ts's `makeMockShell`) — the SAME honest fallback
       every other terminal surface in this app already uses (TerminalsSpace.tsx,
       the Code space's TerminalStrip.tsx); not a fake stream invented for this
       feature, the app's own pre-existing web-preview behavior.

   Deliberately NOT zoom-gated (no 'dot'/'compact' bucket like MissionNode/
   NoteNode): collapsing this to a dot at low zoom would unmount the xterm
   instance and kill the live PTY session underneath it — a running shell is
   not a passive status glyph, it must survive panning/zooming untouched.

   W-CARDS (founder, 2026-07-21) — `showFull` below used to ALSO require
   `zoomLevel === 'full'`, contradicting this file's own "not zoom-gated"
   claim above: below ZOOM_COMPACT the pane fell back to the compact repli
   regardless of real activity, i.e. a genuinely busy terminal could still
   get visually swapped out purely because the user zoomed out — exactly
   the "swap to a compact variant by zoom" pattern the founder's rule bans.
   Fixed: the repli is now driven ONLY by the real idle/selected signal
   (content-based), never by the viewport zoom — the terminal (full or
   repli) then scales naturally with React Flow's own transform like any
   other node.

   `nodrag` sits on the TERMINAL BODY only (the header stays draggable) — the
   xterm surface must receive every click/keystroke itself (selecting text,
   moving the cursor, typing a command) rather than React Flow interpreting
   those as a node drag.
*/

import { memo, useCallback, useEffect, useState } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import type { SurfaceSpec } from '../canvasTypes';
import { useI18n } from '../../../../i18n';
import { TerminalView } from '../../../terminal/TerminalView';
import { useCanvasStore } from '../canvasStore';
import { TERMINAL_NODE_SIZE } from '../reconcilerZones';
import { LivingPaneCompactCard } from './LivingPaneCompactCard';
import { formatCountdown } from '../chrome/nodeChrome';
import { basename, stripVerbatimPrefix } from '../../../../lib/paths';
import { recordTerminalOutputActivity, recordTerminalFocus } from '../../../../lib/agents/terminalActivity';

/**
 * W-CARDS — a terminal's `cwd` is frequently a Windows verbatim
 * (`\\?\C:\Users\...`) path (Rust's `canonicalize()` always returns one on
 * Windows) — showing that raw string as the node's title is the literal
 * "terminal nodes titled with raw truncated `\\?\C:\Users\...` paths" bug
 * this fixes. Returns the worktree/directory BASENAME (short, legible) for
 * display; the caller keeps the full, verbatim-stripped path for its
 * tooltip separately (see `stripVerbatimPrefix`'s own doc comment in
 * lib/paths.ts — SurfaceSpec.cwd's own field comment already documented
 * this stripping as expected behavior; it just never actually ran here).
 */
function shortTerminalTitle(cwd: string | undefined, noCwdLabel: string): string {
  if (!cwd) return noCwdLabel;
  return basename(stripVerbatimPrefix(cwd));
}

export type TerminalFlowNode = Node<SurfaceSpec & Record<string, unknown>, 'terminal'>;

const MIN_WIDTH = 360;
const MIN_HEIGHT = 220;

/** fix/canvas-legibility — heuristic activity threshold: a fresh shell's
 *  own prompt banner (motd, prompt string, etc.) writes a handful of bytes
 *  on spawn — below this, the pane is treated as "genuinely idle", not
 *  merely "just started". */
const TERMINAL_IDLE_BYTE_THRESHOLD = 300;

interface TerminalNodeCardProps {
  data: SurfaceSpec;
  selected?: boolean;
  /** Test-only escape hatch (mounting a REAL xterm instance needs a real
   *  canvas backend jsdom doesn't provide — component tests mock TerminalView
   *  itself, same convention TerminalView.test.tsx already uses for xterm). */
  onResizeEnd?: (width: number, height: number) => void;
  /** W-CARDS — accepted for call-site compatibility (every existing test/
   *  caller) but no longer read: whether the full terminal or the compact
   *  repli renders is driven only by `selected`/idle activity below, never
   *  by the viewport zoom (see this file's own header). */
  zoomLevel?: 'chip' | 'compact' | 'full';
}

export function TerminalNodeCard({ data, selected }: TerminalNodeCardProps) {
  const { t } = useI18n();
  const removeSurface = useCanvasStore((s) => s.removeSurface);
  const updateSurface = useCanvasStore((s) => s.updateSurface);
  const width = data.width ?? TERMINAL_NODE_SIZE.width;
  const height = data.height ?? TERMINAL_NODE_SIZE.height;
  // Local title-bar collapse toggle — the PTY keeps running underneath (it's
  // never unmounted by this, only visually hidden via `display: none` below)
  // so collapsing to save screen space never loses the session.
  const [collapsed, setCollapsed] = useState(false);

  // fix/canvas-legibility — idle detection (module header's own
  // TerminalView.onActivity doc comment explains why history.ts's global
  // buffer can't answer this per-instance). `selected` always forces the
  // full terminal regardless of idle state (an explicitly-selected node is
  // never silently replaced by a summary card).
  const [activityBytes, setActivityBytes] = useState(0);
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (lastActivityAt !== null) {
      setNow(Date.now());
    }
  }, [lastActivityAt]);

  const handleActivity = useCallback((bytes: number) => {
    setActivityBytes((b) => b + bytes);
    const now = Date.now();
    setLastActivityAt(now);
    // Fix 2 (idle-terminal auto-close) — feeds fleetHygiene.ts's rule (h)
    // via agentsStore.tsx's sweep; a plain module-level write (never React
    // state), see terminalActivity.ts's own doc comment for why this lives
    // outside canvasStore.ts.
    recordTerminalOutputActivity(data.id, now);
  }, [data.id]);
  const isIdle = activityBytes < TERMINAL_IDLE_BYTE_THRESHOLD;

  // Fix 2 — "selected" is the best available "the user is looking at/about
  // to use this" proxy this pure hygiene module has access to (see
  // HygienePreviewSurface.lastFocusedAtMs's own doc comment). Recorded on
  // every selection, not just the initial transition, so a terminal the
  // user keeps returning to keeps re-arming its own protection window.
  useEffect(() => {
    if (selected) recordTerminalFocus(data.id);
  }, [selected, data.id]);
  // W-CARDS — content-driven only (never gated on the viewport zoom, see
  // this file's own header): full terminal unless idle, and `selected`
  // always overrides idle too.
  const showFull = selected === true || !isIdle;

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        onResizeEnd={(_event, params) => updateSurface(data.id, { width: params.width, height: params.height })}
      />
      <div
        data-testid={`terminal-node-${data.id}`}
        style={
          showFull
            ? {
                width,
                height: collapsed ? 'auto' : height,
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 10,
                overflow: 'hidden',
                background: '#0E0E12',
                border: selected ? '2px solid var(--color-accent)' : '1px solid var(--color-border)',
                boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
              }
            : { display: 'inline-flex' }
        }
      >
        {showFull ? (
          <div
            data-testid={`terminal-node-header-${data.id}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 8px',
              background: 'var(--color-panel-2)',
              borderBottom: collapsed ? 'none' : '1px solid rgba(255,255,255,0.08)',
              flexShrink: 0,
            }}
          >
            <TerminalGlyph />
            <span
              data-testid="terminal-node-cwd"
              title={data.cwd ? stripVerbatimPrefix(data.cwd) : t('canvas.terminal.noCwd')}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {shortTerminalTitle(data.cwd, t('canvas.terminal.noCwd'))}
            </span>
            <button
              type="button"
              data-testid={`terminal-node-collapse-${data.id}`}
              className="nodrag"
              aria-label={t(collapsed ? 'canvas.terminal.expand' : 'canvas.terminal.collapse')}
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed((v) => !v);
              }}
              style={collapseButtonStyle}
            >
              {collapsed ? '▢' : '—'}
            </button>
            <button
              type="button"
              data-testid={`terminal-node-close-${data.id}`}
              className="nodrag"
              aria-label={t('canvas.terminal.close')}
              onClick={(e) => {
                e.stopPropagation();
                removeSurface(data.id);
              }}
              style={collapseButtonStyle}
            >
              ×
            </button>
          </div>
        ) : (
          <LivingPaneCompactCard
            testId={`living-pane-chip-terminal-${data.id}`}
            title={shortTerminalTitle(data.cwd, t('canvas.terminal.noCwd'))}
            tooltip={data.cwd ? stripVerbatimPrefix(data.cwd) : t('canvas.terminal.noCwd')}
            liveness={isIdle ? 'neutral' : 'running'}
            lastEventLine={
              lastActivityAt !== null
                ? t('canvas.terminal.lastActivity', { when: formatCountdown(now - lastActivityAt, t) })
                : t('canvas.terminal.idle')
            }
          />
        )}
        {/* fix/canvas-legibility — the REAL xterm/PTY instance stays
            mounted at ALL times (a single instance, never remounted by the
            showFull/collapsed toggles above) — only its wrapper's CSS
            display is toggled, so the underlying shell process is never
            killed by a zoom change or the idle-repli tier (module header's
            own "the PTY must never die" commitment, now actually honored —
            the PRE-EXISTING `collapsed` toggle used to conditionally
            unmount this instead, contradicting its own doc comment). */}
        <div className="nodrag" style={{ display: showFull && !collapsed ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
          <TerminalView terminalId={data.id} cwd={data.cwd} onActivity={handleActivity} />
        </div>
      </div>
    </>
  );
}

const collapseButtonStyle = {
  width: 18,
  height: 18,
  lineHeight: '16px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'var(--color-text-disabled)',
  cursor: 'pointer',
  fontSize: 12,
  flexShrink: 0,
} as const;

function TerminalGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true" data-testid="glyph-terminal">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="var(--color-text-muted)" strokeWidth="1.3" />
      <path d="M4 6.2 6.4 8 4 9.8" stroke="var(--color-text-muted)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.6 10h4.4" stroke="var(--color-text-muted)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * P2-15 fix — see PreviewNode.tsx's identical constant/doc comment for the
 * full "React Flow error 008" root cause (this node had no Handle either,
 * so the mission -> terminal surface-edge, reconcilerEdges.ts's
 * `buildSurfaceEdges`, could never anchor). Invisible/non-interactive for
 * the same reason: a terminal surface is never a valid chain endpoint.
 */
const SURFACE_TARGET_HANDLE_STYLE = { opacity: 0, pointerEvents: 'none' as const };

export const TerminalNode = memo(function TerminalNode({ data, selected }: NodeProps<TerminalFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={SURFACE_TARGET_HANDLE_STYLE} />
      <TerminalNodeCard data={data} selected={selected} />
    </>
  );
});
