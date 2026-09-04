/**
 * canvasPopoverPosition.test.ts — fix/canvas-ux R6a BLOQUANT #2: pure
 * flip/clamp math for chrome/popoverPosition.ts's `computePopoverPosition`
 * (shared by GateFeedbackPopover.tsx, EdgeDropNodePicker.tsx, and
 * CanvasContextMenu.tsx). Direct unit tests, no component mount needed —
 * same convention as chrome/useZoomLevel.ts's `bucketZoom`.
 *
 * Real repro this fixes (final dogfood f23/f24): GateFeedbackPopover's
 * submit button rendered at y=851 in an 844px-tall viewport — only the LEFT
 * axis was ever clamped before.
 */

import { describe, it, expect } from 'vitest';
import { computePopoverPosition } from '../components/agents/canvas/chrome/popoverPosition';

const VIEWPORT = { width: 1440, height: 844 };

describe('computePopoverPosition', () => {
  it('renders BELOW the anchor when there is room (matches every pre-fix caller for the common case)', () => {
    const pos = computePopoverPosition(
      { anchorTop: 100, anchorBottom: 120, preferredLeft: 300 },
      { width: 260, height: 80 },
      VIEWPORT,
    );
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(126); // anchorBottom (120) + default gap (6)
    expect(pos.left).toBe(300);
  });

  it('flips ABOVE the anchor when there is not enough room below', () => {
    // Real repro shape: anchor near the bottom of an 844px viewport.
    const pos = computePopoverPosition(
      { anchorTop: 800, anchorBottom: 820, preferredLeft: 300 },
      { width: 260, height: 80 },
      VIEWPORT,
    );
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(800 - 80 - 6); // anchorTop - height - gap
    expect(pos.top + 80).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('NEVER renders any part below the viewport bottom, even with a tall popover and a low anchor', () => {
    const pos = computePopoverPosition(
      { anchorTop: 830, anchorBottom: 845, preferredLeft: 300 },
      { width: 260, height: 200 },
      VIEWPORT,
    );
    expect(pos.top + 200).toBeLessThanOrEqual(VIEWPORT.height);
    expect(pos.top).toBeGreaterThanOrEqual(0);
  });

  it('clamps the LEFT edge so the popover never renders off the right edge', () => {
    const pos = computePopoverPosition(
      { anchorTop: 100, anchorBottom: 120, preferredLeft: 1400 },
      { width: 260, height: 80 },
      VIEWPORT,
    );
    expect(pos.left + 260).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('clamps the LEFT edge so the popover never renders off the left edge', () => {
    const pos = computePopoverPosition(
      { anchorTop: 100, anchorBottom: 120, preferredLeft: -50 },
      { width: 260, height: 80 },
      VIEWPORT,
    );
    expect(pos.left).toBeGreaterThanOrEqual(8);
  });

  it('handles a zero-height point anchor (drop position / click point) the same way', () => {
    const pos = computePopoverPosition(
      { anchorTop: 830, anchorBottom: 830, preferredLeft: 300 },
      { width: 260, height: 120 },
      VIEWPORT,
    );
    expect(pos.placement).toBe('above');
    expect(pos.top + 120).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('respects a custom gap/margin', () => {
    const pos = computePopoverPosition(
      { anchorTop: 100, anchorBottom: 120, preferredLeft: 300 },
      { width: 260, height: 80 },
      VIEWPORT,
      12,
      8,
    );
    expect(pos.top).toBe(132); // 120 + 12
  });

  it('the zero-size (unmeasured) first guess always resolves below and left-clamped', () => {
    const pos = computePopoverPosition({ anchorTop: 100, anchorBottom: 120, preferredLeft: 300 }, { width: 0, height: 0 }, VIEWPORT);
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(126);
  });
});
