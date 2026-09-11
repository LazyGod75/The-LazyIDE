/* MissionDetail — full drill-in view for a mission.

   Split across several files for cohesion/size (each self-contained, "should
   I render" decided internally, matching the existing MissionDetailRight/
   MissionDetailJudge convention):
     - MissionDetailControls   — Stop/Pause/Resume, Approve/Reject, Retry/
                                  Delete, loop toggles (per mission.status).
     - MissionDetailTranscript — action timeline + replay.
     - MissionDetailIntervene  — live-steering input box.
   This file keeps the header/layout composition, the "Save as Agent" wizard
   wiring, and the review-pipeline handlers (handleRunReview/handleRunTests)
   that MissionDetailJudge needs.
*/

import { useState, useCallback, useEffect } from 'react';
import type { Mission, MissionStatus, JudgeVerdict, AgentMetrics } from '../../lib/agents/types';
import type { MissionFocusSection } from '../../lib/bus';
import { MissionDetailPlan } from './MissionDetailPlan';
import { MissionDetailRight } from './MissionDetailRight';
import { MissionDetailJudge } from './MissionDetailJudge';
import { MissionDetailControls } from './MissionDetailControls';
import { MissionDetailTranscript } from './MissionDetailTranscript';
import { MissionDetailIntervene } from './MissionDetailIntervene';
import { MissionDetailCheckpoints } from './MissionDetailCheckpoints';
import { MissionMailbox } from './MissionMailbox';
import { MissionManagerAdvice } from './MissionManagerAdvice';
import { useAgentsStoreActions, resolveProjectRoot } from './agentsStore';
import { isManagedAgentAvailable } from '../../lib/agents/runtime';
import { AgentWizard } from './library/AgentWizard';
import { createNewAgent } from '../../lib/agents/agentDef';
import type { LazyAgent } from '../../lib/agents/agentDef';
import { saveAgent } from '../../lib/agents/agentsStorage';
import { useToast } from '../ui';
import { evaluateMission, deriveJudgesApproved, resolveWorktreePath } from '../../lib/agents/evaluator';
import { LearningInsights } from './LearningInsights';
import { RunHistoryDrawer } from './canvas/history/RunHistoryDrawer';
import { DataInspector } from './canvas/history/DataInspector';
import { useI18n } from '../../i18n';

interface MissionDetailProps {
  mission: Mission;
  onBack: () => void;
  /**
   * 'page' (default) — the pre-D13 two-column desktop layout (full-page
   * swap). 'drawer' — single-column reflow for the 640px mission detail
   * drawer (D13/D14): the right column's cards stack below the left
   * column's instead of sitting beside it, everything else (Controls stay
   * at the top of the header block already, before this prop is even
   * consulted) is unchanged.
   */
  layout?: 'page' | 'drawer';
  /**
   * QA B14: which section to scroll+flash-highlight on mount — set when this
   * drawer was opened via the Cockpit urgent card's "Diff" or "Logs" action
   * (see AgentsSpace.tsx's mission:focusSection subscriber, which is the
   * only current producer). `undefined`/`null` for every other entry point
   * (card double-click, attention inbox, etc.) — those keep landing at the
   * top of the drawer exactly as before.
   */
  focusSection?: MissionFocusSection | null;
  /** Called once the focus request above has been applied (or found nothing
   *  to scroll to) — lets the owner (AgentsSpace.tsx) clear its pending
   *  state so re-renders don't re-trigger the scroll/flash. */
  onFocusHandled?: () => void;
}

// ── Status pill ────────────────────────────────────────────────────

function StatusPill({ status, paused }: { status: MissionStatus; paused?: boolean }) {
  const { t } = useI18n();

  // Paused is a sub-state of 'running' (see Mission.paused's doc comment in
  // lib/agents/types.ts), not a separate MissionStatus value — rendered as
  // its own badge here so it reads honestly, without needing a new status
  // literal (which would ripple into MissionTimeline/MissionList/
  // MissionCalendar's exhaustive Record<MissionStatus,...> maps elsewhere).
  if (status === 'running' && paused) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 10px',
          borderRadius: 6,
          background: 'rgba(56,189,248,0.15)',
          color: '#38BDF8',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {t('agents.status.paused')}
      </span>
    );
  }

  const cfg: Record<MissionStatus, { bg: string; color: string }> = {
    queued: { bg: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.5)' },
    running: { bg: 'rgba(124,92,255,0.18)', color: '#C4B5FD' },
    review: { bg: 'rgba(251,185,36,0.15)', color: '#FBB924' },
    done: { bg: 'rgba(34,197,94,0.12)', color: '#4ADE80' },
    failed: { bg: 'rgba(239,68,68,0.12)', color: '#F87171' },
    cancelled: { bg: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.35)' },
  };
  const { bg, color } = cfg[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        borderRadius: 6,
        background: bg,
        color,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {status === 'running' && <span className="agent-live-dot" />}
      {t(`agents.status.${status}`)}
    </span>
  );
}

// ── Meta chip ──────────────────────────────────────────────────────

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 5,
        background: 'rgba(255,255,255,0.06)',
        color: 'rgba(255,255,255,0.5)',
        fontSize: 11,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      }}
    >
      {children}
    </span>
  );
}

// ── Section box ────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'rgba(255,255,255,0.35)',
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Observability metrics row ─────────────────────────────────────

function ObservabiliteRow({ metrics }: { metrics: AgentMetrics }) {
  const { t } = useI18n();
  const durationSec = (metrics.durationMs / 1000).toFixed(1);
  const costStr = metrics.costUsd > 0
    ? Math.round(metrics.costUsd * 100).toLocaleString('fr-FR')
    : '—';
  const tokensIn = metrics.inputTokens > 0 ? metrics.inputTokens.toLocaleString() : '—';
  const tokensOut = metrics.outputTokens > 0 ? metrics.outputTokens.toLocaleString() : '—';

  const items: Array<{ label: string; value: string }> = [
    { label: t('agents.detail.metricDuration'), value: `${durationSec}s` },
    { label: t('agents.detail.metricTokensIn'), value: tokensIn },
    { label: t('agents.detail.metricTokensOut'), value: tokensOut },
    { label: t('agents.detail.metricCost'), value: costStr },
    { label: t('agents.detail.metricToolCalls'), value: String(metrics.toolCount) },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
        gap: 8,
      }}
    >
      {items.map(({ label, value }) => (
        <div
          key={label}
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 6,
            padding: '7px 10px',
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.35)',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 3,
            }}
          >
            {label}
          </div>
          <div
            style={{
              fontSize: 13,
              color: value === '—' ? 'rgba(255,255,255,0.25)' : '#E2E2F0',
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontWeight: 500,
            }}
          >
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────

// Fallback repo path for platform.tests.run() only (handleRunTests below).
// Worktree/evaluation operations use the real resolveProjectRoot() (shared
// from agentsStore.tsx, imported above) instead — see its doc comment for
// why '.' is unsafe there: evaluateMission's tester role (managed mode)
// shells out via run_shell using a worktree path derived from repoPath as
// its cwd, and a literal '.' made that derived path relative (e.g.
// './.lazy/worktrees/…'), which crashed the Rust side's canonicalize() with
// "path canonicalize failed" — Path::canonicalize() resolves a relative path
// against the Tauri process's own cwd, not the project root, and the
// worktree does not exist there. REVIEWER/SECURITY/JUDGE never hit this: in
// managed mode they call the LLM directly with no cwd/filesystem access (see
// evaluator.ts's runManagedEvaluatorAgent), so only the tester role was ever
// affected.
const DEFAULT_REPO = '.';

export function MissionDetail({ mission, onBack, layout = 'page', focusSection, onFocusHandled }: MissionDetailProps) {
  const isDrawer = layout === 'drawer';
  const [saveAsAgentOpen, setSaveAsAgentOpen] = useState(false);
  const [evalRunning, setEvalRunning] = useState(false);
  const { updateMission } = useAgentsStoreActions();
  const { toast } = useToast();
  const { t, locale } = useI18n();

  // QA B14: "Diff" and "Logs" used to both just open this drawer with no
  // further signal, landing on the identical top-of-drawer view. When a
  // section was requested, scroll straight to it (DiffCard for 'diff',
  // MissionDetailTranscript for 'logs' — see their "mission-diff-card" /
  // "mission-transcript-section" ids) and apply a brief highlight so the
  // two actions are visibly distinct. Honest no-op when the section has
  // nothing to show yet (e.g. a 'diff' request on a mission with no
  // diffFiles/diffSnippet — DiffCard renders null, so there's no element
  // to find) — never fakes a scroll/highlight that didn't happen.
  useEffect(() => {
    if (!focusSection) return;
    // W8b: 'history' scrolls to the « Historique » section (RunHistoryDrawer)
    // — same scroll+flash mechanics as diff/logs, same honest no-op when the
    // element is absent.
    const targetId =
      focusSection === 'diff'
        ? 'mission-diff-card'
        : focusSection === 'history'
        ? 'mission-history-section'
        : 'mission-transcript-section';
    const el = document.getElementById(targetId);
    if (!el) {
      onFocusHandled?.();
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('focus-flash');
    const clearTimer = setTimeout(() => el.classList.remove('focus-flash'), 1400);
    onFocusHandled?.();
    return () => clearTimeout(clearTimer);
    // onFocusHandled intentionally excluded below: AgentsSpace.tsx passes a
    // fresh closure each render, and including it would re-run this effect
    // (and re-scroll) on every unrelated parent re-render instead of once
    // per focus request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSection, mission.id]);

  // Computed once and passed down to MissionDetailControls/MissionDetailIntervene
  // so every consumer of the managed-vs-native honesty distinction agrees.
  const isManagedEngine = isManagedAgentAvailable();

  /** Build a pre-filled agent from this mission. */
  function buildAgentFromMission(): LazyAgent {
    const name = mission.title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);

    const modelTier = mission.model?.toLowerCase().includes('haiku')
      ? ('haiku' as const)
      : mission.model?.toLowerCase().includes('opus')
      ? ('opus' as const)
      : ('sonnet' as const);

    return createNewAgent({
      name: name || 'mission-agent',
      displayName: mission.title.slice(0, 60),
      description: `Agent derived from mission: ${mission.title}. Use this agent to repeat or adapt the task originally performed in this mission.`,
      systemPrompt: `You are an autonomous agent. Your task: ${mission.title}. Complete it fully and autonomously.`,
      modelTier,
      isolation: 'worktree',
      scope: 'project',
      triggers: { manual: true },
    });
  }

  async function handleSaveAgent(agent: LazyAgent) {
    await saveAgent(agent.scope, agent);
    setSaveAsAgentOpen(false);
  }

  /** Trigger the full evaluation pipeline (tester + reviewer + security + judge). */
  const handleRunReview = useCallback(async () => {
    if (evalRunning) return;
    setEvalRunning(true);
    try {
      const repoPath = await resolveProjectRoot();
      // Compute the mission's real worktree directory up front instead of
      // leaning on evaluateMission's own repoPath-only fallback, so the
      // tester's cwd is always correct — see resolveWorktreePath's doc
      // comment in evaluator.ts for the Windows \\?\ separator-mixing bug
      // this avoids (repoPath is a canonicalize()'d, \\?\-prefixed path;
      // joining it with a literal '/' broke Rust's Path::canonicalize()).
      const worktreePath = resolveWorktreePath(repoPath, mission);
      const verdict = await evaluateMission(mission, {
        repoPath,
        worktreePath,
        onProgress: (msg) => {
          const now = new Date();
          const timeLabel = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          const currentTimeline = mission.actionTimeline ?? [];
          updateMission({
            id: mission.id,
            patch: {
              actionTimeline: [
                ...currentTimeline.map((e) => ({ ...e, isLive: false })),
                { time: timeLabel, text: `[eval] ${msg}`, isLive: true },
              ],
            },
          });
        },
      });

      const judgeVerdict: JudgeVerdict = verdict;
      updateMission({
        id: mission.id,
        patch: {
          judgeVerdict,
          judgesApproved: deriveJudgesApproved(judgeVerdict),
          actionTimeline: [
            ...(mission.actionTimeline ?? []).map((e) => ({ ...e, isLive: false })),
            {
              time: new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
              text: t('mission.detail.evalText', {
                score: String(judgeVerdict.score),
                result: judgeVerdict.passed ? t('mission.detail.evalPassed') : t('mission.detail.evalFailed'),
              }),
              isLive: false,
            },
          ],
        },
      });

      toast(
        judgeVerdict.passed
          ? t('mission.detail.evalCompleted', { score: String(judgeVerdict.score) })
          : t('mission.detail.evalRejected', { score: String(judgeVerdict.score) }),
        judgeVerdict.passed ? 'success' : 'error',
      );
    } catch (err) {
      toast(t('mission.detail.evalError', { msg: String(err).slice(0, 80) }), 'error');
    } finally {
      setEvalRunning(false);
    }
  }, [evalRunning, mission, updateMission, toast, locale, t]);

  /** Run tests only via platform.tests.run() — lighter than the full pipeline. */
  const handleRunTests = useCallback(async () => {
    if (evalRunning) return;
    setEvalRunning(true);
    try {
      const { getPlatform } = await import('../../lib/platform');
      const platform = getPlatform();
      const result = await platform.tests.run(DEFAULT_REPO);
      const now = new Date();
      const timeLabel = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      const currentVerdict = mission.judgeVerdict;
      const updatedVerdict: JudgeVerdict = {
        score: currentVerdict?.score ?? (result.ok ? 80 : 30),
        passed: currentVerdict?.passed ?? result.ok,
        risk: currentVerdict?.risk ?? (result.ok ? 'low' : 'high'),
        reviewers: currentVerdict?.reviewers ?? [],
        tests: { passed: result.passed, failed: result.failed },
        createdAt: now.toISOString(),
      };

      updateMission({
        id: mission.id,
        patch: {
          judgeVerdict: updatedVerdict,
          actionTimeline: [
            ...(mission.actionTimeline ?? []).map((e) => ({ ...e, isLive: false })),
            {
              time: timeLabel,
              text: `[tests] ${result.passed} passed, ${result.failed} failed (${result.durationMs}ms)`,
              isLive: false,
            },
          ],
        },
      });

      toast(
        result.ok
          ? t('mission.detail.testsPassedToast', { count: String(result.passed) })
          : t('mission.detail.testsFailedToast', { failed: String(result.failed), total: String(result.total) }),
        result.ok ? 'success' : 'error',
      );
    } catch {
      // Tests runner unavailable in web/mock mode
      toast(t('mission.detail.testRunnerUnavailable'), 'error');
    } finally {
      setEvalRunning(false);
    }
  }, [evalRunning, mission, updateMission, toast, t]);

  return (
    <div data-testid="mission-detail" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={onBack}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            background: 'none',
            border: 'none',
            color: '#A78BFF',
            fontSize: 12,
            cursor: 'pointer',
            padding: '0 0 10px',
            fontFamily: 'inherit',
          }}
        >
          ← {t('agents.missionControl')}
        </button>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <h1
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 700,
              color: '#E2E2F0',
              flex: 1,
              lineHeight: 1.25,
            }}
          >
            {mission.title}
          </h1>
          <StatusPill status={mission.status} paused={mission.paused} />
        </div>

        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {mission.model && <MetaChip>{mission.model}</MetaChip>}
          {mission.worktree && <MetaChip>{mission.worktree}</MetaChip>}
          {mission.cost && <MetaChip>{mission.cost}</MetaChip>}
          {mission.duration && <MetaChip>{mission.duration}</MetaChip>}
          {mission.filesCount !== undefined && <MetaChip>{t('agents.detail.filesCount', { count: String(mission.filesCount) })}</MetaChip>}
          {mission.progress !== undefined && mission.status === 'running' && (
            <MetaChip>{mission.progress}%</MetaChip>
          )}
          {mission.loopConfig && (
            <MetaChip>
              <span style={{ color: '#a78bfa' }}>loop {mission.loopConfig.cadence}</span>
              {' '}#{mission.loopConfig.iterationCount}
              {mission.loopConfig.enabled ? '' : ' (paused)'}
            </MetaChip>
          )}
          {mission.loopParentId && mission.loopIteration && (
            <MetaChip>
              <span style={{ color: '#a78bfa' }}>iter #{mission.loopIteration}</span>
            </MetaChip>
          )}
        </div>

        <MissionDetailControls
          mission={mission}
          onBack={onBack}
          onSaveAsAgent={() => setSaveAsAgentOpen(true)}
          isManagedEngine={isManagedEngine}
        />
      </div>

      <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', marginBottom: 20 }} />

      {/* Two columns on 'page' layout; single column (right stacks below left) on 'drawer' — see MissionDetailProps.layout's doc comment */}
      <div style={{ display: 'flex', flexDirection: isDrawer ? 'column' : 'row', gap: 20, alignItems: isDrawer ? 'stretch' : 'flex-start', minWidth: 0 }}>
        {/* Left ~60% (100% on drawer) */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <MissionManagerAdvice mission={mission} />

          {mission.planSteps && mission.planSteps.length > 0 && (
            <Section title={t('agents.detail.sectionPlan')}>
              <MissionDetailPlan planSteps={mission.planSteps} />
            </Section>
          )}

          <MissionDetailTranscript mission={mission} />

          <MissionDetailCheckpoints mission={mission} />

          {/* Observability — per-run metrics, visible only when emitted by the live runner */}
          {mission.agentMetrics && (
            <Section title={t('agents.detail.sectionObservability')}>
              <ObservabiliteRow metrics={mission.agentMetrics} />
            </Section>
          )}

          <MissionDetailIntervene mission={mission} isManagedEngine={isManagedEngine} />

          <MissionMailbox mission={mission} />

          {/* W8b — structured data inspector (« Données »): task/output/tool
              calls/metrics/verdict, Table/JSON + search. */}
          <div id="mission-data-section">
            <Section title={t('canvas.inspector.sectionTitle')}>
              <DataInspector mission={mission} />
            </Section>
          </div>

          {/* W8b — journal run history (« Historique »): stage Gantt, event
              log, chain fires, totals, project archive. Stable id so the
              focusSection effect (section 'history') can scroll here. */}
          <div id="mission-history-section">
            <Section title={t('canvas.history.sectionTitle')}>
              <RunHistoryDrawer mission={mission} />
            </Section>
          </div>

          {/* Fallback for non-running missions */}
          {!mission.planSteps && !mission.actionTimeline && (
            <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: 13, padding: '20px 0' }}>
              {t('agents.detail.noDetails')}
            </div>
          )}
        </div>

        {/* Right column (340px fixed on 'page'; full-width, stacked below, on 'drawer') */}
        <div style={{ width: isDrawer ? '100%' : 340, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Learning insights — always visible when insights exist or brain adapted */}
          {(mission.learningInsights || mission.brainAdapted) && (
            <LearningInsights
              insights={mission.learningInsights ?? []}
              brainAdapted={mission.brainAdapted}
            />
          )}
          {/* Judge panel — only on review/done status */}
          {(mission.status === 'review' || mission.status === 'done') && (
            <MissionDetailJudge
              verdict={mission.judgeVerdict}
              isRunning={evalRunning}
              onRunReview={handleRunReview}
              onRunTests={handleRunTests}
            />
          )}
          <MissionDetailRight mission={mission} />
        </div>
      </div>

      {/* Save as Agent wizard — pre-filled from this mission */}
      {saveAsAgentOpen && (
        <AgentWizard
          initial={buildAgentFromMission()}
          onSave={handleSaveAgent}
          onTestNow={() => setSaveAsAgentOpen(false)}
          onClose={() => setSaveAsAgentOpen(false)}
        />
      )}
    </div>
  );
}
