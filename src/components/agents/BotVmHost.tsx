/* BotVmHost — global host for a LazyBot's floating VM window.

   A canvas bot node emits `bot:openVm` when the user clicks its "VM" button;
   this host subscribes and renders one floating BotVmWindow (like a localhost
   preview window) with a close affordance. Mounted once at app root so the
   window works from the canvas regardless of the active space.
*/

import { useEffect, useState } from 'react';
import { on } from '../../lib/bus';
import { BotVmWindow } from './canvas/nodes/BotVmWindow';

interface OpenVmState {
  botId: string;
  title: string;
}

export function BotVmHost() {
  const [open, setOpen] = useState<OpenVmState | null>(null);

  useEffect(() => {
    const off = on('bot:openVm', ({ botId, title }) => setOpen({ botId, title: title ?? botId }));
    return off;
  }, []);

  if (!open) return null;

  return (
    <div style={S.host} data-testid="bot-vm-host">
      <div style={S.header}>
        <span style={S.title}>VM — {open.title}</span>
        <button onClick={() => setOpen(null)} style={S.close} aria-label="Close VM window">✕</button>
      </div>
      <BotVmWindow botId={open.botId} title={open.title} />
    </div>
  );
}

const S = {
  host: {
    position: 'fixed' as const,
    bottom: 24,
    left: 24,
    zIndex: 9985,
    display: 'flex',
    flexDirection: 'column' as const,
    background: '#16161D',
    border: '1px solid rgba(124,92,255,0.4)',
    borderRadius: 12,
    overflow: 'hidden',
    boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
    background: '#1E1E2A', borderBottom: '1px solid rgba(124,92,255,0.25)',
  },
  title: { fontSize: 12, fontWeight: 600, color: '#B8A9FF', flex: 1 },
  close: {
    background: 'none', border: 'none', color: '#9994B8', cursor: 'pointer',
    fontSize: 14, padding: '2px 6px', borderRadius: 4,
  },
};
