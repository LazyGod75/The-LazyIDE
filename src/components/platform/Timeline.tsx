import { useState, useEffect, useCallback } from 'react';
import { useAppContext } from '../../app/AppContext';
import type { GitLogEntry } from '../../lib/platform/types';

export function Timeline() {
  const { platform, projectRoot } = useAppContext();
  const [entries, setEntries] = useState<Array<{ type: 'commit' | 'edit' | 'open'; label: string; time: string }>>([]);
  const [loading, setLoading] = useState(true);

  const fetchTimeline = useCallback(async () => {
    if (!projectRoot || platform.name === 'web') {
      setLoading(false);
      return;
    }
    try {
      const log = await platform.git.log(projectRoot, 30);
      const timelineEntries = log.map((entry: GitLogEntry) => ({
        type: 'commit' as const,
        label: entry.subject,
        time: entry.date,
      }));
      setEntries(timelineEntries);
    } catch { /* ignore */ }
    setLoading(false);
  }, [platform, projectRoot]);

  useEffect(() => { fetchTimeline(); }, [fetchTimeline]);

  const typeIcon: Record<string, string> = {
    commit: '📦',
    edit: '✏️',
    open: '📂',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0E0E12' }}>
      <div style={{ padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        Timeline
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {loading && <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>Loading…</div>}
        {!loading && entries.length === 0 && <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>No activity</div>}
        {entries.map((entry, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 12px', fontSize: 11 }}>
            <span style={{ fontSize: 12 }}>{typeIcon[entry.type]}</span>
            <span style={{ flex: 1, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {entry.label}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 10 }}>{entry.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
