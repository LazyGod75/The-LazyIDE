/* SponsorBadge — shows who is paying for a mission + approximate cost.

   P2-7: Sponsor visible. Rendered on mission cards / nodes so the team
   can see who sponsors each agent turn and how much it has cost so far.
*/

import { useI18n } from '../../i18n/index.js';
import type { FleetMission } from '../agents/fleetMissions.js';

interface SponsorBadgeProps {
  mission: FleetMission;
}

function formatCost(cents: number): string {
  if (cents < 100) return `${cents}c`;
  return `$${(cents / 100).toFixed(2)}`;
}

export function SponsorBadge({ mission }: SponsorBadgeProps) {
  const { t } = useI18n();

  if (!mission.sponsorUserId && mission.costCents === undefined) return null;

  const sponsorLabel = mission.sponsorName ?? mission.sponsorUserId?.slice(0, 6) ?? t('collab.sponsor.unknown');
  const isByok = !mission.sponsorUserId;

  return (
    <div
      data-testid={`sponsor-badge-${mission.id}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10,
        color: 'var(--color-text-secondary)',
        padding: '1px 6px',
        borderRadius: 4,
        background: 'rgba(255,255,255,0.05)',
      }}
    >
      <span title={isByok ? t('collab.sponsor.byok') : t('collab.sponsor.paidBy', { name: sponsorLabel })}>
        {isByok ? 'BYOK' : sponsorLabel}
      </span>
      {mission.costCents !== undefined && mission.costCents > 0 && (
        <span style={{ fontWeight: 600 }}>{formatCost(mission.costCents)}</span>
      )}
    </div>
  );
}
