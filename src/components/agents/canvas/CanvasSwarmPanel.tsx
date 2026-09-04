/* CanvasSwarmPanel — persistent panel showing inter-agent messages and
   file change notifications on the canvas.

   Subscribes to 'swarm:message' and 'swarm:fileChange' bus events and
   renders a collapsible feed of recent swarm activity. This gives the
   user real-time visibility into multi-agent coordination: which agent
   messaged which, and which files were modified by which agent.

   Positioned at the bottom-left of the canvas, above the browser panel.
*/

import { useEffect, useState, useCallback } from 'react';
import { on } from '../../../lib/bus';

interface SwarmMessage {
  id: string;
  type: 'message' | 'fileChange';
  fromMissionId: string;
  toMissionId?: string | 'broadcast';
  message?: string;
  filePath?: string;
  action?: 'write' | 'edit' | 'delete';
  timestamp: number;
}

const MAX_ENTRIES = 20;
const FADE_MS = 10000;

export function CanvasSwarmPanel() {
  const [entries, setEntries] = useState<SwarmMessage[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  const addEntry = useCallback((entry: Omit<SwarmMessage, 'id'>) => {
    setEntries(prev => [
      { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
      ...prev,
    ].slice(0, MAX_ENTRIES));
  }, []);

  useEffect(() => {
    const unsubMsg = on('swarm:message', (payload) => {
      addEntry({
        type: 'message',
        fromMissionId: payload.fromMissionId,
        toMissionId: payload.toMissionId,
        message: payload.message,
        timestamp: payload.timestamp,
      });
    });
    const unsubFile = on('swarm:fileChange', (payload) => {
      addEntry({
        type: 'fileChange',
        fromMissionId: payload.missionId,
        filePath: payload.filePath,
        action: payload.action,
        timestamp: payload.timestamp,
      });
    });
    return () => { unsubMsg(); unsubFile(); };
  }, [addEntry]);

  // Auto-remove old entries
  useEffect(() => {
    if (entries.length === 0) return;
    const timer = setInterval(() => {
      const cutoff = Date.now() - FADE_MS;
      setEntries(prev => prev.filter(e => e.timestamp > cutoff));
    }, 2000);
    return () => clearInterval(timer);
  }, [entries.length]);

  if (entries.length === 0) return null;

  const recent = entries.slice(0, collapsed ? 0 : 6);

  return (
    <div style={{
      position: 'absolute',
      bottom: 12,
      left: 12,
      zIndex: 50,
      maxWidth: 360,
      minWidth: 240,
      pointerEvents: 'auto',
    }}>
      <div
        onClick={() => setCollapsed(c => !c)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          background: 'rgba(20, 20, 28, 0.85)',
          backdropFilter: 'blur(8px)',
          borderRadius: '8px 8px 0 0',
          cursor: 'pointer',
          fontSize: 11,
          color: '#a8a8b8',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          userSelect: 'none',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="3" cy="6" r="2" fill="#7C5CFF" />
          <circle cx="9" cy="3" r="2" fill="#5CFF8A" opacity="0.7" />
          <circle cx="9" cy="9" r="2" fill="#FFB85C" opacity="0.7" />
          <line x1="3" y1="6" x2="9" y2="3" stroke="rgba(124,92,255,0.3)" strokeWidth="0.5" />
          <line x1="3" y1="6" x2="9" y2="9" stroke="rgba(124,92,255,0.3)" strokeWidth="0.5" />
        </svg>
        <span style={{ fontWeight: 600 }}>Swarm Activity</span>
        <span style={{ opacity: 0.5, marginLeft: 'auto' }}>{entries.length}</span>
        <span style={{ opacity: 0.4 }}>{collapsed ? '▸' : '▾'}</span>
      </div>
      {!collapsed && (
        <div style={{
          background: 'rgba(20, 20, 28, 0.75)',
          backdropFilter: 'blur(8px)',
          borderRadius: '0 0 8px 8px',
          padding: '4px 0',
          maxHeight: 200,
          overflowY: 'auto',
        }}>
          {recent.map((entry) => (
            <SwarmEntry key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function SwarmEntry({ entry }: { entry: SwarmMessage }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const missionLabel = entry.fromMissionId.slice(0, 8);

  if (entry.type === 'message') {
    const target = entry.toMissionId === 'broadcast' ? 'all' : (entry.toMissionId ?? '').slice(0, 8);
    return (
      <div style={{
        padding: '3px 10px',
        fontSize: 10.5,
        color: '#c8c8d0',
        borderBottom: '1px solid rgba(255,255,255,0.03)',
      }}>
        <span style={{ color: '#7C5CFF', fontWeight: 600 }}>{missionLabel}</span>
        <span style={{ opacity: 0.4 }}> → </span>
        <span style={{ color: '#5CFF8A', fontWeight: 600 }}>{target}</span>
        <span style={{ opacity: 0.3, marginLeft: 6 }}>{time}</span>
        <div style={{ marginTop: 1, opacity: 0.8, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.message}
        </div>
      </div>
    );
  }

  // fileChange
  const actionColor = entry.action === 'delete' ? '#FF5C5C' : entry.action === 'write' ? '#5CFF8A' : '#FFB85C';
  return (
    <div style={{
      padding: '3px 10px',
      fontSize: 10.5,
      color: '#c8c8d0',
      borderBottom: '1px solid rgba(255,255,255,0.03)',
    }}>
      <span style={{ color: '#7C5CFF', fontWeight: 600 }}>{missionLabel}</span>
      <span style={{ color: actionColor, marginLeft: 6, fontWeight: 600 }}>{entry.action}</span>
      <span style={{ opacity: 0.3, marginLeft: 6 }}>{time}</span>
      <div style={{ marginTop: 1, opacity: 0.7, fontFamily: 'monospace', fontSize: 10, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {entry.filePath}
      </div>
    </div>
  );
}
