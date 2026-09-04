/* ImagePreview — full-screen overlay for an image file opened from the Code
   space's file explorer.

   Previously rendered `<img src={`file://${path}`}>`, which is dead in a
   packaged Tauri build: `app.security.csp` (src-tauri/tauri.conf.json)
   only allows `img-src 'self' data: blob:` — no `file:` scheme — so the
   webview silently refused to load the image (CSP violation, no visible
   error). `@tauri-apps/api/core`'s `convertFileSrc` was considered instead,
   but it requires enabling Tauri's native `asset:` protocol AND widening
   its own filesystem scope (app.security.assetProtocol) to cover wherever
   the user's open project happens to live — a new, separately-configured
   read path with no relation to this app's existing per-project root
   jailing.

   `resolveScreenshotSrc` (src/components/agents/report/artifactImage.ts)
   already solves exactly this problem for report screenshot thumbnails:
   it round-trips the file through the binary-safe `read_file_base64` Tauri
   command — validated against the SAME registered-project-roots guard
   every other disk read in this app goes through (`ensure_path_in_any_open_
   project`, src-tauri/src/commands/fs.rs) — and returns a `data:` URI,
   which the CSP already allows with zero config changes. Reused as-is here
   rather than duplicating a second image-loading path. */

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { resolveScreenshotSrc } from '../agents/report/artifactImage';

interface ImagePreviewProps {
  path: string;
  onClose: () => void;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ok'; dataUri: string }
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'too-large' };

export function ImagePreview({ path, onClose }: ImagePreviewProps) {
  const { t } = useI18n();
  const [state, setState] = useState<PreviewState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    resolveScreenshotSrc(path).then((result) => {
      if (cancelled) return;
      setState(
        result.status === 'ok'
          ? { status: 'ok', dataUri: result.dataUri }
          : { status: result.status },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.8)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div style={{ position: 'absolute', top: 12, right: 16, fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
        {path}
      </div>

      {state.status === 'ok' && (
        <img
          src={state.dataUri}
          alt={path}
          style={{
            maxWidth: '90%',
            maxHeight: '85%',
            objectFit: 'contain',
            borderRadius: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        />
      )}

      {state.status !== 'ok' && (
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
          {state.status === 'loading' && t('imagePreview.loading')}
          {state.status === 'missing' && t('imagePreview.missing')}
          {state.status === 'unreadable' && t('imagePreview.unreadable')}
          {state.status === 'too-large' && t('imagePreview.tooLarge')}
        </div>
      )}

      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: 'none',
          border: 'none',
          color: 'rgba(255,255,255,0.4)',
          fontSize: 20,
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );
}
