/* BotListPanel — list of all LazyBots for the cockpit left rail.
   Shows each bot as a compact row with status, autonomy, and active runs.
   Clicking a row selects it (onSelect) for the BotDetailPanel.
*/

import { memo } from 'react';
import type { BotConfig } from '../../lib/bots/botTypes';
import { useBots } from './botsStore';

interface BotListPanelProps {
  selectedBotId?: string;
  onSelect: (bot: BotConfig) => void;
  onCreateClick: () => void;
}

const AUTONOMY_COLORS: Record<BotConfig['autonomy'], string> = {
  manual: '#FF6B6B',
  supervised: '#FFB86B',
  yolo: '#66E27A',
};

export const BotListPanel = memo(function BotListPanel({
  selectedBotId,
  onSelect,
  onCreateClick,
}: BotListPanelProps) {
  const { bots, loading, error, getRuntimeState } = useBots();

  if (loading) {
    return <div style={S.empty}>Loading bots...</div>;
  }

  if (error) {
    return <div style={S.error}>Error: {error}</div>;
  }

  return (
    <div style={S.panel}>
      <div style={S.header}>
        <span style={S.title}>LazyBots</span>
        <button onClick={onCreateClick} style={S.createBtn}>+ New</button>
      </div>

      {bots.length === 0 ? (
        <div style={S.empty}>
          <div style={S.emptyIcon}>🤖</div>
          <div style={S.emptyText}>No bots yet</div>
          <button onClick={onCreateClick} style={S.emptyBtn}>Create your first bot</button>
        </div>
      ) : (
        <div style={S.list}>
          {bots.map((bot) => {
            const runtime = getRuntimeState(bot.id);
            const isSelected = bot.id === selectedBotId;
            return (
              <button
                key={bot.id}
                onClick={() => onSelect(bot)}
                style={{
                  ...S.row,
                  ...(isSelected ? S.rowSelected : {}),
                }}
              >
                <div style={S.rowAvatar}>{bot.avatar ?? '🤖'}</div>
                <div style={S.rowInfo}>
                  <div style={S.rowName}>{bot.name}</div>
                  <div style={S.rowDesc}>{bot.description || 'No description'}</div>
                </div>
                <div style={S.rowMeta}>
                  <span style={{
                    ...S.rowDot,
                    background: bot.enabled ? AUTONOMY_COLORS[bot.autonomy] : '#555',
                  }} />
                  {runtime.activeRuns.length > 0 && (
                    <span style={S.rowRuns}>{runtime.activeRuns.length}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

// ── Styles ─────────────────────────────────────────────────────────

const S = {
  panel: {
    display: 'flex', flexDirection: 'column' as const,
    height: '100%', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px', flexShrink: 0,
  },
  title: { fontSize: 13, fontWeight: 600, color: '#E2E2F0', letterSpacing: '0.02em' },
  createBtn: {
    padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
    background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.3)',
    color: '#B8A9FF', fontSize: 12, fontWeight: 500,
  },
  list: { flex: 1, overflowY: 'auto' as const, padding: '0 8px' },
  row: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
    background: 'transparent', border: '1px solid transparent',
    width: '100%', textAlign: 'left' as const, marginBottom: 4,
  },
  rowSelected: {
    background: 'rgba(124,92,255,0.1)', border: '1px solid rgba(124,92,255,0.3)',
  },
  rowAvatar: {
    fontSize: 20, width: 32, height: 32,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(124,92,255,0.1)', borderRadius: 8, flexShrink: 0,
  },
  rowInfo: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 13, fontWeight: 500, color: '#E2E2F0', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  rowDesc: { fontSize: 11, color: '#9994B8', marginTop: 2, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' },
  rowMeta: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  rowDot: { width: 8, height: 8, borderRadius: '50%' },
  rowRuns: { fontSize: 10, fontWeight: 600, color: '#B8A9FF', background: 'rgba(124,92,255,0.2)', padding: '2px 6px', borderRadius: 6 },
  empty: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
    justifyContent: 'center', gap: 12, padding: 40, color: '#9994B8',
  },
  emptyIcon: { fontSize: 40 },
  emptyText: { fontSize: 14, color: '#9994B8' },
  emptyBtn: {
    padding: '8px 16px', borderRadius: 8, cursor: 'pointer',
    background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.3)',
    color: '#B8A9FF', fontSize: 13,
  },
  error: { padding: 20, color: '#FF6B6B', fontSize: 13 },
};
