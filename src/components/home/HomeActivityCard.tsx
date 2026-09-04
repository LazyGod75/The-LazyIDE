/* HomeActivityCard — token sparkline and mission status bars for the Home dashboard.
   Shows usage trend (Sparkline) and live mission breakdown (MissionStatusBars).
   Accepts missions list from HomeSpace; manages its own time window state.
*/

import { useState } from 'react';
import { useI18n } from '../../i18n';
import {
  Sparkline,
  MissionStatusBars,
  WindowSelector,
  useUsageMetrics,
  formatTokens,
} from '../metrics';
import type { UsageWindow } from '../../lib/models/usageHistory';
import type { Mission } from '../../lib/agents/types';

export interface HomeActivityCardProps {
  missions: Mission[];
}

export function HomeActivityCard({ missions }: HomeActivityCardProps) {
  const { t } = useI18n();
  const [timeWindow, setTimeWindow] = useState<UsageWindow>('today');
  const m = useUsageMetrics(timeWindow);

  const done = missions.filter((ms) => ms.status === 'done').length;
  const running = missions.filter((ms) => ms.status === 'running').length;
  const review = missions.filter((ms) => ms.status === 'review').length;
  const queued = missions.filter((ms) => ms.status === 'queued').length;

  return (
    <section>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <h2
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.3)',
            margin: 0,
          }}
        >
          {t('home.activity.title')}
        </h2>
        <WindowSelector value={timeWindow} onChange={setTimeWindow} />
      </div>
      <div
        style={{
          background: 'var(--color-panel-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {/* Token sparkline */}
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 6,
            }}
          >
            {t('metrics.tokens')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: '#E2E2F0',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatTokens(m.totalTokens)}
            </span>
            <Sparkline data={m.tokenSparkline} width={90} height={22} color="#7C5CFF" fill />
          </div>
        </div>

        {/* Mission status breakdown */}
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 6,
            }}
          >
            {t('metrics.missions')}
          </div>
          <MissionStatusBars done={done} running={running} review={review} queued={queued} />
          {(running + review + done + queued) > 0 && (
            <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
              {running > 0 && (
                <span style={{ fontSize: 10, color: '#FFC76B' }}>
                  {running} {t('metrics.running')}
                </span>
              )}
              {review > 0 && (
                <span style={{ fontSize: 10, color: '#7C5CFF' }}>
                  {review} {t('metrics.review')}
                </span>
              )}
              {done > 0 && (
                <span style={{ fontSize: 10, color: '#66E27A' }}>
                  {done} {t('metrics.missionsDone')}
                </span>
              )}
              {queued > 0 && (
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
                  {queued} {t('metrics.queued')}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
