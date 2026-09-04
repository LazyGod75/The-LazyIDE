/* TimelineScrubber — "voyage dans le temps du brain": a dedicated overlay
   that scrubs the Brain Canvas graph to any point in its growth, from the
   oldest note up to "Tout" (everything). Floats over the bottom of the
   graph canvas — see BrainSpace.tsx, which owns the `timeIdx` state shared
   with BrainGraph3D so the canvas and this control always agree.

   Timeline model: TIME_BUCKET_COUNT (8) discrete positions, precomputed
   once per graph load by canvas/dateBucketing.ts's buildDateAxis (real
   calendar dates when the loaded notes carry a `created` timestamp; a
   stable per-id hash spread otherwise — see AdaptedBrainData.dateAxis in
   lib/brain/brainAdapter.ts). Dragging the slider or stepping prev/next is
   therefore always a cheap integer compare against already-computed data —
   no re-fetch, no re-layout. BrainGraph3D's render loop reads the same
   `timeIdx` and eases each node's reveal toward `dateIdx <= timeIdx` one
   frame at a time (see RenderNode.reveal in canvas/types.ts).

   Degrades gracefully: when the brain's real dates all fall on the same
   calendar day (dateAxis.isSingleDay) — a fresh brain, nothing to scrub
   yet — the whole control disables itself with an explanatory tooltip
   instead of offering a slider with nothing real to reveal. The hash-based
   demo/legacy path (dateAxis.hasRealDates === false) stays fully active,
   unchanged from before this feature.
*/

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import type { Locale } from '../../i18n/types';
import type { DateAxis } from '../../lib/brain/brainAdapter';
import { TIME_BUCKET_COUNT } from './canvas/dateBucketing';

export interface TimelineScrubberProps {
  dateAxis: DateAxis;
  timeIdx: number;
  onTimeIdxChange: (timeIdx: number) => void;
}

const MAX_IDX = TIME_BUCKET_COUNT - 1;
const PLAY_STEP_MS = 900;
const ACCENT = '#7C5CFF';

function formatDateLabel(iso: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(0, 10);
  }
}

function iconButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    width: 26,
    height: 26,
    borderRadius: 7,
    border: `1px solid ${enabled ? 'rgba(124,92,255,0.35)' : 'rgba(255,255,255,0.08)'}`,
    background: enabled ? 'rgba(124,92,255,0.14)' : 'rgba(255,255,255,0.03)',
    color: enabled ? '#E8E3FF' : 'rgba(255,255,255,0.25)',
    fontSize: 12,
    lineHeight: 1,
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontFamily: 'inherit',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };
}

export function TimelineScrubber({ dateAxis, timeIdx, onTimeIdxChange }: TimelineScrubberProps) {
  const { t, locale } = useI18n();
  const [playing, setPlaying] = useState(false);

  const disabled = dateAxis.hasRealDates && dateAxis.isSingleDay;

  // Latest timeIdx mirrored into a ref so the play interval always steps
  // from the current position without needing to restart on every change.
  const timeIdxRef = useRef(timeIdx);
  useEffect(() => {
    timeIdxRef.current = timeIdx;
  }, [timeIdx]);

  // A graph reload can shrink the date range into "single day" mid-session
  // (e.g. switching to a freshly-imported project) — stop any playback
  // rather than leave it running against a now-disabled control.
  useEffect(() => {
    if (disabled) setPlaying(false);
  }, [disabled]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const next = timeIdxRef.current + 1;
      if (next > MAX_IDX) {
        setPlaying(false);
        return;
      }
      onTimeIdxChange(next);
    }, PLAY_STEP_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, onTimeIdxChange]);

  const stopPlayback = () => setPlaying(false);

  const handleSliderChange = (value: number) => {
    stopPlayback();
    onTimeIdxChange(value);
  };

  const handleStep = (delta: number) => {
    stopPlayback();
    onTimeIdxChange(Math.max(0, Math.min(MAX_IDX, timeIdx + delta)));
  };

  const handlePlayToggle = () => {
    if (disabled) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (timeIdx >= MAX_IDX) onTimeIdxChange(0);
    setPlaying(true);
  };

  const atAll = timeIdx >= MAX_IDX;
  const label = atAll
    ? t('brain.timeline.all')
    : dateAxis.hasRealDates && dateAxis.bucketDates[timeIdx]
      ? t('brain.timeline.asOf', { date: formatDateLabel(dateAxis.bucketDates[timeIdx]!, locale) })
      : t('brain.timeTravelBucket', { idx: timeIdx + 1, total: TIME_BUCKET_COUNT });

  return (
    <div
      role="group"
      aria-label={t('brain.timeline.sliderAria')}
      title={disabled ? t('brain.timeline.disabledSingleDay') : undefined}
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 16,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '8px 12px',
        borderRadius: 10,
        background: 'rgba(14,14,18,0.85)',
        border: `1px solid ${disabled ? 'rgba(255,255,255,0.08)' : 'rgba(124,92,255,0.25)'}`,
        backdropFilter: 'blur(6px)',
        opacity: disabled ? 0.55 : 1,
        zIndex: 5,
        maxWidth: 'min(620px, calc(100% - 32px))',
      }}
    >
      {/* Persistent caption — previously this whole control only explained
          itself via hover tooltips (title attrs) and the live aria-label,
          so at a glance it read as "two arrows, a slider, the word All"
          with no indication of what it does. `brain.timeTravel` already
          exists as a translated string (used elsewhere for the same
          concept) — reused here rather than adding a new key. */}
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.35)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {t('brain.timeTravel')}
      </span>

      <button
        type="button"
        onClick={() => handleStep(-1)}
        disabled={disabled || timeIdx <= 0}
        title={t('brain.timeline.prev')}
        aria-label={t('brain.timeline.prev')}
        style={iconButtonStyle(!disabled && timeIdx > 0)}
      >
        ◂
      </button>

      <button
        type="button"
        onClick={handlePlayToggle}
        disabled={disabled}
        title={playing ? t('brain.timeline.pause') : t('brain.timeline.play')}
        aria-label={playing ? t('brain.timeline.pause') : t('brain.timeline.play')}
        aria-pressed={playing}
        style={iconButtonStyle(!disabled)}
      >
        {playing ? '❚❚' : '▸'}
      </button>

      <button
        type="button"
        onClick={() => handleStep(1)}
        disabled={disabled || timeIdx >= MAX_IDX}
        title={t('brain.timeline.next')}
        aria-label={t('brain.timeline.next')}
        style={iconButtonStyle(!disabled && timeIdx < MAX_IDX)}
      >
        ▸
      </button>

      <input
        type="range"
        min={0}
        max={MAX_IDX}
        step={1}
        value={timeIdx}
        disabled={disabled}
        onChange={(e) => handleSliderChange(Number(e.target.value))}
        aria-label={t('brain.timeline.sliderAria')}
        aria-valuetext={label}
        style={{
          WebkitAppearance: 'none',
          appearance: 'none',
          width: 160,
          height: 3,
          borderRadius: 2,
          accentColor: ACCENT,
          cursor: disabled ? 'not-allowed' : 'pointer',
          background: disabled
            ? 'rgba(255,255,255,0.08)'
            : `linear-gradient(to right, ${ACCENT} ${(timeIdx / MAX_IDX) * 100}%, rgba(255,255,255,0.12) ${(timeIdx / MAX_IDX) * 100}%)`,
          outline: 'none',
        }}
      />

      <span
        aria-live="polite"
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: disabled ? 'rgba(255,255,255,0.4)' : '#E8E3FF',
          minWidth: 108,
          textAlign: 'left',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
    </div>
  );
}
