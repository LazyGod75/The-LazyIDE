import { useState, useEffect, useCallback } from 'react';
import type { LspClientHandle } from './lspClient';
import { useI18n } from '../../i18n';

interface OutlineViewProps {
  lspHandle: LspClientHandle | null;
  onJump: (line: number) => void;
}

interface SymbolNode {
  name: string;
  kind: number;
  line: number;
  children?: SymbolNode[];
}

const SYMBOL_ICONS: Record<number, string> = {
  1: '📁', 2: '📦', 3: '🔧', 4: '🔧', 5: '📤', 6: '🔷', 7: '🔶',
  8: '🧩', 9: '🔑', 10: '🔢', 11: '📝', 12: '📋', 13: '⌨️',
  14: '📦', 15: '🎨', 16: '💬', 17: '📄', 18: '🔗', 19: '📂',
  20: '📐', 21: '🔢', 22: '🎯', 23: '⚡', 24: '🧪', 25: '🔧',
  26: '⚙️',
};

/** Raw shape returned by the LSP documentSymbols call. */
interface RawLspSymbol {
  name: string;
  kind: number;
  selectionRange?: { start?: { line?: number } };
  range?: { start?: { line?: number } };
  children?: RawLspSymbol[];
}

function flattenSymbols(symbols: RawLspSymbol[], depth = 0): SymbolNode[] {
  const nodes: SymbolNode[] = [];
  for (const s of symbols) {
    nodes.push({
      name: s.name,
      kind: s.kind,
      line: (s.selectionRange?.start?.line ?? s.range?.start?.line ?? 0) + 1,
      children: s.children ? flattenSymbols(s.children, depth + 1) : undefined,
    });
  }
  return nodes;
}

export function OutlineView({ lspHandle, onJump }: OutlineViewProps) {
  const { t } = useI18n();
  const [symbols, setSymbols] = useState<SymbolNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!lspHandle) return;
    setLoading(true);
    try {
      const result = await lspHandle.documentSymbols();
      if (result) {
        setSymbols(flattenSymbols(result as RawLspSymbol[]));
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [lspHandle]);

  useEffect(() => { refresh(); }, [refresh]);

  function toggleExpand(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderNode(node: SymbolNode, depth: number, parentKey: string): React.ReactNode {
    const key = `${parentKey}:${node.name}:${node.line}`;
    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = expanded.has(key);

    return (
      <div key={key}>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={hasChildren ? isExpanded : undefined}
          onClick={() => hasChildren ? toggleExpand(key) : onJump(node.line)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (hasChildren) toggleExpand(key);
              else onJump(node.line);
            }
          }}
          style={{
            padding: `2px ${depth * 12 + 8}px`,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
            fontSize: 11,
            color: 'rgba(255,255,255,0.6)',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(124,92,255,0.08)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
        >
          {hasChildren && (
            <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{isExpanded ? '▾' : '▸'}</span>
          )}
          <span style={{ fontSize: 10, opacity: 0.7 }}>{SYMBOL_ICONS[node.kind] ?? '•'}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.name}
          </span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)' }}>:{node.line}</span>
        </div>
        {hasChildren && isExpanded && node.children!.map(child => renderNode(child, depth + 1, key))}
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>{t('code.outline.loading')}</div>;
  }

  if (symbols.length === 0) {
    return <div style={{ padding: 12, fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>{t('code.outline.empty')}</div>;
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ padding: '6px 10px 3px', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>{t('code.outline.title')}</span>
        <button onClick={refresh} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 11 }} aria-label={t('common.refresh')}>↻</button>
      </div>
      {symbols.map(s => renderNode(s, 0, 'root'))}
    </div>
  );
}
