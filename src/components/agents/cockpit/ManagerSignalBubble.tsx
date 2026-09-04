/* ManagerSignalBubble — renders ONE live manager-rail signal (question
   relay / proactive review-failed one-liner — see managerSignals.ts's
   module doc comment for why this needs no separate spam-guard: the list
   itself is already deduped/live) as a manager-chat-styled bubble with
   REAL action buttons wired straight to Cockpit.tsx's handlers (no
   decorative buttons — every click reaches interveneMission,
   recordMissionAnswer, approveMission, retryMission, or the mission
   drawer, exactly like the AGENTS zone's own urgent cards / AttentionInbox).
*/

import { useCallback, useState } from 'react';
import { useI18n } from '../../../i18n';
import type { FleetMission } from '../../../lib/agents/fleetMissions';
import type { ManagerSignal } from './managerSignals';
import { translateStatusReason } from '../../../lib/agents/statusReasonLabel';

interface ManagerSignalBubbleProps {
  signal: ManagerSignal;
  onAnswer: (mission: FleetMission, projectId: string, question: string, answer: string) => void;
  onAction: (mission: FleetMission, actionKey: string) => void;
}

export function ManagerSignalBubble({ signal, onAnswer, onAction }: ManagerSignalBubbleProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');

  const submit = useCallback(
    (answer: string) => {
      const trimmed = answer.trim();
      if (!trimmed || !signal.question) return;
      onAnswer(signal.mission, signal.projectId, signal.question, trimmed);
      setDraft('');
    },
    [onAnswer, signal],
  );

  // Surface-the-reason fix (real user report — bare "M27 (LazySite-internet)
  // a échoué." with no way to tell whether to retry, merge, or investigate;
  // same precedent as 4464446's merge-block reason surfacing): a 'failed'
  // signal now always shows the mission's own honest statusReason when one
  // is recorded, falling back to the old bare phrasing only when it truly
  // carries none (e.g. a legacy mission from before statusReason existed).
  const failedReason = translateStatusReason(signal.mission.statusReason, t)?.trim();
  const text =
    signal.kind === 'question'
      ? t('cockpit.signal.question', { mission: signal.mission.id, project: signal.projectName, question: signal.question ?? '' })
      : signal.kind === 'review'
        ? t('cockpit.signal.review', { mission: signal.mission.id, project: signal.projectName })
        : signal.kind === 'conflict'
          ? t('cockpit.signal.conflict', { mission: signal.mission.id, project: signal.projectName })
          : failedReason
            ? t('cockpit.signal.failedWithReason', { mission: signal.mission.id, project: signal.projectName, reason: failedReason })
            : t('cockpit.signal.failed', { mission: signal.mission.id, project: signal.projectName });

  return (
    <div
      data-testid={`manager-signal-${signal.id}`}
      style={{
        alignSelf: 'flex-start',
        maxWidth: '96%',
        background: 'var(--color-panel-2)',
        border: '1px solid rgba(251,185,36,0.35)',
        borderRadius: 11,
        borderTopLeftRadius: 4,
        padding: '10px 13px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <span style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
        <span style={{ color: 'var(--color-warning)' }}>⚠ </span>
        {text}
      </span>

      {signal.kind === 'question' && (
        <>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              data-testid={`signal-answer-input-${signal.mission.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(draft); }}
              placeholder={t('cockpit.signal.answerPlaceholder')}
              style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(124,92,255,0.3)', background: 'var(--color-input)', color: 'var(--color-text)', fontSize: 12, fontFamily: 'inherit' }}
            />
            <button
              data-testid={`signal-answer-submit-${signal.mission.id}`}
              onClick={() => submit(draft)}
              disabled={!draft.trim()}
              style={{ ...pillStyle('primary'), opacity: draft.trim() ? 1 : 0.5 }}
            >
              {t('cockpit.signal.answerSubmit')}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button data-testid={`signal-allow-${signal.mission.id}`} onClick={() => submit(t('cockpit.order.allowOnce'))} style={pillStyle('primary')}>
              {t('cockpit.signal.allow')}
            </button>
            <button data-testid={`signal-deny-${signal.mission.id}`} onClick={() => submit(t('cockpit.order.denyReplan'))} style={pillStyle('outline')}>
              {t('cockpit.signal.deny')}
            </button>
          </div>
        </>
      )}

      {signal.buttons.length > 0 && (
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {signal.buttons.map((button) => (
            <button
              key={button.key}
              data-testid={`signal-action-${button.key}-${signal.mission.id}`}
              onClick={() => onAction(signal.mission, button.key)}
              style={pillStyle(button.variant)}
            >
              {t(button.labelKey)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function pillStyle(variant: 'primary' | 'outline'): React.CSSProperties {
  return variant === 'primary'
    ? { background: 'var(--color-accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }
    : { background: 'transparent', color: 'var(--color-text)', border: '1px solid rgba(255,255,255,0.22)', borderRadius: 7, padding: '6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
}
