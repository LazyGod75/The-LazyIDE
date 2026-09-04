/* ReportKpiStrip.tsx — the Rapport page's top KPI row: missions completed,
   merged today, total cost, total tokens, cumulative duration. Real numbers
   only — an absent/zero-derivable metric shows '—', never a fabricated 0.
*/

import { useI18n } from '../../../i18n';
import type { ProjectReportTotals } from '../../../lib/journal/projectReport';
import { usdToCredits } from '../../../lib/billing/credits';

interface ReportKpiStripProps {
  missionCount: number;
  mergedTodayCount: number;
  totals: ProjectReportTotals;
  /**
   * Brain visibility (brain-integration wave) — count of NEW neurons
   * (brain.captured + brain.decision_created, see zoneDigest.ts's
   * brainNeuronsToday) the project's brain learned today. Undefined/0 hides
   * the tile entirely rather than showing a fabricated/uninteresting zero —
   * this KPI only earns a slot in the strip when there is real brain
   * activity to report.
   */
  brainNeuronsToday?: number;
}

function Kpi({
  label,
  value,
  'data-testid': testId,
  tooltip,
}: {
  label: string;
  value: string;
  'data-testid'?: string;
  /** fix/canvas-ux R9 MAJEUR — see KpiGroup.tsx's own KpiTile `tooltip` doc
   *  comment: makes this KPI's real scope explicit (per-project here, vs
   *  the cockpit Bandeau's fleet-wide equivalent tile). */
  tooltip?: string;
}) {
  return (
    <div
      data-testid={testId}
      title={tooltip}
      style={{
        flex: '1 1 120px',
        minWidth: 120,
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

export function ReportKpiStrip({ missionCount, mergedTodayCount, totals, brainNeuronsToday }: ReportKpiStripProps) {
  const { t } = useI18n();
  const totalTokens = totals.tokensIn + totals.tokensOut;
  // Fix D (2026-08-19 dollar-kill incident, display half) — `totals.costUsd`
  // mixes real managed/BYOK spend with native-rail API-equivalent figures
  // (ProjectReportTotals's own doc comment); rendering it as one plain
  // "cost" figure would be exactly the misleading aggregate the incident
  // review flagged. Split into two honestly-labeled tiles instead — real
  // credits spent, and a separately-badged API-equivalent tile (the
  // MissionReportCard.tsx "API equivalent" badge is the precedent) — never
  // just hidden.
  const managedCredits = usdToCredits(totals.costUsdManaged);
  const equivalentCredits = usdToCredits(totals.costUsdApiEquivalent);

  return (
    <div data-testid="report-kpi-strip" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <Kpi label={t('report.kpi.missionsCompleted')} value={String(missionCount)} />
      <Kpi label={t('report.kpi.mergedToday')} value={String(mergedTodayCount)} tooltip={t('report.kpi.mergedTodayScope')} />
      <Kpi
        label={t('report.kpi.totalCost')}
        value={managedCredits > 0 ? `${managedCredits.toLocaleString()} ${t('canvas.node.creditsUnit')}` : '—'}
        tooltip={t('report.kpi.totalCostScope')}
      />
      {equivalentCredits > 0 && (
        <Kpi
          data-testid="report-kpi-cost-api-equivalent"
          label={t('report.kpi.totalCostApiEquivalent')}
          value={`${equivalentCredits.toLocaleString()} ${t('canvas.node.creditsUnit')}`}
          tooltip={t('report.mission.apiEquivalentTitle')}
        />
      )}
      <Kpi label={t('report.kpi.totalTokens')} value={totalTokens > 0 ? totalTokens.toLocaleString() : '—'} />
      <Kpi label={t('report.kpi.totalDuration')} value={totals.durationMs > 0 ? t('report.kpi.durationMinutes', { count: String(Math.round(totals.durationMs / 60000)) }) : '—'} />
      {/* Brain visibility (brain-integration wave) — only rendered when the
          project's brain actually learned something today (real, honest
          data from zoneDigest.ts's brainNeuronsToday); never a fabricated
          "0" tile. */}
      {brainNeuronsToday !== undefined && brainNeuronsToday > 0 && (
        <Kpi data-testid="report-kpi-brain-neurons" label={t('report.kpi.brainNeurons')} value={String(brainNeuronsToday)} />
      )}
    </div>
  );
}
