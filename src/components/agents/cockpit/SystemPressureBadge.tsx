/* SystemPressureBadge.tsx — FOUNDER NORTH STAR: "the app adapts the pace
   automatically, and it TELLS you — never a silent throttle". A small,
   sober pill (same chip footprint/palette as CostChip.tsx) shown only while
   systemPressure.ts reports anything other than 'normal', with a tooltip
   carrying the real available-RAM/CPU numbers when the backend supplied
   them. Mounted from FluxFooter.tsx — see that file's own doc comment for
   why THIS is the chosen mount point (not CanvasView.tsx/ManagerOverlay.tsx).
*/

import { useEffect, useState } from 'react';
import { useI18n } from '../../../i18n';
import { getSystemPressure, subscribeSystemPressure, type SystemPressureSnapshot } from '../../../lib/agents/systemPressure';

export function SystemPressureBadge() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<SystemPressureSnapshot>(getSystemPressure);

  useEffect(() => subscribeSystemPressure(setSnapshot), []);

  if (snapshot.level === 'normal') return null;

  const tooltipParts: string[] = [];
  if (typeof snapshot.availableMemoryMb === 'number') {
    tooltipParts.push(t('pressure.tooltipRam', { mb: Math.round(snapshot.availableMemoryMb) }));
  }
  if (typeof snapshot.cpuPercent === 'number') {
    tooltipParts.push(t('pressure.tooltipCpu', { pct: Math.round(snapshot.cpuPercent) }));
  }
  const tooltip = tooltipParts.length > 0 ? tooltipParts.join(' · ') : t('pressure.tooltipFallback');

  return (
    <span
      data-testid="system-pressure-badge"
      data-pressure-level={snapshot.level}
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontFamily: 'var(--font-ui)',
        fontSize: 10.5,
        fontWeight: 600,
        color: 'var(--color-warning-text)',
        background: 'rgba(251,185,36,0.14)',
        border: '1px solid rgba(251,185,36,0.32)',
        borderRadius: 999,
        padding: '2px 9px',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }}
      />
      {t('pressure.label')}
    </span>
  );
}
