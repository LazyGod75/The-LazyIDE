/* CodeSidebarWorktrees — the "WORKTREES — {project}" sidebar section
   (design-code.md §4.3). One card per REAL running/failed mission worktree
   for the active file's project, plus a "main" row derived from the
   project's own git status/log when that's cheaply available (omitted
   otherwise — never a fabricated "saine" row with no backing data).
*/

import { useEffect, useState } from 'react';
import type { Platform } from '../../../lib/platform/types';
import type { FleetMission } from '../../../lib/agents/fleetMissions';
import { useI18n } from '../../../i18n';
import { basename } from '../../../lib/paths';

interface MainRowInfo {
  branch: string;
  lastCommitAgoMs: number | null;
}

function formatAgo(ms: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t('codespace.worktrees.justNow');
  if (minutes < 60) return t('codespace.worktrees.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('codespace.worktrees.hoursAgo', { count: hours });
  return t('codespace.worktrees.daysAgo', { count: Math.floor(hours / 24) });
}

function worktreeState(mission: FleetMission, t: (key: string) => string): string {
  if (mission.status === 'failed') return t('codespace.worktrees.stateFailed');
  if (mission.pendingQuestion) return t('codespace.worktrees.statePaused');
  return t('codespace.worktrees.stateRunning');
}

function diffStat(mission: FleetMission): string {
  if (mission.diffAdded !== undefined || mission.diffRemoved !== undefined) {
    return `+${mission.diffAdded ?? 0} −${mission.diffRemoved ?? 0}`;
  }
  return '✓';
}

interface WorktreeCardProps {
  dotColor: string;
  dotAnim: string;
  branch: string;
  subtitle: string;
  diff: string;
  onDiff: () => void;
  t: (key: string) => string;
}

function WorktreeCard({ dotColor, dotAnim, branch, subtitle, diff, onDiff, t }: WorktreeCardProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 9,
        alignItems: 'center',
        background: 'var(--color-panel-2)',
        border: '1px solid var(--color-border)',
        borderRadius: 9,
        padding: '8px 11px',
        margin: '0 18px 7px',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, animation: dotAnim, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--color-text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {branch}
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {subtitle}
        </div>
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-success)', flexShrink: 0 }}>{diff}</span>
      <button
        onClick={onDiff}
        style={{
          padding: '4px 10px',
          borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.18)',
          background: 'transparent',
          color: 'var(--color-text-secondary)',
          fontSize: 11,
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: 'inherit',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { const el = e.currentTarget; el.style.borderColor = 'rgba(255,255,255,0.45)'; el.style.color = '#fff'; }}
        onMouseLeave={(e) => { const el = e.currentTarget; el.style.borderColor = 'rgba(255,255,255,0.18)'; el.style.color = 'var(--color-text-secondary)'; }}
      >
        {t('codespace.worktrees.diffButton')}
      </button>
    </div>
  );
}

interface CodeSidebarWorktreesProps {
  projectRoot: string;
  platform: Platform;
  missions: readonly FleetMission[];
  onOpenDiff: (worktreeBranch: string, subtitle: string, mission: FleetMission | null) => void;
}

export function CodeSidebarWorktrees({ projectRoot, platform, missions, onOpenDiff }: CodeSidebarWorktreesProps) {
  const { t } = useI18n();
  const [mainInfo, setMainInfo] = useState<MainRowInfo | null>(null);

  useEffect(() => {
    if (platform.name !== 'tauri' || !projectRoot) { setMainInfo(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const [status, log] = await Promise.all([
          platform.git.status(projectRoot),
          platform.git.log(projectRoot, 1).catch(() => []),
        ]);
        if (cancelled) return;
        const lastCommit = log[0];
        const lastCommitAgoMs = lastCommit ? Date.now() - new Date(lastCommit.date).getTime() : null;
        setMainInfo({ branch: status.branch, lastCommitAgoMs: Number.isFinite(lastCommitAgoMs) ? lastCommitAgoMs : null });
      } catch {
        if (!cancelled) setMainInfo(null);
      }
    })();
    return () => { cancelled = true; };
  }, [platform, projectRoot]);

  const worktreeMissions = missions.filter((m) => m.worktree && (m.status === 'running' || m.status === 'failed'));

  return (
    <div style={{ padding: '10px 0' }}>
      <div style={{ padding: '4px 18px 8px' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 1.8, color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>
          {t('codespace.worktrees.title')} — {basename(projectRoot) || projectRoot}
        </span>
      </div>
      {worktreeMissions.length === 0 && !mainInfo && (
        <div style={{ padding: '0 18px', fontSize: 11.5, color: 'var(--color-text-disabled)' }}>
          {t('codespace.worktrees.empty')}
        </div>
      )}
      {worktreeMissions.map((m) => (
        <WorktreeCard
          key={m.id}
          dotColor={m.status === 'failed' || m.pendingQuestion ? 'var(--color-danger)' : 'var(--color-success)'}
          dotAnim={m.status === 'failed' ? 'none' : m.pendingQuestion ? 'blinkDot 1s infinite' : 'blinkDot 1.5s infinite'}
          branch={m.worktree ?? m.id}
          subtitle={`${m.title} · ${m.model} · ${worktreeState(m, t)}`}
          diff={diffStat(m)}
          onDiff={() => onOpenDiff(m.worktree ?? m.id, `${m.title} · ${m.model}`, m)}
          t={t}
        />
      ))}
      {mainInfo && (
        <WorktreeCard
          dotColor="var(--color-text-muted)"
          dotAnim="none"
          branch={mainInfo.branch}
          subtitle={
            mainInfo.lastCommitAgoMs !== null
              ? `${t('codespace.worktrees.healthy')} · ${t('codespace.worktrees.lastMerge', { time: formatAgo(mainInfo.lastCommitAgoMs, t) })}`
              : t('codespace.worktrees.healthy')
          }
          diff="✓"
          onDiff={() => onOpenDiff(mainInfo.branch, t('codespace.worktrees.healthy'), null)}
          t={t}
        />
      )}
    </div>
  );
}
