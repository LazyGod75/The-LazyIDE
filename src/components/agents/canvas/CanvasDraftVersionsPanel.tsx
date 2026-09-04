/* CanvasDraftVersionsPanel.tsx — « Versions » dropdown for
   CanvasQuickCreateModal.tsx's draft editor (Activepieces parity, draft
   version history). A compact toggle button reveals a list of past
   snapshots (relative time, newest first); selecting one shows a simple
   two-pane diff (title/task) against the CURRENT draft; « Restaurer »
   re-applies that old snapshot via the caller's `onRestore` — which itself
   goes through canvasStore's `restoreDraftVersion` (appends a FRESH
   snapshot, never rewrites history, see that action's own doc comment).

   Kept as its own small file (not inlined into the modal) — the modal's own
   header already declares itself deliberately minimal, and this panel's
   list/diff/restore concern is independent of the title/task/model form
   fields it sits alongside.
*/

import { useId, useState, type CSSProperties } from 'react';
import { useI18n } from '../../../i18n';
import type { DraftVersion } from './canvasTypes';

interface CanvasDraftVersionsPanelProps {
  /** Stored order (oldest first, append-only) — this component reverses it
   *  for display (newest first reads better in a dropdown). */
  versions: DraftVersion[];
  current: { title: string; task: string };
  onRestore: (ts: number) => void;
}

const PANEL_STYLE: CSSProperties = {
  marginTop: 4,
  padding: 8,
  borderRadius: 8,
  border: '1px solid var(--color-border-3)',
  background: 'var(--color-panel-3)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const DIFF_COLUMN_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '6px 8px',
  borderRadius: 6,
  background: 'var(--color-panel-2)',
  border: '1px solid var(--color-border-3)',
  fontSize: 11,
  color: 'var(--color-text)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 140,
  overflowY: 'auto',
};

function formatRelative(ts: number, t: (key: string, params?: Record<string, string>) => string): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return t('canvas.quickCreate.versionJustNow');
  if (diffMs < 3_600_000) return t('canvas.quickCreate.versionMinutesAgo', { n: String(Math.floor(diffMs / 60_000)) });
  if (diffMs < 86_400_000) return t('canvas.quickCreate.versionHoursAgo', { n: String(Math.floor(diffMs / 3_600_000)) });
  return t('canvas.quickCreate.versionDaysAgo', { n: String(Math.floor(diffMs / 86_400_000)) });
}

export function CanvasDraftVersionsPanel({ versions, current, onRestore }: CanvasDraftVersionsPanelProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const listboxId = useId();

  const newestFirst = [...versions].reverse();
  const selected = selectedTs !== null ? versions.find((v) => v.ts === selectedTs) : undefined;

  return (
    <div>
      <button
        type="button"
        data-testid="canvas-quickcreate-versions-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listboxId}
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: '4px 8px',
          borderRadius: 6,
          border: '1px solid var(--color-border-3)',
          background: 'transparent',
          color: 'var(--color-text-muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {t('canvas.quickCreate.versions')} ({versions.length})
      </button>

      {open && (
        <div id={listboxId} data-testid="canvas-quickcreate-versions-panel" style={PANEL_STYLE}>
          {newestFirst.length === 0 ? (
            <p style={{ margin: 0, fontSize: 11, color: 'var(--color-text-disabled)' }}>{t('canvas.quickCreate.versionsEmpty')}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 120, overflowY: 'auto' }}>
              {newestFirst.map((version) => (
                <button
                  key={version.ts}
                  type="button"
                  data-testid={`canvas-quickcreate-version-${version.ts}`}
                  onClick={() => setSelectedTs(version.ts === selectedTs ? null : version.ts)}
                  style={{
                    textAlign: 'left',
                    fontSize: 11,
                    padding: '4px 6px',
                    borderRadius: 5,
                    border: 'none',
                    background: version.ts === selectedTs ? 'var(--color-accent-border)' : 'transparent',
                    color: 'var(--color-text)',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {formatRelative(version.ts, t)} — {version.title || t('canvas.draft.untitled')}
                </button>
              ))}
            </div>
          )}

          {selected && (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <div>
                  <p style={{ margin: '0 0 3px', fontSize: 10, fontWeight: 700, color: 'var(--color-text-muted)' }}>
                    {t('canvas.quickCreate.versionSelected')}
                  </p>
                  <div data-testid="canvas-quickcreate-diff-selected" style={DIFF_COLUMN_STYLE}>
                    <strong>{selected.title}</strong>
                    {'\n'}
                    {selected.task}
                  </div>
                </div>
                <div>
                  <p style={{ margin: '0 0 3px', fontSize: 10, fontWeight: 700, color: 'var(--color-text-muted)' }}>
                    {t('canvas.quickCreate.versionCurrent')}
                  </p>
                  <div data-testid="canvas-quickcreate-diff-current" style={DIFF_COLUMN_STYLE}>
                    <strong>{current.title}</strong>
                    {'\n'}
                    {current.task}
                  </div>
                </div>
              </div>
              <button
                type="button"
                data-testid="canvas-quickcreate-version-restore"
                onClick={() => {
                  onRestore(selected.ts);
                  setSelectedTs(null);
                  setOpen(false);
                }}
                style={{
                  alignSelf: 'flex-start',
                  fontSize: 11,
                  fontWeight: 700,
                  padding: '5px 10px',
                  borderRadius: 6,
                  border: 'none',
                  cursor: 'pointer',
                  background: 'var(--color-accent)',
                  color: '#14141C',
                  fontFamily: 'inherit',
                }}
              >
                {t('canvas.quickCreate.versionRestore')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
