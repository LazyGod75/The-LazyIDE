/* JoinNode.tsx — W-JOIN: fan-in (all-of) node, RouterNode.tsx's structural
   mirror image (read that file's own header first — this one deliberately
   follows its diamond-card / inline-delete conventions verbatim).

   A router is one incoming edge fanning OUT to N labeled branches the user
   TYPES; a join is N incoming sources fanning IN, wired by drag-connecting
   a real upstream mission/loop node into this one (canvasStore's `addChain`
   choke point keeps `JoinSpec.sourceRefs` in sync — see its own doc
   comment) — so unlike RouterNode, this card has no "add source" affordance
   or inline label editor: each row is a READ-ONLY projection of an already-
   wired source (title + live arrival dot), the join's own name is set once
   at creation, and the only per-row action is "unwire this source" (removes
   it from `sourceRefs`, mirroring RouterNode's `removeBranch`).

   W-CARDS (founder, 2026-07-21) — the old `zoomLevel === 'chip'` branch
   (a constant-size status dot standing in for the diamond below ZOOM_CHIP)
   and the `zoomLevel === 'full'` gate around the source-list panel are both
   retired: this node now renders its ONE full layout (diamond + source
   list) at every zoom, scaled naturally by React Flow's own viewport
   transform, same convention as MissionNode.tsx.
*/

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { makeRef, MIN_JOIN_SOURCES, type JoinNodeData, type JoinSourceView } from '../canvasTypes';
import { useI18n } from '../../../../i18n';
import { useCanvasStore } from '../canvasStore';
import { TypeGlyph, typeAccentColor } from '../chrome/nodeChrome';
import type { CanvasZoomLevel } from '../chrome/useZoomLevel';
import { useConnectionDragHighlight } from '../chrome/connectionDragStore';
import { JOIN_NODE_SIZE } from '../reconciler';

const JOIN_ACCENT = typeAccentColor('join');

// See MissionNode.tsx's MissionFlowNode doc comment for why the
// `& Record<string, unknown>` intersection is needed here.
export type JoinFlowNode = Node<JoinNodeData & Record<string, unknown>, 'join'>;

interface JoinNodeCardProps {
  data: JoinNodeData;
  /** W-CARDS — accepted for call-site compatibility (every existing test/
   *  caller) but no longer read: the card always renders its one full
   *  layout regardless of zoom (see this file's own header). */
  zoomLevel?: CanvasZoomLevel;
  selected?: boolean;
}

function modeLabel(mode: JoinNodeData['mode'], t: (key: string) => string): string {
  return mode === 'all_success' ? t('canvas.join.modeAllSuccess') : t('canvas.join.modeAllSettled');
}

function sourceDotColor(status: JoinSourceView['status']): string {
  return status === 'satisfied' ? 'var(--canvas-state-done, #34d399)' : 'var(--color-text-disabled)';
}

export function JoinNodeCard({ data, selected }: JoinNodeCardProps) {
  const { t } = useI18n();
  const updateJoin = useCanvasStore((s) => s.updateJoin);
  const removeJoin = useCanvasStore((s) => s.removeJoin);
  const connectionHighlight = useConnectionDragHighlight(makeRef('join', data.joinId));
  // Chantier 3 (plan-first canvas) — same convention as DraftNode.tsx: a
  // still-pending proposed join renders visibly more tentative than a real
  // (validated) fan-in join, see canvasTypes.ts's `JoinSpec.proposedPlanId`.
  const isProposed = data.proposedPlanId != null;

  function removeSource(ref: string): void {
    if (data.sources.length <= MIN_JOIN_SOURCES) return; // never below the fan-in floor — see canvasTypes.ts's MIN_JOIN_SOURCES
    updateJoin(
      data.joinId,
      { sourceRefs: data.sources.filter((s) => s.ref !== ref).map((s) => s.ref) },
    );
  }

  const diamondClasses = [
    'canvas-node-card',
    connectionHighlight === 'compatible' ? 'canvas-connect-compatible' : '',
    connectionHighlight === 'incompatible' ? 'canvas-connect-incompatible' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      data-testid={`join-node-${data.joinId}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        width: JOIN_NODE_SIZE.width + 40,
        opacity: isProposed ? 0.55 : 1,
      }}
    >
      <div
        title={data.name ?? t('canvas.node.join')}
        className={diamondClasses}
        style={{
          width: JOIN_NODE_SIZE.width * 0.6,
          height: JOIN_NODE_SIZE.width * 0.6,
          transform: 'rotate(45deg)',
          borderRadius: 8,
          background: 'var(--canvas-node-bg)',
          border: selected
            ? `2px solid ${JOIN_ACCENT}`
            : isProposed
              ? `2px dashed var(--color-warning, #f5b942)`
              : '1px solid var(--canvas-node-border-resting)',
          boxShadow: selected
            ? `0 0 0 4px color-mix(in srgb, ${JOIN_ACCENT} 18%, transparent)`
            : connectionHighlight === 'compatible'
              ? `0 0 0 2px color-mix(in srgb, ${JOIN_ACCENT} 55%, transparent), 2px 2px 0 rgba(0,0,0,0.3)`
              : '2px 2px 0 rgba(0,0,0,0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderTop: !selected ? `3px solid ${JOIN_ACCENT}` : undefined,
        }}
      >
        <span style={{ transform: 'rotate(-45deg)' }}>
          <TypeGlyph kind="join" size={18} color={JOIN_ACCENT} title={t('canvas.node.join')} />
        </span>
      </div>

      <div
        className="nodrag"
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '6px 8px',
          borderRadius: 8,
          background: 'var(--canvas-node-bg)',
          border: '1px solid var(--canvas-node-border-resting)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
          <span
            data-testid={`join-node-name-${data.joinId}`}
            style={{ fontSize: 11, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {data.name ?? t('canvas.node.join')}
          </span>
          <span
            data-testid={`join-node-mode-${data.joinId}`}
            style={{
              fontSize: 9,
              fontWeight: 600,
              padding: '1px 5px',
              borderRadius: 999,
              background: 'var(--color-panel-3)',
              color: 'var(--color-text-muted)',
              flexShrink: 0,
            }}
          >
            {modeLabel(data.mode, t)}
          </span>
        </div>

        {data.sources.map((source) => (
          <div
            key={source.ref}
            data-testid={`join-node-source-${source.ref}`}
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
          >
            <span
              data-testid={`join-node-source-dot-${source.ref}`}
              title={source.status === 'satisfied' ? t('canvas.join.arrivalSatisfied') : t('canvas.join.arrivalPending')}
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                flexShrink: 0,
                background: sourceDotColor(source.status),
              }}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {source.title}
            </span>
            {data.sources.length > MIN_JOIN_SOURCES && (
              <button
                type="button"
                data-testid={`join-node-source-remove-${source.ref}`}
                aria-label={t('canvas.join.removeSource')}
                onClick={(e) => {
                  e.stopPropagation();
                  removeSource(source.ref);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  width: 14,
                  height: 14,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--color-text-disabled)',
                  cursor: 'pointer',
                  flexShrink: 0,
                  fontSize: 11,
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}

        <button
          type="button"
          data-testid={`join-node-delete-${data.joinId}`}
          onClick={(e) => {
            e.stopPropagation();
            removeJoin(data.joinId);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: '2px 4px',
            border: 'none',
            background: 'transparent',
            color: 'var(--color-danger)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            opacity: 0.75,
          }}
        >
          {t('canvas.contextMenu.deleteJoin')}
        </button>
      </div>
    </div>
  );
}

const TARGET_HANDLE_STYLE = { width: 6, height: 16, borderRadius: 2, background: JOIN_ACCENT, border: '2px solid var(--color-panel)' };
const SOURCE_HANDLE_STYLE = { width: 12, height: 12, borderRadius: '50%', background: JOIN_ACCENT, border: '2px solid var(--color-panel)' };

export const JoinNode = memo(function JoinNode({ data, selected }: NodeProps<JoinFlowNode>) {
  return (
    <>
      {/* Every wired source lands on the SAME shared target handle — same
          v1 simplification RouterNode.tsx documents for its single source
          handle, mirrored here (chainEngine/canvasStore resolve fan-in
          membership from `JoinSpec.sourceRefs`, never from handle geometry). */}
      <Handle type="target" position={Position.Left} style={TARGET_HANDLE_STYLE} />
      <JoinNodeCard data={data} selected={selected} />
      <Handle type="source" position={Position.Right} style={SOURCE_HANDLE_STYLE} />
    </>
  );
});
