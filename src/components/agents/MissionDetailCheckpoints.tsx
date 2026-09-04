/* MissionDetailCheckpoints — lists this mission's saved checkpoints
   (managed-agent turn boundaries, graph/checkpointStore.ts) and lets the
   user fork a new graph run from any of them (graph/forkFromCheckpoint.ts,
   via the agents store's forkMissionFromCheckpoint).

   Self-contained like MissionDetailTranscript/MissionDetailIntervene — owns
   its own "should I render" check and section title, the parent just places
   it. Renders nothing when there are no checkpoints yet: a native
   (non-managed) mission, or one that hasn't reached a turn boundary, has
   none — this is not an error state (see checkpointStore.ts's own header).
*/

import { useState, useEffect, useCallback } from 'react';
import type { Mission } from '../../lib/agents/types';
import type { Checkpoint } from '../../lib/agents/graph/types';
import { listCheckpoints } from '../../lib/agents/graph/checkpointStore';
import { useAgentsStore } from './agentsStore';
import { useToast } from '../ui';
import { useI18n } from '../../i18n';

interface MissionDetailCheckpointsProps {
  mission: Mission;
}

export function MissionDetailCheckpoints({ mission }: MissionDetailCheckpointsProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const { forkMissionFromCheckpoint } = useAgentsStore();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [forkingId, setForkingId] = useState<string | null>(null);

  // Only listed for missions that recorded their own project root at
  // creation (every mission launched via addMission does — see
  // Mission.repoRoot's doc comment). Deliberately NOT falling back to
  // resolveProjectRoot()'s "currently active project" guess here: unlike
  // handleRunReview's fallback (a user-initiated action against whatever
  // project is open right now), an unattended mount-time checkpoint lookup
  // has no business resolving against a DIFFERENT project than the one
  // this mission actually ran in — an honest empty list beats a
  // possibly-wrong guess.
  useEffect(() => {
    if (!mission.repoRoot) {
      setCheckpoints([]);
      return;
    }
    let cancelled = false;
    void listCheckpoints(mission.repoRoot, mission.id).then((list) => {
      if (!cancelled) setCheckpoints(list);
    });
    return () => {
      cancelled = true;
    };
  }, [mission.id, mission.repoRoot]);

  const handleFork = useCallback(
    async (checkpointId: string) => {
      if (forkingId) return;
      setForkingId(checkpointId);
      try {
        const result = await forkMissionFromCheckpoint(mission.id, checkpointId);
        toast(t('agents.detail.checkpoints.forkedToast', { runId: result.newRunId }), 'success');
      } catch (err) {
        toast(t('agents.detail.checkpoints.forkError', { msg: String(err).slice(0, 80) }), 'error');
      } finally {
        setForkingId(null);
      }
    },
    [forkingId, forkMissionFromCheckpoint, mission.id, t, toast],
  );

  if (checkpoints.length === 0) return null;

  return (
    <div id="mission-checkpoints-section">
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.35)',
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          marginBottom: 10,
        }}
      >
        {t('agents.detail.sectionCheckpoints')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {checkpoints.map((cp) => (
          <div
            key={cp.id}
            data-testid={`checkpoint-row-${cp.id}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              padding: '7px 10px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ color: '#E2E2F0' }}>
                {cp.summary.label ?? `${t('agents.detail.checkpoints.turn')} ${cp.summary.turn}`}
              </span>
              <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>
                {new Date(cp.createdAt).toLocaleString(locale)}
              </span>
            </div>
            <button
              data-testid={`fork-checkpoint-btn-${cp.id}`}
              onClick={() => void handleFork(cp.id)}
              disabled={forkingId === cp.id}
              style={{
                flexShrink: 0,
                padding: '4px 12px',
                borderRadius: 6,
                border: '1px solid rgba(124,92,255,0.35)',
                background: forkingId === cp.id ? 'rgba(124,92,255,0.06)' : 'rgba(124,92,255,0.12)',
                color: '#C4B5FD',
                fontSize: 11.5,
                fontFamily: 'inherit',
                cursor: forkingId === cp.id ? 'not-allowed' : 'pointer',
              }}
            >
              {forkingId === cp.id ? t('agents.detail.checkpoints.forking') : t('agents.detail.checkpoints.forkCta')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
