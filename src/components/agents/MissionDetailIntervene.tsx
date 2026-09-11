/* MissionDetailIntervene — live-steering input box for a running mission.
   Extracted from MissionDetail.tsx (file-size split).

   Honesty contract (per engine — see agentsStore.interveneMission):
     - Managed missions: the instruction is REALLY queued and delivered to
       the agent as a new user message at its next ReAct step
       (managedAgent.planAndActManaged drains the queue between steps).
     - Native missions (one-shot `claude -p`, see isLiveAgentAvailable's doc
       comment in runtime.ts): there is no mid-run injection point, so the
       UI must never claim the instruction was "sent" — it is recorded as
       queued for a future run instead.
*/

import { useState, useCallback, useRef } from 'react';
import type { Mission } from '../../lib/agents/types';
import { useAgentsStoreActions } from './agentsStore';
import { useI18n } from '../../i18n';
import { useToast } from '../ui';

interface MissionDetailInterveneProps {
  mission: Mission;
  /** Whether this mission's engine is the managed (Pro) loop — computed
   *  once in MissionDetail.tsx via isManagedAgentAvailable() and passed down
   *  so every consumer of the honesty distinction agrees on one answer. */
  isManagedEngine: boolean;
}

export function MissionDetailIntervene({ mission, isManagedEngine }: MissionDetailInterveneProps) {
  const { interveneMission } = useAgentsStoreActions();
  const { t } = useI18n();
  const { toast } = useToast();
  const [interventionText, setInterventionText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  const handleIntervene = useCallback(() => {
    const text = interventionText.trim();
    if (!text) return;
    interveneMission(mission.id, text);
    setInterventionText('');
    toast(
      isManagedEngine
        ? t('agents.detail.interventionQueuedManaged')
        : t('agents.detail.interventionQueuedNative'),
      'info',
    );
    setTimeout(() => containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  }, [interventionText, mission.id, interveneMission, isManagedEngine, toast, t]);

  if (mission.status !== 'running') return null;

  const disclaimer = isManagedEngine
    ? t('agents.detail.liveSteeringConnected')
    : t('agents.detail.liveSteeringUnavailable');

  const submitTitle = isManagedEngine
    ? t('agents.detail.sendAtNextStep')
    : t('agents.detail.queueForNextRun');

  return (
    <div ref={containerRef}>
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
        {t('agents.detail.sectionIntervene')}
      </div>
      <div
        data-testid="intervene-disclaimer"
        style={{ fontSize: 10, color: 'rgba(255,255,255,0.32)', marginBottom: 6, lineHeight: 1.4 }}
      >
        {disclaimer}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          background: '#16161D',
          border: '1px solid rgba(124,92,255,0.20)',
          borderRadius: 8,
          padding: '8px 10px',
        }}
      >
        <input
          value={interventionText}
          onChange={(e) => setInterventionText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleIntervene();
            }
          }}
          placeholder={t('agents.detail.interventionPlaceholder')}
          style={{
            flex: 1,
            background: 'none',
            border: 'none',
            outline: 'none',
            color: '#E2E2F0',
            fontSize: 13,
            fontFamily: 'inherit',
            caretColor: '#7C5CFF',
          }}
        />
        <button
          data-testid="intervene-submit-btn"
          onClick={handleIntervene}
          disabled={!interventionText.trim()}
          title={submitTitle}
          style={{
            width: 30,
            height: 30,
            borderRadius: 6,
            border: 'none',
            background: interventionText.trim() ? '#7C5CFF' : 'rgba(124,92,255,0.25)',
            color: '#fff',
            fontSize: 16,
            cursor: interventionText.trim() ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            transition: 'background 0.15s',
          }}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
