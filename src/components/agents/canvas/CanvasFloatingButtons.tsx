/* CanvasFloatingButtons — circular expandable buttons on the left edge of
   the canvas. Provides quick access to:
   - Agent Library (popup with general + favorites tabs)
   - MCP Servers (popup for connecting to external MCP servers)

   Each button is a circle that opens a popup when clicked.

   BUG FIX: this rail used to anchor at `top:'50%'; transform:'translateY(-50%)'`
   — the exact same vertically-centered spot CockpitLeftRail.tsx (Cockpit.tsx's
   OTHER floating left-edge rail, mounted as this component's sibling over the
   same canvas — see Cockpit.tsx and CanvasView.tsx) already occupies. Two
   independent flex columns anchored to the identical origin, with no shared
   parent to stack them under, so this rail's icons visually overlapped that
   one's (measured: both groups painting at x=16, y=409-459 in a 1440x844
   viewport). Now anchors BELOW CockpitLeftRail's stack instead, using that
   file's exported height (COCKPIT_LEFT_RAIL_HEIGHT) rather than a hardcoded
   guess, so the two can never overlap even if that rail's icon count changes
   later; `min(...)` keeps this rail from drifting past the bottom edge on
   short windows rather than running off-screen.

   Tooltip-consistency fix (real user report, 2026-08-14): these two buttons
   used to carry only a raw `title` attribute — no `aria-label`, and no
   visible hover bubble matching CockpitLeftRail.tsx's OWN icons (its
   RailIconButton sets `aria-label` AND `data-tooltip`, the app's own
   design-system.css `[data-tooltip]::after` convention — 9 icons already
   used it, these 2 were the only holdouts using a different mechanism).
   Switched to the same `aria-label` + `data-tooltip` pair so every floating
   icon on the canvas shows a consistent hover tooltip. */

import { useRef, useState } from 'react';
import { CanvasLibraryPopup } from './CanvasLibraryPopup';
import { CanvasMcpPopup } from './CanvasMcpPopup';
import type { LazyAgent } from '../../../lib/agents/agentDef';
import { COCKPIT_LEFT_RAIL_HEIGHT } from '../cockpit/CockpitLeftRail';
import { useI18n } from '../../../i18n';

// Founder bug fix audit (2026-07-22): unlike CockpitRailPopover.tsx's
// popovers, CanvasLibraryPopup/CanvasMcpPopup each render a full-bleed
// backdrop at a higher z-index than these trigger buttons, so in a real
// browser a re-click while open never even reaches the button (the backdrop
// intercepts it first, closing the popup) — no close-then-reopen race in
// practice. `libraryTriggerRef`/`mcpTriggerRef` below are threaded through
// anyway, purely as defense-in-depth (see useDismissable.ts), and to
// consolidate onto the same shared hook CockpitRailPopover.tsx now uses
// rather than keeping a second hand-rolled copy of the same listener code.

// This rail's own stack height (2 buttons * 40px + 1 gap * 10px) — used
// below to clamp its position so it never drifts past the container's
// bottom edge on short viewports.
const OWN_RAIL_HEIGHT = 2 * 40 + 10;
// Breathing room between this rail's top edge and CockpitLeftRail's bottom
// edge (see the header comment above).
const RAIL_CLEARANCE_GAP = 16;
const BOTTOM_MARGIN = 16;

interface CanvasFloatingButtonsProps {
  onRunAgent: (agent: LazyAgent, task: string) => void;
}

export function CanvasFloatingButtons({ onRunAgent }: CanvasFloatingButtonsProps) {
  const { t } = useI18n();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const mcpTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      {/* Floating buttons on the left edge — anchored BELOW CockpitLeftRail's
          stack, not centered on the same origin (see this file's header
          comment for the overlap bug this fixes). */}
      <div
        style={{
          position: 'absolute',
          left: 16,
          top: `min(calc(50% + ${COCKPIT_LEFT_RAIL_HEIGHT / 2 + RAIL_CLEARANCE_GAP}px), calc(100% - ${OWN_RAIL_HEIGHT + BOTTOM_MARGIN}px))`,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          zIndex: 500,
        }}
      >
        {/* Agent Library button */}
        <button
          ref={libraryTriggerRef}
          type="button"
          data-testid="canvas-floating-library"
          onClick={() => {
            setLibraryOpen((v) => !v);
            setMcpOpen(false);
          }}
          aria-label={t('agents.library.title')}
          data-tooltip={t('agents.library.title')}
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            border: libraryOpen
              ? '2px solid var(--color-accent)'
              : '1px solid rgba(255,255,255,0.14)',
            background: libraryOpen
              ? 'rgba(124,92,255,0.15)'
              : 'var(--color-panel-2)',
            color: libraryOpen ? 'var(--color-accent)' : 'rgba(255,255,255,0.55)',
            fontSize: 18,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
            transition: 'all 150ms ease',
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => {
            if (!libraryOpen) {
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)';
              e.currentTarget.style.color = 'rgba(255,255,255,0.8)';
            }
          }}
          onMouseLeave={(e) => {
            if (!libraryOpen) {
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)';
              e.currentTarget.style.color = 'rgba(255,255,255,0.55)';
            }
          }}
        >
          {/* Book/library icon */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        </button>

        {/* MCP button */}
        <button
          ref={mcpTriggerRef}
          type="button"
          data-testid="canvas-floating-mcp"
          onClick={() => {
            setMcpOpen((v) => !v);
            setLibraryOpen(false);
          }}
          aria-label={t('canvas.mcp.title')}
          data-tooltip={t('canvas.mcp.title')}
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            border: mcpOpen
              ? '2px solid var(--color-accent)'
              : '1px solid rgba(255,255,255,0.14)',
            background: mcpOpen
              ? 'rgba(124,92,255,0.15)'
              : 'var(--color-panel-2)',
            color: mcpOpen ? 'var(--color-accent)' : 'rgba(255,255,255,0.55)',
            fontSize: 18,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
            transition: 'all 150ms ease',
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => {
            if (!mcpOpen) {
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)';
              e.currentTarget.style.color = 'rgba(255,255,255,0.8)';
            }
          }}
          onMouseLeave={(e) => {
            if (!mcpOpen) {
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)';
              e.currentTarget.style.color = 'rgba(255,255,255,0.55)';
            }
          }}
        >
          {/* Plug/connection icon */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 2v6" />
            <path d="M15 2v6" />
            <path d="M5 8h14" />
            <path d="M12 8v14" />
          </svg>
        </button>
      </div>

      {/* Popups */}
      <CanvasLibraryPopup
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onRunAgent={onRunAgent}
        triggerRef={libraryTriggerRef}
      />
      <CanvasMcpPopup
        open={mcpOpen}
        onClose={() => setMcpOpen(false)}
        triggerRef={mcpTriggerRef}
      />
    </>
  );
}
