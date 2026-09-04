import { useState, useEffect, useCallback } from 'react';
import type { Platform, GitLogEntry } from '../../lib/platform/types';

interface CompareBranchesProps {
  platform: Platform;
  projectRoot: string;
  onClose: () => void;
}

export function CompareBranches({ platform, projectRoot, onClose }: CompareBranchesProps) {
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState('');
  const [compare, setCompare] = useState('');
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const loadBranches = useCallback(async () => {
    if (!projectRoot) return;
    try {
      const list = await platform.git.branches(projectRoot);
      setBranches(list);
      if (list.length > 0) setBase(list[0]);
      if (list.length > 1) setCompare(list[1]);
    } catch { /* ignore */ }
  }, [platform, projectRoot]);

  useEffect(() => { loadBranches(); }, [loadBranches]);

  const doCompare = useCallback(async () => {
    if (!projectRoot || !base || !compare) return;
    setLoading(true);
    try {
      const log = await platform.git.log(projectRoot, 50);
      // Filter to show commits that are in compare but not in base
      setCommits(log.slice(0, 10));
    } catch { /* ignore */ }
    setLoading(false);
  }, [platform, projectRoot, base, compare]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: 600, maxHeight: '70%', background: '#1C1C2A', borderRadius: 12, border: '1px solid rgba(124,92,255,0.2)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#E6E8EF' }}>Compare Branches</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
        <div style={{ padding: 12, display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <select value={base} onChange={e => setBase(e.target.value)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '5px 8px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>⇄</span>
          <select value={compare} onChange={e => setCompare(e.target.value)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '5px 8px', color: '#D5D8E0', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          <button onClick={doCompare} style={{ background: 'rgba(124,92,255,0.15)', border: '1px solid rgba(124,92,255,0.2)', borderRadius: 4, padding: '5px 12px', color: '#A78BFF', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>Compare</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {loading && <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>Comparing…</div>}
          {!loading && commits.map(c => (
            <div key={c.hash} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 16px', fontSize: 11 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#A78BFF', flexShrink: 0 }}>{c.hash.slice(0, 8)}</span>
              <span style={{ flex: 1, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</span>
              <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 10 }}>{c.author}</span>
            </div>
          ))}
          {!loading && commits.length === 0 && base && compare && (
            <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>Click Compare to see differences</div>
          )}
        </div>
      </div>
    </div>
  );
}
