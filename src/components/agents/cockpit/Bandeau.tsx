/* Bandeau — météo phrase + per-project status pills + KPI row (design §5,
   plus the README-only per-project pills feature D1 asks to build). */

import { useAuth } from '../../../lib/auth';
import { colorForProject } from '../../../lib/projectColors';
import { useI18n } from '../../../i18n';
import type { ProjectPill } from './cockpitHelpers';
import { KpiGroup } from './KpiGroup';
import type { FleetProject } from '../../../lib/agents/fleetMissions';

/** Exported for CockpitMeteoLine.tsx (P1-3 full-bleed redesign): the
 *  greeting logic moved into the far-left rail's KPIs popover alongside
 *  KpiGroup — reused here rather than duplicated. */
export function firstName(user: ReturnType<typeof useAuth>['user']): string | null {
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const raw = (typeof meta.full_name === 'string' && meta.full_name) || (typeof meta.name === 'string' && meta.name) || null;
  if (!raw) return null;
  const first = raw.trim().split(/\s+/)[0];
  return first || null;
}

/** Exported for CockpitMeteoLine.tsx — same reuse rationale as `firstName`
 *  above. */
export const PILL_COLOR: Record<ProjectPill['state'], string> = {
  urgent: 'var(--color-danger)',
  active: 'var(--color-success)',
  idle: 'var(--color-text-disabled)',
};

interface BandeauProps {
  projects: FleetProject[];
  pills: ProjectPill[];
  pendingDecisions: number;
  /** QA B16 — see KpiGroupProps' doc comment; threaded straight through,
   *  Bandeau owns no decision about what they do. */
  onDecisionsKpiClick?: () => void;
  onAgentsKpiClick?: () => void;
  onMergedKpiClick?: () => void;
  onBrainKpiClick?: () => void;
}

export function Bandeau({
  projects,
  pills,
  pendingDecisions,
  onDecisionsKpiClick,
  onAgentsKpiClick,
  onMergedKpiClick,
  onBrainKpiClick,
}: BandeauProps) {
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
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        background: 'var(--color-panel)',
        borderBottom: '1px solid var(--color-border)',
        padding: '14px 28px',
        flexShrink: 0,
        flexWrap: 'wrap',
        rowGap: 10,
      }}
    >
      <span style={{ fontSize: 34, fontWeight: 700, lineHeight: 1.2, color: 'var(--color-text)', fontFamily: 'var(--font-ui)' }}>
        {name ? t('cockpit.meteo.greetingNamed', { name }) : t('cockpit.meteo.greeting')}
        {' '}
        <span style={{ color: 'var(--color-warning)' }}>{meteoText}</span>
      </span>

      {pills.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                fontSize: 11,
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
              {pill.state === 'idle' && <span style={{ color: 'var(--color-text-disabled)' }}>zzz</span>}
            </span>
          ))}
        </div>
      )}

      <KpiGroup
        projects={projects}
        pendingDecisions={pendingDecisions}
        onDecisionsClick={onDecisionsKpiClick}
        onAgentsClick={onAgentsKpiClick}
        onMergedClick={onMergedKpiClick}
        onBrainClick={onBrainKpiClick}
      />
    </div>
  );
}
