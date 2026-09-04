/* MissionDetailControls — mission lifecycle action rows (Stop/Pause/Resume,
   Approve/Reject, Retry/Delete, loop toggles) for MissionDetail.
   Extracted from MissionDetail.tsx (file-size split).

   Pause/Resume honesty (see agentsStore.pauseMission/resumeMission and
   runtime.ts's isLiveAgentAvailable doc comment):
     - Managed missions: Pause/Resume flip the pauseFlag between ReAct steps.
     - Native missions: Pause/Resume use stop-then-resume (`--resume`).
*/

import { useCallback, useState, type CSSProperties } from 'react';
import type { Mission } from '../../lib/agents/types';
import { useAgentsStore, resolveProjectRoot, type RevertableMission } from './agentsStore';
import { ApproveBlockedError, isJudgeRejected } from './approveGate';
import { useToast } from '../ui';
import { useI18n } from '../../i18n';
import { isLiveAgentAvailable } from '../../lib/agents/runtime';
import { canNativePause } from '../../lib/agents/nativePause';

interface MissionDetailControlsProps {
  mission: Mission;
  onBack: () => void;
  onSaveAsAgent: () => void;
  /** Whether this mission's engine is the managed (Pro) loop — see
   *  MissionDetail's single isManagedAgentAvailable() call site. */
  isManagedEngine: boolean;
}

export function MissionDetailControls({ mission, onBack, onSaveAsAgent, isManagedEngine }: MissionDetailControlsProps) {
  const {
    stopMission,
    pauseMission,
    resumeMission,
    takeoverMission,
    returnFromTakeover,
    approveMission,
    discardMission,
    revertMission,
    toggleLoop,
    deleteLoop,
    retryMission,
    deleteMission,
  } = useAgentsStore();
  const { toast } = useToast();
  const { t, locale } = useI18n();

  const [reviewing, setReviewing] = useState(false);
  /** Set when an approve attempt is blocked — drives the force-merge affordance. */
  const [blockedError, setBlockedError] = useState<ApproveBlockedError | null>(null);
  /** T1.7 — "Annuler la mission" in-flight state (mirrors `reviewing` above). */
  const [reverting, setReverting] = useState(false);

  // T1.7 — additive fields not yet on Mission (see RevertableMission's doc
  // comment in agentsStore.tsx). Read-only narrowing cast: safe because a
  // plain Mission structurally satisfies RevertableMission too (both
  // extra fields are optional).
  const revertInfo = mission as RevertableMission;
  const nativePauseOk = !isManagedEngine && isLiveAgentAvailable() && canNativePause(mission);

  const handleStop = useCallback(() => {
    stopMission(mission.id);
    onBack();
  }, [mission.id, stopMission, onBack]);

  // Pause/Resume intentionally do NOT call onBack() — the user stays on this
  // view so Resume remains one click away (unlike Stop, this is not terminal).
  const handlePause = useCallback(() => {
    pauseMission(mission.id);
  }, [mission.id, pauseMission]);

  const handleResume = useCallback(() => {
    resumeMission(mission.id);
  }, [mission.id, resumeMission]);

  const handleApprove = useCallback(async () => {
    setBlockedError(null);
    setReviewing(true);
    try {
      // Real opened-project root — NOT '.' (the Tauri process cwd). See
      // resolveProjectRoot's doc comment in agentsStore.tsx for the bug this
      // fixes: '.' made Rust's ensure_repo_in_project_root reject the merge
      // as "outside project root", and the store used to swallow that error
      // and lie about success anyway (see approveMission's honesty fix).
      const repoPath = await resolveProjectRoot();
      await approveMission(mission.id, repoPath);
      setReviewing(false);
      onBack();
    } catch (err) {
      setReviewing(false);
      if (err instanceof ApproveBlockedError) {
        setBlockedError(err);
      } else {
        toast(`${t('common.error')}: ${String(err)}`, 'error');
      }
    }
  }, [mission.id, approveMission, onBack, toast, t]);

  const handleForceApprove = useCallback(async () => {
    setBlockedError(null);
    setReviewing(true);
    try {
      const repoPath = await resolveProjectRoot();
      await approveMission(mission.id, repoPath, { force: true });
      setReviewing(false);
      onBack();
    } catch (err) {
      setReviewing(false);
      toast(`${t('common.error')}: ${String(err)}`, 'error');
    }
  }, [mission.id, approveMission, onBack, toast, t]);

  const handleDiscard = useCallback(async () => {
    setReviewing(true);
    try {
      const repoPath = await resolveProjectRoot();
      await discardMission(mission.id, repoPath);
      setReviewing(false);
      onBack();
    } catch (err) {
      // Honesty fix: discardMission can now throw for real (Tauri, discard
      // failed) instead of always silently succeeding — surface it and keep
      // the mission in its current status rather than pretending it was
      // rejected/removed.
      setReviewing(false);
      toast(`${t('common.error')}: ${String(err)}`, 'error');
    }
  }, [mission.id, discardMission, onBack, toast, t]);

  /**
   * T1.7 — "Annuler la mission" (revert). Confirm-on-click, same pattern as
   * AgentLibrary's deleteConfirm (window.confirm gated by an i18n string).
   * Any failure (including revertMission's own plain Error for a merged
   * mission with no recorded mergeSha) surfaces as a toast, same as
   * handleDiscard above — no crash, no silent no-op.
   * Resilient to window.confirm() failures: catches and logs, then cancels.
   */
  const handleRevert = useCallback(async () => {
    try {
      if (!window.confirm(t('agents.detail.revertConfirm', { title: mission.title }))) return;
    } catch (confirmErr) {
      // If window.confirm throws (permission/platform), log and cancel.
      console.warn('[MissionDetailControls] window.confirm failed:', confirmErr);
      return;
    }
    setReverting(true);
    try {
      const repoPath = await resolveProjectRoot();
      await revertMission(mission.id, repoPath);
      setReverting(false);
      onBack();
    } catch (err) {
      setReverting(false);
      toast(`${t('common.error')}: ${String(err)}`, 'error');
    }
  }, [mission.id, mission.title, revertMission, onBack, toast, t]);

  /**
   * Retry-with-edit friction fix — human-facing counterpart to the manager's
   * own retry_mission "modifications.task" lever (managerEngine.ts): lets a
   * bad/ambiguous instruction be corrected from the mission card itself
   * instead of forcing a "Cloner" detour. Uses window.prompt, pre-filled with
   * the CURRENT task text — same cheap-affordance convention this codebase
   * already uses for quick single-string input (see CodeSidebarProjects.tsx's
   * handleNewFile/handleNewFolder). Cancelling (null) or leaving the text
   * unchanged/blank is a no-op — retryMission itself is only asked to amend
   * the task when the trimmed result genuinely differs.
   */
  const handleRetryWithEdit = useCallback(() => {
    const currentTask = mission.agentTask ?? mission.title;
    let edited: string | null;
    try {
      edited = window.prompt(t('agents.retry.editPrompt'), currentTask);
    } catch (promptErr) {
      console.warn('[MissionDetailControls] window.prompt failed:', promptErr);
      return;
    }
    if (edited === null) return; // cancelled
    const trimmed = edited.trim();
    if (!trimmed) return;
    void retryMission(mission.id, trimmed === currentTask ? undefined : { newTask: trimmed });
    onBack();
  }, [mission.id, mission.agentTask, mission.title, retryMission, onBack, t]);

  const retryEditButtonStyle: CSSProperties = {
    padding: '7px 18px',
    borderRadius: 6,
    border: '1px solid rgba(251,185,36,0.25)',
    background: 'rgba(251,185,36,0.04)',
    color: '#FBB924',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontWeight: 500,
  };

  return (
    <>
      {/* Loop controls */}
      {mission.loopConfig && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 14px',
            background: 'rgba(124,92,255,0.06)',
            border: '1px solid rgba(124,92,255,0.15)',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 12, color: '#a78bfa', fontWeight: 600 }}>
            {t('agents.detail.loopConfiguration')}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
            {t('agents.detail.cadence')}: <span style={{ color: '#E2E2F0' }}>{mission.loopConfig.cadence}</span>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
            {t('agents.detail.iterations')}: <span style={{ color: '#E2E2F0' }}>{mission.loopConfig.iterationCount}</span>
          </div>
          {mission.loopConfig.nextRunAt && mission.loopConfig.enabled && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
              {t('agents.detail.next')}: <span style={{ color: '#E2E2F0' }}>{new Date(mission.loopConfig.nextRunAt).toLocaleString(locale)}</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button
              onClick={() => void toggleLoop(mission.id, !mission.loopConfig!.enabled)}
              style={{
                padding: '4px 12px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 5,
                border: '1px solid rgba(124,92,255,0.25)',
                background: mission.loopConfig.enabled ? 'rgba(239,68,68,0.10)' : 'rgba(34,197,94,0.10)',
                color: mission.loopConfig.enabled ? '#F87171' : '#4ADE80',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {mission.loopConfig.enabled ? t('agents.detail.pause') : t('agents.detail.resume')}
            </button>
            <button
              onClick={() => { void deleteLoop(mission.id); onBack(); }}
              style={{
                padding: '4px 12px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 5,
                border: '1px solid rgba(239,68,68,0.20)',
                background: 'rgba(239,68,68,0.06)',
                color: '#F87171',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {t('agents.detail.deleteLoop')}
            </button>
          </div>
        </div>
      )}

      {/* Running action buttons */}
      {mission.status === 'running' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            onClick={handleStop}
            style={{
              padding: '5px 14px',
              borderRadius: 6,
              border: '1px solid rgba(248,113,113,0.35)',
              background: 'rgba(248,113,113,0.10)',
              color: '#F87171',
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
          >
            {t('agents.detail.stop')}
          </button>
          {mission.paused ? (
            <button
              data-testid="resume-btn"
              onClick={handleResume}
              style={{
                padding: '5px 14px',
                borderRadius: 6,
                border: '1px solid rgba(74,222,128,0.35)',
                background: 'rgba(74,222,128,0.10)',
                color: '#4ADE80',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {t('agents.detail.resume')}
            </button>
          ) : (isManagedEngine || nativePauseOk) ? (
            <button
              data-testid="pause-btn"
              onClick={handlePause}
              style={{
                padding: '5px 14px',
                borderRadius: 6,
                border: '1px solid rgba(124,92,255,0.35)',
                background: 'rgba(124,92,255,0.10)',
                color: '#C4B5FD',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {t('agents.detail.pause')}
            </button>
          ) : (
            // Scripted/web engine — no real pause hook.
            <button
              data-testid="pause-btn"
              disabled
              title={t('agents.detail.pauseUnavailableTitle')}
              style={{
                padding: '5px 14px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.02)',
                color: 'rgba(255,255,255,0.28)',
                fontSize: 12,
                cursor: 'not-allowed',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {t('agents.detail.pause')}
            </button>
          )}
          {mission.takenOver ? (
            <button
              data-testid="handback-btn"
              onClick={() => void returnFromTakeover(mission.id)}
              style={{
                padding: '5px 14px',
                borderRadius: 6,
                border: '1px solid rgba(74,222,128,0.35)',
                background: 'rgba(74,222,128,0.10)',
                color: '#4ADE80',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {t('agents.detail.handBack')}
            </button>
          ) : (
            <button
              data-testid="takeover-btn"
              onClick={() => void takeoverMission(mission.id)}
              style={{
                padding: '5px 14px',
                borderRadius: 6,
                border: '1px solid rgba(251,185,36,0.35)',
                background: 'rgba(251,185,36,0.10)',
                color: '#FBB924',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {t('agents.detail.takeover')}
            </button>
          )}
        </div>
      )}
      {mission.status === 'review' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            data-testid="approve-btn"
            onClick={handleApprove}
            disabled={reviewing}
            style={{
              padding: '7px 18px',
              borderRadius: 6,
              border: '1px solid rgba(74,222,128,0.35)',
              background: reviewing ? 'rgba(74,222,128,0.05)' : 'rgba(74,222,128,0.12)',
              color: '#4ADE80',
              fontSize: 13,
              cursor: reviewing ? 'default' : 'pointer',
              fontFamily: 'inherit',
              fontWeight: 600,
            }}
          >
            {reviewing ? t('agents.detail.merging') : t('agents.detail.approveAndMerge')}
          </button>
          {blockedError !== null && (
            <button
              data-testid="force-approve-btn"
              onClick={handleForceApprove}
              disabled={reviewing}
              title={t('agents.detail.forceMergeTitle')}
              style={{
                padding: '7px 18px',
                borderRadius: 6,
                border: '1px solid rgba(251,185,36,0.35)',
                background: reviewing ? 'rgba(251,185,36,0.05)' : 'rgba(251,185,36,0.10)',
                color: '#FBB924',
                fontSize: 12,
                cursor: reviewing ? 'default' : 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {t('agents.detail.forceApprove')}
            </button>
          )}
          <button
            data-testid="discard-btn"
            onClick={handleDiscard}
            disabled={reviewing}
            style={{
              padding: '7px 18px',
              borderRadius: 6,
              border: '1px solid rgba(248,113,113,0.25)',
              background: 'rgba(248,113,113,0.07)',
              color: '#F87171',
              fontSize: 13,
              cursor: reviewing ? 'default' : 'pointer',
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
          >
            {t('agents.detail.reject')}
          </button>
          <button
            data-testid="save-as-agent-btn"
            onClick={onSaveAsAgent}
            style={{
              padding: '7px 18px',
              borderRadius: 6,
              border: '1px solid rgba(124,92,255,0.35)',
              background: 'rgba(124,92,255,0.08)',
              color: '#C4B5FD',
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
          >
            {t('agents.detail.saveAsAgent')}
          </button>
          {/* QA B15: a rejected judge verdict leaves the mission in 'review'
              (never 'failed' — see approveGate.ts's isJudgeRejected doc
              comment), so Retry used to be unreachable here: force-merge or
              discard were the only two options for a mission the judge
              actually rejected. */}
          {isJudgeRejected(mission) && (
            <button
              data-testid="review-retry-btn"
              onClick={() => { retryMission(mission.id); onBack(); }}
              style={{
                padding: '7px 18px',
                borderRadius: 6,
                border: '1px solid rgba(251,185,36,0.25)',
                background: 'rgba(251,185,36,0.08)',
                color: '#FBB924',
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {t('agents.detail.retry')}
            </button>
          )}
          {isJudgeRejected(mission) && (
            <button
              data-testid="review-retry-edit-btn"
              onClick={handleRetryWithEdit}
              style={retryEditButtonStyle}
            >
              {t('agents.detail.retryEdit')}
            </button>
          )}
        </div>
      )}

      {/* Block reason — shown when an approve attempt was blocked */}
      {blockedError !== null && mission.status === 'review' && (
        <div
          data-testid="approve-blocked-reason"
          style={{
            marginTop: 8,
            padding: '7px 12px',
            borderRadius: 6,
            background: 'rgba(251,185,36,0.08)',
            border: '1px solid rgba(251,185,36,0.22)',
            color: '#FBB924',
            fontSize: 12,
          }}
        >
          {blockedError.reason}
        </div>
      )}

      {/* Done state — "Save as Agent" + retry/delete/revert still available */}
      {mission.status === 'done' && (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              data-testid="save-as-agent-btn"
              onClick={onSaveAsAgent}
              style={{
                padding: '7px 18px',
                borderRadius: 6,
                border: '1px solid rgba(124,92,255,0.35)',
                background: 'rgba(124,92,255,0.08)',
                color: '#C4B5FD',
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {t('agents.detail.saveAsAgent')}
            </button>
            <button
              onClick={() => { retryMission(mission.id); onBack(); }}
              style={{
                padding: '7px 18px',
                borderRadius: 6,
                border: '1px solid rgba(251,185,36,0.25)',
                background: 'rgba(251,185,36,0.08)',
                color: '#FBB924',
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {t('agents.detail.retry')}
            </button>
            <button
              data-testid="retry-edit-btn"
              onClick={handleRetryWithEdit}
              style={retryEditButtonStyle}
            >
              {t('agents.detail.retryEdit')}
            </button>
            <button
              onClick={() => { deleteMission(mission.id); onBack(); }}
              style={{
                padding: '7px 18px',
                borderRadius: 6,
                border: '1px solid rgba(248,113,113,0.20)',
                background: 'rgba(248,113,113,0.06)',
                color: '#F87171',
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {t('agents.detail.delete')}
            </button>
            {/* T1.7 — always visible on Done missions (spec §8), unless
                already reverted (nothing left to revert twice). */}
            {!revertInfo.reverted && (
              <button
                data-testid="revert-btn"
                onClick={() => void handleRevert()}
                disabled={reverting}
                style={{
                  padding: '7px 18px',
                  borderRadius: 6,
                  border: '1px solid rgba(248,113,113,0.25)',
                  background: reverting ? 'rgba(248,113,113,0.04)' : 'rgba(248,113,113,0.07)',
                  color: '#F87171',
                  fontSize: 13,
                  cursor: reverting ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                }}
              >
                {reverting ? t('agents.detail.reverting') : t('agents.detail.revert')}
              </button>
            )}
          </div>
          {revertInfo.reverted && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>
                {t('agents.detail.revertedMsg')}
              </span>
            </div>
          )}
        </>
      )}

      {/* Failed/cancelled state — retry + delete (+ revert for a 'failed'
          mission that still has a live worktree — spec §8's unmerged
          revert path; 'review' already has an equivalent action: Reject) */}
      {(mission.status === 'failed' || mission.status === 'cancelled') && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button
            onClick={() => { retryMission(mission.id); onBack(); }}
            style={{
              padding: '7px 18px',
              borderRadius: 6,
              border: '1px solid rgba(251,185,36,0.25)',
              background: 'rgba(251,185,36,0.08)',
              color: '#FBB924',
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
          >
            {t('agents.detail.retry')}
          </button>
          <button
            data-testid="retry-edit-btn"
            onClick={handleRetryWithEdit}
            style={retryEditButtonStyle}
          >
            {t('agents.detail.retryEdit')}
          </button>
          <button
            onClick={() => { deleteMission(mission.id); onBack(); }}
            style={{
              padding: '7px 18px',
              borderRadius: 6,
              border: '1px solid rgba(248,113,113,0.20)',
              background: 'rgba(248,113,113,0.06)',
              color: '#F87171',
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
          >
            {t('agents.detail.delete')}
          </button>
          {mission.status === 'failed' && Boolean(mission.worktree) && (
            <button
              data-testid="revert-btn"
              onClick={() => void handleRevert()}
              disabled={reverting}
              style={{
                padding: '7px 18px',
                borderRadius: 6,
                border: '1px solid rgba(248,113,113,0.25)',
                background: reverting ? 'rgba(248,113,113,0.04)' : 'rgba(248,113,113,0.07)',
                color: '#F87171',
                fontSize: 13,
                cursor: reverting ? 'default' : 'pointer',
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              {reverting ? t('agents.detail.reverting') : t('agents.detail.revert')}
            </button>
          )}
        </div>
      )}

      {/* Failed state — show error info */}
      {mission.status === 'failed' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: '#F87171' }}>
            {t('agents.detail.failedMsg')}
          </span>
        </div>
      )}

      {/* Cancelled state */}
      {mission.status === 'cancelled' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>
            {t('agents.detail.cancelledMsg')}
          </span>
        </div>
      )}
    </>
  );
}
