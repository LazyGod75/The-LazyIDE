/* BotVmNode.tsx — the LazyBot's connected live VM/browser window IN the canvas.

   Renders as its own canvas node (`botVm:<botId>`) tethered to the bot node by
   a hierarchy edge — the same visual contract as local agents' connected live
   windows (TerminalNode/PreviewNode). User-resizable via NodeResizer (selected
   only), draggable, closable (✕ → botVmWindows.toggle). The body is the exact
   BotVmSurface used by the old floating panel.
*/

import { memo, type CSSProperties } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import type { BotVmNodeData } from '../canvasTypes';
import { BotVmSurface } from './BotVmSurface';
import {
  toggleBotVmWindow,
  setBotVmWindowSize,
  BOT_VM_WINDOW_DEFAULT_SIZE,
} from '../../../../lib/solari/botVmWindows';

export type BotVmFlowNode = Node<BotVmNodeData, 'botVm'>;

const MIN_WIDTH = 260;
const MIN_HEIGHT = 180;

export function BotVmNodeCard({ data }: { data: BotVmNodeData }) {
  const { botId, botName, status } = data;
  const width = data.width ?? BOT_VM_WINDOW_DEFAULT_SIZE.width;
  const height = data.height ?? BOT_VM_WINDOW_DEFAULT_SIZE.height;
  const haloColor =
    status === 'working'
      ? '#66E27A'
      : status === 'waiting'
        ? '#FFB86B'
        : status === 'failed'
          ? '#FF6B6B'
          : status === 'done'
            ? '#B8A9FF'
            : '#9994B8';

  return (
    <div style={S.wrap(width, height)} data-testid={`bot-vm-node-${botId}`}>
      <div style={S.header}>
        <span style={{ ...S.dot, background: haloColor }} />
        <span style={S.title} title={botName}>
          {botName} · VM
        </span>
        <span style={S.spacer} />
        <button
          style={S.close}
          title="Fermer la fenêtre VM"
          data-testid={`bot-vm-close-${botId}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleBotVmWindow(botId);
          }}
        >
          ✕
        </button>
      </div>
      <div style={S.body}>
        <BotVmSurface botId={botId} />
      </div>
    </div>
  );
}

function BotVmNodeImpl({ data, selected }: NodeProps) {
  const d = data as BotVmNodeData;
  return (
    <>
      <Handle type="target" position={Position.Left} style={S.handle} />
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        onResizeEnd={(_event, params) => setBotVmWindowSize(d.botId, params.width, params.height)}
      />
      <BotVmNodeCard data={d} />
    </>
  );
}

export const BotVmNode = memo(BotVmNodeImpl);

const S = {
  wrap: (width: number, height: number): CSSProperties => ({
    width,
    height,
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid rgba(124,92,255,0.4)',
    borderRadius: 12,
    overflow: 'hidden',
    background: '#0E0E14',
    boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
  }),
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    background: '#16161D',
    flexShrink: 0,
    borderBottom: '1px solid rgba(124,92,255,0.2)',
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  title: { fontSize: 12, fontWeight: 600, color: '#E2E2F0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  spacer: { flex: 1 },
  close: {
    padding: '1px 7px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
    background: 'transparent', border: '1px solid rgba(255,107,107,0.4)', color: '#FF6B6B',
  },
  body: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  handle: {
    opacity: 0,
    width: 1,
    height: 1,
  },
};
