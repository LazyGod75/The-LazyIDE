/* DiffDrawer — 680px right-side diff overlay (design-code.md §4.8, D12).
   Real per-worktree diff (lib/review/useWorktreeReview.ts) — never the
   design mock's static single diff. "Approuver ce diff" maps to a real
   primitive: agentsStore.approveMission when the worktree belongs to a
   mission (repoPath resolved via resolveProjectRoot), otherwise (a plain
   git worktree with no mission behind it — e.g. the "main" card) a plain
   git stage+commit of the shown files, mirroring ReviewSpace's own
   handleApprove. Opened from a worktree card's "Diff" button.
*/

import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useToast } from '../../ui';
import { getPlatform } from '../../../lib/platform';
import { emit } from '../../../lib/bus';
import { useWorktreeReview } from '../../../lib/review/useWorktreeReview';
import type { DiffLine } from '../../../lib/review/diffParse';
import { computeHeuristicRisk, type RiskLevel } from '../../../lib/review/risk';
import { useAgentAvailable } from '../../../lib/review/agentAvailability';
import { useAgentsStoreActionsOptional, resolveProjectRoot } from '../../agents/agentsStore';
import { ApproveBlockedError } from '../../agents/approveGate';

export interface DiffDrawerTarget {
  worktreePath: string;
  branch: string;
  missionId: string | null;
}

interface DiffDrawerProps {
  target: DiffDrawerTarget;
  onClose: () => void;
}

const LINE_BG: Record<DiffLine['type'], string> = {
  add: 'rgba(74,222,128,0.07)',
  remove: 'rgba(248,113,113,0.07)',
  hunk: 'transparent',
  context: 'transparent',
};
const LINE_COLOR: Record<DiffLine['type'], string> = {
  add: '#B7EEC7',
  remove: '#F5B5B5',
  hunk: 'var(--color-text-muted)',
  context: 'var(--color-text-muted)',
};
const LINE_SIGN: Record<DiffLine['type'], string> = { add: '+', remove: '-', hunk: '', context: '' };

// ── Risk badge (src/lib/review/risk.ts — same heuristic ReviewSpace shows
// in its own review panel, colors/levels kept identical for consistency) ──

const RISK_COLOR: Record<RiskLevel, string> = {
  low: '#66E27A',
  medium: '#FFC76B',
  high: '#FF7B7B',
};
const RISK_BG: Record<RiskLevel, string> = {
  low: 'rgba(102,226,122,0.12)',
  medium: 'rgba(255,199,107,0.12)',
  high: 'rgba(255,123,123,0.12)',
};

function RiskBadge({ level, reasons }: { level: RiskLevel; reasons: string[] }) {
  return (
    <span
      title={reasons.length > 0 ? reasons.join(', ') : undefined}
      style={{
        fontSize: 9,
        fontWeight: 700,
        padding: '2px 6px',
        borderRadius: 4,
        background: RISK_BG[level],
        color: RISK_COLOR[level],
        border: `1px solid ${RISK_COLOR[level]}33`,
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
    >
      {level}
    </span>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div style={{ display: 'flex', background: LINE_BG[line.type] }}>
      <span style={{ width: 34, textAlign: 'center', flexShrink: 0, color: line.type === 'context' ? 'var(--color-text-disabled)' : LINE_COLOR[line.type], fontFamily: 'var(--font-mono)' }}>
        {LINE_SIGN[line.type]}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13.5, lineHeight: 1.7, color: LINE_COLOR[line.type], whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {line.content}
      </span>
    </div>
  );
}

export function DiffDrawer({ target, onClose }: DiffDrawerProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const platform = getPlatform();
  const agentsActions = useAgentsStoreActionsOptional();
  const state = useWorktreeReview(target.worktreePath);
  const agentAvailable = useAgentAvailable();
  const [approving, setApproving] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  const stat =
    state.kind === 'data'
      ? `+${state.added} −${state.removed}`
      : state.kind === 'empty'
        ? t('codespace.diffDrawer.noChanges')
        : '';

  const risk = useMemo(() => {
    if (state.kind !== 'data') return null;
    const content = state.files.flatMap((f) => f.lines.map((l) => l.content)).join('\n');
    return computeHeuristicRisk({ title: target.branch, content, removed: state.removed });
  }, [state, target.branch]);

  function handleSendAgent() {
    if (!agentAvailable || state.kind !== 'data') return;
    const fileList = state.files.map((f) => f.path).join(', ');
    emit('agent:launch', {
      task: `Review this diff for correctness, code quality, and potential issues.\nBranch: ${target.branch}\nFiles: ${fileList}\nAdded: ${state.added} lines, Removed: ${state.removed} lines.`,
      title: `Reviewer — ${target.branch}`,
      model: 'Sonnet 4.6',
    });
    toast(t('codespace.diffDrawer.agentLaunched'), 'success');
  }

  async function handleApprove() {
    setBlockedReason(null);
    setApproving(true);
    try {
      if (target.missionId && agentsActions) {
        const repoPath = await resolveProjectRoot();
        await agentsActions.approveMission(target.missionId, repoPath);
        toast(t('codespace.diffDrawer.approved'), 'success');
        onClose();
        return;
      }
      // No mission behind this worktree (e.g. the "main" card) — the
      // git-level approve ReviewSpace's own ReviewActions.handleApprove
      // implements: stage + commit the changed files directly in place.
      if (platform.name !== 'tauri' || state.kind !== 'data') {
        toast(t('codespace.diffDrawer.approveUnavailable'), 'warning');
        return;
      }
      const paths = state.files.map((f) => f.path);
      await platform.git.stage(target.worktreePath, paths);
      await platform.git.commit(target.worktreePath, `review: approve ${target.branch}`);
      toast(t('codespace.diffDrawer.approved'), 'success');
      onClose();
    } catch (err) {
      if (err instanceof ApproveBlockedError) {
        setBlockedReason(err.reason);
      } else {
        toast(`${t('common.error')}: ${String(err)}`, 'error');
      }
    } finally {
      setApproving(false);
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(6,6,10,0.55)', zIndex: 40, display: 'flex', justifyContent: 'flex-end' }}
      onClick={onClose}
    >
      <div
        style={{ width: 680, maxWidth: '92vw', height: '100%', background: 'var(--color-panel)', borderLeft: '1px solid rgba(255,255,255,0.12)', boxShadow: '-20px 0 60px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {target.branch}
          </span>
          {stat && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-success)', flexShrink: 0 }}>{stat}</span>}
          {risk && <RiskBadge level={risk.level} reasons={risk.reasons} />}
          <button
            onClick={onClose}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 17, color: 'var(--color-text-disabled)', flexShrink: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#fff'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-disabled)'; }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '14px 0' }}>
          {state.kind === 'loading' && (
            <div style={{ padding: 24, fontSize: 13, color: 'var(--color-text-muted)' }}>{t('codespace.diffDrawer.loading')}</div>
          )}
          {state.kind === 'unavailable' && (
            <div style={{ padding: 24, fontSize: 13, color: 'var(--color-text-muted)' }}>{t('codespace.diffDrawer.unavailable')}</div>
          )}
          {state.kind === 'error' && (
            <div style={{ padding: 24, fontSize: 13, color: 'var(--color-danger)' }}>{t('codespace.diffDrawer.error', { message: state.message })}</div>
          )}
          {state.kind === 'empty' && (
            <div style={{ padding: 24, fontSize: 13, color: 'var(--color-text-muted)' }}>{t('codespace.diffDrawer.noChanges')}</div>
          )}
          {state.kind === 'data' && state.files.map((file) => (
            <div key={file.path} style={{ marginBottom: 20 }}>
              <div style={{ padding: '8px 22px', background: 'rgba(255,255,255,0.04)', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>{file.path}</span>
                <span style={{ fontSize: 11, color: 'var(--color-success)' }}>+{file.added}</span>
                <span style={{ fontSize: 11, color: 'var(--color-danger)' }}>-{file.removed}</span>
              </div>
              {file.lines.map((line, i) => <DiffLineRow key={i} line={line} />)}
            </div>
          ))}
        </div>

        {blockedReason && (
          <div style={{ margin: '0 22px 10px', padding: '7px 12px', borderRadius: 6, background: 'rgba(251,185,36,0.08)', border: '1px solid rgba(251,185,36,0.22)', color: '#FBB924', fontSize: 12 }}>
            {blockedReason}
          </div>
        )}

        <div style={{ padding: '16px 22px', borderTop: '1px solid var(--color-border)', display: 'flex', gap: 9 }}>
          <button
            onClick={handleApprove}
            disabled={approving || state.kind !== 'data'}
            style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 9, background: 'var(--color-merge)', color: '#06220F', fontSize: 14, fontWeight: 700, border: 'none', cursor: state.kind === 'data' ? 'pointer' : 'default', opacity: state.kind === 'data' ? 1 : 0.5, fontFamily: 'inherit' }}
          >
            {approving ? t('codespace.diffDrawer.approving') : t('codespace.diffDrawer.approve')}
          </button>
          <button
            onClick={handleSendAgent}
            disabled={!agentAvailable || state.kind !== 'data'}
            title={!agentAvailable ? t('codespace.diffDrawer.agentUnavailable') : undefined}
            style={{
              padding: '10px 16px',
              borderRadius: 9,
              border: `1px solid ${agentAvailable ? 'rgba(124,92,255,0.3)' : 'rgba(255,255,255,0.08)'}`,
              background: agentAvailable ? 'rgba(124,92,255,0.1)' : 'transparent',
              color: agentAvailable ? '#A78BFF' : 'var(--color-text-disabled)',
              fontSize: 14,
              fontWeight: 600,
              cursor: agentAvailable && state.kind === 'data' ? 'pointer' : 'not-allowed',
              opacity: state.kind === 'data' ? 1 : 0.5,
              fontFamily: 'inherit',
            }}
          >
            {t('codespace.diffDrawer.sendAgent')}
          </button>
          <button
            onClick={onClose}
            style={{ padding: '10px 20px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: 'var(--color-text)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            {t('codespace.diffDrawer.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
