/* BrainSavingsCard.tsx — the Rapport page's "Brain" card: what the project's
   brain measurably contributed — real recalls used and real prompt-cache
   tokens served. Hidden entirely when there is no real brain activity yet
   (brainSavings.ts's hasActivity) — never a fabricated zero-state card,
   same "absence over fabrication" rule ReportKpiStrip's brainNeuronsToday
   tile already applies.

   Honesty scope (see brainSavings.ts's header): this card never claims a
   dollar amount "saved" or a counterfactual "tokens saved" figure — only
   two real, directly-observed counts. No estimation/pricing is shown here,
   so there is nothing to label "≈ estimation" — every number rendered is
   exact, never approximate.
*/

import { useI18n } from '../../../i18n';
import type { BrainSavingsSummary } from '../../../lib/journal/brainSavings';

interface BrainSavingsCardProps {
  summary: BrainSavingsSummary | null;
}

function Tile({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div
      data-testid={testId}
      style={{
        flex: '1 1 140px',
        minWidth: 140,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        padding: '10px 12px',
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          color: 'var(--color-text-disabled)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}>{value}</div>
    </div>
  );
}

export function BrainSavingsCard({ summary }: BrainSavingsCardProps) {
  const { t } = useI18n();
  if (!summary || !summary.hasActivity) return null;

  return (
    <div
      data-testid="brain-savings-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        padding: 14,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>{t('report.brain.title')}</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Tile testId="brain-savings-recalls" label={t('report.brain.recalls')} value={summary.recallCount > 0 ? String(summary.recallCount) : '—'} />
        <Tile
          testId="brain-savings-cache"
          label={t('report.brain.cacheReused')}
          value={summary.cacheReadTokens > 0 ? summary.cacheReadTokens.toLocaleString() : '—'}
        />
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>{t('report.brain.hint')}</div>
    </div>
  );
}
