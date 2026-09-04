/* LazyBotNode — canvas card for a LazyBot (premium visual).
   Pure presentational component (LazyBotNodeCard) + React Flow wrapper
   (LazyBotNode) following the MissionNode split pattern.

   Reads `BotNodeData` (canvasTypes.ts): the bot NAME is the largest,
   always-visible element (the LazyManager asks for it at creation), with a
   status halo (idle/working/waiting/done/failed), autonomy badge, and the
   current/last action.
*/

import { memo, useEffect, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { BotNodeData, BotNodeStatus } from '../canvasTypes';
import { listPendingApprovals, resolveApproval } from '../../../../lib/agents/approval/approvalGate';
import { isBotVmWindowOpen, toggleBotVmWindow, subscribeBotVmWindows } from '../../../../lib/solari/botVmWindows';

export type { BotNodeData } from '../canvasTypes';

/** Alias kept for callers that imported the old name before the LazyBot
 *  canvas wave standardized the payload on canvasTypes's BotNodeData. */
export type LazyBotNodeData = BotNodeData;

export type LazyBotFlowNode = Node<BotNodeData, 'bot'>;

const AUTONOMY_COLORS: Record<string, string> = {
  manual: '#FF6B6B',
  supervised: '#FFB86B',
  yolo: '#66E27A',
};

const STATUS_COLORS: Record<BotNodeStatus, string> = {
  idle: '#8A86A0',
  working: '#66E27A',
  waiting: '#FFB86B',
  done: '#B8A9FF',
  failed: '#FF6B6B',
};

const STATUS_LABEL: Record<BotNodeStatus, string> = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Needs approval',
  done: 'Done',
  failed: 'Failed',
};

const CARD_WIDTH = 220;
const CARD_HEIGHT = 140;

export const LazyBotNodeCard = memo(function LazyBotNodeCard({
  bot,
  status = 'idle',
  activeRuns = 0,
  activeRunIds,
  lastAction,
  selected = false,
}: BotNodeData & { selected?: boolean }) {
  const autonomyColor = AUTONOMY_COLORS[bot.autonomy] ?? '#B8A9FF';
  const statusColor = STATUS_COLORS[status];
  const caps = [
    bot.capabilities.browser && 'Browser',
    bot.capabilities.desktop && 'Desktop',
    bot.capabilities.sandbox && 'Sandbox',
  ].filter(Boolean).join(' · ');

  // Connected VM window (canvas node) — reflect + toggle its open state.
  const [vmOpen, setVmOpen] = useState(() => isBotVmWindowOpen(bot.id));
  useEffect(
    () =>
      subscribeBotVmWindows(({ botId, open }) => {
        if (botId === bot.id) setVmOpen(open);
      }),
    [bot.id],
  );

  // Inline approval (Auto Review): when waiting, resolve this bot's pending
  // gate requests by mission id and let the user approve/deny right here.
  const pending = status === 'waiting'
    ? listPendingApprovals().filter((p) => activeRunIds?.includes(p.missionId))
    : [];

  return (
    <div
      style={{
        ...S.card,
        ...(selected ? S.cardSelected : {}),
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      }}
    >
      {/* Status halo */}
      <div
        style={{
          ...S.halo,
          background: statusColor,
          boxShadow: `0 0 10px ${statusColor}${status === 'working' ? 'cc' : '55'}`,
          ...(status === 'working' ? S.haloPulse : {}),
        }}
      />

      {/* Header: avatar + name (prominent) + autonomy */}
      <div style={S.header}>
        <div style={S.avatar}>{bot.avatar ?? '🤖'}</div>
        <div style={S.nameSection}>
          <div style={S.name} title={bot.name}>{bot.name}</div>
          {bot.description && <div style={S.desc}>{bot.description}</div>}
        </div>
        <span style={{ ...S.autonomyChip, color: autonomyColor, borderColor: autonomyColor }}>
          {bot.autonomy.toUpperCase()}
        </span>
      </div>

      {/* Status + action line */}
      <div style={S.statusBar}>
        <span style={{ color: statusColor, fontWeight: 600 }}>
          {STATUS_LABEL[status]}
        </span>
        {activeRuns > 0 && <span style={S.runsChip}>{activeRuns} run{activeRuns > 1 ? 's' : ''}</span>}
        {caps && <span style={S.capsChip}>{caps}</span>}
        <button
          className="nodrag"
          data-testid={`bot-vm-open-${bot.id}`}
          onClick={(e) => { e.stopPropagation(); toggleBotVmWindow(bot.id); }}
          style={vmOpen ? S.vmBtnActive : S.vmBtn}
          title={vmOpen ? 'Fermer la fenêtre VM' : 'Ouvrir la fenêtre VM'}
        >
          {vmOpen ? '✕ VM' : '▶ VM'}
        </button>
      </div>
      <div style={S.actionLine} title={lastAction}>
        {lastAction || 'Ready'}
      </div>
      {pending.length > 0 && (
        <div style={S.approvalRow} data-testid={`bot-approval-inline-${bot.id}`}>
          <span style={S.approvalTool}>{pending[0].tool}</span>
          <button style={S.approveBtn} onClick={() => resolveApproval(pending[0].missionId, 'approve')}>Approve</button>
          <button style={S.alwaysBtn} onClick={() => resolveApproval(pending[0].missionId, 'alwaysAllow')}>Always</button>
          <button style={S.denyBtn} onClick={() => resolveApproval(pending[0].missionId, 'deny')}>Deny</button>
        </div>
      )}
    </div>
  );
});

export const LazyBotNode = memo(function LazyBotNode({ data, selected }: NodeProps<LazyBotFlowNode>) {
  return (
    <>
      <Handle type="target" position={Position.Top} style={S.handle} />
      <LazyBotNodeCard {...data} selected={selected} />
      <Handle type="source" position={Position.Bottom} style={S.handle} />
    </>
  );
});

// ── Styles ─────────────────────────────────────────────────────────

const S = {
  card: {
    position: 'relative' as const,
    background: 'linear-gradient(135deg, #1A1A24 0%, #16161D 100%)',
    border: '1px solid rgba(124, 92, 255, 0.3)',
    borderRadius: 12,
    padding: 12,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
    overflow: 'hidden',
    cursor: 'pointer',
  },
  cardSelected: {
    border: '1px solid rgba(124, 92, 255, 0.6)',
    boxShadow: '0 0 20px rgba(124, 92, 255, 0.3)',
  },
  halo: {
    position: 'absolute' as const,
    top: 8,
    right: 10,
    width: 10,
    height: 10,
    borderRadius: '50%',
    zIndex: 1,
  },
  haloPulse: {
    animation: 'lazybot-halo-pulse 1.4s ease-in-out infinite',
  },
  header: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: {
    fontSize: 26, width: 40, height: 40,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(124, 92, 255, 0.12)', borderRadius: 10,
    flexShrink: 0,
  },
  nameSection: { flex: 1, minWidth: 0 },
  // The name is the largest text on the node and is always fully visible.
  name: {
    fontSize: 17, fontWeight: 700, color: '#F2F2FA',
    whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
    lineHeight: 1.15,
  },
  desc: {
    fontSize: 11, color: '#9994B8', marginTop: 2,
    whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
  },
  autonomyChip: {
    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 6,
    border: '1px solid', letterSpacing: '0.03em', flexShrink: 0,
  },
  statusBar: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const },
  runsChip: {
    fontSize: 10, fontWeight: 600, color: '#B8A9FF',
    background: 'rgba(124,92,255,0.2)', padding: '2px 6px', borderRadius: 6,
  },
  capsChip: { fontSize: 10, color: '#9994B8' },
  vmBtn: {
    fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: '2px 7px', borderRadius: 6,
    background: 'rgba(124,92,255,0.18)', border: '1px solid rgba(124,92,255,0.45)', color: '#B8A9FF',
    marginLeft: 'auto',
  },
  vmBtnActive: {
    fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: '2px 7px', borderRadius: 6,
    background: 'rgba(124,92,255,0.42)', border: '1px solid rgba(180,160,255,0.9)', color: '#FFFFFF',
    marginLeft: 'auto',
  },
  actionLine: {
    fontSize: 11, color: '#B8A9FF', marginTop: 'auto',
    whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
    paddingTop: 2,
  },
  approvalRow: {
    display: 'flex', alignItems: 'center', gap: 4, marginTop: 2,
    padding: '4px 6px', borderRadius: 6, background: 'rgba(255,183,107,0.12)',
    border: '1px solid rgba(255,183,107,0.35)',
  },
  approvalTool: {
    fontSize: 10, color: '#FFB86B', fontFamily: 'monospace',
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  },
  approveBtn: {
    fontSize: 10, fontWeight: 600, cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
    background: 'rgba(102,226,122,0.15)', border: '1px solid rgba(102,226,122,0.4)', color: '#66E27A',
  },
  alwaysBtn: {
    fontSize: 10, fontWeight: 600, cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
    background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.4)', color: '#B8A9FF',
  },
  denyBtn: {
    fontSize: 10, fontWeight: 600, cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
    background: 'rgba(255,107,107,0.15)', border: '1px solid rgba(255,107,107,0.4)', color: '#FF6B6B',
  },
  handle: { width: 8, height: 8, background: 'rgba(124, 92, 255, 0.5)', border: 'none' },
};

