/* DryRunOverlay.tsx — W8a deliverable #3: the visual layer of the dry-run
   chain preview. Renders ABOVE the live canvas (a viewport-transformed
   overlay, same flow->screen projection AlignmentGuides.tsx uses) without
   ever touching React Flow's own nodes/edges state:

     - each reached node gets a one-shot highlight pulse ring
       (canvas.css's canvas-dryrun-pulse, 400ms stagger upstream in
       dryRunWalk.ts);
     - each fired chain edge draws its condition-styled path (success
       solid, fail dashed — the "alternate path" look — always dotted) plus
       a traveling dot reusing ChainEdge's exact firing mechanics
       (CSS offset-path, canvas-chain-dot) via LOCAL state only;
     - a banner « Simulation — aucun agent lancé » with [Rejouer] [Fermer]
       (Escape exits too — see useDryRunPreview.ts).

   Read-only by construction: the only inputs are the session timeline and
   React Flow's internal nodeLookup (for geometry) — no canvasStore import
   at all, so a preview cannot mutate persisted state even by accident.
*/

import { memo, type CSSProperties } from 'react';
import { getBezierPath, Position, useStore, useViewport, type ReactFlowState } from '@xyflow/react';
import { useI18n } from '../../../../i18n';
import { conditionStrokeProps } from '../edges/ChainEdge';
import type { DryRunSession } from './useDryRunPreview';

interface NodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

function selectNodeGeometry(s: ReactFlowState): ReadonlyMap<string, NodeGeometry> {
  const geometry = new Map<string, NodeGeometry>();
  for (const [id, node] of s.nodeLookup) {
    geometry.set(id, {
      x: node.internals.positionAbsolute.x,
      y: node.internals.positionAbsolute.y,
      width: node.measured.width ?? node.width ?? 0,
      height: node.measured.height ?? node.height ?? 0,
    });
  }
  return geometry;
}

interface DryRunOverlayProps {
  session: DryRunSession;
  onReplay: () => void;
  onClose: () => void;
}

const BANNER_BUTTON_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.18)',
  background: 'transparent',
  color: 'var(--color-text)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export const DryRunOverlay = memo(function DryRunOverlay({ session, onReplay, onClose }: DryRunOverlayProps) {
  const { t } = useI18n();
  const { x: panX, y: panY, zoom } = useViewport();
  const geometry = useStore(selectNodeGeometry);
  const { timeline, elapsedMs } = session;

  const visibleNodeSteps = timeline.nodeSteps.filter((step) => elapsedMs >= step.at && geometry.has(step.id));
  const visibleEdgeSteps = timeline.edgeSteps.filter(
    (step) => elapsedMs >= step.at && geometry.has(step.source) && geometry.has(step.target),
  );
  const isEmpty = timeline.nodeSteps.length === 0;

  return (
    <div
      data-testid="canvas-dryrun-overlay"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 6, overflow: 'hidden' }}
    >
      {/* Flow-space layer — same projection AlignmentGuides applies per
          element, hoisted onto one container: screen = flow * zoom + pan. */}
      <div style={{ position: 'absolute', top: 0, left: 0, transform: `translate(${panX}px, ${panY}px) scale(${zoom})`, transformOrigin: '0 0' }}>
        <svg width={1} height={1} style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }} aria-hidden="true">
          {visibleEdgeSteps.map((step) => {
            const sourceGeom = geometry.get(step.source)!;
            const targetGeom = geometry.get(step.target)!;
            const [path] = getBezierPath({
              sourceX: sourceGeom.x + sourceGeom.width,
              sourceY: sourceGeom.y + sourceGeom.height / 2,
              sourcePosition: Position.Right,
              targetX: targetGeom.x,
              targetY: targetGeom.y + targetGeom.height / 2,
              targetPosition: Position.Left,
            });
            const stroke = conditionStrokeProps(step.condition, false);
            return (
              <g key={step.id} data-testid={`dryrun-edge-${step.id}`} data-condition={step.condition}>
                <path
                  d={path}
                  fill="none"
                  stroke={stroke.stroke}
                  strokeWidth={2.5}
                  strokeDasharray={step.condition === 'success' ? undefined : stroke.strokeDasharray}
                  opacity={0.9}
                />
                <circle
                  data-testid={`dryrun-dot-${step.id}`}
                  r={5}
                  fill={stroke.stroke}
                  className="canvas-chain-dot"
                  style={{ offsetPath: `path('${path}')` } as CSSProperties}
                />
              </g>
            );
          })}
        </svg>
        {visibleNodeSteps.map((step) => {
          const nodeGeom = geometry.get(step.id)!;
          return (
            <div
              key={step.id}
              data-testid={`dryrun-node-pulse-${step.id}`}
              className="canvas-dryrun-node-pulse"
              style={{
                position: 'absolute',
                left: nodeGeom.x - 4,
                top: nodeGeom.y - 4,
                width: nodeGeom.width + 8,
                height: nodeGeom.height + 8,
                borderRadius: 12,
                pointerEvents: 'none',
              }}
            />
          );
        })}
      </div>

      {/* Banner — screen-space, interactive. */}
      <div
        data-testid="canvas-dryrun-banner"
        role="status"
        style={{
          position: 'absolute',
          top: 12,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '7px 14px',
          borderRadius: 20,
          background: 'var(--color-panel-2)',
          border: '1px solid var(--color-accent-border)',
          boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
          color: 'var(--color-text)',
          fontSize: 12,
          fontWeight: 600,
          fontFamily: 'var(--font-ui)',
          pointerEvents: 'auto',
          whiteSpace: 'nowrap',
        }}
      >
        <span>{isEmpty ? t('canvas.dryrun.empty') : t('canvas.dryrun.banner')}</span>
        {!isEmpty && (
          <button type="button" data-testid="canvas-dryrun-replay" onClick={onReplay} style={BANNER_BUTTON_STYLE}>
            {t('canvas.dryrun.replay')}
          </button>
        )}
        <button type="button" data-testid="canvas-dryrun-close" onClick={onClose} style={BANNER_BUTTON_STYLE}>
          {t('canvas.dryrun.close')}
        </button>
      </div>
    </div>
  );
});
