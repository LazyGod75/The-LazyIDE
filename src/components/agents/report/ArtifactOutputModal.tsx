/* ArtifactOutputModal.tsx — click-through content viewer for `test_run` /
   `command_output` proof artifacts' outputPath (ArtifactChip.tsx's click
   target). Monospace, capped (see artifactFiles.ts's MAX_DISPLAY_CHARS),
   honest missing/unreadable states — never a silent empty box.
*/

import { useEffect, useState } from 'react';
import { useI18n } from '../../../i18n';
import { resolveArtifactText, type ArtifactTextResult } from './artifactFiles';

interface ArtifactOutputModalProps {
  title: string;
  path: string;
  onClose: () => void;
}

type LoadState = { status: 'loading' } | ArtifactTextResult;

export function ArtifactOutputModal({ title, path, onClose }: ArtifactOutputModalProps) {
  const { t } = useI18n();
  // Result stored WITH the path it answers; staleness derived at render
  // time (same convention as ArtifactThumbnail's useScreenshotSrc /
  // useMissionHistory.ts's hooks) — avoids an eager setState('loading') at
  // the top of the effect (react-hooks/set-state-in-effect).
  const [loaded, setLoaded] = useState<{ key: string; result: ArtifactTextResult } | null>(null);
  const state: LoadState = loaded && loaded.key === path ? loaded.result : { status: 'loading' };

  useEffect(() => {
    let cancelled = false;
    void resolveArtifactText(path).then((result) => {
      if (!cancelled) setLoaded({ key: path, result });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      data-testid="artifact-output-modal-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(6,6,10,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        data-testid="artifact-output-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(720px, 92vw)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--color-panel)',
          border: '1px solid var(--color-border)',
          borderRadius: 10,
          padding: 16,
          gap: 10,
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--color-text)',
              fontFamily: 'var(--font-mono)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
          <button
            data-testid="artifact-output-modal-close"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, flexShrink: 0 }}
          >
            ×
          </button>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {state.status === 'loading' && (
            <div style={{ fontSize: 12, color: 'var(--color-text-disabled)' }}>{t('common.loading')}</div>
          )}
          {state.status === 'missing' && (
            <div data-testid="artifact-output-missing" style={{ fontSize: 12, color: 'var(--color-text-ghost)' }}>
              {t('report.artifact.fileMissing')}
            </div>
          )}
          {state.status === 'unreadable' && (
            <div data-testid="artifact-output-unreadable" style={{ fontSize: 12, color: 'var(--color-warning)' }}>
              {t('report.artifact.previewUnavailable')}
            </div>
          )}
          {state.status === 'ok' && (
            <>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: 'var(--color-text-secondary)',
                }}
              >
                {state.text}
              </pre>
              {state.truncated && (
                <div style={{ marginTop: 8, fontSize: 10.5, color: 'var(--color-text-disabled)' }}>
                  {t('report.artifact.outputTruncated')}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
