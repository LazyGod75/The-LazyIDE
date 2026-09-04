/* ProjectSwitcherPill.tsx — one project pill in the multi-project Rapport
   switcher row. Calls useProjectReport ITSELF (rather than the parent
   fetching a report per open project) so each pill's mergedTodayCount badge
   loads independently without a parent needing to call the hook in a loop.
*/

import { useI18n } from '../../../i18n';
import { useProjectReport } from '../../../lib/journal/useMissionHistory';
import { projectColor } from '../canvas/canvasTypes';

interface ProjectSwitcherPillProps {
  projectId: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}

export function ProjectSwitcherPill({ projectId, label, active, onSelect }: ProjectSwitcherPillProps) {
  const { t } = useI18n();
  const { report } = useProjectReport(projectId);
  const badgeCount = report?.mergedTodayCount ?? 0;
  const color = projectColor(projectId);

  return (
    <button
      data-testid={`report-project-pill-${projectId}`}
      onClick={onSelect}
      title={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 999,
        border: `1px solid ${active ? color : 'var(--color-border)'}`,
        background: active ? 'var(--color-panel-3)' : 'var(--color-panel-2)',
        color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
        fontSize: 11.5,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {badgeCount > 0 && (
        <span
          data-testid={`report-project-pill-badge-${projectId}`}
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            padding: '1px 6px',
            borderRadius: 999,
            background: 'rgba(34,197,94,0.15)',
            color: 'var(--color-success)',
          }}
        >
          {t('report.projectSwitcher.mergedBadge', { count: String(badgeCount) })}
        </span>
      )}
    </button>
  );
}
