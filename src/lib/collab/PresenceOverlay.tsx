/* PresenceOverlay — multiplayer presence mount for the Agent Canvas.

   Consumes CollabContext (ONE channel). Renders:
     - colored avatar chips (click = jump to teammate camera / focused node)
     - a halo around any canvas node a teammate has focused
*/

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCollab } from './CollabContext.js';
import { emit } from '../bus.js';
import { useI18n } from '../../i18n/index.js';

const HALO_POLL_MS = 400;

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

interface HaloRect {
  userId: string;
  color: string;
  name: string;
  rect: DOMRect;
}

function locateHaloRects(
  users: Array<{ userId: string; name: string; color: string; focusedRef?: string }>,
): HaloRect[] {
  const rects: HaloRect[] = [];
  for (const user of users) {
    if (!user.focusedRef) continue;
    const el =
      document.querySelector(`[data-testid="mission-node-${user.focusedRef}"]`) ??
      document.querySelector(`[data-id="${user.focusedRef}"]`);
    if (!el) continue;
    rects.push({ userId: user.userId, color: user.color, name: user.name, rect: el.getBoundingClientRect() });
  }
  return rects;
}

function jumpToTeammate(focusedRef?: string, viewportCenter?: { x: number; y: number }): void {
  if (focusedRef) {
    emit('canvas:focus', { ref: focusedRef });
    return;
  }
  if (viewportCenter) {
    emit('canvas:followViewport', viewportCenter);
  }
}

export function PresenceOverlay() {
  const { t } = useI18n();
  const { active, remoteUsers } = useCollab();
  const [haloRects, setHaloRects] = useState<HaloRect[]>([]);

  const focusedCount = remoteUsers.filter((u) => u.focusedRef).length;

  useEffect(() => {
    if (!active || focusedCount === 0) {
      setHaloRects([]);
      return;
    }
    const update = () => setHaloRects(locateHaloRects(remoteUsers));
    update();
    const intervalId = setInterval(update, HALO_POLL_MS);
    return () => clearInterval(intervalId);
  }, [active, focusedCount, remoteUsers]);

  if (!active || remoteUsers.length === 0) return null;

  return (
    <>
      <div
        data-testid="presence-overlay-chips"
        title={t('presence.toolbarTitle')}
        style={{
          position: 'fixed',
          top: 12,
          right: 16,
          zIndex: 40,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {remoteUsers.map((user) => (
          <button
            type="button"
            key={user.userId}
            data-testid={`presence-chip-${user.userId}`}
            title={user.focusedRef ? t('presence.focusedMission', { name: user.name, title: user.focusedRef }) : t('presence.viewingProject', { name: user.name })}
            onClick={() => jumpToTeammate(user.focusedRef, user.viewportCenter)}
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: user.color,
              color: '#0d0d14',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10.5,
              fontWeight: 700,
              border: '2px solid rgba(13,13,20,0.85)',
              marginLeft: -6,
              boxShadow: '0 0 0 1px rgba(255,255,255,0.15)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {initials(user.name)}
          </button>
        ))}
      </div>

      {haloRects.length > 0 &&
        createPortal(
          <>
            {haloRects.map((h) => (
              <div
                key={h.userId}
                data-testid={`presence-halo-${h.userId}`}
                style={{
                  position: 'fixed',
                  left: h.rect.left - 4,
                  top: h.rect.top - 4,
                  width: h.rect.width + 8,
                  height: h.rect.height + 8,
                  borderRadius: 10,
                  border: `2px solid ${h.color}`,
                  boxShadow: `0 0 12px ${h.color}`,
                  pointerEvents: 'none',
                  zIndex: 30,
                }}
              />
            ))}
          </>,
          document.body,
        )}
    </>
  );
}
