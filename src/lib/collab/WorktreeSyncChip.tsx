/* WorktreeSyncChip — "2 versions" chip when a remote teammate's worktree
   HEAD diverges from the local worktree HEAD on the same mission.

   P2-8: Sync worktree session. Shows a warning chip when the remote
   worktree branch has a different HEAD than the local one, indicating
   the two worktrees have diverged and a 3-way merge may be needed.
*/

import { useI18n } from '../../i18n/index.js';
import { useCollab } from './CollabContext.js';
import type { FleetMission } from '../agents/fleetMissions.js';

interface WorktreeSyncChipProps {
  mission: FleetMission;
}

export function WorktreeSyncChip({ mission }: WorktreeSyncChipProps) {
  const { t } = useI18n();
  const { remoteDeltasByMission } = useCollab();

  if (!mission.worktree) return null;

  // Look for a remote delta for this mission with a different worktreeHead
  const remoteDelta = remoteDeltasByMission.get(mission.id);
  if (!remoteDelta?.worktreeHead || !remoteDelta.worktreeBranch) return null;
  if (remoteDelta.worktreeBranch !== mission.worktree) return null;

  // Compare HEADs — if they differ, the two worktrees have diverged
  // (local HEAD isn't directly available on FleetMission, but the
  // presence of a remote HEAD different from what we last saw = divergence)
  const localHead = mission.worktreeHead;
  if (!localHead || localHead === remoteDelta.worktreeHead) return null;

  return (
    <div
      data-testid={`worktree-sync-chip-${mission.id}`}
      title={t('collab.worktree.diverged', { local: localHead.slice(0, 7), remote: remoteDelta.worktreeHead.slice(0, 7) })}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10,
        color: '#F87171',
        padding: '1px 6px',
        borderRadius: 4,
        background: 'rgba(248,113,113,0.1)',
        border: '1px solid rgba(248,113,113,0.3)',
        cursor: 'help',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#F87171' }} />
      {t('collab.worktree.twoVersions')}
    </div>
  );
}
