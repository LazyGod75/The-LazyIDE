/* ArtifactThumbnail.tsx — one `screenshot` proof artifact rendered as an
   actual disk-backed thumbnail when possible, and an HONEST fallback chip
   otherwise (see artifactImage.ts's header for exactly why a real binary
   screenshot often can't be inlined yet in this app — no broken <img> is
   ever shown; a distinct label always explains the state).
*/

import { memo, useEffect, useState } from 'react';
import { useI18n } from '../../../i18n';
import { resolveScreenshotSrc, type ArtifactImageResult } from './artifactImage';

interface ArtifactThumbnailProps {
  path: string;
  label: string;
}

type LoadState = { status: 'loading' } | ArtifactImageResult;

/** Result is stored WITH the path it answers ({ key, result }); staleness
 *  is DERIVED at render time (key !== current path) instead of an eager
 *  setState('loading') at the top of the effect — the same convention
 *  useMissionHistory.ts's hooks use (see that file's header comment) to
 *  avoid the react-hooks/set-state-in-effect cascading-render warning. */
function useScreenshotSrc(path: string): LoadState {
  const [state, setState] = useState<{ key: string; result: ArtifactImageResult } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void resolveScreenshotSrc(path).then((result) => {
      if (!cancelled) setState({ key: path, result });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return state && state.key === path ? state.result : { status: 'loading' };
}

const FRAME_SIZE = { width: 168, height: 110 };

export const ArtifactThumbnail = memo(function ArtifactThumbnail({ path, label }: ArtifactThumbnailProps) {
  const { t } = useI18n();
  const state = useScreenshotSrc(path);

  return (
    <div data-testid="artifact-screenshot" style={{ display: 'flex', flexDirection: 'column', gap: 4, width: FRAME_SIZE.width }}>
      <div
        style={{
          width: FRAME_SIZE.width,
          height: FRAME_SIZE.height,
          borderRadius: 8,
          border: '1px solid var(--color-border)',
          background: 'var(--color-panel-3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {state.status === 'loading' && (
          <span style={{ fontSize: 10, color: 'var(--color-text-disabled)' }}>{t('report.artifact.loading')}</span>
        )}
        {state.status === 'ok' && (
          <img src={state.dataUri} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
        {state.status === 'missing' && (
          <span
            data-testid="artifact-state-missing"
            style={{ fontSize: 10, color: 'var(--color-text-ghost)', textAlign: 'center', padding: '0 8px' }}
          >
            {t('report.artifact.fileMissing')}
          </span>
        )}
        {state.status === 'unreadable' && (
          <span
            data-testid="artifact-state-unreadable"
            style={{ fontSize: 10, color: 'var(--color-warning)', textAlign: 'center', padding: '0 8px' }}
          >
            {t('report.artifact.previewUnavailable')}
          </span>
        )}
        {state.status === 'too-large' && (
          <span
            data-testid="artifact-state-too-large"
            style={{ fontSize: 10, color: 'var(--color-warning)', textAlign: 'center', padding: '0 8px' }}
          >
            {t('report.artifact.tooLarge')}
          </span>
        )}
      </div>
      <span
        title={label}
        style={{
          fontSize: 10.5,
          color: 'var(--color-text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </div>
  );
});
