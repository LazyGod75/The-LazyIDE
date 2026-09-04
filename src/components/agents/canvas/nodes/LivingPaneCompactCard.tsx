/* LivingPaneCompactCard.tsx — fix/canvas-legibility: shared compact repli
   card for a "living surface" (terminal/preview) whose current content
   carries no meaningful signal — an idle shell prompt, an empty preview
   with no URL yet. QA evidence: at ~50-95% zoom these panes rendered as
   huge near-black rectangles with no title, no status, terrible
   signal/noise ("96%-47%: huge living panes render as near-black
   rectangles ... no mission titles visible").

   Same visual language everywhere this repli is used — status glyph +
   truncated title — so a user sees one consistent "compact" idiom across
   every living-surface node kind, not a different shorthand per one.

   W-CARDS (founder, 2026-07-21) — the constant-screen-size
   `transform: scale(var(--canvas-lod-mission-chip-scale, 1))` this card
   used to carry is retired: whether this repli or the full surface renders
   is a CONTENT decision (idle/no-url — see TerminalNode.tsx/PreviewNode.tsx's
   own callers), never a zoom one, and once rendered it must scale
   naturally with React Flow's own viewport transform like any other node,
   not fight it to stay a constant on-screen size.
*/

import { StatusGlyph, statusAccentColor, type NodeLiveness } from '../chrome/nodeChrome';

export interface LivingPaneCompactCardProps {
  testId: string;
  /** Short, legible label (e.g. a worktree basename, never a raw
   *  `\\?\C:\Users\...` path) — this is what's actually rendered. */
  title: string;
  /** W-CARDS — the native HTML tooltip text, shown on hover. Defaults to
   *  `title` when absent (every pre-existing caller keeps its old
   *  behavior unchanged) — a caller with a longer/more complete string to
   *  disclose (TerminalNodeCard's full, verbatim-prefix-stripped cwd) can
   *  pass it separately here instead of cramming it into the visible
   *  `title` label. */
  tooltip?: string;
  /** 'neutral' — no real liveness signal to show (e.g. an idle terminal,
   *  a preview with no URL yet) — renders a muted glyph/color instead of a
   *  fabricated status. */
  liveness: NodeLiveness | 'neutral';
  lastEventLine: string;
}

function livingPaneColor(liveness: NodeLiveness | 'neutral'): string {
  return liveness === 'neutral' ? 'var(--color-text-disabled)' : statusAccentColor(liveness);
}

export function LivingPaneCompactCard({ testId, title, tooltip, liveness, lastEventLine }: LivingPaneCompactCardProps) {
  const color = livingPaneColor(liveness);
  return (
    <div
      data-testid={testId}
      title={tooltip ?? title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        borderRadius: 8,
        background: 'var(--color-panel-2)',
        border: `1px solid ${color}`,
        color: 'var(--color-text)',
        maxWidth: 220,
      }}
    >
      {liveness !== 'neutral' && <StatusGlyph liveness={liveness} size={11} color={color} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, flex: 1 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 9.5,
            opacity: 0.7,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {lastEventLine}
        </span>
      </div>
    </div>
  );
}
