/* MissionManagerAdvice — D13 graft (a): "Avis du manager" card inside
   MissionDetail. Shown only for a failed mission or a running mission with
   a real pending ask_user question (shouldOfferManagerAdvice). On demand,
   runs a REAL grounded managerEngine.runManagerTurn call (same direct-call
   pattern as the cockpit's AnalysisDesk.tsx, D7) — it never touches
   LazyManager's own chat state (managerMessages/managerBusy stay untouched).

   Applying the recommendation reuses existing store primitives only:
     - running/paused mission -> interveneMission(id, recommendation)
     - failed mission -> updateMission(agentTask += recommendation) then
       retryMission(id) (retryMission's clone copies agentTask verbatim —
       see agentsStore.tsx — so patching it first is how the retried run
       actually carries the guidance forward; no new store method needed).
*/

import { useState } from 'react';
import type { Mission } from '../../lib/agents/types';
import { runManagerTurn } from '../../lib/agents/managerEngine';
import {
  shouldOfferManagerAdvice,
  buildManagerAdvicePrompt,
  extractAlternatePlan,
  buildRetryTaskWithRecommendation,
} from '../../lib/agents/managerAdvice';
import { useAgentsStore } from './agentsStore';
import { isJudgeRejected } from './approveGate';
import { useToast } from '../ui';
import { useI18n } from '../../i18n';

interface MissionManagerAdviceProps {
  mission: Mission;
}

type AdviceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; responseText: string; plan: string; applied: boolean };

export function MissionManagerAdvice({ mission }: MissionManagerAdviceProps) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const { managerModel, interveneMission, updateMission, retryMission } = useAgentsStore();
  const [state, setState] = useState<AdviceState>({ status: 'idle' });

  if (!shouldOfferManagerAdvice(mission)) return null;

  async function handleAsk() {
    setState({ status: 'loading' });
    try {
      const prompt = buildManagerAdvicePrompt(mission);
      const turn = await runManagerTurn({
        messages: [{ id: 'mission-advice', role: 'user', content: prompt, timestamp: new Date().toISOString() }],
        // Same bug shape flagged elsewhere in ManagerContext.locale's doc
        // comment (managerEngine.ts): this is a real runManagerTurn call
        // site that used to omit `locale` entirely, silently falling back
        // to whatever the LANGUAGE rule defaults to with no signal at all.
        // `prompt` here is a programmatic (non-user) advice request, so
        // `locale` is this turn's ONLY language signal — must be threaded
        // through.
        context: { agents: [], missions: [mission], locale },
        model: managerModel,
      });
      setState({
        status: 'done',
        responseText: turn.responseText,
        plan: extractAlternatePlan(turn.responseText),
        applied: false,
      });
    } catch (err) {
      setState({ status: 'error', message: String(err) });
    }
  }

  function handleApply() {
    if (state.status !== 'done') return;
    // QA B15: a judge-rejected 'review' mission behaves like 'failed' here
    // too — it isn't running, so interveneMission (live-steering) has
    // nothing to steer; retryMission (with the recommendation folded into
    // agentTask) is the same real action that already applied to a genuine
    // 'failed' mission.
    if (mission.status === 'failed' || isJudgeRejected(mission)) {
      updateMission({ id: mission.id, patch: { agentTask: buildRetryTaskWithRecommendation(mission, state.plan) } });
      retryMission(mission.id);
    } else {
      interveneMission(mission.id, state.plan);
    }
    setState({ ...state, applied: true });
    toast(t('agents.detail.managerAdviceApplied'), 'success');
  }

  return (
    <div
      data-testid="mission-manager-advice"
      style={{
        background: 'rgba(124,92,255,0.07)',
        border: '1px solid rgba(124,92,255,0.3)',
        borderRadius: 10,
        padding: '11px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginBottom: 14,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-accent-pale)' }}>
        {t('agents.detail.managerAdviceTitle')}
      </div>

      {state.status === 'idle' && (
        <button
          data-testid="manager-advice-ask-btn"
          onClick={() => void handleAsk()}
          style={{
            alignSelf: 'flex-start',
            background: 'var(--color-accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 7,
            padding: '6px 13px',
            fontSize: 12.5,
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {t('agents.detail.managerAdviceAsk')}
        </button>
      )}

      {state.status === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--color-accent-pale)' }}>
          <span
            style={{
              width: 13,
              height: 13,
              border: '2px solid var(--color-accent)',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          {t('agents.detail.managerAdviceLoading')}
        </div>
      )}

      {state.status === 'error' && (
        <div style={{ fontSize: 12.5, color: 'var(--color-danger-text)' }}>
          {t('agents.detail.managerAdviceError', { msg: state.message.slice(0, 160) })}
        </div>
      )}

      {state.status === 'done' && (
        <>
          <div style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' }}>
            {state.responseText}
          </div>
          <button
            data-testid="manager-advice-apply-btn"
            onClick={handleApply}
            disabled={state.applied}
            style={{
              alignSelf: 'flex-start',
              background: state.applied ? 'rgba(124,92,255,0.15)' : 'var(--color-accent)',
              color: state.applied ? 'var(--color-accent-pale)' : '#fff',
              border: 'none',
              borderRadius: 7,
              padding: '6px 13px',
              fontSize: 12.5,
              fontWeight: 700,
              cursor: state.applied ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {state.applied ? t('agents.detail.managerAdviceApplied') : t('agents.detail.managerAdviceApply')}
          </button>
        </>
      )}
    </div>
  );
}
