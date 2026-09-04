/* SessionMembers — renders the members of a shared mission session
   as avatar chips, showing who is owner / collaborator / spectator.

   P2-4: Lanes multi-owner. When a mission has sessionMembers, each
   member gets a colored chip with their role. The owner has a crown
   indicator. Spectators have a dimmed chip.
*/

import { useI18n } from '../../i18n/index.js';
import { colorForUserId } from './useFleetPresence.js';
import type { FleetMission } from '../agents/fleetMissions.js';

interface SessionMembersProps {
  mission: FleetMission;
  maxAvatars?: number;
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

export function SessionMembers({ mission, maxAvatars = 5 }: SessionMembersProps) {
  const { t } = useI18n();

  if (!mission.sessionMembers || mission.sessionMembers.length === 0) return null;

  const members = mission.sessionMembers.slice(0, maxAvatars);
  const overflow = mission.sessionMembers.length - members.length;

  return (
    <div
      data-testid={`session-members-${mission.id}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
    >
      {members.map((member) => {
        const color = colorForUserId(member.userId);
        const isOwner = member.role === 'owner';
        const isSpectator = member.role === 'spectator';
        return (
          <div
            key={member.userId}
            data-testid={`session-member-${mission.id}-${member.userId}`}
            title={t(`collab.session.role.${member.role}`, { name: member.name })}
            style={{
              position: 'relative',
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: color,
              opacity: isSpectator ? 0.5 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 8,
              fontWeight: 700,
              color: '#0d0d14',
              border: isOwner ? '2px solid #eab308' : '1px solid rgba(0,0,0,0.3)',
            }}
          >
            {initials(member.name)}
            {isOwner && (
              <span
                style={{
                  position: 'absolute',
                  top: -6,
                  fontSize: 8,
                  color: '#eab308',
                }}
              >
                *
              </span>
            )}
          </div>
        );
      })}
      {overflow > 0 && (
        <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>+{overflow}</span>
      )}
    </div>
  );
}
