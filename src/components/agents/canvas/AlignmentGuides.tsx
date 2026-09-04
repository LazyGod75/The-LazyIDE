/* AlignmentGuides.tsx — renders the 1px snap/alignment lines computed by
   canvasPlacement.ts's computeAlignmentGuides (spec §5 "Snap & guides").
   CSS/SVG only, no dependency: an absolutely-positioned overlay projecting
   flow-space guide coordinates into screen space via React Flow's own
   translate-then-scale viewport transform (`screen = flow * zoom + pan`,
   the same formula CanvasToolbar's zoom-% readout and every RF-internal
   node relies on via useViewport()/useStore(s => s.transform)).

   Rendered as a plain child of `<ReactFlow>` (not a `<Panel>`, which clips
   to a corner) so the lines can span the whole pane.
*/

import { memo } from 'react';
import { useViewport } from '@xyflow/react';
import type { AlignmentGuides as AlignmentGuidesValue } from './canvasPlacement';

interface AlignmentGuidesProps {
  guides: AlignmentGuidesValue | null;
}

export const AlignmentGuides = memo(function AlignmentGuides({ guides }: AlignmentGuidesProps) {
  const { x: panX, y: panY, zoom } = useViewport();

  if (!guides || (guides.x === undefined && guides.y === undefined)) return null;

  return (
    <div data-testid="canvas-alignment-guides" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {guides.x !== undefined && (
        <div
          data-testid="canvas-alignment-guide-x"
          style={{
            position: 'absolute',
            left: guides.x * zoom + panX,
            top: 0,
            bottom: 0,
            width: 1,
            background: 'var(--color-accent)',
            opacity: 0.7,
          }}
        />
      )}
      {guides.y !== undefined && (
        <div
          data-testid="canvas-alignment-guide-y"
          style={{
            position: 'absolute',
            top: guides.y * zoom + panY,
            left: 0,
            right: 0,
            height: 1,
            background: 'var(--color-accent)',
            opacity: 0.7,
          }}
        />
      )}
    </div>
  );
});
