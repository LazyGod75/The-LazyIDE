/* MultiFileEditModal — multi-file diff preview with accept/reject per file.
   Shows side-by-side diffs for multiple files proposed by the AI.
*/

import { useState, useMemo } from 'react';
import { useI18n } from '../../i18n';
import { basename } from '../../lib/paths';

interface FileEdit {
  path: string;
  proposedContent: string;
  currentContent: string;
  language?: string;
}

interface MultiFileEditModalProps {
  files: FileEdit[];
  onAccept: (acceptedPaths: string[]) => void;
  onReject: () => void;
}

// Language detection removed — using LCS-based diff for correctness.

const LCS_LINE_LIMIT = 1000;

/**
 * LCS-based diff — correctly handles insertions and deletions.
 * Falls back to index-parallel diff when either side exceeds LCS_LINE_LIMIT lines
 * to avoid O(n²) memory usage on large files.
 */
function computeDiff(
  aLines: string[],
  bLines: string[],
): Array<{ type: 'same' | 'add' | 'del'; line: string }> {
  // Fallback for very large files.
  if (aLines.length > LCS_LINE_LIMIT || bLines.length > LCS_LINE_LIMIT) {
    const maxLines = Math.max(aLines.length, bLines.length);
    const result: Array<{ type: 'same' | 'add' | 'del'; line: string }> = [];
    for (let i = 0; i < maxLines; i++) {
      const curr = aLines[i];
      const prop = bLines[i];
      if (curr === prop) {
        result.push({ type: 'same', line: curr });
      } else {
        if (curr !== undefined) result.push({ type: 'del', line: curr });
        if (prop !== undefined) result.push({ type: 'add', line: prop });
      }
    }
    return result;
  }

  // Build LCS table.
  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aLines[i - 1] === bLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Trace back to produce the diff.
  const result: Array<{ type: 'same' | 'add' | 'del'; line: string }> = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      result.push({ type: 'same', line: aLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', line: bLines[j - 1] });
      j--;
    } else {
      result.push({ type: 'del', line: aLines[i - 1] });
      i--;
    }
  }
  result.reverse();
  return result;
}

function DiffView({ file }: { file: FileEdit }) {
  const { currentContent, proposedContent, path } = file;
  const filename = basename(path);

  const currentLines = currentContent.split('\n');
  const proposedLines = proposedContent.split('\n');

  const diffLines = useMemo(() => {
    return computeDiff(currentLines, proposedLines);
  }, [currentLines, proposedLines]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{
        padding: '4px 10px',
        fontSize: 10,
        color: 'rgba(255,255,255,0.5)',
        background: 'rgba(255,255,255,0.03)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        fontFamily: "'JetBrains Mono', monospace",
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {filename}
      </div>
      <div style={{ flex: 1, overflow: 'auto', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
        {diffLines.map((line, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              background: line.type === 'add' ? 'rgba(102,226,122,0.06)' : line.type === 'del' ? 'rgba(240,113,120,0.06)' : 'transparent',
              minHeight: 18,
            }}
          >
            <span style={{ width: 28, textAlign: 'right', paddingRight: 6, color: 'rgba(255,255,255,0.15)', flexShrink: 0, userSelect: 'none' }}>
              {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
            </span>
            <span style={{
              flex: 1,
              color: line.type === 'add' ? '#66E27A' : line.type === 'del' ? '#F07178' : 'rgba(255,255,255,0.6)',
              whiteSpace: 'pre',
              overflow: 'hidden',
            }}>
              {line.line}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MultiFileEditModal({ files, onAccept, onReject }: MultiFileEditModalProps) {
  const { t } = useI18n();
  const [acceptedSet, setAcceptedSet] = useState<Set<string>>(new Set(files.map(f => f.path)));
  const [activeIndex, setActiveIndex] = useState(0);

  const toggleAccept = (path: string) => {
    setAcceptedSet(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleAcceptAll = () => {
    onAccept(Array.from(acceptedSet));
  };

  const activeFile = files[activeIndex];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onReject}
    >
      <div
        style={{
          width: '90vw',
          maxWidth: 1100,
          height: '80vh',
          background: '#12121A',
          border: '1px solid rgba(124,92,255,0.3)',
          borderRadius: 10,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '10px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#D5D8E0' }}>
            {t('multiEdit.title', { count: files.length, s: files.length > 1 ? 's' : '' })}
          </span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
            {t('multiEdit.accepted', { accepted: acceptedSet.size, total: files.length, s: acceptedSet.size > 1 ? 's' : '' })}
          </span>
        </div>

        {/* Body: file list + diff */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* File list sidebar */}
          <div style={{
            width: 200,
            borderRight: '1px solid rgba(255,255,255,0.07)',
            overflowY: 'auto',
            flexShrink: 0,
          }}>
            {files.map((file, i) => {
              const fname = basename(file.path);
              const isAccepted = acceptedSet.has(file.path);
              const isActive = i === activeIndex;
              return (
                <div
                  key={file.path}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={0}
                  onClick={() => setActiveIndex(i)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActiveIndex(i);
                    }
                  }}
                  style={{
                    padding: '6px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: 'pointer',
                    background: isActive ? 'rgba(124,92,255,0.12)' : 'transparent',
                    fontSize: 11,
                    color: isActive ? '#D5D8E0' : 'rgba(255,255,255,0.4)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isAccepted}
                    onChange={e => { e.stopPropagation(); toggleAccept(file.path); }}
                    style={{ margin: 0, cursor: 'pointer' }}
                  />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fname}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Diff view */}
          {activeFile && (
            <DiffView file={activeFile} />
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid rgba(255,255,255,0.07)',
        }}>
          <button
            onClick={onReject}
            style={{
              padding: '6px 16px',
              fontSize: 12,
              background: 'rgba(255,255,255,0.05)',
              color: 'rgba(255,255,255,0.5)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('multiEdit.rejectAll')}
          </button>
          <button
            onClick={handleAcceptAll}
            disabled={acceptedSet.size === 0}
            style={{
              padding: '6px 16px',
              fontSize: 12,
              background: acceptedSet.size > 0 ? '#7C5CFF' : 'rgba(124,92,255,0.25)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: acceptedSet.size > 0 ? 'pointer' : 'default',
              fontFamily: 'inherit',
              fontWeight: 600,
            }}
          >
            {t('multiEdit.acceptCount', { count: acceptedSet.size, s: acceptedSet.size > 1 ? 's' : '' })}
          </button>
        </div>
      </div>
    </div>
  );
}
