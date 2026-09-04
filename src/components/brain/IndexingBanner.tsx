/* IndexingBanner — honest, non-blocking indicator for the background
   auto-index pipeline (Rust `spawn_auto_index_if_needed`,
   src-tauri/src/commands/brain/index_project.rs).

   Listens for the `brain://indexing` Tauri event and renders whichever
   phase the Rust side actually reported — started / done / failed. No fake
   percentages: there is no partial-progress signal to show, only discrete
   phase transitions and (once known) the real note count.

   Mounted by BrainSpace inside the graph canvas's relatively-positioned
   container (top-right corner) so it never competes with BrainSetupCard or
   the loading/sidecar-unavailable overlays for the same screen space — see
   BrainSpace.tsx's "Live refresh" section.
*/

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { pluralKey } from '../../i18n/plural';
import { getPlatform } from '../../lib/platform';
import { Spinner } from '../ui';

type IndexingPhase = 'started' | 'done' | 'failed';

interface IndexingEventPayload {
  status: IndexingPhase;
  notes?: number;
}

export interface IndexingBannerProps {
  /** Called once indexing completes successfully, so the parent can refresh
      the graph (see BrainSpace's brain://updated handler for the identical
      refresh pattern). Never called on failure — nothing new to show. */
  onIndexed?: () => void;
}

/** How long the terminal states (done/failed) stay visible before
    auto-dismissing. The 'started' phase never auto-dismisses — it must stay
    up until a real done/failed event arrives. */
const AUTO_DISMISS_MS = 6000;

const PHASE_COLOR: Record<IndexingPhase, string> = {
  started: '#A78BFF',
  done: '#66E27A',
  failed: '#FCA5A5',
};

export function IndexingBanner({ onIndexed }: IndexingBannerProps) {
  const { t, locale } = useI18n();
  const platform = getPlatform();
  const isTauri = platform.name === 'tauri';

  const [phase, setPhase] = useState<IndexingPhase | null>(null);
  const [notes, setNotes] = useState<number | null>(null);

  const dismiss = useCallback(() => setPhase(null), []);

  useEffect(() => {
    if (!isTauri) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<IndexingEventPayload>('brain://indexing', (event) => {
        if (cancelled) return;
        const { status, notes: n } = event.payload;
        setPhase(status);
        setNotes(typeof n === 'number' ? n : null);
        if (status === 'done') onIndexed?.();
      }).then((fn) => {
        if (cancelled) { fn(); return; }
        unlisten = fn;
      }).catch(() => {
        // No sidecar / event bridge available — the banner simply never
        // appears, matching every other brain:// listener's fail-open style.
      });
    }).catch(() => {});

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [isTauri, onIndexed]);

  // Auto-dismiss terminal states after a delay. Never for 'started' — no
  // fake progress, no disappearing while work might still be happening.
  useEffect(() => {
    if (phase !== 'done' && phase !== 'failed') return;
    const timer = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [phase, dismiss]);

  if (!phase) return null;

  const label =
    phase === 'started' ? t('brain.indexing.started')
    : phase === 'done' ? t(pluralKey('brain.indexing.done', notes ?? 0, locale), { count: notes ?? 0 })
    : t('brain.indexing.failed');

  const color = PHASE_COLOR[phase];

  return (
    <div
      aria-live="polite"
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        background: '#16161D',
        border: `1px solid ${color}40`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        fontSize: 11,
        color: '#E6E8EF',
        maxWidth: 280,
      }}
    >
      {phase === 'started' && <Spinner size={12} color={color} />}
      <span>{label}</span>
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={dismiss}
        style={{
          background: 'none',
          border: 'none',
          color: 'rgba(255,255,255,0.35)',
          cursor: 'pointer',
          fontSize: 12,
          lineHeight: 1,
          padding: '0 2px',
          fontFamily: 'monospace',
        }}
      >
        x
      </button>
    </div>
  );
}
