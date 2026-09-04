import { useState, useMemo } from 'react';
import { useEditorStore } from './editorStore';
import { useAutoFix } from '../../lib/ai/autoFix';
import { emit } from '../../lib/bus';

interface ProblemsPanelProps {
  onFileOpen: (path: string) => void;
}

const SEVERITY_COLOR: Record<string, string> = {
  error: '#F07178',
  warning: '#FFC76B',
  info: '#4FC3F7',
};

const SEVERITY_ICON: Record<string, string> = {
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
};

export function ProblemsPanel({ onFileOpen }: ProblemsPanelProps) {
  const { diagnostics } = useEditorStore();
  const { fixDiagnostic, isFixing } = useAutoFix();
  const [fixingPath, setFixingPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    return diagnostics.filter(d => {
      if (filter === 'error' && d.severity !== 'error') return false;
      if (filter === 'warning' && d.severity !== 'warning') return false;
      if (search && !d.message.toLowerCase().includes(search.toLowerCase()) && !d.filename.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [diagnostics, filter, search]);

  const errorCount = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

  if (diagnostics.length === 0) {
    return (
      <div style={{ padding: '16px 12px', fontSize: 11, color: 'rgba(255,255,255,0.3)', textAlign: 'center' }}>
        No problems detected
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
        <button
          onClick={() => setFilter('all')}
          style={filterBtnStyle(filter === 'all')}
        >All ({diagnostics.length})</button>
        <button
          onClick={() => setFilter('error')}
          style={filterBtnStyle(filter === 'error')}
        >✕ ({errorCount})</button>
        <button
          onClick={() => setFilter('warning')}
          style={filterBtnStyle(filter === 'warning')}
        >⚠ ({warningCount})</button>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter..."
          style={{
            flex: 1,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 4,
            padding: '3px 8px',
            color: '#D5D8E0',
            fontSize: 11,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.map((d, i) => (
          <div
            key={`${d.path}-${d.line}-${i}`}
            role="button"
            tabIndex={0}
            onClick={() => onFileOpen(d.path)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onFileOpen(d.path);
              }
            }}
            style={{
              padding: '5px 12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              borderBottom: '1px solid rgba(255,255,255,0.03)',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(124,92,255,0.05)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <span style={{ color: SEVERITY_COLOR[d.severity], fontSize: 10, flexShrink: 0, marginTop: 1 }}>
              {SEVERITY_ICON[d.severity]}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {d.message}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 1 }}>
                {d.filename}:{d.line}
              </div>
            </div>
            {d.severity === 'error' && (
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  setFixingPath(d.path);
                  const result = await fixDiagnostic(d.message, d.filename, 'typescript', d.message);
                  setFixingPath(null);
                  if (result.fix) {
                    emit('editor:applyEdit', {
                      proposedContent: result.fix,
                      path: d.path,
                      language: 'typescript',
                    });
                  }
                }}
                disabled={isFixing}
                style={{
                  background: 'rgba(124,92,255,0.1)',
                  border: '1px solid rgba(124,92,255,0.2)',
                  borderRadius: 4,
                  padding: '2px 8px',
                  color: '#A78BFF',
                  cursor: isFixing ? 'wait' : 'pointer',
                  fontSize: 10,
                  fontFamily: 'inherit',
                  flexShrink: 0,
                  opacity: isFixing && fixingPath === d.path ? 0.5 : 1,
                }}
              >
                {isFixing && fixingPath === d.path ? '...' : 'Fix'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function filterBtnStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? 'rgba(124,92,255,0.15)' : 'transparent',
    border: '1px solid rgba(124,92,255,0.2)',
    borderRadius: 4,
    padding: '3px 8px',
    color: active ? '#A78BFF' : 'rgba(255,255,255,0.4)',
    cursor: 'pointer',
    fontSize: 10,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
}
