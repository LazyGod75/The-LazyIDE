/* MissionDetailDrawer — D13/D14: MissionDetail as a 640px right-side drawer
   over the Cockpit (design-cockpit.md §11.2), replacing the old full-page
   swap in AgentsSpace.tsx. Rendered as a fixed-position overlay ALONGSIDE
   the normal space content (never unmounts Cockpit underneath — its polling
   / journal subscriptions keep running, matching the AppShell's keep-alive
   convention for spaces).

   D14 responsive fallback: below DRAWER_MIN_VIEWPORT_WIDTH, the overlay
   covers the full viewport with an opaque background instead of a
   640px-anchored panel + translucent backdrop — visually equivalent to the
   pre-drawer full-page behavior, still implemented as an overlay (so
   Cockpit stays mounted) rather than a tree swap.
*/

import { useEffect, useRef, useState } from 'react';
import type { Mission } from '../../lib/agents/types';
import type { MissionFocusSection } from '../../lib/bus';
import { MissionDetail } from './MissionDetail';
import { useFocusTrap } from '../../hooks/useFocusTrap';

/** Below this viewport width, fall back to full-page instead of a 640px
 *  drawer (D14) — a 640px fixed panel plus the Cockpit's own 460px right
 *  rail would leave too little room for the pipeline grid underneath. */
const DRAWER_MIN_VIEWPORT_WIDTH = 1100;
const DRAWER_WIDTH_PX = 640;

function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(() => (typeof window !== 'undefined' ? window.innerWidth : DRAWER_MIN_VIEWPORT_WIDTH));
  useEffect(() => {
    function onResize() {
      setWidth(window.innerWidth);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

interface MissionDetailDrawerProps {
  mission: Mission;
  onClose: () => void;
  /** QA B14 — see MissionDetail.tsx's MissionDetailProps.focusSection doc
   *  comment. Threaded straight through: this component owns no layout
   *  decision about it, just passes it to MissionDetail. */
  focusSection?: MissionFocusSection | null;
  onFocusHandled?: () => void;
}

export function MissionDetailDrawer({ mission, onClose, focusSection, onFocusHandled }: MissionDetailDrawerProps) {
  const viewportWidth = useViewportWidth();
  const isDrawer = viewportWidth >= DRAWER_MIN_VIEWPORT_WIDTH;
  const panelRef = useRef<HTMLDivElement>(null);

  // Accessibility fix (real user report, 2026-08-14): this overlay is a
  // real modal (Cockpit stays mounted underneath but is not interactive
  // while this is open — the backdrop click-to-close below already assumes
  // that) yet carried no role="dialog"/aria-modal, so a screen reader never
  // announced it as a dialog and Tab could walk straight out into the
  // Cockpit content behind it. useFocusTrap (hooks/useFocusTrap.ts — the
  // same hook already wired into NewMissionModal.tsx/InviteModal.tsx/
  // CreateAndInviteModal.tsx/CreateTeamModal.tsx/JoinOrgModal.tsx/
  // CanvasSaveMacroModal.tsx) now owns focus-on-open, Tab trapping, and
  // Escape-to-close — replacing the ad hoc window keydown listener this
  // used to have (same convention as every other useFocusTrap call site:
  // one owner for Escape, not two).
  useFocusTrap(panelRef, { onClose });

  return (
    <div
      data-testid="mission-detail-overlay"
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: isDrawer ? 'rgba(6,6,10,0.55)' : 'var(--color-bg)',
        display: 'flex',
        justifyContent: isDrawer ? 'flex-end' : 'stretch',
      }}
    >
      <div
        ref={panelRef}
        data-testid="mission-detail-panel"
        role="dialog"
        aria-modal="true"
        aria-label={mission.title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: isDrawer ? DRAWER_WIDTH_PX : '100%',
          maxWidth: isDrawer ? '92vw' : '100%',
          height: '100%',
          background: 'var(--color-panel)',
          borderLeft: isDrawer ? '1px solid rgba(255,255,255,0.12)' : 'none',
          boxShadow: isDrawer ? '-20px 0 60px rgba(0,0,0,0.5)' : 'none',
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '20px 22px 24px',
          animation: isDrawer ? 'slide-in-right 0.2s ease' : 'fade-in 0.15s ease',
        }}
      >
        <MissionDetail
          mission={mission}
          onBack={onClose}
          layout={isDrawer ? 'drawer' : 'page'}
          focusSection={focusSection}
          onFocusHandled={onFocusHandled}
        />
      </div>
    </div>
  );
}
