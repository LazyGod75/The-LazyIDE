/* ReplayBar.tsx — Agent Canvas W8d: the Replay mode overlay bar. Bottom
   Panel (mounted inside <ReactFlow> from CanvasView.tsx, same
   pattern CanvasToolbar/ShortcutsPanel already use for `useReactFlow()`-free
   overlays) with the timeline scrubber, play/pause/speed, window selector,
   current-time label, and the one-line event ticker (spec: "14:32 — M12 →
   TEST"). A prominent REPLAY badge keeps live vs. replay unmistakable.

   Read-only over the live graph by construction: every prop here is data
   (from useReplayMode.ts) plus callbacks — this component never touches
   canvasStore/agentsStore/the journal itself.
*/

import { useMemo, type CSSProperties } from 'react';
import { Panel } from '@xyflow/react';
import { useI18n } from '../../../../i18n';
import { densityBuckets } from './replayModel';
import { formatClock, tickerText } from './replayTicker';
import type { ReplaySpeed, UseReplayModeResult } from './useReplayMode';
import type { ReplayWindowOption } from './replayModel';

const WINDOW_OPTIONS: readonly ReplayWindowOption[] = ['today', '24h', '7d'];
const SPEEDS: readonly ReplaySpeed[] = [1, 4, 16];
const DENSITY_BUCKET_COUNT = 48;

const CHIP_STYLE: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  padding: '3px 8px',
  borderRadius: 14,
  border: '1px solid var(--color-border-3)',
  background: 'transparent',
  color: 'var(--color-text-secondary)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
};

const CHIP_ACTIVE_STYLE: CSSProperties = {
  ...CHIP_STYLE,
  border: '1px solid var(--color-accent)',
  background: 'var(--color-accent)',
  color: '#14141C',
};

const FORK_BUTTON_STYLE: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  padding: '3px 9px',
  borderRadius: 14,
  border: '1px solid var(--color-accent)',
  background: 'transparent',
  color: 'var(--color-accent)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
};

const ICON_BUTTON_STYLE: CSSProperties = {
  width: 24,
  height: 22,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: 'var(--color-text)',
  fontSize: 13,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
};

function windowOptionLabelKey(option: ReplayWindowOption): string {
  if (option === '24h') return 'canvas.replay.window.24h';
  if (option === '7d') return 'canvas.replay.window.7d';
  return 'canvas.replay.window.today';
}

export interface ReplayBarProps {
  replay: UseReplayModeResult;
  /**
   * Fork-from-replay (v1) — materializes an isolated draft seeded from the
   * currently `selectedMissionId`'s journal state as of the current
   * playhead, then exits replay (CanvasView.tsx's real implementation —
   * this component stays "data + callbacks only", see this file's own
   * header). Optional so a caller that never wires the feature (or an
   * existing test fixture) simply never renders the entry — the button's
   * OWN visibility still requires a `selectedMissionId`, see below.
   */
  onForkMission?: (missionId: string) => void;
}

export function ReplayBar({ replay, onForkMission }: ReplayBarProps) {
  const { t } = useI18n();
  const { timeline, currentTMs, playing, speed, windowOption, loading, tickerKeyframe, selectedMissionId } = replay;

  const buckets = useMemo(
    () => (timeline ? densityBuckets(timeline, DENSITY_BUCKET_COUNT) : []),
    [timeline],
  );
  const maxBucket = Math.max(1, ...buckets);
  // R2a fix (thread 3): before this, `isEmpty` was `timeline !== null && ...`
  // — while `timeline` is still `null` (the fetch hasn't settled yet,
  // `loading === true`), that condition is FALSE, so the code fell into the
  // "not empty" branch below with a zero-valued scrubber AND a ticker whose
  // `tickerKeyframe` is still `undefined` — which renders the EXACT SAME
  // `canvas.replay.empty` copy the dedicated empty state uses (see
  // replayTicker.ts's tickerText fallback). A user (or a screenshot) sees
  // "no events" during ordinary IPC/query latency, indistinguishable from a
  // genuinely empty window. `isLoadingWindow` now gates a THIRD, honest
  // state so "still fetching" is never rendered as "found nothing".
  const isLoadingWindow = loading || timeline === null;
  const isEmpty = timeline !== null && !loading && timeline.keyframes.length === 0;

  return (
    <Panel position="bottom-center">
      <div
        data-testid="canvas-replay-bar"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          width: 560,
          maxWidth: '80vw',
          padding: '8px 12px',
          borderRadius: 10,
          background: 'var(--color-panel-2)',
          border: '1px solid var(--color-danger)',
          boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span data-testid="canvas-replay-badge" className="canvas-replay-badge">
            <span className="canvas-replay-badge-dot" aria-hidden="true" />
            {t('canvas.replay.badge')}
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {WINDOW_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                data-testid={`canvas-replay-window-${option}`}
                onClick={() => replay.setWindowOption(option)}
                aria-pressed={windowOption === option}
                style={windowOption === option ? CHIP_ACTIVE_STYLE : CHIP_STYLE}
              >
                {t(windowOptionLabelKey(option))}
              </button>
            ))}
          </div>

          <div style={{ flex: 1 }} />

          {loading && (
            <span data-testid="canvas-replay-loading" style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>
              {t('canvas.replay.loading')}
            </span>
          )}

          {/* Fork-from-replay (v1) — only when a mission node is selected
              AND the caller actually wired the feature (onForkMission).
              See canvasTypes.ts's DraftSpec.forkOf and
              lib/agents/forkFromReplay.ts for the honest-semantics
              boundary this button's action respects. */}
          {selectedMissionId && onForkMission && (
            <button
              type="button"
              data-testid="canvas-replay-fork"
              onClick={() => onForkMission(selectedMissionId)}
              title={t('canvas.replay.forkFromHere')}
              style={FORK_BUTTON_STYLE}
            >
              {t('canvas.replay.forkFromHere')}
            </button>
          )}

          <button
            type="button"
            data-testid="canvas-replay-exit"
            onClick={replay.exit}
            title={t('canvas.replay.exit')}
            aria-label={t('canvas.replay.exit')}
            style={ICON_BUTTON_STYLE}
          >
            ×
          </button>
        </div>

        {isLoadingWindow ? (
          // R2a fix (thread 3): a THIRD, honest state — distinct from both
          // "found real events" and "found genuinely zero events" — shown
          // for as long as the fetch hasn't settled (`loading === true`, or
          // `timeline` hasn't been set even once yet). Never the
          // `canvas.replay.empty` copy: see the `isLoadingWindow` doc
          // comment above for why conflating the two used to read as "no
          // events" during ordinary query latency.
          <div
            data-testid="canvas-replay-loading-state"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)', padding: '4px 0' }}
          >
            {t('canvas.replay.loadingWindow')}
          </div>
        ) : isEmpty ? (
          <div
            data-testid="canvas-replay-empty"
            style={{ fontSize: 11.5, color: 'var(--color-text-muted)', padding: '4px 0' }}
          >
            {t('canvas.replay.empty')}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                data-testid="canvas-replay-play-pause"
                onClick={replay.togglePlay}
                title={t(playing ? 'canvas.replay.pause' : 'canvas.replay.play')}
                aria-label={t(playing ? 'canvas.replay.pause' : 'canvas.replay.play')}
                aria-pressed={playing}
                style={{ ...ICON_BUTTON_STYLE, color: 'var(--color-accent)', fontSize: 15 }}
              >
                {playing ? '❚❚' : '▶'}
              </button>

              <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    data-testid={`canvas-replay-speed-${s}`}
                    onClick={() => replay.setSpeed(s)}
                    aria-pressed={speed === s}
                    style={speed === s ? CHIP_ACTIVE_STYLE : CHIP_STYLE}
                  >
                    {t('canvas.replay.speed', { speed: s })}
                  </button>
                ))}
              </div>

              <div style={{ position: 'relative', flex: 1 }}>
                {/* Density ticks — a plain flex row of bars scaled to the
                    busiest bucket, drawn BEHIND the range input via
                    negative margin so both share the same horizontal
                    extent without JS-measuring anything. */}
                <div
                  data-testid="canvas-replay-density"
                  aria-hidden="true"
                  style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 10, padding: '0 2px' }}
                >
                  {buckets.map((count, i) => (
                    <span
                      key={i}
                      style={{
                        flex: 1,
                        height: count === 0 ? 1 : Math.max(2, (count / maxBucket) * 10),
                        background: count === 0 ? 'var(--color-border-3)' : 'var(--color-accent)',
                        opacity: count === 0 ? 0.4 : 0.8,
                        borderRadius: 1,
                      }}
                    />
                  ))}
                </div>
                <input
                  type="range"
                  data-testid="canvas-replay-scrubber"
                  className="nodrag"
                  aria-label={t('canvas.replay.scrubber')}
                  min={timeline?.windowStartMs ?? 0}
                  max={timeline?.windowEndMs ?? 0}
                  value={currentTMs}
                  onChange={(e) => replay.scrubTo(Number(e.target.value))}
                  style={{ width: '100%', margin: 0 }}
                />
              </div>

              <span
                data-testid="canvas-replay-clock"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-secondary)', width: 46, textAlign: 'right' }}
              >
                {formatClock(currentTMs)}
              </span>
            </div>

            <div
              data-testid="canvas-replay-ticker"
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {/* R2a fix (thread 3, observed live): this branch only renders
                  when the window HAS keyframes, yet tickerText falls back to
                  the SAME `canvas.replay.empty` copy when no keyframe has
                  been crossed yet (playhead at window start = local
                  midnight, first event later in the day) — "Aucun événement
                  sur la fenêtre" over a scrubber full of density ticks is a
                  lie. Distinct honest copy for "events exist, none crossed
                  yet". */}
              {tickerKeyframe ? tickerText(t, tickerKeyframe) : t('canvas.replay.ticker.notStarted')}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
