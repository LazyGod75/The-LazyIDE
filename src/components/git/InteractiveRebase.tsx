import { useState, useEffect, useCallback } from 'react';
import type { Platform, GitLogEntry } from '../../lib/platform/types';

interface InteractiveRebaseProps {
  platform: Platform;
  projectRoot: string;
  onClose: () => void;
}

type RebaseAction = 'pick' | 'squash' | 'fixup' | 'reword' | 'drop' | 'edit';

interface RebaseEntry {
  hash: string;
  subject: string;
  action: RebaseAction;
}

export function InteractiveRebase({ platform, projectRoot, onClose }: InteractiveRebaseProps) {
  const [entries, setEntries] = useState<RebaseEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadLog = useCallback(async () => {
    if (!projectRoot) { setLoading(false); return; }
    try {
      const log = await platform.git.log(projectRoot, 15);
      setEntries(log.map((e: GitLogEntry) => ({
        hash: e.hash,
        subject: e.subject,
        action: 'pick' as RebaseAction,
      })));
    } catch { /* ignore */ }
    setLoading(false);
  }, [platform, projectRoot]);

  useEffect(() => { loadLog(); }, [loadLog]);

  function setAction(idx: number, action: RebaseAction) {
    setEntries(prev => prev.map((e, i) => i === idx ? { ...e, action } : e));
  }

  function moveUp(idx: number) {
    if (idx === 0) return;
    setEntries(prev => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  }

  function moveDown(idx: number) {
    if (idx === entries.length - 1) return;
    setEntries(prev => {
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }

  const actionColors: Record<RebaseAction, string> = {
    pick: '#7C5CFF',
    squash: '#FFC76B',
    fixup: '#4FC3F7',
    reword: '#66E27A',
    drop: '#F07178',
    edit: '#FF7BB0',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: 600, maxHeight: '70%', background: '#1C1C2A', borderRadius: 12, border: '1px solid rgba(124,92,255,0.2)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#E6E8EF' }}>Interactive Rebase</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>Loading…</div>}
          {!loading && entries.map((entry, i) => (
            <div key={entry.hash} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
              <select
                value={entry.action}
                onChange={e => setAction(i, e.target.value as RebaseAction)}
                style={{
                  width: 70, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4,
                  padding: '3px 6px', color: actionColors[entry.action], fontSize: 10, fontFamily: 'inherit', outline: 'none',
                  textTransform: 'uppercase', fontWeight: 600,
                }}
              >
                <option value="pick">pick</option>
                <option value="squash">squash</option>
                <option value="fixup">fixup</option>
                <option value="reword">reword</option>
                <option value="drop">drop</option>
                <option value="edit">edit</option>
              </select>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>
                {entry.hash.slice(0, 8)}
              </span>
              <span style={{ flex: 1, fontSize: 11, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.subject}
              </span>
              <button onClick={() => moveUp(i)} disabled={i === 0} style={{ background: 'none', border: 'none', color: i === 0 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.3)', cursor: i === 0 ? 'default' : 'pointer', fontSize: 10 }}>▲</button>
              <button onClick={() => moveDown(i)} disabled={i === entries.length - 1} style={{ background: 'none', border: 'none', color: i === entries.length - 1 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.3)', cursor: i === entries.length - 1 ? 'default' : 'pointer', fontSize: 10 }}>▼</button>
            </div>
          ))}
        </div>
        <div style={{ padding: 12, display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid rgba(255,255,255,0.07)' }}>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '6px 16px', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={onClose} style={{ background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 4, padding: '6px 16px', color: '#A78BFF', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>Start Rebase</button>
        </div>
      </div>
    </div>
  );
}
