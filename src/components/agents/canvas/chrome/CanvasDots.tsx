import { memo } from 'react';
import { useStore } from '@xyflow/react';

/**
 * Screen-space constant-size canvas dot grid — the Figma/tldraw treatment.
 *
 * React Flow's own `<Background variant={Dots}>` paints the pattern in WORLD
 * coordinates, so the SVG transform scales it: at 16% overview zoom a 1px
 * dot renders at 0.16px — physically invisible — and the canvas reads as an
 * empty black void (founder's design-audit screenshot, 2026-08-22). Real
 * canvas apps keep the DOT at a constant SCREEN size and instead scale the
 * LATTICE, switching to a coarser world-spacing as you zoom out so the
 * on-screen gap never collapses.
 *
 * Implementation: one div painting a radial-gradient dot tile, sized and
 * offset every frame from React Flow's live viewport transform:
 *   - background-size   = worldGap * zoom          (lattice pitch, screen px)
 *   - background-position = (tx, ty)               (world origin anchoring,
 *     so dots PAN WITH the content — free parallax correctness, no listener)
 * World spacing jumps x4 whenever the screen gap would drop below MIN_GAP_PX
 * (Figma does the same discrete level switch; imperceptible while panning).
 * The whole layer is pointer-events-none and sits at z-index -1, i.e. above
 * the flat --xy-background-color and below every node/edge, exactly where
 * RF's own Background lived.
 */
const BASE_WORLD_GAP = 22;
const MIN_GAP_PX = 13;

function pickWorldGap(zoom: number): number {
  let gap = BASE_WORLD_GAP;
  // Guard the loop against a degenerate zoom (0/negative) — clamp keeps the
  // arithmetic total even before React Flow feeds us real transforms.
  const z = Math.max(zoom, 0.01);
  while (gap * z < MIN_GAP_PX) gap *= 4;
  return gap;
}

export const CanvasDots = memo(function CanvasDots() {
  const transform = useStore((s) => s.transform);
  const [tx, ty, zoom] = transform;
  const worldGap = pickWorldGap(zoom);
  const gapPx = worldGap * zoom;
  return (
    <div
      aria-hidden
      data-testid="canvas-dots"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: -1,
        backgroundImage: 'radial-gradient(circle, var(--canvas-dot-color, rgba(255,255,255,0.13)) 1px, transparent 1px)',
        backgroundSize: `${gapPx}px ${gapPx}px`,
        backgroundPosition: `${tx}px ${ty}px`,
      }}
    />
  );
});
