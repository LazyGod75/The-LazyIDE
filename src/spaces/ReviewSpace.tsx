/* ReviewSpace — pending diffs & review actions.
   Under Tauri: data comes from real git (git_status + git_diff).
     - On error: shows an explicit error/empty state — NEVER falls back to mock data.
   Under web:   falls back to mock data with a visible "DEMO" badge.
*/

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { PendingChange, DiffLine, ReviewDiff, JudgeVerdict, ReviewerVerdict, RiskLevel } from '../lib/mock/review';
import { useAppContext } from '../app/AppContext';
import { getPlatform } from '../lib/platform';
import { getProjectRoot } from '../lib/platform/tauri';
import { EmptyState, Spinner, useToast } from '../components/ui';
import { emit } from '../lib/bus';
import { computeHeuristicRisk } from '../lib/review/risk';
import { useAgentAvailable } from '../lib/review/agentAvailability';

// ── Extended Git interface (added by PLATFORM-B, cast at runtime) ──

interface ExtendedGit {
  status: (repoPath: string) => Promise<{ branch: string; ahead: number; behind: number; files: { path: string; status: string }[] }>;
  diff: (repoPath: string, filePath?: string) => Promise<string>;
  commit: (repoPath: string, message: string) => Promise<void>;
  stage?: (repoPath: string, paths: string[]) => Promise<void>;
  push?: (repoPath: string) => Promise<void>;
}

// ── Git adapter ────────────────────────────────────────────────────

/** Convert a raw unified diff string into DiffLine[]. */
function parseDiffLines(raw: string): DiffLine[] {
  return raw.split('\n').map((content): DiffLine => {
    if (content.startsWith('@@')) return { type: 'hunk', content };
    if (content.startsWith('+') && !content.startsWith('+++')) return { type: 'add', content: content.slice(1) };
    if (content.startsWith('-') && !content.startsWith('---')) return { type: 'remove', content: content.slice(1) };
    return { type: 'context', content };
  });
}

/** Count +/- lines in a diff string. */
function countDiffLines(raw: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

type ReviewLoadState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; changes: PendingChange[]; diffs: ReviewDiff[] };

interface GitReviewData {
  state: ReviewLoadState;
}

function useGitReview(): GitReviewData {
  const { t } = useI18n();
  const { platform, projectRoot } = useAppContext();
  const [state, setState] = useState<ReviewLoadState>(
    platform.name === 'tauri' ? { kind: 'loading' } : { kind: 'empty' }
  );

  useEffect(() => {
    if (platform.name !== 'tauri') {
      setState({ kind: 'empty' }); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }

    let cancelled = false;
    setState({ kind: 'loading' });

    async function loadFromGit() {
      try {
        const repoPath = projectRoot || await getProjectRoot().catch(() => '');
        if (!repoPath || cancelled) return;

        const gitStatus = await platform.git.status(repoPath);
        if (cancelled) return;

        if (gitStatus.files.length === 0) {
          setState({ kind: 'empty' });
          return;
        }

        const changes: PendingChange[] = [];
        const diffs: ReviewDiff[] = [];

        await Promise.all(
          gitStatus.files.map(async (f, i) => {
            const id = `git-${i}`;
            let rawDiff = '';
            try {
              rawDiff = await platform.git.diff(repoPath, f.path);
            } catch {
              // rawDiff stays '' — show empty diff, not an error
            }
            const { added, removed } = countDiffLines(rawDiff);
            const lines = parseDiffLines(rawDiff);

            const statusLabel: Record<string, string> = {
              M: t('review.status.modified'),
              A: t('review.status.added'),
              D: t('review.status.deleted'),
              '?': t('review.status.untracked'),
            };

            changes.push({
              id,
              title: f.path,
              worktree: `${statusLabel[f.status] ?? f.status} · ${gitStatus.branch}`,
              added,
              removed,
              author: 'user',
              status: 'local',
              isDemo: false,
            });

            diffs.push({
              changeId: id,
              files: [{ filename: f.path, added, removed, lines }],
            });
          })
        );

        if (!cancelled) {
          setState({ kind: 'data', changes, diffs });
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setState({ kind: 'error', message });
        }
      }
    }

    loadFromGit();
    return () => { cancelled = true; };
  }, [platform, projectRoot, t]);

  return { state };
}

// ── Comment thread types ───────────────────────────────────────────

interface Comment {
  id: string;
  text: string;
  author: 'user';
  createdAt: string;
}

// ── Types ──────────────────────────────────────────────────────────

interface ChangeListItemProps {
  change: PendingChange;
  selected: boolean;
  onSelect: () => void;
  isDemoMode: boolean;
}

interface DiffViewerProps {
  changeId: string;
  diffs: ReviewDiff[];
}

interface DiffLineRowProps {
  line: DiffLine;
}

interface ReviewActionsProps {
  change: PendingChange;
  repoPath: string;
  isDemoMode: boolean;
  diffs: ReviewDiff[];
  agentAvailable: boolean;
}

// ── Risk heuristic ─────────────────────────────────────────────────
//
// The actual keyword/threshold scoring now lives in src/lib/review/risk.ts
// (shared with DiffDrawer.tsx's own risk badge) — this thin adapter only
// shapes ReviewSpace's own PendingChange/ReviewDiff data model into that
// module's generic { title, content, removed } input, so both surfaces stay
// on the exact same heuristic instead of two copies drifting apart.

interface HeuristicRisk {
  level: RiskLevel;
  reasons: string[];
}

function computeChangeRisk(change: PendingChange, diffs: ReviewDiff[]): HeuristicRisk {
  const diff = diffs.find(d => d.changeId === change.id);
  const content = diff
    ? diff.files.flatMap(f => f.lines.map(l => l.content)).join('\n')
    : change.title;
  return computeHeuristicRisk({ title: change.title, content, removed: change.removed });
}

// ── Sub-components ──────────────────────────────────────────────────

function DemoBadge() {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      padding: '2px 7px',
      borderRadius: 4,
      background: 'rgba(255,199,107,0.12)',
      color: '#FFC76B',
      border: '1px solid rgba(255,199,107,0.3)',
    }}>
      DEMO
    </span>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.1em',
      textTransform: 'uppercase',
      color: 'rgba(255,255,255,0.25)',
      padding: '10px 14px 6px',
    }}>
      {children}
    </div>
  );
}

function AuthorBadge({ author }: { author: 'agent' | 'user' }) {
  const { t } = useI18n();
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 700,
      padding: '2px 6px',
      borderRadius: 4,
      background: author === 'agent' ? 'rgba(124,92,255,0.18)' : 'rgba(255,255,255,0.07)',
      color: author === 'agent' ? '#A78BFF' : 'rgba(255,255,255,0.45)',
      textTransform: 'uppercase',
    }}>
      {author === 'agent' ? t('review.author.agent') : t('review.author.you')}
    </span>
  );
}

// ── Risk badge ─────────────────────────────────────────────────────

const RISK_COLOR: Record<RiskLevel, string> = {
  low:    '#66E27A',
  medium: '#FFC76B',
  high:   '#FF7B7B',
};
const RISK_BG: Record<RiskLevel, string> = {
  low:    'rgba(102,226,122,0.12)',
  medium: 'rgba(255,199,107,0.12)',
  high:   'rgba(255,123,123,0.12)',
};

function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 700,
      padding: '2px 6px',
      borderRadius: 4,
      background: RISK_BG[level],
      color: RISK_COLOR[level],
      border: `1px solid ${RISK_COLOR[level]}33`,
      textTransform: 'uppercase',
    }}>
      {level}
    </span>
  );
}

// ── Verdict badge ──────────────────────────────────────────────────

const VERDICT_COLOR: Record<ReviewerVerdict['verdict'], string> = {
  approve:         '#66E27A',
  request_changes: '#FFC76B',
  reject:          '#FF7B7B',
};
function VerdictBadge({ verdict }: { verdict: ReviewerVerdict['verdict'] }) {
  const { t } = useI18n();
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 700,
      padding: '2px 6px',
      borderRadius: 4,
      background: `${VERDICT_COLOR[verdict]}18`,
      color: VERDICT_COLOR[verdict],
      border: `1px solid ${VERDICT_COLOR[verdict]}33`,
      textTransform: 'uppercase',
    }}>
      {t(`review.verdictLabel.${verdict}`)}
    </span>
  );
}

// ── JudgeVerdictPanel ──────────────────────────────────────────────

interface JudgeVerdictPanelProps {
  verdict: JudgeVerdict;
  isDemoMode: boolean;
}

function JudgeVerdictPanel({ verdict, isDemoMode }: JudgeVerdictPanelProps) {
  const { t } = useI18n();
  const scoreColor = verdict.score >= 80 ? '#66E27A' : verdict.score >= 60 ? '#FFC76B' : '#FF7B7B';

  return (
    <div style={{
      border: '1px solid var(--color-border)',
      borderRadius: 8,
      overflow: 'hidden',
      marginTop: 12,
    }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px',
        background: 'rgba(255,255,255,0.03)',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '0.06em' }}>
          {t('review.verdict')}
        </span>
        {isDemoMode && <DemoBadge />}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
          {new Date(verdict.createdAt).toLocaleString(undefined, {
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
          })}
        </span>
      </div>

      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Score + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            border: `2px solid ${scoreColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: scoreColor }}>{verdict.score}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: verdict.passed ? '#66E27A' : '#FF7B7B' }}>
                {verdict.passed ? t('review.passed') : t('review.rejected')}
              </span>
              <RiskBadge level={verdict.risk} />
            </div>
            {verdict.tests && (
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                <span style={{ color: '#66E27A' }}>{t('review.testsPassed', { count: verdict.tests.passed })}</span>
                {verdict.tests.failed > 0 && (
                  <span style={{ color: '#FF7B7B', marginLeft: 6 }}>{t('review.testsFailed', { count: verdict.tests.failed })}</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Reviewer list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {verdict.reviewers.map((rv, i) => (
            <div key={i} style={{
              padding: '6px 8px',
              background: 'rgba(255,255,255,0.025)',
              borderRadius: 6,
              border: '1px solid var(--color-border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase' }}>
                  {rv.role}
                </span>
                <VerdictBadge verdict={rv.verdict} />
                {rv.score !== undefined && (
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginLeft: 'auto' }}>
                    {rv.score}/100
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.4 }}>
                {rv.summary}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── No-verdict state ───────────────────────────────────────────────

function NoVerdictState() {
  const { t } = useI18n();
  return (
    <div style={{
      padding: '10px 12px',
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid var(--color-border)',
      borderRadius: 8,
      marginTop: 12,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.35)', marginBottom: 4 }}>
        {t('review.verdict')}
      </div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', lineHeight: 1.5 }}>
        {t('review.noVerdict')}
      </div>
    </div>
  );
}

// ── Heuristic risk panel ───────────────────────────────────────────

interface HeuristicRiskPanelProps {
  change: PendingChange;
  diffs: ReviewDiff[];
}

function HeuristicRiskPanel({ change, diffs }: HeuristicRiskPanelProps) {
  const { t } = useI18n();
  const { level, reasons } = computeChangeRisk(change, diffs);

  return (
    <div style={{
      padding: '8px 12px',
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid var(--color-border)',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: reasons.length > 0 ? 6 : 0 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {t('review.heuristicRisk')}
        </span>
        <RiskBadge level={level} />
      </div>
      {reasons.length > 0 ? (
        <ul style={{ margin: 0, padding: '0 0 0 14px', listStyle: 'disc' }}>
          {reasons.map((r, i) => (
            <li key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5 }}>{r}</li>
          ))}
        </ul>
      ) : (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
          {t('review.noRiskSignals')}
        </div>
      )}
    </div>
  );
}

function ChangeListItem({ change, selected, onSelect, isDemoMode }: ChangeListItemProps) {
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'block',
        width: '100%',
        padding: '10px 14px',
        background: selected ? 'rgba(124,92,255,0.1)' : 'transparent',
        border: 'none',
        borderLeft: selected ? '2px solid #7C5CFF' : '2px solid transparent',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'inherit',
        transition: 'background 0.12s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: selected ? 'var(--color-accent-light)' : 'var(--color-text)' }}>
          {change.title}
        </span>
        <AuthorBadge author={change.author} />
        {isDemoMode && change.isDemo && <DemoBadge />}
        {change.judgesApproved && (
          <span style={{ fontSize: 9, color: '#66E27A', marginLeft: 'auto' }}>
            {change.judgesApproved}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', display: 'flex', gap: 8 }}>
        <span>{change.worktree}</span>
        <span style={{ color: '#66E27A' }}>+{change.added}</span>
        <span style={{ color: '#FF7B7B' }}>-{change.removed}</span>
      </div>
    </button>
  );
}

function DiffLineRow({ line }: DiffLineRowProps) {
  const BG: Record<string, string> = {
    add:     'rgba(34,197,94,0.08)',
    remove:  'rgba(255,82,82,0.08)',
    hunk:    'rgba(124,92,255,0.08)',
    context: 'transparent',
  };
  const COLOR: Record<string, string> = {
    add:     '#86EFAC',
    remove:  '#FCA5A5',
    hunk:    '#A78BFF',
    context: 'rgba(255,255,255,0.5)',
  };
  const PREFIX: Record<string, string> = {
    add:     '+',
    remove:  '-',
    hunk:    '',
    context: ' ',
  };

  return (
    <div style={{
      display: 'flex',
      background: BG[line.type],
      padding: '1px 0',
    }}>
      <span style={{
        width: 20,
        textAlign: 'center',
        color: COLOR[line.type],
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        flexShrink: 0,
        opacity: 0.7,
      }}>
        {PREFIX[line.type]}
      </span>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: COLOR[line.type],
        whiteSpace: 'pre',
        overflowX: 'auto',
      }}>
        {line.content}
      </span>
    </div>
  );
}

function DiffViewer({ changeId, diffs }: DiffViewerProps) {
  const { t } = useI18n();
  const diff = diffs.find(d => d.changeId === changeId);
  if (!diff) return (
    <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>
      {t('review.noDiff')}
    </div>
  );

  return (
    <div style={{ overflow: 'auto', flex: 1 }}>
      {diff.files.map((file, fi) => (
        <div key={fi} style={{ marginBottom: 20 }}>
          {/* File header */}
          <div style={{
            padding: '8px 14px',
            background: 'rgba(255,255,255,0.04)',
            borderBottom: '1px solid var(--color-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)', fontWeight: 600 }}>
              {file.filename}
            </span>
            <span style={{ fontSize: 11, color: '#86EFAC' }}>+{file.added}</span>
            <span style={{ fontSize: 11, color: '#FCA5A5' }}>-{file.removed}</span>
          </div>
          {/* Full diff — no truncation */}
          <div>
            {file.lines.map((line, li) => (
              <DiffLineRow key={li} line={line} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReviewActions({ change, repoPath, isDemoMode, diffs, agentAvailable }: ReviewActionsProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [approving, setApproving] = useState(false);
  const [changeRequestSent, setChangeRequestSent] = useState(false);
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentInput, setCommentInput] = useState('');
  const commentInputRef = useRef<HTMLTextAreaElement>(null);

  // Feature-detect 'gh' CLI once on mount
  useEffect(() => {
    async function detectGh() {
      const platform = getPlatform();
      if (platform.name !== 'tauri') {
        setGhAvailable(false);
        return;
      }
      try {
        const proc = await platform.terminal.spawn('gh', ['--version']);
        let output = '';
        const unsubData = proc.onData(d => { output += d; });
        await new Promise<void>(resolve => {
          const unsubExit = proc.onExit(() => { resolve(); });
          // Safety timeout — if no exit in 3s, assume not found
          setTimeout(() => { unsubExit(); resolve(); }, 3000);
        });
        unsubData();
        setGhAvailable(output.includes('gh version'));
      } catch {
        setGhAvailable(false);
      }
    }
    detectGh();
  }, []);

  async function handleApprove() {
    if (approving) return;
    setApproving(true);

    const platform = getPlatform();
    const git = platform.git as ExtendedGit;

    try {
      if (isDemoMode) {
        throw new Error('not available in the browser');
      }

      // Collect file paths for this change
      const filePaths = [change.title]; // title is the file path in real git mode

      // Stage files
      if (git.stage) {
        await git.stage(repoPath, filePaths);
      }

      // Commit
      const message = `review: approve ${change.title}`;
      await git.commit(repoPath, message);

      toast(t('review.approvedCommitted'), 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not available in the browser')) {
        toast(t('review.approveDemo'), 'warning');
      } else {
        toast(t('review.gitError', { msg }), 'error');
      }
    } finally {
      setApproving(false);
    }
  }

  function handleRequestChanges() {
    setChangeRequestSent(true);
    toast(t('review.changesRequested'), 'warning');
  }

  function handleCreatePr() {
    if (!ghAvailable) return;
    if (isDemoMode) {
      toast(t('review.prDemo'), 'warning');
      return;
    }
    // gh pr create would be triggered here via terminal if desired
    toast(t('review.prNotImplemented'), 'info');
  }

  function handleAddComment() {
    const text = commentInput.trim();
    if (!text) return;
    const newComment: Comment = {
      id: `c-${Date.now()}`,
      text,
      author: 'user',
      createdAt: new Date().toISOString(),
    };
    setComments(prev => [...prev, newComment]);
    setCommentInput('');
    if (commentInputRef.current) {
      commentInputRef.current.focus();
    }
  }

  function handleAskReviewer() {
    if (!agentAvailable) {
      toast(t('review.agentRuntimeUnavailable'), 'warning');
      return;
    }
    const diff = diffs.find(d => d.changeId === change.id);
    const fileList = diff ? diff.files.map(f => f.filename).join(', ') : change.title;
    emit('agent:launch', {
      task: `Review this diff for correctness, code quality, and potential issues.\nChange: ${change.title}\nFiles: ${fileList}\nAdded: ${change.added} lines, Removed: ${change.removed} lines.\nProvide a structured verdict: approve, request_changes, or reject with a summary.`,
      title: `Reviewer — ${change.title}`,
      model: 'Sonnet 4.6',
    });
    toast(t('review.reviewerLaunched'), 'success');
  }

  function handleAskTester() {
    if (!agentAvailable) {
      toast(t('review.agentRuntimeUnavailable'), 'warning');
      return;
    }
    const diff = diffs.find(d => d.changeId === change.id);
    const fileList = diff ? diff.files.map(f => f.filename).join(', ') : change.title;
    emit('agent:launch', {
      task: `Run tests and evaluate this diff for regressions and test coverage.\nChange: ${change.title}\nFiles: ${fileList}\nReport: tests passed, failed, and any new test cases needed.`,
      title: `Tester — ${change.title}`,
      model: 'Haiku 4.5',
    });
    toast(t('review.testerLaunched'), 'success');
  }

  const ghTooltip = ghAvailable === false
    ? t('review.ghNotFound')
    : ghAvailable === null
    ? t('review.ghDetecting')
    : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '16px 14px' }}>
      {/* Change info */}
      <div style={{ padding: '10px 12px', background: 'var(--color-panel-2)', borderRadius: 8, border: '1px solid var(--color-border)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)', marginBottom: 4 }}>{change.title}</div>
        {change.model && (
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginBottom: 2 }}>{t('review.model')}: {change.model}</div>
        )}
        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{change.worktree}</div>
        {change.judgesApproved && (
          <div style={{
            marginTop: 8,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            background: 'rgba(102,226,122,0.1)',
            border: '1px solid rgba(102,226,122,0.25)',
            borderRadius: 5,
            padding: '3px 8px',
            fontSize: 11,
            color: '#66E27A',
            fontWeight: 600,
          }}>
            {t('review.verifiedByJudges', { count: change.judgesApproved })}
            {change.isDemo && isDemoMode && (
              <span style={{ fontSize: 9, color: '#FFC76B', marginLeft: 4 }}>(demo)</span>
            )}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* Approuver */}
        <button
          disabled={approving}
          onClick={handleApprove}
          title={isDemoMode ? t('review.notAvailableDemo') : undefined}
          style={{
            padding: '8px 12px',
            background: 'rgba(102,226,122,0.1)',
            border: '1px solid rgba(102,226,122,0.3)',
            borderRadius: 7,
            color: '#66E27A',
            fontSize: 12,
            fontWeight: 500,
            cursor: approving ? 'wait' : 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
            opacity: approving ? 0.6 : 1,
            transition: 'opacity 0.12s',
          }}
          onMouseEnter={e => { if (!approving) (e.currentTarget as HTMLButtonElement).style.opacity = '0.75'; }}
          onMouseLeave={e => { if (!approving) (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
        >
          {approving ? t('review.inProgress') : t('review.approve')}
        </button>

        {/* Demander des changements */}
        <button
          onClick={handleRequestChanges}
          style={{
            padding: '8px 12px',
            background: changeRequestSent ? 'rgba(255,199,107,0.15)' : 'rgba(255,199,107,0.08)',
            border: `1px solid ${changeRequestSent ? 'rgba(255,199,107,0.5)' : 'rgba(255,199,107,0.25)'}`,
            borderRadius: 7,
            color: '#FFC76B',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
            transition: 'opacity 0.12s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.75'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
        >
          {changeRequestSent ? t('review.changesRequested') : t('review.requestChanges')}
        </button>

        {/* Creer la PR */}
        <button
          disabled={ghAvailable === false || ghAvailable === null}
          onClick={handleCreatePr}
          title={ghTooltip}
          style={{
            padding: '8px 12px',
            background: 'rgba(124,92,255,0.1)',
            border: '1px solid rgba(124,92,255,0.3)',
            borderRadius: 7,
            color: ghAvailable ? '#A78BFF' : 'rgba(167,139,255,0.4)',
            fontSize: 12,
            fontWeight: 500,
            cursor: ghAvailable ? 'pointer' : 'not-allowed',
            textAlign: 'left',
            fontFamily: 'inherit',
            opacity: ghAvailable ? 1 : 0.5,
            transition: 'opacity 0.12s',
          }}
        >
          {t('review.createPr')}
          {ghAvailable === false && (
            <span style={{ fontSize: 10, marginLeft: 6, color: 'rgba(255,255,255,0.3)' }}>({t('review.ghNotFoundShort')})</span>
          )}
        </button>
      </div>

      {/* Agent evaluation buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.25)', textTransform: 'uppercase', marginBottom: 2 }}>
          {t('review.agentEvaluation')}
        </div>
        <button
          onClick={handleAskReviewer}
          disabled={!agentAvailable}
          title={!agentAvailable ? t('review.agentRuntimeUnavailable') : t('review.reviewerTooltip')}
          style={{
            padding: '7px 12px',
            background: agentAvailable ? 'rgba(124,92,255,0.1)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${agentAvailable ? 'rgba(124,92,255,0.3)' : 'rgba(255,255,255,0.08)'}`,
            borderRadius: 7,
            color: agentAvailable ? '#A78BFF' : 'rgba(255,255,255,0.25)',
            fontSize: 12,
            fontWeight: 500,
            cursor: agentAvailable ? 'pointer' : 'not-allowed',
            textAlign: 'left',
            fontFamily: 'inherit',
            transition: 'opacity 0.12s',
          }}
          onMouseEnter={e => { if (agentAvailable) (e.currentTarget as HTMLButtonElement).style.opacity = '0.75'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
        >
          {t('review.askReviewer')}
          {!agentAvailable && (
            <span style={{ fontSize: 10, marginLeft: 6, color: 'rgba(255,255,255,0.2)' }}>({t('review.notAvailableShort')})</span>
          )}
        </button>
        <button
          onClick={handleAskTester}
          disabled={!agentAvailable}
          title={!agentAvailable ? t('review.agentRuntimeUnavailable') : t('review.testerTooltip')}
          style={{
            padding: '7px 12px',
            background: agentAvailable ? 'rgba(102,226,122,0.08)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${agentAvailable ? 'rgba(102,226,122,0.2)' : 'rgba(255,255,255,0.08)'}`,
            borderRadius: 7,
            color: agentAvailable ? '#66E27A' : 'rgba(255,255,255,0.25)',
            fontSize: 12,
            fontWeight: 500,
            cursor: agentAvailable ? 'pointer' : 'not-allowed',
            textAlign: 'left',
            fontFamily: 'inherit',
            transition: 'opacity 0.12s',
          }}
          onMouseEnter={e => { if (agentAvailable) (e.currentTarget as HTMLButtonElement).style.opacity = '0.75'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
        >
          {t('review.askTester')}
          {!agentAvailable && (
            <span style={{ fontSize: 10, marginLeft: 6, color: 'rgba(255,255,255,0.2)' }}>({t('review.notAvailableShort')})</span>
          )}
        </button>
      </div>

      {/* Heuristic risk */}
      <HeuristicRiskPanel change={change} diffs={diffs} />

      {/* Judge verdict — show real verdict or honest no-verdict state */}
      {change.judgeVerdict
        ? <JudgeVerdictPanel verdict={change.judgeVerdict} isDemoMode={isDemoMode} />
        : <NoVerdictState />
      }

      {/* Comment thread */}
      <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 12 }}>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {t('review.comments')} {comments.length > 0 && `(${comments.length})`}
        </div>

        {/* Existing comments */}
        {comments.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {comments.map(c => (
              <div key={c.id} style={{
                padding: '7px 10px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
              }}>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginBottom: 3 }}>
                  {t('review.author.you')} — {new Date(c.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text)', lineHeight: 1.4 }}>{c.text}</div>
              </div>
            ))}
          </div>
        )}

        {/* Input area */}
        <textarea
          ref={commentInputRef}
          value={commentInput}
          onChange={e => setCommentInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleAddComment();
            }
          }}
          placeholder={t('review.commentPlaceholder')}
          rows={2}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 10px',
            background: 'transparent',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--color-text)',
            fontFamily: 'inherit',
            resize: 'vertical',
            outline: 'none',
            minHeight: 48,
          }}
        />
        {commentInput.trim().length > 0 && (
          <button
            onClick={handleAddComment}
            style={{
              marginTop: 6,
              padding: '5px 12px',
              background: 'rgba(124,92,255,0.15)',
              border: '1px solid rgba(124,92,255,0.3)',
              borderRadius: 5,
              color: '#A78BFF',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('review.send')}
          </button>
        )}
      </div>
    </div>
  );
}

// ── ReviewSpace ────────────────────────────────────────────────────
//
// useAgentAvailable now lives in src/lib/review/agentAvailability.ts (shared
// with DiffDrawer.tsx's "Send an agent" affordance) — same routing-table
// mirror (isManagedAgentAvailable() checked before isLiveAgentAvailable(),
// matching planAndAct() in runtime.ts) previously duplicated here.

export function ReviewSpace() {
  const { t } = useI18n();
  const { state } = useGitReview();
  const { projectRoot } = useAppContext();
  const platform = getPlatform();
  const repoPath = projectRoot || '';
  const agentAvailable = useAgentAvailable();

  const [selectedId, setSelectedId] = useState<string>('');

  const isDemoMode = false;
  const changes = useMemo(
    () => (state.kind === 'data' ? state.changes : []),
    [state],
  );
  const diffs = state.kind === 'data' ? state.diffs : [];

  // Update selectedId when changes load
  useEffect(() => {
    if (changes.length > 0 && !changes.find(c => c.id === selectedId)) {
      setSelectedId(changes[0].id); // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [changes, selectedId]);

  const selectedChange = changes.find(c => c.id === selectedId) ?? changes[0];

  if (state.kind === 'loading') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
        <Spinner size={24} />
        <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{t('review.loadingGit')}</span>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <EmptyState
        icon="!"
        title={t('review.gitReadError')}
        subtitle={state.message}
      />
    );
  }

  if (state.kind === 'empty') {
    const inBrowser = platform.name !== 'tauri';
    return (
      <EmptyState
        icon="*"
        title={t(inBrowser ? 'review.browserNoGit' : 'review.noChanges')}
        subtitle={t(inBrowser ? 'review.browserNoGitDesc' : 'review.noChangesDesc')}
      />
    );
  }

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      overflow: 'hidden',
      background: 'var(--color-bg)',
    }}>
      {/* Left: change list */}
      <div style={{
        width: 230,
        flexShrink: 0,
        borderRight: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--color-panel)',
      }}>
        <div style={{ padding: '14px 14px 4px', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>{t('review.title')}</div>
            {isDemoMode && <DemoBadge />}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
            {t('review.changesPending', { count: changes.length })}
          </div>
        </div>
        <SectionLabel>{t('review.pending')}</SectionLabel>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {changes.map(change => (
            <ChangeListItem
              key={change.id}
              change={change}
              selected={change.id === selectedId}
              onSelect={() => setSelectedId(change.id)}
              isDemoMode={isDemoMode}
            />
          ))}
        </div>
      </div>

      {/* Center: diff viewer */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minWidth: 0,
      }}>
        {/* Diff header */}
        {selectedChange && (
          <div style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--color-border)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: 'var(--color-chrome)',
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
              {selectedChange.title}
            </span>
            <span style={{ fontSize: 11, color: '#86EFAC' }}>+{selectedChange.added}</span>
            <span style={{ fontSize: 11, color: '#FCA5A5' }}>-{selectedChange.removed}</span>
          </div>
        )}
        {selectedChange && <DiffViewer changeId={selectedId} diffs={diffs} />}
      </div>

      {/* Right: review actions */}
      {selectedChange && (
        <div style={{
          width: 260,
          flexShrink: 0,
          borderLeft: '1px solid var(--color-border)',
          overflow: 'auto',
          background: 'var(--color-panel)',
        }}>
          <ReviewActions
            change={selectedChange}
            repoPath={repoPath}
            isDemoMode={isDemoMode || platform.name !== 'tauri'}
            diffs={diffs}
            agentAvailable={agentAvailable}
          />
        </div>
      )}
    </div>
  );
}
