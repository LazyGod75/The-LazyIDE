/* RouterNode.tsx — W8c deliverable #3: an N-way branch node (Activepieces
   MIT-licensed router, REIMPLEMENTED here from scratch: this file shares no
   code/markup/assets with that project, only the "ordered labeled branches,
   first match wins" semantics, which chainEngine.ts's `resolveRouterBranch`
   actually implements — this component is display + editing only).

   Rendered as a small diamond (spec: "small diamond node with N ordered
   labeled outputs"), with its ordered branch list shown below as small
   editable rows (label input + condition summary + delete), and an "add
   branch" affordance while under the 4-branch cap. Mutates
   canvasStore.setRouterBranches directly — same "canvas-owned mutation,
   direct store read" convention DraftNode.tsx already uses for
   `removeDraft`, no new primitive needed.

   ONE React Flow source handle only (v1 simplification, documented in
   reconciler.ts's `resolveRouterBranchEndpoint` doc comment): every branch's
   outgoing chain edge visually emanates from the same point, distinguished
   by its own edge label (`ChainEdgeData.branchLabel`) rather than a
   per-branch anchor — chainEngine.ts's actual branch RESOLUTION logic does
   not depend on handle geometry at all, only on the persisted
   `RouterSpec.branches` order.

   W-CARDS (founder, 2026-07-21) — the old `zoomLevel === 'chip'` branch
   (a constant-size status dot standing in for the diamond below ZOOM_CHIP)
   and the `zoomLevel === 'full'` gate around the branch-list panel are both
   retired: this node now renders its ONE full layout (diamond + branch
   list) at every zoom, scaled naturally by React Flow's own viewport
   transform, same convention as MissionNode.tsx.
*/

import { memo, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { makeRef, type RouterBranch, type RouterBranchCondition, type RouterNodeData } from '../canvasTypes';
import { useI18n } from '../../../../i18n';
import { useCanvasStore } from '../canvasStore';
import { generateCanvasId } from '../canvasIds';
import { TypeGlyph, typeAccentColor } from '../chrome/nodeChrome';
import type { CanvasZoomLevel } from '../chrome/useZoomLevel';
import { useConnectionDragHighlight } from '../chrome/connectionDragStore';
import { ROUTER_NODE_SIZE } from '../reconciler';

const ROUTER_ACCENT = typeAccentColor('router');

// See MissionNode.tsx's MissionFlowNode doc comment for why the
// `& Record<string, unknown>` intersection is needed here.
export type RouterFlowNode = Node<RouterNodeData & Record<string, unknown>, 'router'>;

const MAX_BRANCHES = 4;
const MIN_BRANCHES = 2;

function conditionSummary(condition: RouterBranchCondition, t: (key: string, params?: Record<string, string>) => string): string {
  if (condition.kind === 'outcome') {
    return condition.value === 'success' ? t('canvas.router.conditionOutcomeSuccess') : t('canvas.router.conditionOutcomeFail');
  }
  if (condition.kind === 'contains') return t('canvas.router.conditionContains', { value: condition.value });
  return t('canvas.router.conditionDefault');
}

interface RouterNodeCardProps {
  data: RouterNodeData;
  /** W-CARDS — accepted for call-site compatibility (every existing test/
   *  caller) but no longer read: the card always renders its one full
   *  layout regardless of zoom (see this file's own header). */
  zoomLevel?: CanvasZoomLevel;
  selected?: boolean;
}

export function RouterNodeCard({ data, selected }: RouterNodeCardProps) {
  const { t } = useI18n();
  const setRouterBranches = useCanvasStore((s) => s.setRouterBranches);
  const removeRouter = useCanvasStore((s) => s.removeRouter);
  const [editingId, setEditingId] = useState<string | null>(null);
  const connectionHighlight = useConnectionDragHighlight(makeRef('router', data.routerId));

  function updateBranch(branchId: string, patch: Partial<Omit<RouterBranch, 'id'>>): void {
    const next = data.branches.map((b) => (b.id === branchId ? { ...b, ...patch } : b));
    setRouterBranches(data.routerId, next);
  }

  function addBranch(): void {
    if (data.branches.length >= MAX_BRANCHES) return;
    const branch: RouterBranch = {
      id: generateCanvasId('branch'),
      label: t('canvas.router.branchLabel', { n: String(data.branches.length + 1) }),
      condition: { kind: 'default' },
    };
    setRouterBranches(data.routerId, [...data.branches, branch]);
  }

  function removeBranch(branchId: string): void {
    if (data.branches.length <= MIN_BRANCHES) return;
    setRouterBranches(
      data.routerId,
      data.branches.filter((b) => b.id !== branchId),
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
      data-testid={`router-node-${data.routerId}`}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: ROUTER_NODE_SIZE.width + 40 }}
    >
      <div
        title={t('canvas.node.router')}
        className={diamondClasses}
        style={{
          width: ROUTER_NODE_SIZE.width * 0.6,
          height: ROUTER_NODE_SIZE.width * 0.6,
          transform: 'rotate(45deg)',
          borderRadius: 8,
          background: 'var(--canvas-node-bg)',
          border: selected ? `2px solid ${ROUTER_ACCENT}` : '1px solid var(--canvas-node-border-resting)',
          // W-BYO nit (b) — same inline-always-wins-over-CSS-class fix as
          // nodeChrome.tsx's NodeCard (see that file's comment): a
          // compatible connection-drag target now glows in the router's
          // OWN type-accent color instead of a dead CSS rule.
          boxShadow: selected
            ? `0 0 0 4px color-mix(in srgb, ${ROUTER_ACCENT} 18%, transparent)`
            : connectionHighlight === 'compatible'
              ? `0 0 0 2px color-mix(in srgb, ${ROUTER_ACCENT} 55%, transparent), 2px 2px 0 rgba(0,0,0,0.3)`
              : '2px 2px 0 rgba(0,0,0,0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderTop: !selected ? `3px solid ${ROUTER_ACCENT}` : undefined,
        }}
      >
        <span style={{ transform: 'rotate(-45deg)' }}>
          <TypeGlyph kind="router" size={18} color={ROUTER_ACCENT} title={t('canvas.node.router')} />
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
        {data.branches.map((branch, index) => (
          <div
            key={branch.id}
            data-testid={`router-node-branch-${branch.id}`}
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
          >
            <span style={{ fontSize: 9.5, color: 'var(--color-text-disabled)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
              {index + 1}
            </span>
            {editingId === branch.id ? (
              <input
                autoFocus
                data-testid={`router-node-branch-input-${branch.id}`}
                value={branch.label}
                onChange={(e) => updateBranch(branch.id, { label: e.target.value })}
                onBlur={() => setEditingId(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setEditingId(null);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 11,
                  padding: '2px 4px',
                  borderRadius: 4,
                  border: '1px solid var(--color-border-3)',
                  background: 'var(--color-panel-3)',
                  color: 'var(--color-text)',
                  fontFamily: 'inherit',
                }}
              />
            ) : (
              <button
                type="button"
                data-testid={`router-node-branch-label-${branch.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingId(branch.id);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                title={conditionSummary(branch.condition, t)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: 'left',
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '2px 4px',
                  borderRadius: 4,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--color-text)',
                  cursor: 'text',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {branch.label}
              </button>
            )}
            {data.branches.length > MIN_BRANCHES && (
              <button
                type="button"
                data-testid={`router-node-branch-delete-${branch.id}`}
                aria-label={t('canvas.router.deleteBranch')}
                onClick={(e) => {
                  e.stopPropagation();
                  removeBranch(branch.id);
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
        {data.branches.length < MAX_BRANCHES && (
          <button
            type="button"
            data-testid={`router-node-add-branch-${data.routerId}`}
            onClick={(e) => {
              e.stopPropagation();
              addBranch();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              padding: '3px 6px',
              borderRadius: 5,
              border: '1px dashed var(--color-border-3)',
              background: 'transparent',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            + {t('canvas.router.newBranch')}
          </button>
        )}
        <button
          type="button"
          data-testid={`router-node-delete-${data.routerId}`}
          onClick={(e) => {
            e.stopPropagation();
            removeRouter(data.routerId);
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
          {t('canvas.contextMenu.deleteRouter')}
        </button>
      </div>
    </div>
  );
}

const TARGET_HANDLE_STYLE = { width: 6, height: 16, borderRadius: 2, background: ROUTER_ACCENT, border: '2px solid var(--color-panel)' };
const SOURCE_HANDLE_STYLE = { width: 12, height: 12, borderRadius: '50%', background: ROUTER_ACCENT, border: '2px solid var(--color-panel)' };

export const RouterNode = memo(function RouterNode({ data, selected }: NodeProps<RouterFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} style={TARGET_HANDLE_STYLE} />
      <RouterNodeCard data={data} selected={selected} />
      {/* Single shared source handle — every branch's outgoing chain
          visually emanates from here, distinguished by its edge label (see
          this file's module header). */}
      <Handle type="source" position={Position.Right} style={SOURCE_HANDLE_STYLE} />
    </>
  );
});
