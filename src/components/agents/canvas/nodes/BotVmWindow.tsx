/* BotVmWindow — collapsible floating panel that wraps BotVmSurface for one
   LazyBot. This is the standalone embeddable surface; the canvas integration
   (tethered to the bot node) can reuse it as-is.
*/

import { useState } from 'react';
import { BotVmSurface } from './BotVmSurface';

interface BotVmWindowProps {
  botId: string;
  title?: string;
}

export function BotVmWindow({ botId, title = 'Bot VM' }: BotVmWindowProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={S.window} data-testid="bot-vm-window">
      <button style={S.header} onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
        <span style={S.dot} />
        <span style={S.title}>{title}</span>
        <span style={S.chevron}>{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && <BotVmSurface botId={botId} />}
    </div>
  );
}

const S = {
  window: {
    display: 'flex', flexDirection: 'column' as const,
    border: '1px solid rgba(124,92,255,0.3)', borderRadius: 12, overflow: 'hidden',
    background: '#0E0E14', width: 520, height: 400,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
    background: '#16161D', border: 'none', cursor: 'pointer', width: '100%',
    textAlign: 'left' as const, flexShrink: 0,
  },
  dot: { width: 8, height: 8, borderRadius: '50%', background: '#66E27A' },
  title: { fontSize: 13, fontWeight: 600, color: '#E2E2F0', flex: 1 },
  chevron: { fontSize: 12, color: '#9994B8' },
};
