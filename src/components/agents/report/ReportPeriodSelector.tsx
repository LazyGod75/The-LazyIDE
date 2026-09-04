/* ReportPeriodSelector.tsx — "Aujourd'hui / 7 jours / Tout" pill selector
   driving ProjectReportPage's mission-list filter (reportPeriod.ts). */

import { useI18n } from '../../../i18n';
import { REPORT_PERIODS, type ReportPeriod } from './reportPeriod';

interface ReportPeriodSelectorProps {
  value: ReportPeriod;
  onChange: (period: ReportPeriod) => void;
}

const LABEL_KEY: Record<ReportPeriod, string> = {
  today: 'report.period.today',
  week: 'report.period.week',
  all: 'report.period.all',
};

export function ReportPeriodSelector({ value, onChange }: ReportPeriodSelectorProps) {
  const { t } = useI18n();
  return (
    <div
      data-testid="report-period-selector"
      style={{
        display: 'flex',
        gap: 4,
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        padding: 2,
      }}
    >
      {REPORT_PERIODS.map((p) => (
        <button
          key={p}
          data-testid={`report-period-${p}`}
          onClick={() => onChange(p)}
          style={{
            padding: '4px 12px',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            fontSize: 11.5,
            fontWeight: 600,
            fontFamily: 'inherit',
            background: value === p ? 'var(--color-accent)' : 'transparent',
            color: value === p ? '#fff' : 'var(--color-text-muted)',
          }}
        >
          {t(LABEL_KEY[p])}
        </button>
      ))}
    </div>
  );
}
