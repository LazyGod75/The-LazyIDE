/* DraftNode.tsx — an armed-but-not-launched mission spec (spec §4.2):
   dashed "ghost" card, task preview, model/agent chips, a "En attente"
   badge (reuses the existing `canvas.node.waiting` i18n key), a launch
   button (reuses `canvas.node.launch`), and an edit affordance.

   W-CARDS (founder, 2026-07-21: "every node scales naturally with the
   canvas, exactly like MissionNode") — the old three-level semantic zoom
   (dot glyph / stripped compact header / full card) is retired: this card
   now renders its ONE full layout at every zoom, geometrically scaled by
   React Flow's own viewport transform like any other node. `zoomLevel` is
   still accepted on `DraftNodeCardProps` for call-site compatibility
   (every existing test/caller) but no longer changes what renders — same
   convention MissionNode.tsx already established. The RF-registered
   `DraftNode` below never read the live viewport zoom in the first place
   (it always passed the literal 'full'), so this only retires the now-dead
   'chip'/'compact' branches `DraftNodeCard` itself used to expose.

   fix/canvas-ux R6a BLOQUANT #1 (superseded by W-CARDS, kept for history):
   the ONLY launch affordance used to be the "▶ Lancer" button inside the
   `zoomLevel === 'full'` block — below ZOOM_COMPACT, the compact card
   rendered NOTHING but the header row, so the primary gesture could vanish
   entirely at the exact zoom level auto-arrange leaves the user at. Now
   moot: the full body (launch + edit buttons) is the only body, at every
   zoom, so the gesture is always reachable.
*/

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { makeRef, type DraftSpec } from '../canvasTypes';
import { useI18n } from '../../../../i18n';
import { useCanvasActions } from '../chrome/CanvasActionsContext';
import { useCanvasStore } from '../canvasStore';
import type { CanvasZoomLevel } from '../chrome/useZoomLevel';
import { formatClock } from '../replay/replayTicker';
import { AgentPersonaChip, AutonomyModeChip, CardTitleBand, FULL_CARD_MAX_HEIGHT, FULL_CARD_WIDTH, MetaChip, ModelTierChip, NodeCard, ProposedBadge, TypeGlyph, buildNodeTooltip, typeAccentColor } from '../chrome/nodeChrome';
import { DeleteIcon, EditIcon, HoverActionStrip, PlayIcon, type HoverAction } from '../chrome/HoverActionStrip';
import { useConnectionDragHighlight } from '../chrome/connectionDragStore';

const DRAFT_ACCENT = typeAccentColor('draft');

// See MissionNode.tsx's MissionFlowNode doc comment for why the
// `& Record<string, unknown>` intersection is needed here.
export type DraftFlowNode = Node<DraftSpec & Record<string, unknown>, 'draft'>;

interface DraftNodeCardProps {
  data: DraftSpec;
  /** W-CARDS — accepted for call-site compatibility (every existing test/
   *  caller) but no longer read: the card always renders its one full
   *  layout regardless of zoom (see this file's own header). */
  zoomLevel?: CanvasZoomLevel;
  selected?: boolean;
}

export function DraftNodeCard({ data, selected }: DraftNodeCardProps) {
  const { t } = useI18n();
  const actions = useCanvasActions();
  // Delete is a canvas-owned mutation (removeDraft) — same direct
  // canvasStore read CanvasContextMenu.tsx already uses for its own
  // draft-delete entry, no new primitive.
  const removeDraft = useCanvasStore((s) => s.removeDraft);
  const connectionHighlight = useConnectionDragHighlight(makeRef('draft', data.id));
  // Chantier 3 (plan-first canvas) — a still-pending proposed step has no
  // individual launch/edit/delete affordance of its own: the decision is
  // made once, at the PLAN level (GraphProposalCard's validate/modify/
  // reject), never per-node — see canvasTypes.ts's `DraftSpec.proposedPlanId`
  // doc comment for the full identity-continuity rationale.
  const isProposed = data.proposedPlanId != null;

  // W8a deliverable #1 — hover quick-actions.
  const hoverActions: HoverAction[] = [
    { key: 'launch', label: t('canvas.node.launch'), icon: <PlayIcon />, onSelect: () => actions.onLaunchDraft(data.id) },
    { key: 'edit', label: t('canvas.contextMenu.edit'), icon: <EditIcon />, onSelect: () => actions.onEditDraft(data.id) },
    { key: 'delete', label: t('canvas.contextMenu.delete'), icon: <DeleteIcon />, danger: true, onSelect: () => removeDraft(data.id) },
  ];

  return (
    <NodeCard
      typeAccent={DRAFT_ACCENT}
      connectionHighlight={connectionHighlight}
      selected={selected}
      ghost
      proposed={isProposed}
      testId={`draft-node-${data.id}`}
      tooltip={buildNodeTooltip(data.title, t(isProposed ? 'canvas.node.proposed' : 'canvas.node.waiting'), data.model)}
      hoverActions={isProposed ? undefined : <HoverActionStrip actions={hoverActions} groupLabel={t('canvas.hover.actions')} />}
      style={{
        padding: '12px 12px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        width: FULL_CARD_WIDTH,
        maxHeight: FULL_CARD_MAX_HEIGHT,
        overflow: 'hidden',
      }}
    >
      <CardTitleBand testId={`draft-node-title-band-${data.id}`}>
        <TypeGlyph kind="draft" color={DRAFT_ACCENT} title="Draft" />
        {data.agentName && (
          <AgentPersonaChip agentName={data.agentName} testId="draft-node-agent-chip" />
        )}
        <span
          data-testid="draft-node-title"
          style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {data.title}
        </span>
        <AutonomyModeChip mode={data.permissionMode} />
        {isProposed ? (
          <ProposedBadge label={t('canvas.node.proposed')} />
        ) : (
          <span
            data-testid="draft-node-waiting-badge"
            style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: 'var(--color-panel-3)', color: 'var(--color-text-disabled)', whiteSpace: 'nowrap' }}
          >
            {t('canvas.node.waiting')}
          </span>
        )}
      </CardTitleBand>

      <p
        data-testid="draft-node-task-preview"
        style={{
          margin: 0,
          fontSize: 11,
          color: 'var(--color-text-muted)',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {data.task}
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        {data.agentName && <MetaChip testId="draft-node-agent-chip">{data.agentName}</MetaChip>}
        {data.model && <ModelTierChip model={data.model} testId="draft-node-model-chip" />}
        {/* Fork-from-replay (v1) provenance — see canvasTypes.ts's
            DraftSpec.forkOf and lib/agents/forkFromReplay.ts's own
            honest-semantics header. */}
        {data.forkOf && (
          <MetaChip testId="draft-node-fork-chip">
            {t('canvas.node.forkOf', { missionId: data.forkOf.missionId, time: formatClock(data.forkOf.atMs) })}
          </MetaChip>
        )}
      </div>

      {!isProposed && (
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          data-testid={`draft-node-launch-${data.id}`}
          className="nodrag"
          onClick={(e) => {
            e.stopPropagation();
            actions.onLaunchDraft(data.id);
          }}
          style={{
            flex: 1,
            fontSize: 11,
            fontWeight: 700,
            padding: '5px 8px',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            background: 'var(--color-accent)',
            color: '#14141C',
          }}
        >
          {/* The "▶" arrow is a plain character, not an emoji icon prop
              (design-system convention) — no i18n key needed for it. */}
          ▶ {t('canvas.node.launch')}
        </button>
        <button
          type="button"
          data-testid={`draft-node-edit-${data.id}`}
          className="nodrag"
          onClick={(e) => {
            e.stopPropagation();
            actions.onEditDraft(data.id);
          }}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: '5px 8px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.18)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            background: 'transparent',
            color: 'var(--color-text-muted)',
          }}
        >
          {t('canvas.node.edit')}
        </button>
      </div>
      )}
    </NodeCard>
  );
}

const TARGET_HANDLE_STYLE = { width: 6, height: 16, borderRadius: 2, background: DRAFT_ACCENT, border: '2px solid var(--color-panel)' };
const SOURCE_HANDLE_STYLE = { width: 12, height: 12, borderRadius: '50%', background: DRAFT_ACCENT, border: '2px solid var(--color-panel)' };

export const DraftNode = memo(function DraftNode({ data, selected }: NodeProps<DraftFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Left} style={TARGET_HANDLE_STYLE} />
      <DraftNodeCard data={data} selected={selected} />
      <Handle type="source" position={Position.Right} style={SOURCE_HANDLE_STYLE} />
    </>
  );
});
