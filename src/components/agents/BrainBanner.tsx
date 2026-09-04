/* BrainBanner — shared-brain banner shown below the subheader.
   Displays real neuron count from active missions and real token savings from costStore. */

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { pluralKey } from '../../i18n/plural';
import type { Mission } from '../../lib/agents/types';
import { subscribeCost, getCostState, type CostState } from '../../lib/models/costStore';
import { formatTokenCountShort } from '../../lib/agents/tokenFormat';

interface BrainBannerProps {
  missions: Mission[];
}

export function BrainBanner({ missions }: BrainBannerProps) {
  const { t, locale } = useI18n();
  const [cost, setCost] = useState<CostState>(getCostState);

  useEffect(() => {
    return subscribeCost(setCost);
  }, []);

  // Count neurons injected into active (running/queued/review) missions
  const activeMissions = missions.filter(
    (m) => m.status === 'running' || m.status === 'queued' || m.status === 'review',
  );
  const neuronCount = activeMissions.reduce(
    (sum, m) => sum + (m.brainCitations?.length ?? 0),
    0,
  );

  const tokensSaved = cost.totalBrainTokensSaved;
  const tokensLabel = formatTokenCountShort(tokensSaved);

  return (
    <div
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '7px 20px',
        background: 'rgba(124,92,255,0.07)',
        borderBottom: '1px solid rgba(124,92,255,0.2)',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13 }}>🧠</span>
        <span
          style={{
            fontSize: 12,
            color: 'rgba(255,255,255,0.70)',
            fontWeight: 500,
          }}
        >
          {t('agents.brain.sharedMemory')}{' '}
          <span style={{ color: '#C4B5FD', fontWeight: 600 }}>
            {t(pluralKey('agents.brain.neuronsInjected', neuronCount, locale), { count: neuronCount })}
          </span>{' '}
          {t('agents.brain.inActiveAgents')}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 10px',
          borderRadius: 20,
          background: 'rgba(34,197,94,0.08)',
          border: '1px solid rgba(34,197,94,0.18)',
        }}
      >
        <span style={{ fontSize: 11 }}>💸</span>
        <span style={{ fontSize: 11, color: '#4ADE80', fontWeight: 500, whiteSpace: 'nowrap' }}>
          {t('agents.brain.tokensSaved', { count: tokensLabel })}
        </span>
      </div>
    </div>
  );
}
