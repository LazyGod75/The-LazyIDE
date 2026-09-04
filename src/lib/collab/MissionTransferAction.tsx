/* MissionTransferAction — "Transfer to teammate" button for mission handoff.

   P2-5: Handoff humain↔humain. Renders a dropdown of online teammates
   (from presence). Clicking one broadcasts a MissionTransfer event.
   The receiving teammate sees a notification toast + the mission
   appears in their fleet as owned by them.
*/

import { useState, useRef, useEffect } from 'react';
import { useCollab } from './CollabContext.js';
import { useI18n } from '../../i18n/index.js';
import { emit } from '../bus.js';

interface MissionTransferActionProps {
  missionId: string;
  missionTitle: string;
  disabled?: boolean;
}

export function MissionTransferAction({ missionId, missionTitle, disabled }: MissionTransferActionProps) {
  const { t } = useI18n();
  const { active, remoteUsers, projectId, broadcastMissionTransfer, self } = useCollab();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!active || remoteUsers.length === 0) return null;

  const handleTransfer = (userId: string, name: string) => {
    if (!projectId || !self) return;
    broadcastMissionTransfer({
      projectId,
      missionId,
      toUserId: userId,
      toName: name,
      reason: t('collab.transfer.reason', { title: missionTitle }),
    });
    emit('toast:info', { message: t('collab.transfer.sent', { name }) });
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        data-testid={`transfer-mission-${missionId}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          fontSize: 11,
          padding: '3px 10px',
          borderRadius: 5,
          border: '1px solid var(--color-border)',
          background: 'transparent',
          color: 'var(--color-text-secondary)',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {t('collab.transfer.button')}
      </button>
      {open && (
        <div
          data-testid={`transfer-dropdown-${missionId}`}
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 160,
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 50,
            padding: 4,
          }}
        >
          {remoteUsers.map((user) => (
            <button
              type="button"
              key={user.userId}
              data-testid={`transfer-target-${user.userId}`}
              onClick={() => handleTransfer(user.userId, user.name)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '6px 8px',
                borderRadius: 5,
                border: 'none',
                background: 'transparent',
                color: 'var(--color-text)',
                cursor: 'pointer',
                fontSize: 12,
                textAlign: 'left',
              }}
            >
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: user.color, flexShrink: 0 }} />
              {user.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
