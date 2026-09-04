/* FleetMap.tsx — Multi-project fleet overview (Pillar E1).

   Duplicate-heading fix (real user report, 2026-08-14): this component used
   to render its OWN "Fleet Map" heading, directly under CockpitRailPopover's
   (CockpitRailPopover.tsx) uppercased title bar — the popover's ONLY caller
   is CockpitLeftRail.tsx's 'fleetMap' icon, which already passes title=
   "Fleet Map" (t('cockpit.rail.fleetMap')), so every open of this popover
   showed "FLEET MAP" immediately followed by a second "Fleet Map" row. No
   heading here at all now — the popover chrome IS the heading.

   Tokens: same CSS-variable surface as PlanApprovalPanel / BudgetBurn —
   no leftover Tailwind `bg-slate-800` utilities.
*/

import type { CSSProperties } from 'react';
import type { Mission } from '../../../lib/agents/types';
import { useI18n } from '../../../i18n';
import { pluralKey } from '../../../i18n/plural';

export interface FleetProject {
  id: string;
  name: string;
  missions: Mission[];
}

export interface FleetMapProps {
  projects: FleetProject[];
  onSelectProject?: (projectId: string) => void;
}

const wrap: CSSProperties = { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 };
const empty: CSSProperties = { margin: 0, fontSize: 12, color: 'var(--color-text-muted)' };
const row: CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: 12,
  borderRadius: 10,
  background: 'var(--color-panel-2)',
  border: '1px solid var(--color-border)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  color: 'inherit',
};
const nameStyle: CSSProperties = { fontSize: 13, fontWeight: 650, color: 'var(--color-text)' };
const metaStyle: CSSProperties = { fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 };

export function FleetMap({ projects, onSelectProject }: FleetMapProps) {
  const { t, locale } = useI18n();
  return (
    <div data-testid="fleet-map" style={wrap}>
      {projects.length === 0 && (
        <p data-testid="fleet-map-empty" style={empty}>{t('cockpit.fleetMap.noProjects')}</p>
      )}
      {projects.map((p) => {
        const total = p.missions.length;
        const running = p.missions.filter((m) => m.status === 'running').length;
        const blocked = p.missions.filter((m) => m.status === 'failed' || m.status === 'review').length;
        return (
          <button
            key={p.id}
            type="button"
            data-testid="fleet-map-project"
            onClick={() => onSelectProject?.(p.id)}
            style={row}
          >
            <div style={nameStyle}>{p.name}</div>
            <div style={metaStyle}>
              {t(pluralKey('cockpit.fleetMap.missions', total, locale), { count: total })}
              {' · '}
              {t(pluralKey('cockpit.fleetMap.running', running, locale), { count: running })}
              {' · '}
              {t(pluralKey('cockpit.fleetMap.blocked', blocked, locale), { count: blocked })}
            </div>
          </button>
        );
      })}
    </div>
  );
}
