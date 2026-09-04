/* FrameNode.tsx — W-CLOSE row 2 (canvas scorecard "n8n Canvas Groups"
   parity gap). A PURELY VISUAL grouping rectangle rendered BEHIND every
   other node (reconcilerZones.ts's `buildFrameNodes` sets a negative
   `zIndex` — see that function's own doc comment for why that, not DOM
   order, is what actually puts it behind). Honest v1 scope, matching
   canvasTypes.ts's FrameSpec header: no parenting, no reflow — a frame
   never moves/deletes whatever visually sits on top of it, and dragging a
   node that happens to be over a frame never re-parents it into the frame.

   Modeled closely on TerminalNode.tsx's resize/title-bar shape (NodeResizer
   only while selected, a small header row) and NoteNode.tsx's inline-rename
   pattern (double-click the title -> input, Enter/blur commits, Escape
   reverts) — no new interaction idiom invented for this feature.
*/

import { memo, useRef, useState } from 'react';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import type { FrameSpec } from '../canvasTypes';
import { useI18n } from '../../../../i18n';
import { useCanvasStore } from '../canvasStore';
import { DEFAULT_FRAME_SIZE } from '../reconcilerZones';

export type FrameFlowNode = Node<FrameSpec & Record<string, unknown>, 'frame'>;

const MIN_WIDTH = 160;
const MIN_HEIGHT = 100;

interface FrameNodeCardProps {
  data: FrameSpec;
  selected?: boolean;
}

export function FrameNodeCard({ data, selected }: FrameNodeCardProps) {
  const { t } = useI18n();
  const updateFrame = useCanvasStore((s) => s.updateFrame);
  const removeFrame = useCanvasStore((s) => s.removeFrame);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const width = data.width ?? DEFAULT_FRAME_SIZE.width;
  const height = data.height ?? DEFAULT_FRAME_SIZE.height;

  function commit(): void {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== data.title) updateFrame(data.id, { title: trimmed });
    else setDraft(data.title); // empty/unchanged — revert the local draft, never persist a blank title
  }

  function cancel(): void {
    setDraft(data.title);
    setEditing(false);
  }

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        onResizeEnd={(_event, params) => updateFrame(data.id, { width: params.width, height: params.height })}
      />
      <div
        data-testid={`frame-node-${data.id}`}
        style={{
          width,
          height,
          borderRadius: 10,
          border: `1.5px dashed ${selected ? 'var(--color-accent)' : 'rgba(255,255,255,0.28)'}`,
          background: 'rgba(255,255,255,0.025)',
          display: 'flex',
          flexDirection: 'column',
          // No pointer-events trickery needed: reconcilerZones.ts's
          // `buildFrameNodes` gives every frame a negative `zIndex`, and
          // React Flow renders every node as a flat sibling in the SAME
          // stacking context regardless of `parentId` nesting (positions are
          // resolved to absolute coordinates internally) — so a real node
          // visually on top of this frame is simply a HIGHER-zIndex sibling
          // at that exact point and wins ordinary CSS hit-testing on its
          // own. Clicking empty frame area (nothing else on top there)
          // naturally hits this card, letting the user drag/select the
          // frame itself — the same "click a group's empty body to move it"
          // gesture n8n's own Canvas Groups use.
        }}
      >
        <div
          className="nodrag"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 8px',
            alignSelf: 'flex-start',
            maxWidth: '100%',
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setDraft(data.title);
            setEditing(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          {editing ? (
            <input
              ref={inputRef}
              data-testid={`frame-node-title-input-${data.id}`}
              className="nodrag"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancel();
                }
              }}
              style={{
                fontSize: 11,
                fontWeight: 700,
                background: 'var(--color-panel-2)',
                color: 'var(--color-text)',
                border: '1px solid var(--color-accent-border)',
                borderRadius: 4,
                padding: '2px 5px',
                minWidth: 80,
              }}
            />
          ) : (
            <span
              data-testid={`frame-node-title-${data.id}`}
              title={data.title}
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--color-text-secondary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {data.title || t('canvas.frame.untitled')}
            </span>
          )}
          <button
            type="button"
            data-testid={`frame-node-remove-${data.id}`}
            className="nodrag"
            aria-label={t('canvas.frame.remove')}
            onClick={(e) => {
              e.stopPropagation();
              removeFrame(data.id);
            }}
            style={{
              width: 14,
              height: 14,
              lineHeight: '12px',
              borderRadius: 3,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-disabled)',
              cursor: 'pointer',
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      </div>
    </>
  );
}

export const FrameNode = memo(function FrameNode({ data, selected }: NodeProps<FrameFlowNode>) {
  return <FrameNodeCard data={data} selected={selected} />;
});
