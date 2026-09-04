import { useState, useEffect, useCallback } from 'react';
import type { Lsp } from '../../lib/platform/types';
import { getPlatform } from '../../lib/platform';

interface PeekDefinitionProps {
  lsp: Lsp;
  repoPath: string;
  language: string;
  filePath: string;
  position: { line: number; character: number };
  onClose: () => void;
}

export function PeekDefinition({ lsp, repoPath, language, filePath, position, onClose }: PeekDefinitionProps) {
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState<string>('');
  const [targetPath, setTargetPath] = useState<string>('');
  const [targetLine, setTargetLine] = useState(0);

  const fetchDefinition = useCallback(async () => {
    try {
      const result = await lsp.request(repoPath, language, 'textDocument/definition', {
        textDocument: { uri: `file://${filePath}` },
        position,
      });
      if (!result) { setLoading(false); return; }
      const locations = Array.isArray(result) ? result : [result];
      const first = locations[0];
      if (!first) { setLoading(false); return; }
      
      const path = first.uri.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1');
      setTargetPath(path);
      setTargetLine((first.range?.start?.line ?? 0) + 1);

      const platform = getPlatform();
      const fileContent = await platform.fs.readFile(path);
      setContent(fileContent);
    } catch { /* ignore */ }
    setLoading(false);
  }, [lsp, repoPath, language, filePath, position]);

  useEffect(() => { fetchDefinition(); }, [fetchDefinition]);

  const lines = content.split('\n');
  const startLine = Math.max(0, targetLine - 5);
  const endLine = Math.min(lines.length, targetLine + 15);
  const visibleLines = lines.slice(startLine, endLine);

  return (
    <div
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '70%',
        maxWidth: 800,
        maxHeight: 400,
        background: '#1A1A24',
        border: '1px solid rgba(124,92,255,0.3)',
        borderRadius: 8,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
          {targetPath || 'Peek Definition'}:{targetLine}
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: 14 }}>×</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px', fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
        {loading && <div style={{ color: 'rgba(255,255,255,0.2)' }}>Loading…</div>}
        {!loading && visibleLines.map((line, i) => (
          <div
            key={startLine + i}
            style={{
              display: 'flex',
              gap: 12,
              padding: '1px 0',
              background: startLine + i + 1 === targetLine ? 'rgba(124,92,255,0.08)' : 'transparent',
            }}
          >
            <span style={{ color: 'rgba(255,255,255,0.2)', minWidth: 30, textAlign: 'right', userSelect: 'none' }}>
              {startLine + i + 1}
            </span>
            <span style={{ color: '#D5D8E0', whiteSpace: 'pre' }}>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
