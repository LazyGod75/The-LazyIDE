/**
 * FleetCommandBar — quick-action toolbar for fleet-wide operations (T2.8).
 *
 * Shows compact buttons for common fleet actions:
 * - Stop all running missions
 * - Retry all failed missions
 * - Approve all in review
 * - New mission
 *
 * Designed to sit above the mission views in the cockpit.
 */

import { useI18n } from '../../i18n';
import type { Mission } from '../../lib/agents/types';

interface FleetCommandBarProps {
  missions: Mission[];
  onStopAll: () => void;
  onRetryFailed: () => void;
  onApproveAll: () => void;
  onNewMission: () => void;
}

export function FleetCommandBar({ missions, onStopAll, onRetryFailed, onApproveAll, onNewMission }: FleetCommandBarProps) {
  const { t } = useI18n();

  const runningCount = missions.filter((m) => m.status === 'running').length;
  const failedCount = missions.filter((m) => m.status === 'failed').length;
  const reviewCount = missions.filter((m) => m.status === 'review').length;

  return (
    <div
      data-testid="fleet-command-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        background: '#0E0E12',
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.30)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginRight: 4,
        }}
      >
        {t('agents.commandBar.title')}
      </span>

      <CommandButton
        label={t('agents.commandBar.stopAll')}
        count={runningCount}
        color="#F87171"
        onClick={onStopAll}
        disabled={runningCount === 0}
      />
      <CommandButton
        label={t('agents.commandBar.retryFailed')}
        count={failedCount}
        color="#FB923C"
        onClick={onRetryFailed}
        disabled={failedCount === 0}
      />
      <CommandButton
        label={t('agents.commandBar.approveAll')}
        count={reviewCount}
        color="#4ADE80"
        onClick={onApproveAll}
        disabled={reviewCount === 0}
      />

      <div style={{ flex: 1 }} />

      <button
        onClick={onNewMission}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 12px',
          borderRadius: 6,
          border: '1px solid rgba(124,92,255,0.4)',
          background: 'rgba(124,92,255,0.12)',
          color: '#C4B5FD',
          fontSize: 11,
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        + {t('agents.commandBar.newMission')}
      </button>
    </div>
  );
}

function CommandButton({
  label,
  count,
  color,
  onClick,
  disabled,
}: {
  label: string;
  count: number;
  color: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      data-testid={`fleet-cmd-${label.toLowerCase().replace(/\s/g, '-')}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '4px 10px',
        borderRadius: 5,
        border: `1px solid ${disabled ? 'rgba(255,255,255,0.04)' : `${color}33`}`,
        background: disabled ? 'transparent' : `${color}0D`,
        color: disabled ? 'rgba(255,255,255,0.15)' : color,
        fontSize: 11,
        fontWeight: 500,
        fontFamily: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
      {count > 0 && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            background: `${color}22`,
            fontSize: 9,
            fontWeight: 700,
            padding: '0 4px',
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}
