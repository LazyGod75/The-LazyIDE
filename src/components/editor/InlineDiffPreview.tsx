import { useMemo } from 'react';
import { myersDiff, type DiffLineType } from '../../lib/diff/myersDiff';

interface InlineDiffPreviewProps {
  original: string;
  proposed: string;
  filename: string;
  language: string;
  onAccept: () => void;
  onReject: () => void;
}

/** Maps the shared myersDiff line type to this component's display type. */
const DIFF_TYPE_MAP: Record<DiffLineType, 'add' | 'remove' | 'context'> = {
  added: 'add',
  removed: 'remove',
  same: 'context',
};

/**
 * Compute a minimal line-level diff via the Myers algorithm (shortest edit
 * script). Unlike naive index alignment, a single insertion or deletion no
 * longer shifts every subsequent line into a false remove+add wall.
 * Exported for unit testing.
 */
export function computeDiffLines(original: string, proposed: string): Array<{ type: 'add' | 'remove' | 'context'; content: string }> {
  const { lines } = myersDiff(original, proposed);
  return lines.map((diffLine) => ({
    type: DIFF_TYPE_MAP[diffLine.type],
    content: diffLine.line,
  }));
}

export function InlineDiffPreview({ original, proposed, filename, onAccept, onReject }: InlineDiffPreviewProps) {
  const diffLines = useMemo(() => computeDiffLines(original, proposed), [original, proposed]);
  const added = diffLines.filter(d => d.type === 'add').length;
  const removed = diffLines.filter(d => d.type === 'remove').length;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(14,14,18,0.95)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          borderBottom: '1px solid rgba(124,92,255,0.2)',
          background: 'rgba(124,92,255,0.06)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#D5D8E0' }}>
            Diff Preview — {filename}
          </span>
          <span style={{ fontSize: 11, color: '#66E27A' }}>+{added}</span>
          <span style={{ fontSize: 11, color: '#F07178' }}>−{removed}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onReject}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              padding: '6px 16px',
              color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          >
            Reject (Esc)
          </button>
          <button
            onClick={onAccept}
            style={{
              background: 'rgba(124,92,255,0.2)',
              border: '1px solid rgba(124,92,255,0.4)',
              borderRadius: 6,
              padding: '6px 16px',
              color: '#A78BFF',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
              fontWeight: 600,
            }}
          >
            Accept
          </button>
        </div>
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '12.5px',
          padding: '8px 0',
        }}
      >
        {diffLines.map((line, i) => (
          <div
            key={i}
            style={{
              padding: '0 16px',
              minHeight: '18px',
              background: line.type === 'add'
                ? 'rgba(102,226,122,0.08)'
                : line.type === 'remove'
                ? 'rgba(240,113,120,0.08)'
                : 'transparent',
              color: line.type === 'add'
                ? '#66E27A'
                : line.type === 'remove'
                ? '#F07178'
                : 'rgba(255,255,255,0.6)',
              whiteSpace: 'pre',
            }}
          >
            <span style={{ opacity: 0.4, marginRight: 8, userSelect: 'none' }}>
              {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}
            </span>
            {line.content}
          </div>
        ))}
      </div>
    </div>
  );
}
