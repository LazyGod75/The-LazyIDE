/* LiveWorktreeView — read-only "agent is writing this file right now" pane
   (design-code.md §4.6 code area, D9). Renders REAL polled worktree content
   (useLiveWorktreeTail) — no scripted/canned text. The growing edge (lines
   changed since the last 1.5s poll) gets the violet highlight + a trailing
   green cursor block on the last line, exactly like watching the agent's
   own editor over its shoulder. Deliberately NOT the normal editable
   EditorPane/CodeMirror: this path is mounted only while a mission is
   actively writing the file in its own worktree, so presenting it as
   editable would invite an edit race against the agent's own writes.
*/

import { useEffect, useRef } from 'react';
import { useI18n } from '../../../i18n';
import type { Platform } from '../../../lib/platform/types';
import { useLiveWorktreeTail } from './useLiveWorktreeTail';

interface LiveWorktreeViewProps {
  platform: Platform;
  path: string;
}

export function LiveWorktreeView({ platform, path }: LiveWorktreeViewProps) {
  const { t } = useI18n();
  const { lines, changedFrom, loading, error } = useLiveWorktreeTail(platform, path, true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && changedFrom < lines.length) el.scrollTop = el.scrollHeight;
  }, [lines, changedFrom]);

  if (loading && lines.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-disabled)', fontSize: 12 }}>
        {t('codespace.liveView.loading')}
      </div>
    );
  }
  if (error && lines.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-danger)', fontSize: 12 }}>
        {t('codespace.liveView.error', { message: error })}
      </div>
    );
  }

  return (
    <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '14px 0', fontFamily: 'var(--font-mono)', fontSize: 14, lineHeight: 1.75 }}>
      {lines.map((line, i) => {
        const isChanged = i >= changedFrom;
        const isLastChanged = isChanged && i === lines.length - 1;
        return (
          <div key={i} style={{ display: 'flex', background: isChanged ? 'rgba(124,92,255,0.08)' : 'transparent' }}>
            <span style={{ width: 56, textAlign: 'right', paddingRight: 18, color: '#4A4F5C', userSelect: 'none', flexShrink: 0 }}>
              {i + 1}
            </span>
            <span style={{ whiteSpace: 'pre', color: 'var(--color-text-secondary)' }}>
              {line}
              {isLastChanged && <span style={{ color: 'var(--color-success)' }}> ▊</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
