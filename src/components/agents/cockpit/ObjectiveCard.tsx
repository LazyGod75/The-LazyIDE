/* ObjectiveCard — one CAP objective card (design §6): 58px ring gauge,
   title/deadline, status line, and (when late) "Plan de rattrapage" /
   "Décaler" actions. */

import { useState } from 'react';
import { useI18n } from '../../../i18n';
import type { Objective } from '../../../lib/objectives/objectivesStore';
import { deriveObjectiveStatus, type ObjectiveStatus } from '../../../lib/objectives/objectivesStatus';

const STATUS_COLOR: Record<ObjectiveStatus, string> = {
  'on-track': 'var(--color-success)',
  late: 'var(--color-danger)',
  'no-deadline': '#5A5F6C',
};

const STATUS_BORDER: Record<ObjectiveStatus, string> = {
  'on-track': 'rgba(255,255,255,0.09)',
  late: 'rgba(248,113,113,0.5)',
  'no-deadline': 'rgba(255,255,255,0.09)',
};

function gaugeText(objective: Objective): string {
  if (objective.targetCount === null) return '∞';
  return `${Math.min(objective.currentCount, objective.targetCount)}/${objective.targetCount}`;
}

function formatDeadlineFr(deadlineMs: number | null, t: (key: string) => string): string {
  if (deadlineMs === null) return t('cockpit.cap.permanentRule');
  const days = Math.ceil((deadlineMs - Date.now()) / 86_400_000);
  if (days < 0) return t('cockpit.cap.overdue');
  if (days === 0) return t('cockpit.cap.today');
  if (days === 1) return t('cockpit.cap.tomorrow');
  return `${t('cockpit.cap.inDays')} ${days} j`;
}

interface ObjectiveCardProps {
  objective: Objective;
  onRequestRecoveryPlan: (objective: Objective) => void;
  onShift: (objective: Objective, newDeadlineMs: number) => void;
  onHover: (objectiveId: string | null) => void;
  /** B9: manual override of the auto-derived currentCount for a
   *  project-linked objective. Absent for unlinked objectives (nothing to
   *  override — currentCount is already fully manual there). */
  onOverrideCount?: (objective: Objective, newCount: number) => void;
  /** B9: clears manualOverride so auto-derivation resumes. */
  onResumeAuto?: (objective: Objective) => void;
}

export function ObjectiveCard({ objective, onRequestRecoveryPlan, onShift, onHover, onOverrideCount, onResumeAuto }: ObjectiveCardProps) {
  const { t } = useI18n();
  const [shifting, setShifting] = useState(false);
  const [shiftValue, setShiftValue] = useState('');
  const [overriding, setOverriding] = useState(false);
  const [overrideValue, setOverrideValue] = useState('');
  const isLinked = objective.projectId !== null;

  const status = deriveObjectiveStatus({
    createdAtMs: objective.createdAtMs,
    deadlineMs: objective.deadlineMs,
    targetCount: objective.targetCount,
    currentCount: objective.currentCount,
  });
  const ringColor = STATUS_COLOR[status];
  const showActions = status === 'late';

  const stateText =
    status === 'late'
      ? t('cockpit.cap.stateLate')
      : status === 'no-deadline'
        ? t('cockpit.cap.statePermanent')
        : t('cockpit.cap.stateOnTrack');

  return (
    <div
      data-testid={`objective-card-${objective.id}`}
      onMouseEnter={() => onHover(objective.id)}
      onMouseLeave={() => onHover(null)}
      style={{
        flex: 1,
        background: 'var(--color-panel-2)',
        border: `1px solid ${STATUS_BORDER[status]}`,
        borderRadius: 13,
        padding: '13px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div
          style={{
            width: 58,
            height: 58,
            borderRadius: '50%',
            border: `3.5px solid ${ringColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13.5,
            fontWeight: 700,
            color: ringColor,
            flexShrink: 0,
          }}
        >
          {gaugeText(objective)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 17,
              fontWeight: 700,
              color: 'var(--color-text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {objective.title}
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--color-text-muted)' }}>
            {formatDeadlineFr(objective.deadlineMs, t)}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.45, color: STATUS_COLOR[status] }}>
        {stateText}
      </div>

      {isLinked && (onOverrideCount || onResumeAuto) && !overriding && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--color-text-disabled)' }}>
          {objective.manualOverride ? (
            <>
              <span>{t('cockpit.cap.manualBadge')}</span>
              {onResumeAuto && (
                <button
                  data-testid={`objective-resume-auto-${objective.id}`}
                  onClick={() => onResumeAuto(objective)}
                  style={ghostLinkStyle}
                >
                  {t('cockpit.cap.resumeAuto')}
                </button>
              )}
            </>
          ) : (
            <>
              <span>{t('cockpit.cap.autoBadge')}</span>
              {onOverrideCount && (
                <button
                  data-testid={`objective-override-toggle-${objective.id}`}
                  onClick={() => {
                    setOverrideValue(String(objective.currentCount));
                    setOverriding(true);
                  }}
                  style={ghostLinkStyle}
                >
                  {t('cockpit.cap.correctCount')}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {overriding && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="number"
            min={0}
            value={overrideValue}
            onChange={(e) => setOverrideValue(e.target.value)}
            style={{
              width: 70,
              background: 'var(--color-input)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 6,
              padding: '5px 8px',
              color: 'var(--color-text)',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          />
          <button
            data-testid={`objective-override-confirm-${objective.id}`}
            onClick={() => {
              const n = Number(overrideValue);
              if (Number.isFinite(n) && n >= 0) onOverrideCount?.(objective, Math.round(n));
              setOverriding(false);
            }}
            style={{
              padding: '5px 12px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--color-accent)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('cockpit.cap.confirmShift')}
          </button>
        </div>
      )}

      {showActions && !shifting && (
        <div style={{ marginTop: 'auto', display: 'flex', gap: 7 }}>
          <button
            data-testid={`objective-recovery-${objective.id}`}
            onClick={() => onRequestRecoveryPlan(objective)}
            style={{
              flex: 1,
              background: '#F0EFF4',
              color: '#14141C',
              border: 'none',
              borderRadius: 8,
              padding: '7px 10px',
              fontSize: 13.5,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('cockpit.cap.recoveryPlan')}
          </button>
          <button
            onClick={() => setShifting(true)}
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'transparent',
              color: 'var(--color-text)',
              fontSize: 13.5,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('cockpit.cap.shift')}
          </button>
        </div>
      )}

      {shifting && (
        <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
          <input
            type="date"
            value={shiftValue}
            onChange={(e) => setShiftValue(e.target.value)}
            style={{
              flex: 1,
              background: 'var(--color-input)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 6,
              padding: '5px 8px',
              color: 'var(--color-text)',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={() => {
              const ms = shiftValue ? new Date(shiftValue).getTime() : NaN;
              if (Number.isFinite(ms)) onShift(objective, ms);
              setShifting(false);
              setShiftValue('');
            }}
            style={{
              padding: '5px 12px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--color-accent)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('cockpit.cap.confirmShift')}
          </button>
        </div>
      )}
    </div>
  );
}

const ghostLinkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--color-accent-pale)',
  fontSize: 11.5,
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: 0,
  textDecoration: 'underline',
};
