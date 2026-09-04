/* ManagerAutonomyBar — compact autonomy-mode control embedded in the
   right-side LazyManager overlay (design spec: "compose + messages + model +
   COMPACT autonomy control", replacing AutonomySelector's old home in the
   left rail's KPIs popover — friction F5). Deliberately its own tiny
   component rather than reusing AutonomySelector.tsx verbatim: that
   component renders with Tailwind utility classes (bg-slate-200/
   text-slate-900/...) which don't match this app's CSS-variable-driven
   dark/glass design system (every other cockpit surface — LazyManagerRail,
   CockpitLeftRail, KpiGroup — is styled with inline styles + var(--color-*)
   tokens), so reusing it verbatim here would look visually inconsistent
   with the glass overlay it now sits in. Same AutonomyMode type/onChange
   contract as AutonomySelector, so this was a pure UI swap, not a data-model
   change — AutonomySelector.tsx has since been wired up as ManagerOverlay's
   footer strip and removed (2026-08-11), its role fully taken over here. */

import { useI18n } from '../../../i18n';
import type { AutonomyMode } from '../../../lib/agents/types';

export interface ManagerAutonomyBarProps {
  value: AutonomyMode;
  onChange: (mode: AutonomyMode) => void;
}

const MODES: AutonomyMode[] = ['manual', 'supervised', 'yolo', 'custom'];

const MODE_LABEL_KEY: Record<AutonomyMode, string> = {
  manual: 'cockpit.manager.autonomy.manual',
  supervised: 'cockpit.manager.autonomy.supervised',
  yolo: 'cockpit.manager.autonomy.yolo',
  custom: 'cockpit.manager.autonomy.custom',
};

const MODE_TOOLTIP_KEY: Record<AutonomyMode, string> = {
  manual: 'lazyManager.autonomy.tooltip.manual',
  supervised: 'lazyManager.autonomy.tooltip.supervised',
  yolo: 'lazyManager.autonomy.tooltip.lazy',
  custom: 'lazyManager.autonomy.tooltip.custom',
};

export function ManagerAutonomyBar({ value, onChange }: ManagerAutonomyBarProps) {
  const { t } = useI18n();
  return (
    <div data-testid="manager-autonomy-bar" style={{ display: 'flex', gap: 4, padding: '0 16px 10px', flexWrap: 'wrap' }}>
      {MODES.map((mode) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            data-testid={`manager-autonomy-${mode}`}
            onClick={() => onChange(mode)}
            aria-pressed={active}
            title={t(MODE_TOOLTIP_KEY[mode])}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              padding: '3px 8px',
              borderRadius: 6,
              border: active ? '1px solid var(--color-accent-border)' : '1px solid var(--color-border-2)',
              background: active ? 'rgba(124,92,255,0.14)' : 'transparent',
              color: active ? 'var(--color-accent-pale)' : 'var(--color-text-disabled)',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {t(MODE_LABEL_KEY[mode])}
          </button>
        );
      })}
    </div>
  );
}
