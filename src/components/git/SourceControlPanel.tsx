/* SourceControlPanel — git status, stage/unstage, commit, branches, log, push.
   Mounted inside CodeSpace as a toggleable left-side panel.
   Web mode: stage/unstage/push/branches/log are rejected by WebPlatform; we
   show an honest "not available in demo" banner for write/nav ops.
*/

import { useCallback, useEffect, useState } from 'react';
import type { Platform, GitStatus, GitLogEntry } from '../../lib/platform/types';
import { useToast } from '../ui';
import { useI18n } from '../../i18n';
import { AiCommitMessage } from './AiCommitMessage';
import { AiReview } from './AiReview';
import { mapWithConcurrency } from '../../lib/concurrency';

// B3.3: the staged file list is user-controlled (a big commit can stage
// hundreds of files) — bounding concurrent `git diff` subprocesses avoids
// launching hundreds of them at once.
const STAGED_DIFF_CONCURRENCY = 8;

// ── Types ─────────────────────────────────────────────────────────

interface Props {
  platform: Platform;
  projectRoot: string;
}

type LoadState = 'idle' | 'loading' | 'error';

// ── Helpers ───────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = { M: 'M', A: 'A', D: 'D', '?': 'U' };
const STATUS_COLOR: Record<string, string> = {
  M: '#FFC76B',
  A: '#66E27A',
  D: '#F07178',
  '?': 'rgba(255,255,255,0.35)',
};

function statusColor(s: string): string {
  return STATUS_COLOR[s] ?? 'rgba(255,255,255,0.35)';
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

// ── Sub-components ────────────────────────────────────────────────

interface SectionLabelProps {
  label: string;
  count?: number;
}

function SectionLabel({ label, count }: SectionLabelProps) {
  return (
    <div
      style={{
        padding: '6px 10px 3px',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.06em',
        color: 'rgba(255,255,255,0.35)',
        textTransform: 'uppercase',
        display: 'flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          style={{
            background: 'rgba(124,92,255,0.25)',
            color: '#A78BFF',
            borderRadius: 8,
            fontSize: 9,
            padding: '0 4px',
            lineHeight: '14px',
            fontWeight: 600,
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}

interface FileRowProps {
  filePath: string;
  statusCode: string;
  actionLabel: string;
  actionAriaLabel: string;
  onAction: (path: string) => void;
  onOpenDiff?: (path: string) => void;
}

function FileRow({ filePath, statusCode, actionLabel, actionAriaLabel, onAction, onOpenDiff }: FileRowProps) {
  const [hovered, setHovered] = useState(false);
  // Keyboard users can't hover — the stage/unstage button must stay mounted
  // (and therefore reachable by Tab) at all times. It was previously only
  // rendered inside `{hovered && ...}`, which meant it never existed in the
  // DOM — and so never entered the tab order — until a mouse moved over the
  // row (git-a11y fix, 2026-08-15). `revealed` now only controls visibility
  // (opacity), not mounting, so focusing it via keyboard shows it too.
  const [focused, setFocused] = useState(false);
  const revealed = hovered || focused;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px 2px 18px',
        fontSize: 11,
        color: 'rgba(255,255,255,0.65)',
        background: hovered ? 'rgba(124,92,255,0.08)' : 'transparent',
        cursor: onOpenDiff ? 'pointer' : 'default',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => onOpenDiff?.(filePath)}
    >
      <span
        style={{
          fontWeight: 700,
          fontSize: 10,
          color: statusColor(statusCode),
          minWidth: 10,
          flexShrink: 0,
        }}
      >
        {STATUS_LABEL[statusCode] ?? statusCode}
      </span>
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={filePath}
      >
        {basename(filePath)}
      </span>
      <button
        onClick={() => onAction(filePath)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label={actionAriaLabel}
        style={{
          background: 'rgba(124,92,255,0.2)',
          border: '1px solid rgba(124,92,255,0.4)',
          borderRadius: 3,
          color: '#A78BFF',
          fontSize: 9,
          padding: '1px 5px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          flexShrink: 0,
          opacity: revealed ? 1 : 0,
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────

export function SourceControlPanel({ platform, projectRoot }: Props) {
  const { toast } = useToast();
  const { t } = useI18n();

  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [diffPath, setDiffPath] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState<string>('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [stagedDiff, setStagedDiff] = useState<string>('');
  const isWeb = platform.name === 'web';

  const refresh = useCallback(async () => {
    if (!projectRoot) return;
    setLoadState('loading');
    try {
      const status = await platform.git.status(projectRoot);
      setGitStatus(status);
      setLoadState('idle');
    } catch {
      setLoadState('error');
    }
  }, [platform, projectRoot]);

  useEffect(() => {
    if (!projectRoot) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => { if (!cancelled) setLoadState('loading'); })
      .then(() => platform.git.status(projectRoot))
      .then((status) => {
        if (!cancelled) {
          setGitStatus(status);
          setLoadState('idle');
        }
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });
    return () => { cancelled = true; };
  }, [platform, projectRoot]);

  // Compute staged diff for AI commit message and review
  useEffect(() => {
    if (staged.size === 0 || !projectRoot) {
      setStagedDiff('');
      return;
    }
    let cancelled = false;
    const files = [...staged];
    mapWithConcurrency(files, STAGED_DIFF_CONCURRENCY, f => platform.git.diff(projectRoot, f).catch(() => ''))
      .then(diffs => {
        if (!cancelled) setStagedDiff(diffs.join('\n'));
      });
    return () => { cancelled = true; };
  }, [staged, platform, projectRoot]);

  // ── Staging ───────────────────────────────────────────────────

  async function handleStage(filePath: string) {
    if (!projectRoot) return;
    try {
      await platform.git.stage(projectRoot, [filePath]);
      setStaged(prev => new Set([...prev, filePath]));
      toast(t('git.staged', { file: basename(filePath) }), 'success', 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(isWeb ? t('git.stageNotAvailable') : msg, 'warning');
    }
  }

  async function handleUnstage(filePath: string) {
    if (!projectRoot) return;
    try {
      await platform.git.unstage(projectRoot, [filePath]);
      setStaged(prev => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
      toast(t('git.unstaged', { file: basename(filePath) }), 'info', 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast(isWeb ? t('git.unstageNotAvailable') : msg, 'warning');
    }
  }

  // ── Commit ────────────────────────────────────────────────────

  async function handleCommit() {
    const msg = commitMsg.trim();
    if (!msg || !projectRoot) return;
    if (staged.size === 0) {
      toast(t('git.noStagedFiles'), 'warning');
      return;
    }
    setCommitting(true);
    try {
      await platform.git.commit(projectRoot, msg);
      setCommitMsg('');
      setStaged(new Set());
      toast(t('git.committed'), 'success');
      await refresh();
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      toast(isWeb ? t('git.commitNotAvailable') : raw, 'warning');
    } finally {
      setCommitting(false);
    }
  }

  // ── Push ──────────────────────────────────────────────────────

  async function handlePush() {
    if (!projectRoot) return;
    if (!window.confirm(t('git.pushConfirm'))) return;
    setPushing(true);
    try {
      await platform.git.push(projectRoot);
      toast(t('git.pushed'), 'success');
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      toast(isWeb ? t('git.pushNotAvailable') : raw, 'error');
    } finally {
      setPushing(false);
    }
  }

  // ── Branches ──────────────────────────────────────────────────

  async function loadBranches() {
    if (!projectRoot) return;
    try {
      const b = await platform.git.branches(projectRoot);
      setBranches(b);
      setBranchesOpen(true);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      toast(isWeb ? t('git.branchesNotAvailable') : raw, 'warning');
    }
  }

  // ── Log ───────────────────────────────────────────────────────

  async function loadLog() {
    if (!projectRoot) return;
    try {
      const entries = await platform.git.log(projectRoot, 10);
      setLog(entries);
      setLogOpen(true);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      toast(isWeb ? t('git.logNotAvailable') : raw, 'warning');
    }
  }

  // ── Diff viewer ─────────────────────────────────────────────

  async function handleOpenDiff(filePath: string) {
    if (!projectRoot) return;
    setDiffPath(filePath);
    setDiffLoading(true);
    setDiffContent('');
    try {
      const diff = await platform.git.diff(projectRoot, filePath);
      setDiffContent(diff);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setDiffContent(isWeb ? t('git.diffNotAvailable') : raw);
    } finally {
      setDiffLoading(false);
    }
  }

  // ── Partition files ───────────────────────────────────────────

  const allFiles = gitStatus?.files ?? [];
  const stagedFiles = allFiles.filter(f => staged.has(f.path));
  const unstagedFiles = allFiles.filter(f => !staged.has(f.path));

  // ── Render ────────────────────────────────────────────────────

  return (
    <div
      style={{
        width: 220,
        flexShrink: 0,
        borderRight: '1px solid rgba(255,255,255,0.07)',
        background: 'var(--color-panel-2, #13131A)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontSize: 12,
        color: 'rgba(255,255,255,0.75)',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '8px 10px 7px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 11, color: '#D5D8E0', flex: 1 }}>
          {t('git.sourceControl')}
        </span>
        {gitStatus && (
          <span
            style={{
              fontSize: 10,
              color: '#A78BFF',
              background: 'rgba(124,92,255,0.12)',
              borderRadius: 4,
              padding: '1px 5px',
            }}
          >
            {gitStatus.branch}
            {gitStatus.ahead > 0 && ` +${gitStatus.ahead}`}
          </span>
        )}
        <button
          onClick={refresh}
          disabled={loadState === 'loading'}
          title={t('common.refresh')}
          aria-label={t('common.refresh')}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'rgba(255,255,255,0.35)',
            cursor: 'pointer',
            fontSize: 12,
            padding: '0 2px',
          }}
        >
          {loadState === 'loading' ? '...' : '↻'}
        </button>
      </div>

      {/* Web demo notice */}
      {isWeb && (
        <div
          style={{
            background: 'rgba(255,199,107,0.08)',
            borderBottom: '1px solid rgba(255,199,107,0.15)',
            padding: '5px 10px',
            fontSize: 10,
            color: '#FFC76B',
            flexShrink: 0,
          }}
        >
          {t('git.demoModeNotice')}
        </div>
      )}

      {/* Error state */}
      {loadState === 'error' && (
        <div
          style={{
            padding: '12px 10px',
            fontSize: 11,
            color: '#F07178',
          }}
        >
          {t('git.loadError')}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Staged files */}
        {stagedFiles.length > 0 && (
          <>
            <SectionLabel label={t('git.stagedChanges')} count={stagedFiles.length} />
            {stagedFiles.map(f => (
              <FileRow
                key={f.path}
                filePath={f.path}
                statusCode={f.status}
                actionLabel="-"
                actionAriaLabel={t('git.unstageFile', { file: basename(f.path) })}
                onAction={handleUnstage}
                onOpenDiff={handleOpenDiff}
              />
            ))}
          </>
        )}

        {/* Unstaged files */}
        {unstagedFiles.length > 0 && (
          <>
            <SectionLabel label={t('git.changes')} count={unstagedFiles.length} />
            {unstagedFiles.map(f => (
              <FileRow
                key={f.path}
                filePath={f.path}
                statusCode={f.status}
                actionLabel="+"
                actionAriaLabel={t('git.stageFile', { file: basename(f.path) })}
                onAction={handleStage}
                onOpenDiff={handleOpenDiff}
              />
            ))}
          </>
        )}

        {allFiles.length === 0 && loadState === 'idle' && (
          <div
            style={{
              padding: '16px 10px',
              fontSize: 11,
              color: 'rgba(255,255,255,0.2)',
              textAlign: 'center',
            }}
          >
            {t('git.noChanges')}
          </div>
        )}

        {/* Commit message */}
        <div style={{ padding: '8px 10px 4px', flexShrink: 0 }}>
          <textarea
            value={commitMsg}
            onChange={e => setCommitMsg(e.target.value)}
            placeholder={t('git.commitPlaceholder')}
            rows={2}
            style={{
              width: '100%',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 4,
              color: '#D5D8E0',
              fontSize: 11,
              fontFamily: 'inherit',
              padding: '5px 7px',
              resize: 'vertical',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <AiCommitMessage diff={stagedDiff} onApply={msg => setCommitMsg(msg)} />
          </div>
          {staged.size === 0 && (
            <div style={{ marginTop: 4, fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
              {t('git.commitDisabledNoStaged')}
            </div>
          )}
          {stagedDiff && (
            <div style={{ marginTop: 4 }}>
              <AiReview diff={stagedDiff} />
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ padding: '2px 10px 8px', display: 'flex', gap: 5, flexShrink: 0 }}>
          <button
            onClick={handleCommit}
            disabled={committing || !commitMsg.trim() || staged.size === 0}
            title={
              staged.size === 0
                ? t('git.commitDisabledNoStaged')
                : !commitMsg.trim()
                  ? t('git.commitDisabledNoMessage')
                  : undefined
            }
            style={{
              flex: 1,
              background: '#7C5CFF',
              border: 'none',
              borderRadius: 4,
              color: '#fff',
              fontSize: 11,
              fontWeight: 500,
              padding: '5px 0',
              cursor: committing || !commitMsg.trim() || staged.size === 0 ? 'not-allowed' : 'pointer',
              opacity: committing || !commitMsg.trim() || staged.size === 0 ? 0.45 : 1,
              fontFamily: 'inherit',
            }}
          >
            {committing ? t('git.committing') : t('git.commit')}
          </button>
          <button
            onClick={handlePush}
            disabled={pushing}
            title={t('git.pushToRemote')}
            aria-label={t('git.pushToRemote')}
            style={{
              background: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4,
              color: 'rgba(255,255,255,0.55)',
              fontSize: 11,
              padding: '5px 8px',
              cursor: pushing ? 'not-allowed' : 'pointer',
              opacity: pushing ? 0.5 : 1,
              fontFamily: 'inherit',
            }}
          >
            {pushing ? '...' : '↑'}
          </button>
        </div>

        {/* Branches */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '4px 0' }}>
          <button
            onClick={branchesOpen ? () => setBranchesOpen(false) : loadBranches}
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              color: 'rgba(255,255,255,0.4)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              textAlign: 'left',
              padding: '5px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span>{branchesOpen ? '▾' : '▸'}</span> {t('git.branches')}
          </button>
          {branchesOpen && branches.map(b => (
            <div
              key={b}
              style={{
                padding: '2px 18px',
                fontSize: 11,
                color: b === gitStatus?.branch ? '#A78BFF' : 'rgba(255,255,255,0.5)',
                fontWeight: b === gitStatus?.branch ? 600 : 400,
              }}
            >
              {b === gitStatus?.branch ? '● ' : '○ '}{b}
            </div>
          ))}
        </div>

        {/* Log */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '4px 0' }}>
          <button
            onClick={logOpen ? () => setLogOpen(false) : loadLog}
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              color: 'rgba(255,255,255,0.4)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              textAlign: 'left',
              padding: '5px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <span>{logOpen ? '▾' : '▸'}</span> {t('git.recentCommits')}
          </button>
          {logOpen && log.map(entry => (
            <div
              key={entry.hash}
              style={{
                padding: '3px 10px 3px 18px',
                fontSize: 10,
                borderBottom: '1px solid rgba(255,255,255,0.04)',
              }}
            >
              <div
                style={{
                  color: 'rgba(255,255,255,0.65)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={entry.subject}
              >
                {entry.subject}
              </div>
              <div style={{ color: 'rgba(255,255,255,0.25)', marginTop: 1 }}>
                {entry.author} &middot; {entry.hash.slice(0, 7)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Diff viewer panel */}
      {diffPath && (
        <div
          style={{
            borderTop: '1px solid rgba(255,255,255,0.07)',
            maxHeight: 240,
            display: 'flex',
            flexDirection: 'column',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              padding: '4px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t('git.diffHeader', { file: basename(diffPath) })}
            </span>
            <button
              onClick={() => setDiffPath(null)}
              title={t('common.close')}
              aria-label={t('common.close')}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'rgba(255,255,255,0.3)',
                cursor: 'pointer',
                fontSize: 13,
                padding: 0,
                fontFamily: 'inherit',
              }}
            >
              ×
            </button>
          </div>
          <div
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '4px 10px',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              whiteSpace: 'pre',
              color: 'rgba(255,255,255,0.6)',
              lineHeight: 1.5,
            }}
          >
            {diffLoading ? t('git.diffLoading') : diffContent || t('git.noChanges')}
          </div>
        </div>
      )}
    </div>
  );
}
