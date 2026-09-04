/* ContextualBanner — the editor's per-file agent-state banner
   (design-code.md §4.6, D9). Derived purely from real fleet mission data
   (lib/agents/codeBanner.ts) — every action button below is wired to a
   real store primitive, never a visual no-op:
     - run:      pauseMission (real — managed-mode only, guarded by the
                 store itself for native engines) + a local "follow" scroll.
                 A paused mission (Mission.paused, mirrored onto
                 FleetMission — B18) keeps status === 'running', so the
                 banner stays mounted and swaps to a "paused" text + a
                 resumeMission button instead of disappearing — pausing
                 used to call onDismiss(), which hid the banner for good
                 and left no way back to the mission short of the Cockpit.
     - question: interveneMission + recordMissionAnswer (the same real
                 answer flow AttentionInbox.tsx's question items use) —
                 "Autoriser 1×" delivers an affirmative answer, "Refuser +
                 replan" delivers a refusal, both are real messages queued
                 into the running mission.
     - failed:   retryMission (real) + a real navigation to the mission in
                 the Cockpit (no fake "Logs" no-op).
     - review:   follow-cursor + open in Cockpit (the file is under review,
                 not being written — pause/resume would be a lie).
     - locked:   no actions (matches design — a locked file has none).
*/

import { useCallback, useState } from 'react';
import { useI18n } from '../../../i18n';
import type { CodeBanner } from '../../../lib/agents/codeBanner';
import { fileActivityWhoLine } from '../../../lib/agents/codeFileActivity';
import { translateStatusReason } from '../../../lib/agents/statusReasonLabel';
import { useAgentsStoreOptional, resolveProjectRoot } from '../../agents/agentsStore';
import { recordMissionAnswer } from '../../../lib/agents/missionQuestion';
import { projectIdFromRoot } from '../../../lib/journal/projectId';
import { emit } from '../../../lib/bus';
import { useToast } from '../../ui';

interface BannerStyle {
  dotColor: string;
  dotAnim: string;
  background: string;
  border: string;
  textColor: string;
}

const STYLES: Record<Exclude<CodeBanner['kind'], 'none'>, BannerStyle> = {
  run: { dotColor: 'var(--color-success)', dotAnim: 'blinkDot 1.4s infinite', background: 'rgba(74,222,128,0.06)', border: 'rgba(74,222,128,0.25)', textColor: 'var(--color-success-text)' },
  question: { dotColor: 'var(--color-warning)', dotAnim: 'blinkDot 1s infinite', background: 'rgba(251,185,36,0.08)', border: 'rgba(251,185,36,0.35)', textColor: 'var(--color-warning-text)' },
  failed: { dotColor: 'var(--color-danger)', dotAnim: 'none', background: 'rgba(248,113,113,0.07)', border: 'rgba(248,113,113,0.35)', textColor: 'var(--color-danger-text)' },
  review: { dotColor: 'var(--color-warning)', dotAnim: 'blinkDot 1.2s infinite', background: 'rgba(251,185,36,0.06)', border: 'rgba(251,185,36,0.28)', textColor: 'var(--color-warning-text)' },
  locked: { dotColor: 'var(--color-text-muted)', dotAnim: 'none', background: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.12)', textColor: 'var(--color-text-muted)' },
};

function ActionButton({ label, primary, onClick }: { label: string; primary?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px',
        borderRadius: 8,
        fontSize: 12.5,
        fontWeight: 700,
        fontFamily: 'inherit',
        cursor: 'pointer',
        background: primary ? '#F0EFF4' : 'transparent',
        color: primary ? '#14141C' : 'var(--color-text)',
        border: primary ? '1px solid transparent' : '1px solid rgba(255,255,255,0.25)',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.filter = 'brightness(1.15)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.filter = 'none'; }}
    >
      {label}
    </button>
  );
}

interface ContextualBannerProps {
  banner: CodeBanner;
  onFollowCursor: () => void;
  onDismiss: () => void;
}

export function ContextualBanner({ banner, onFollowCursor, onDismiss }: ContextualBannerProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const agentsStore = useAgentsStoreOptional();
  const [busy, setBusy] = useState(false);

  const handleAnswer = useCallback(async (answer: string) => {
    if (banner.kind !== 'question' || !agentsStore || busy) return;
    setBusy(true);
    try {
      agentsStore.interveneMission(banner.mission.id, answer);
      const repoPath = await resolveProjectRoot();
      await recordMissionAnswer({
        missionId: banner.mission.id,
        question: banner.question,
        answer,
        projectId: projectIdFromRoot(repoPath),
        actor: 'user',
      });
      onDismiss();
    } finally {
      setBusy(false);
    }
  }, [banner, agentsStore, busy, onDismiss]);

  const handlePause = useCallback(() => {
    if (banner.kind !== 'run' || !agentsStore) return;
    agentsStore.pauseMission(banner.mission.id);
    // Deliberately no onDismiss() here (unlike the other actions below) —
    // the banner must stay mounted so it can flip to the "paused" state and
    // offer Resume. See this file's header comment for why (B18).
  }, [banner, agentsStore]);

  const handleResume = useCallback(() => {
    if (banner.kind !== 'run' || !agentsStore) return;
    agentsStore.resumeMission(banner.mission.id);
  }, [banner, agentsStore]);

  const handleRetry = useCallback(() => {
    if (banner.kind !== 'failed' || !agentsStore) return;
    agentsStore.retryMission(banner.mission.id);
    onDismiss();
  }, [banner, agentsStore, onDismiss]);

  const handleOpenMission = useCallback(() => {
    if (banner.kind !== 'failed' && banner.kind !== 'question' && banner.kind !== 'review') return;
    if (agentsStore) agentsStore.setSelectedMissionId(banner.mission.id);
    emit('nav:navigateSpace', 'agents');
  }, [banner, agentsStore]);

  if (banner.kind === 'none') return null;
  const isPausedRun = banner.kind === 'run' && banner.mission.paused === true;
  const style = isPausedRun ? { ...STYLES.run, dotAnim: 'none', dotColor: 'var(--color-text-muted)' } : STYLES[banner.kind];
  const whoLine = banner.kind === 'locked'
    ? null
    : fileActivityWhoLine({ kind: banner.kind, mission: banner.mission }, t);

  return (
    <div
      data-testid="code-contextual-banner"
      data-kind={banner.kind}
      style={{ padding: '10px 20px', borderBottom: `1px solid ${style.border}`, background: style.background }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: style.dotColor, animation: style.dotAnim, flexShrink: 0 }} />
        <span style={{ fontSize: 13.5, color: style.textColor, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span>
            {banner.kind === 'run' && (isPausedRun
              ? t('codespace.banner.paused', { title: banner.mission.title })
              : t('codespace.banner.run', { title: banner.mission.title }))}
            {banner.kind === 'question' && t('codespace.banner.question', { title: banner.mission.title, question: banner.question })}
            {banner.kind === 'failed' && t('codespace.banner.failed', { title: banner.mission.title, reason: translateStatusReason(banner.mission.statusReason, t) ?? '' })}
            {banner.kind === 'review' && t('codespace.banner.review', { title: banner.mission.title })}
            {banner.kind === 'locked' && t('codespace.banner.locked', { title: banner.mission.title })}
          </span>
          {whoLine && (
            <span data-testid="code-contextual-banner-cursor" style={{ fontSize: 11.5, color: 'var(--color-text-muted)', fontWeight: 500 }}>
              {whoLine}
            </span>
          )}
        </span>
      </div>
      {(banner.kind === 'run' || banner.kind === 'question' || banner.kind === 'failed' || banner.kind === 'review') && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, marginLeft: 17 }}>
          {banner.kind === 'run' && (
            <>
              <ActionButton label={t('codespace.banner.followCursor')} onClick={onFollowCursor} />
              {agentsStore && (isPausedRun
                ? <ActionButton primary label={t('codespace.banner.resumeAgent')} onClick={handleResume} />
                : <ActionButton label={t('codespace.banner.pauseAgent')} onClick={handlePause} />)}
            </>
          )}
          {banner.kind === 'question' && agentsStore && (
            <>
              <ActionButton primary label={t('codespace.banner.deny')} onClick={() => void handleAnswer(t('codespace.banner.denyAnswer'))} />
              <ActionButton label={t('codespace.banner.allowOnce')} onClick={() => void handleAnswer(t('codespace.banner.allowAnswer'))} />
            </>
          )}
          {banner.kind === 'failed' && agentsStore && (
            <>
              <ActionButton primary label={t('codespace.banner.retry')} onClick={handleRetry} />
              <ActionButton label={t('codespace.banner.logs')} onClick={handleOpenMission} />
            </>
          )}
          {banner.kind === 'review' && (
            <>
              <ActionButton label={t('codespace.banner.followCursor')} onClick={onFollowCursor} />
              {agentsStore && <ActionButton primary label={t('codespace.banner.openInCockpit')} onClick={handleOpenMission} />}
            </>
          )}
          {!agentsStore && banner.kind !== 'run' && (
            <ActionButton label={t('codespace.banner.openInCockpit')} onClick={() => toast(t('codespace.banner.cockpitUnavailable'), 'warning')} />
          )}
        </div>
      )}
    </div>
  );
}
