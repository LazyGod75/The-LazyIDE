/* HomeHealthCard — system & brain health indicators for the Home dashboard.
   Shows: active model, neuron count (async), active agent count, brain status.
   Honest "—" when a value is unavailable. Demo badge on web.
*/

import { useState, useEffect } from 'react';
import { useAppContext } from '../../app/AppContext';
import { useI18n } from '../../i18n';
import { getPlatform } from '../../lib/platform';
import { loadAccessSettings } from '../../lib/models/accessSettings';
import { findModelById, DEFAULT_MODEL } from '../../lib/models/registry';

interface HealthItemProps {
  label: string;
  value: string;
  valueColor?: string;
}

function HealthItem({ label, value, valueColor }: HealthItemProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '7px 0',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>{label}</span>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: valueColor ?? '#E2E2F0',
          fontVariantNumeric: 'tabular-nums',
          maxWidth: '60%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

export function HomeHealthCard() {
  const { t } = useI18n();
  const { agentCount } = useAppContext();
  const [neuronCount, setNeuronCount] = useState<number | null>(null);
  const [brainReady, setBrainReady] = useState<boolean | null>(null);

  const isWeb = getPlatform().name === 'web';
  const settings = loadAccessSettings();
  const modelId = settings.model ?? DEFAULT_MODEL.id;
  const modelLabel = findModelById(modelId)?.label ?? '—';

  useEffect(() => {
    let cancelled = false;

    async function fetchNeuronCount(): Promise<void> {
      try {
        if (isWeb) {
          const res = await fetch('/_api/graph');
          if (!res.ok) { setBrainReady(false); return; }
          const raw = (await res.json()) as { nodes: unknown[] };
          if (!cancelled) {
            setNeuronCount(raw.nodes.length);
            setBrainReady(true);
          }
        } else {
          const data = await getPlatform().brain.graph();
          if (!cancelled) {
            setNeuronCount(data.nodes.length);
            setBrainReady(true);
          }
        }
      } catch {
        if (!cancelled) setBrainReady(false);
      }
    }

    fetchNeuronCount();
    return () => { cancelled = true; };
  }, [isWeb]);

  const statusValue = brainReady === null ? '—' : brainReady ? t('home.health.ready') : '—';
  const statusColor = brainReady ? '#66E27A' : undefined;

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
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
          {t('home.health.title')}
        </h2>
        {isWeb && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              color: 'rgba(255,200,80,0.7)',
              background: 'rgba(255,200,80,0.08)',
              border: '1px solid rgba(255,200,80,0.18)',
              borderRadius: 3,
              padding: '1px 5px',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            demo
          </span>
        )}
      </div>
      <div
        style={{
          background: 'var(--color-panel-2)',
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: '4px 14px',
        }}
      >
        <HealthItem label={t('home.health.activeModel')} value={modelLabel} />
        <HealthItem
          label={t('home.health.neurons')}
          value={neuronCount !== null ? String(neuronCount) : '—'}
        />
        <HealthItem
          label={t('home.health.agents')}
          value={String(agentCount)}
        />
        <HealthItem
          label={t('home.health.status')}
          value={statusValue}
          valueColor={statusColor}
        />
      </div>
    </section>
  );
}
