/* RegimeStatusCard — continuous visibility of a recurring/permanent
   regime's lifecycle state (SPEC-CHARTE-DE-MISSION.md §4): trial (with
   its approved-count / threshold), validated, autonomous, or
   self-improving (LoopConfig.regimeState's 4th value — the regime also
   adjusting its own choices from the named measure). Lets the user
   revert to trial or stop the regime in one click, at any state — both
   are always available, not gated on the current state, since the user
   must "garder la main a tout moment".

   Same visual family as GraphProposalCard.tsx / PendingApprovalCard.tsx
   (this folder): bordered card, plain-language labels, real buttons.

   Rendered in a persistent strip above the thread
   (LazyManagerMessageList's `activeRegimes` prop, derived from each
   mission's real `loopConfig` — see missionCharter.ts's
   `regimeStatusFromMission`) so the state stays visible "en continu",
   independent of any single conversation turn. */

import { useI18n } from '../../i18n';
import type { RegimeState, RegimeStatus } from './missionCharter';

export interface RegimeStatusCardProps {
  regime: RegimeStatus;
  onRevertToTrial: (id: string) => void;
  onStop: (id: string) => void;
  /** NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — true while a
   *  revert-to-trial / stop click has been queued (manager busy at click
   *  time) but not yet actually sent. This card has no resolved/pending
   *  concept of its own (revert/stop are "always available" — see this
   *  file's own module header), so the fix is just: never silently drop the
   *  click, and show why the button is momentarily disabled. Optional,
   *  defaulting to false so every pre-existing caller/test keeps behaving
   *  exactly as before. */
  isRevertQueued?: boolean;
  isStopQueued?: boolean;
}

const STATE_COLOR: Record<RegimeState, string> = {
  trial: 'var(--color-warning)',
  validated: 'var(--color-accent-pale)',
  autonomous: 'var(--color-success, #22c55e)',
  self_improving: 'var(--color-success, #22c55e)',
};

function stateLabel(regime: RegimeStatus, t: (key: string, params?: Record<string, string | number>) => string): string {
  switch (regime.state) {
    case 'trial':
      return t('lazyManager.regime.state.trial', { approved: regime.trialApproved, threshold: regime.trialThreshold });
    case 'validated':
      return t('lazyManager.regime.state.validated');
    case 'autonomous':
      return t('lazyManager.regime.state.autonomous');
    case 'self_improving':
      return t('lazyManager.regime.state.selfImproving');
  }
}

const smallButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 11,
  fontWeight: 700,
  borderRadius: 7,
  cursor: 'pointer',
  fontFamily: 'inherit',
  border: '1px solid var(--color-border-2)',
  background: 'transparent',
  color: 'var(--color-text-muted)',
};

export function RegimeStatusCard({ regime, onRevertToTrial, onStop, isRevertQueued = false, isStopQueued = false }: RegimeStatusCardProps) {
  const { t } = useI18n();
  return (
    <div
      data-testid={`regime-status-${regime.id}`}
      style={{
        marginTop: 8,
        borderRadius: 9,
        border: '1px solid var(--color-border-2)',
        background: 'rgba(124,92,255,0.04)',
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
          {regime.label}
        </span>
        <span
          data-testid={`regime-state-${regime.id}`}
          style={{ fontSize: 10.5, fontWeight: 600, color: STATE_COLOR[regime.state], textTransform: 'uppercase', letterSpacing: '0.04em' }}
        >
          {stateLabel(regime, t)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
        {regime.state !== 'trial' && (
          <button
            type="button"
            data-testid={`regime-revert-${regime.id}`}
            disabled={isRevertQueued}
            onClick={() => onRevertToTrial(regime.id)}
            style={{ ...smallButtonStyle, opacity: isRevertQueued ? 0.5 : 1, cursor: isRevertQueued ? 'default' : 'pointer' }}
          >
            {t('lazyManager.regime.revert')}
          </button>
        )}
        <button
          type="button"
          data-testid={`regime-stop-${regime.id}`}
          disabled={isStopQueued}
          onClick={() => onStop(regime.id)}
          style={{ ...smallButtonStyle, opacity: isStopQueued ? 0.5 : 1, cursor: isStopQueued ? 'default' : 'pointer' }}
        >
          {t('lazyManager.regime.stop')}
        </button>
        {(isRevertQueued || isStopQueued) && (
          <span data-testid={`regime-queued-${regime.id}`} style={{ fontSize: 10, color: 'var(--color-warning)' }}>
            {t('lazyManager.actionQueued')}
          </span>
        )}
      </div>
    </div>
  );
}
