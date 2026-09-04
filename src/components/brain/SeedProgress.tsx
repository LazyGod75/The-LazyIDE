/* SeedProgress — shared, animated presentational UI for the brain
   "seed from history" import flow. Both onboarding's BrainSetupStep and
   Settings' MemoryPanel (HistoryReimportSection) stream the same
   platform.brain.onSeedProgress() channel (see src/lib/platform/types.ts's
   SeedProgressEvent) — this component turns that stream into an
   unmistakable in-progress -> done/error sequence instead of a thin,
   easy-to-miss line of text.

   Read-only by design: everything arrives via props. This component never
   calls platform.brain.* itself — callers own the state machine and pass
   the current status/progress/result/error down.

   Data-accuracy note: for history imports, brain_seed's `done`/`total`
   count SOURCES being processed (e.g. "claude-code", "cursor" — usually 1
   or 2), not individual conversations — the backend never reports
   per-conversation counts. The labels below reflect that honestly (a
   source-count fraction + the raw per-source message, e.g. "Importing from
   claude-code") rather than inventing a conversation-level count that does
   not exist in the data.

   Animation: reuses the keyframes already global in
   src/styles/design-system.css (spin / pulse-drop / lm-pulse / fade-in) —
   nothing new is injected into the document head. Respects
   prefers-reduced-motion: the spinner becomes a static pulsing dot
   (lm-pulse) instead of spinning, and pop-in transitions are skipped. */

import React, { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import type { SeedProgressEvent } from '../../lib/platform/types';

// ── prefers-reduced-motion ────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

// ── Public API ────────────────────────────────────────────────────

export type SeedProgressStatus = 'running' | 'done' | 'error';

export interface SeedProgressResult {
  imported: number;
  skipped: number;
}

export interface SeedProgressProps {
  status: SeedProgressStatus;
  /** Latest event from platform.brain.onSeedProgress(); null before the
      first event arrives — the running view still renders immediately,
      it does not wait for data to show that work has started. */
  progress: SeedProgressEvent | null;
  /** Used when status === 'done'. */
  result?: SeedProgressResult | null;
  /** Used when status === 'error'. */
  errorMessage?: string | null;
  /** Renders a Cancel button in the running view when provided. */
  onCancel?: () => void;
  /** Renders a Retry button in the error view when provided. */
  onRetry?: () => void;
  /** Renders the primary "next action" button in the done view (and a
      secondary Close button in the error view) when provided, together
      with doneLabel. */
  onDone?: () => void;
  doneLabel?: string;
}

export function SeedProgress(props: SeedProgressProps) {
  if (props.status === 'done') {
    return <DoneState result={props.result} onDone={props.onDone} doneLabel={props.doneLabel} />;
  }
  if (props.status === 'error') {
    return (
      <ErrorState
        errorMessage={props.errorMessage}
        onRetry={props.onRetry}
        onDone={props.onDone}
        doneLabel={props.doneLabel}
      />
    );
  }
  return <RunningState progress={props.progress} onCancel={props.onCancel} />;
}

// ── Phase labels ─────────────────────────────────────────────────

function phaseLabel(t: (key: string, params?: Record<string, string | number>) => string, phase: string | undefined): string {
  switch (phase) {
    case 'starting': return t('brain.seedProgress.phase.starting');
    case 'backend': return t('brain.seedProgress.phase.backend');
    case 'import': return t('brain.seedProgress.phase.import');
    // Not emitted by the current backend (which now goes straight from
    // 'import' into the post-seed pipeline below) but kept as a defensive
    // fallback for older payload shapes. Deliberately worded as MID-flight,
    // not a finish line: real completion is 'done', which arrives after
    // five more pipeline steps.
    case 'complete': return t('brain.seedProgress.phase.complete');
    // Post-seed pipeline (see SeedProgressEvent's doc comment in
    // lib/platform/types.ts): runs after every source has imported, in this
    // order, done/total re-based to 0..5 — 'import's source-count fraction
    // does not carry over.
    case 'indexing': return t('brain.seedProgress.phase.indexing');
    case 'synthesizing': return t('brain.seedProgress.phase.synthesizing');
    case 'linking': return t('brain.seedProgress.phase.linking');
    case 'scoring': return t('brain.seedProgress.phase.scoring');
    case 'serving': return t('brain.seedProgress.phase.serving');
    case 'done': return t('brain.seedProgress.phase.done');
    case 'error': return t('brain.seedProgress.phase.sourceError');
    // No event received yet (progress is still null the instant the running
    // view mounts) — "starting" reads correctly here and, just as
    // importantly, avoids literally repeating the header's "Importing…"
    // text right below itself.
    case undefined: return t('brain.seedProgress.phase.starting');
    default: return t('onboarding.brain.importing');
  }
}

/** Post-seed pipeline phases (see phaseLabel above): done/total on these is
    re-based to a fixed 0..5 step count (indexing=0, synthesizing=1,
    linking=2, scoring=3, serving=4, done=5/5), unrelated to 'import's
    source-count scale — see RunningState's progress-bar comment for why that
    matters. 'error' is deliberately excluded: it fires during both the
    per-source import loop (source-count total) AND the post-seed pipeline
    (5-based total), so the phase name alone can't disambiguate its scale —
    it keeps rendering with the plain done/total math, unchanged. */
const POST_PIPELINE_PHASES = new Set(['indexing', 'synthesizing', 'linking', 'scoring', 'serving', 'done']);

// ── Running state ────────────────────────────────────────────────

interface RunningStateProps {
  progress: SeedProgressEvent | null;
  onCancel?: () => void;
}

function RunningState({ progress, onCancel }: RunningStateProps) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const done = progress?.done ?? 0;
  const total = progress?.total ?? 0;
  const isSourceError = progress?.phase === 'error';
  // The post-seed pipeline (indexing/synthesizing/linking/scoring/serving/
  // done) re-bases done/total to a fixed 0..5 step count that has nothing to
  // do with the import phase's source-count fraction — reusing the naive
  // done/total ratio for both would make the bar visibly jump backwards
  // (e.g. 100% · 2/2 sources -> 0% · 0/5 steps).
  const isPostPipelinePhase = progress?.phase !== undefined && POST_PIPELINE_PHASES.has(progress.phase);
  // `percent` is a whole-pipeline, source-weighted value computed
  // server-side (see history_import.rs's import_phase_percent /
  // emit_seed_progress) and carried as an additive field on the event —
  // not part of the shared SeedProgressEvent type (platform/types.ts), read
  // here via a locally-widened type, same convention used elsewhere in this
  // codebase for extending a shared platform type without editing its file.
  // Preferring it over the naive done/total ratio is what lets the SAME
  // determinate bar span import AND the post-seed pipeline without ever
  // jumping backwards — done/total alone cannot do that (see above).
  const rawPercent = (progress as (SeedProgressEvent & { percent?: number }) | null)?.percent;
  const hasRealPercent = typeof rawPercent === 'number';
  const pct = hasRealPercent
    ? Math.min(100, Math.max(0, Math.round(rawPercent as number)))
    : (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);
  // Indeterminate shimmer is now only a LAST-RESORT fallback: once the
  // backend emits a real weighted percent (the normal case after this
  // fix), every phase — import AND the post-seed pipeline — renders as one
  // continuous determinate bar. Only an event that somehow lacks `percent`
  // (e.g. a stale/older payload shape) falls back to the old shimmer for
  // the post-pipeline phases, where done/total alone would be misleading —
  // this never invents a number, same honesty rule as this file's
  // data-accuracy note above.
  const showIndeterminate = isPostPipelinePhase && !hasRealPercent;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        padding: '16px 18px',
        background: 'var(--color-panel-2)',
        border: '1.5px solid rgba(124,92,255,0.5)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        animation: reducedMotion ? undefined : 'pulse-drop 2.4s ease-in-out infinite',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Spinner reducedMotion={reducedMotion} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>
            {t('onboarding.brain.importing')}
          </div>
          <div style={{
            fontSize: 12,
            color: isSourceError ? '#FBBF24' : 'var(--color-text-muted)',
            marginTop: 2,
          }}>
            {phaseLabel(t, progress?.phase)}
          </div>
        </div>
        {onCancel && (
          <button onClick={onCancel} style={ghostButtonStyle}>
            {t('onboarding.brain.cancel')}
          </button>
        )}
      </div>

      {/* Determinate progress bar — smooth width transition on every
          update, never a static/frozen line. Renders the real percent
          continuously across import AND the post-seed pipeline whenever the
          backend provides one (hasRealPercent); only falls back to an
          indeterminate shimmer (reuses Skeleton's own skeleton-shimmer
          keyframe — see design-system.css) when it doesn't — see
          showIndeterminate above for why. */}
      <div style={{ height: 8, background: 'rgba(255,255,255,0.07)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          width: showIndeterminate ? '100%' : `${pct}%`,
          background: showIndeterminate
            ? 'linear-gradient(90deg, var(--color-accent) 0%, #A78BFF 50%, var(--color-accent) 100%)'
            : 'linear-gradient(90deg, var(--color-accent), #A78BFF)',
          backgroundSize: showIndeterminate ? '200% 100%' : undefined,
          borderRadius: 4,
          transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
          animation: showIndeterminate && !reducedMotion ? 'skeleton-shimmer 1.6s ease-in-out infinite' : undefined,
        }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{
          fontSize: 11,
          color: 'var(--color-text-muted)',
          fontFamily: 'var(--font-mono, monospace)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {progress?.message ?? ''}
        </div>
        <div style={{
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--color-accent-light)',
          fontFamily: 'var(--font-mono, monospace)',
          flexShrink: 0,
        }}>
          {hasRealPercent
            ? (isPostPipelinePhase ? `${pct}%` : `${pct}% · ${done} / ${total}`)
            : (total > 0 && !isPostPipelinePhase ? `${pct}% · ${done} / ${total}` : '…')}
        </div>
      </div>
    </div>
  );
}

function Spinner({ reducedMotion, size = 16 }: { reducedMotion: boolean; size?: number }) {
  if (reducedMotion) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: Math.round(size * 0.5),
          height: Math.round(size * 0.5),
          borderRadius: '50%',
          background: 'var(--color-accent)',
          display: 'inline-block',
          flexShrink: 0,
          animation: 'lm-pulse 1.4s ease-in-out infinite',
        }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: '2.5px solid var(--color-accent)',
        borderTopColor: 'transparent',
        display: 'inline-block',
        flexShrink: 0,
        animation: 'spin 0.8s linear infinite',
      }}
    />
  );
}

// ── Done state ───────────────────────────────────────────────────

interface DoneStateProps {
  result?: SeedProgressResult | null;
  onDone?: () => void;
  doneLabel?: string;
}

function DoneState({ result, onDone, doneLabel }: DoneStateProps) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  const imported = result?.imported ?? 0;
  const skipped = result?.skipped ?? 0;

  return (
    <div
      role="status"
      style={{
        padding: '16px 18px',
        background: 'rgba(34,197,94,0.07)',
        border: '1px solid rgba(34,197,94,0.3)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <CheckBadge reducedMotion={reducedMotion} />
        <div style={{ fontSize: 14, fontWeight: 700, color: '#66E27A' }}>
          {t('onboarding.brain.importComplete')}
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', lineHeight: 1.55 }}>
        {t('onboarding.brain.importResult', { imported: imported.toLocaleString(), skipped: skipped.toLocaleString() })}
      </div>
      {onDone && doneLabel && (
        <button onClick={onDone} style={successButtonStyle}>
          {doneLabel}
        </button>
      )}
    </div>
  );
}

function CheckBadge({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 24,
        height: 24,
        borderRadius: '50%',
        background: 'rgba(34,197,94,0.18)',
        border: '1.5px solid #4ADE80',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        animation: reducedMotion ? undefined : 'fade-in 0.3s ease-out',
      }}
    >
      <svg width="12" height="10" viewBox="0 0 12 10" fill="none">
        <path d="M1 5L4.5 8.5L11 1.5" stroke="#4ADE80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

// ── Error state ──────────────────────────────────────────────────

interface ErrorStateProps {
  errorMessage?: string | null;
  onRetry?: () => void;
  onDone?: () => void;
  doneLabel?: string;
}

function ErrorState({ errorMessage, onRetry, onDone, doneLabel }: ErrorStateProps) {
  const { t } = useI18n();

  return (
    <div
      role="alert"
      style={{
        padding: '16px 18px',
        background: 'rgba(248,113,113,0.07)',
        border: '1px solid rgba(248,113,113,0.3)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden="true" style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          background: 'rgba(248,113,113,0.18)',
          border: '1.5px solid #F87171',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          fontSize: 13,
          fontWeight: 700,
          color: '#F87171',
          lineHeight: 1,
        }}>
          !
        </span>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#F87171' }}>
          {t('brain.seedProgress.error.title')}
        </div>
      </div>
      {errorMessage && (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', lineHeight: 1.55 }}>
          {errorMessage}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        {onRetry && (
          <button onClick={onRetry} style={retryButtonStyle}>
            {t('onboarding.brain.tryAgain')}
          </button>
        )}
        {onDone && doneLabel && (
          <button onClick={onDone} style={ghostButtonStyle}>
            {doneLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Shared styles ────────────────────────────────────────────────

const ghostButtonStyle: React.CSSProperties = {
  padding: '7px 12px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 7,
  color: 'var(--color-text-muted)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
  flexShrink: 0,
};

const successButtonStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  padding: '8px 16px',
  background: 'rgba(34,197,94,0.15)',
  border: '1px solid #4ADE80',
  borderRadius: 7,
  color: '#66E27A',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const retryButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'rgba(248,113,113,0.15)',
  border: '1px solid #F87171',
  borderRadius: 7,
  color: '#F87171',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
