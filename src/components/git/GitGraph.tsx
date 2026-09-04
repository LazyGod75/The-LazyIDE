import { useState, useEffect, useCallback } from 'react';
import type { Platform } from '../../lib/platform/types';
import { useI18n } from '../../i18n';

interface GitGraphProps {
  platform: Platform;
  projectRoot: string;
}

interface GraphNode {
  hash: string;
  subject: string;
  author: string;
  date: string;
  branch: string;
  parents: string[];
  x: number;
  y: number;
}

export function GitGraph({ platform, projectRoot }: GitGraphProps) {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  const fetchLog = useCallback(async () => {
    if (!projectRoot) { setLoading(false); return; }
    try {
      const log = await platform.git.log(projectRoot, 50);
      const graphNodes: GraphNode[] = log.map((entry, i) => ({
        ...entry,
        branch: 'main',
        parents: [],
        x: 30,
        y: i * 36 + 20,
      }));
      setNodes(graphNodes);
    } catch { /* ignore */ }
    setLoading(false);
  }, [platform, projectRoot]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Git Graph</span>
        <button onClick={fetchLog} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 11 }} aria-label={t('common.refresh')}>↻</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        {loading && <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>Loading…</div>}
        {!loading && nodes.length === 0 && <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>No commits</div>}
        {nodes.map((node, i) => (
          <div
            key={node.hash}
            onClick={() => setSelected(node)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '4px 12px',
              cursor: 'pointer',
              background: selected?.hash === node.hash ? 'rgba(124,92,255,0.08)' : 'transparent',
              borderBottom: '1px solid rgba(255,255,255,0.02)',
            }}
          >
            {/* Graph lane */}
            <div style={{ position: 'relative', width: 24, height: 28, flexShrink: 0 }}>
              <div style={{ position: 'absolute', left: 10, top: 0, bottom: 0, width: 2, background: 'rgba(124,92,255,0.2)' }} />
              <div style={{ position: 'absolute', left: 6, top: 10, width: 10, height: 10, borderRadius: '50%', background: i === 0 ? '#66E27A' : '#7C5CFF', border: '2px solid #1C1C2A' }} />
            </div>
            {/* Commit info */}
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#A78BFF', flexShrink: 0 }}>
              {node.hash.slice(0, 8)}
            </span>
            <span style={{ flex: 1, fontSize: 11, color: 'rgba(255,255,255,0.6)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.subject}
            </span>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>
              {node.author}
            </span>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', flexShrink: 0 }}>
              {node.date}
            </span>
          </div>
        ))}
      </div>
      {selected && (
        <div style={{ padding: '8px 12px', background: 'rgba(124,92,255,0.05)', borderTop: '1px solid rgba(124,92,255,0.15)', fontSize: 11 }}>
          <div style={{ color: '#A78BFF', fontFamily: "'JetBrains Mono', monospace", marginBottom: 4 }}>{selected.hash}</div>
          <div style={{ color: 'rgba(255,255,255,0.6)' }}>{selected.subject}</div>
          <div style={{ color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>{selected.author} • {selected.date}</div>
        </div>
      )}
    </div>
  );
}
