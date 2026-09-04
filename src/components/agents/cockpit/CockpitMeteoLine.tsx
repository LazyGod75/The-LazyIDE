/* CockpitMeteoLine — compact "météo" greeting + per-project status pills
   (P1-3 full-bleed redesign: the wide top Bandeau bar is gone — see
   Cockpit.tsx's header comment). Rendered inside the far-left rail's KPIs
   popover, above KpiGroup's tiles, so Bandeau's non-KPI data still has a
   home instead of being silently dropped. Reuses Bandeau.tsx's own
   `firstName`/`PILL_COLOR` (exported for exactly this reuse) rather than
   duplicating that logic — this is a narrower, vertical-friendly re-layout
   of the SAME data for a 340px popover, not a re-derivation. */

import { useAuth } from '../../../lib/auth';
import { colorForProject } from '../../../lib/projectColors';
import { useI18n } from '../../../i18n';
import type { ProjectPill } from './cockpitHelpers';
import { firstName, PILL_COLOR } from './Bandeau';

export interface CockpitMeteoLineProps {
  pills: ProjectPill[];
  pendingDecisions: number;
}

export function CockpitMeteoLine({ pills, pendingDecisions }: CockpitMeteoLineProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const name = firstName(user);

  const meteoText =
    pendingDecisions === 0
      ? t('cockpit.meteo.clear')
      : pendingDecisions === 1
        ? t('cockpit.meteo.pendingOne', { count: pendingDecisions })
        : t('cockpit.meteo.pendingMany', { count: pendingDecisions });

  return (
    <div data-testid="cockpit-meteo-line" style={{ display: 'flex', flexDirection: 'column', gap: 9, padding: '12px 14px 6px' }}>
      <span style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.4, color: 'var(--color-text)', fontFamily: 'var(--font-ui)' }}>
        {name ? t('cockpit.meteo.greetingNamed', { name }) : t('cockpit.meteo.greeting')}
        {' '}
        <span style={{ color: 'var(--color-warning)', fontWeight: 600 }}>{meteoText}</span>
      </span>

      {pills.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {pills.map((pill) => (
            <span
              key={pill.projectId}
              title={pill.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '3px 9px',
                borderRadius: 20,
                border: `1px solid ${PILL_COLOR[pill.state]}55`,
                fontSize: 10.5,
                color: 'var(--color-text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: pill.state === 'idle' ? colorForProject(pill.projectId) : PILL_COLOR[pill.state],
                  opacity: pill.state === 'idle' ? 0.4 : 1,
                  animation: pill.state === 'urgent' ? 'pulseRed 2s infinite' : 'none',
                }}
              />
              {pill.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
