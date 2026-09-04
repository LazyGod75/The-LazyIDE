/* SharedPlanPanel — renders a remote mission's plan steps with owner
   badges + claim buttons. Mounted inside MissionDetail for remote missions.

   P2-3: Plan partagé + claim steps.
*/

import { useCollab } from './CollabContext.js';
import { useI18n } from '../../i18n/index.js';
import type { FleetMission } from '../agents/fleetMissions.js';

interface SharedPlanPanelProps {
  mission: FleetMission;
}

export function SharedPlanPanel({ mission }: SharedPlanPanelProps) {
  const { t } = useI18n();
  const { self, broadcastSessionEvent, remoteSessionEvents, projectId } = useCollab();

  if (!mission.planSteps || mission.planSteps.length === 0) return null;

  const sessionKey = (stepLabel: string) => `${mission.id}:claim-step:${stepLabel}`;
  const claimedBy = (stepLabel: string): string | undefined => {
    const event = remoteSessionEvents.get(sessionKey(stepLabel));
    return event?.targetUserId;
  };

  const handleClaim = (stepLabel: string) => {
    if (!self || !projectId) return;
    broadcastSessionEvent({
      projectId,
      missionId: mission.id,
      kind: 'claim-step',
      stepLabel,
      targetUserId: self.userId,
      targetName: self.name,
    });
  };

  return (
    <div data-testid={`shared-plan-${mission.id}`} style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: 'var(--color-text-secondary)' }}>
        {t('collab.sharedPlan.title')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {mission.planSteps.map((step, i) => {
          const claimerId = claimedBy(step.label) ?? step.meta;
          const isMine = self && claimerId === self.userId;
          const stateColor = step.state === 'done' ? '#22c55e' : step.state === 'in_progress' ? '#eab308' : '#6b7280';
          return (
            <div
              key={`${step.label}-${i}`}
              data-testid={`plan-step-${mission.id}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 8px',
                borderRadius: 6,
                background: 'rgba(255,255,255,0.04)',
                fontSize: 12,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: stateColor, flexShrink: 0 }} />
              <span style={{ flex: 1, textDecoration: step.state === 'done' ? 'line-through' : 'none', opacity: step.state === 'done' ? 0.6 : 1 }}>
                {step.label}
              </span>
              {claimerId && (
                <span
                  data-testid={`step-owner-${mission.id}-${i}`}
                  style={{ fontSize: 10, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}
                >
                  {isMine ? t('collab.sharedPlan.you') : claimerId.slice(0, 6)}
                </span>
              )}
              {!claimerId && step.state !== 'done' && self && (
                <button
                  type="button"
                  data-testid={`claim-step-${mission.id}-${i}`}
                  onClick={() => handleClaim(step.label)}
                  style={{
                    fontSize: 10,
                    padding: '2px 8px',
                    borderRadius: 4,
                    border: '1px solid var(--color-border)',
                    background: 'transparent',
                    color: 'var(--color-text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {t('collab.sharedPlan.claim')}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
