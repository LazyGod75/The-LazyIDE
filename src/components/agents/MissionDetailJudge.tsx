/* MissionDetailJudge — displays the JudgeVerdict from the evaluation pipeline.
   Shows reviewer badges, score, risk level, and test counts.
   Renders an honest "unavailable" state when no verdict is present.
*/

import type { JudgeVerdict, ReviewerVerdict, RiskLevel } from '../../lib/agents/types';
import { isVerdictScoreAvailable } from '../../lib/agents/evaluator';
import { useI18n } from '../../i18n';

// ── Role badge config ──────────────────────────────────────────────

const ROLE_LABELS: Record<ReviewerVerdict['role'], string> = {
  tester: 'Tester',
  reviewer: 'Reviewer',
  security: 'Security',
  judge: 'Judge',
};

const VERDICT_CONFIG: Record<
  ReviewerVerdict['verdict'],
  { label: string; color: string; bg: string; border: string }
> = {
  approve: {
    label: 'Approve',
    color: '#4ADE80',
    bg: 'rgba(74,222,128,0.10)',
    border: 'rgba(74,222,128,0.30)',
  },
  request_changes: {
    label: 'Changes requested',
    color: '#FBB924',
    bg: 'rgba(251,185,36,0.10)',
    border: 'rgba(251,185,36,0.25)',
  },
  reject: {
    label: 'Reject',
    color: '#F87171',
    bg: 'rgba(248,113,113,0.10)',
    border: 'rgba(248,113,113,0.25)',
  },
};

const RISK_CONFIG: Record<RiskLevel, { label: string; color: string; bg: string }> = {
  low: { label: 'Low risk', color: '#4ADE80', bg: 'rgba(74,222,128,0.10)' },
  medium: { label: 'Medium risk', color: '#FBB924', bg: 'rgba(251,185,36,0.10)' },
  high: { label: 'High risk', color: '#F87171', bg: 'rgba(248,113,113,0.10)' },
};

// ── Sub-components ─────────────────────────────────────────────────

/**
 * R13 — "Verdict 0/100" residual fix: `verdict.scoreUnavailable` means
 * `score` is a `0` PLACEHOLDER (evaluator.ts's aggregateVerdict/
 * evaluateScripted/buildUnavailableVerdict — see JudgeVerdict's doc comment),
 * never a real evaluation result. R11 already fixed nodeChrome.tsx's node
 * chip for this; this ring was the residual surface R12's dogfood run still
 * saw it on. `available` gates the SAME shared rule (evaluator.ts's
 * `isVerdictScoreAvailable`, called once by the caller below) — an
 * unavailable score renders an honest neutral "—" ring instead of a
 * fabricated 0.
 */
function ScoreRing({ score, available }: { score: number; available: boolean }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const filled = available ? circumference * (score / 100) : 0;
  const color = !available ? 'rgba(255,255,255,0.35)' : score >= 80 ? '#4ADE80' : score >= 50 ? '#FBB924' : '#F87171';

  return (
    <div style={{ position: 'relative', width: 56, height: 56, flexShrink: 0 }}>
      <svg width="56" height="56" viewBox="0 0 56 56" style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx="28"
          cy="28"
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="4"
        />
        {available && (
          <circle
            cx="28"
            cy="28"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="4"
            strokeDasharray={`${filled} ${circumference - filled}`}
            strokeLinecap="round"
          />
        )}
      </svg>
      <span
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          fontWeight: 700,
          color,
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {available ? score : '—'}
      </span>
    </div>
  );
}

function ReviewerRow({ reviewer }: { reviewer: ReviewerVerdict }) {
  const vcfg = VERDICT_CONFIG[reviewer.verdict];
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 10px',
        borderRadius: 7,
        background: reviewer.role === 'judge' ? 'rgba(124,92,255,0.06)' : 'transparent',
        borderLeft: reviewer.role === 'judge' ? '2px solid rgba(124,92,255,0.35)' : '2px solid transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: 'rgba(255,255,255,0.45)',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            minWidth: 60,
          }}
        >
          {ROLE_LABELS[reviewer.role]}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '2px 8px',
            borderRadius: 4,
            background: vcfg.bg,
            border: `1px solid ${vcfg.border}`,
            color: vcfg.color,
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {vcfg.label}
        </span>
        {typeof reviewer.score === 'number' && (
          <span
            style={{
              fontSize: 10,
              color: 'rgba(255,255,255,0.35)',
              fontFamily: "'JetBrains Mono', monospace",
              marginLeft: 'auto',
            }}
          >
            {reviewer.score}/100
          </span>
        )}
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 11,
          color: 'rgba(255,255,255,0.5)',
          lineHeight: 1.5,
          paddingLeft: 68,
        }}
      >
        {reviewer.summary}
      </p>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────

interface MissionDetailJudgeProps {
  verdict: JudgeVerdict | undefined;
  isRunning: boolean;
  onRunReview: () => void;
  onRunTests: () => void;
}

export function MissionDetailJudge({
  verdict,
  isRunning,
  onRunReview,
  onRunTests,
}: MissionDetailJudgeProps) {
  const { t } = useI18n();
  const risk = verdict ? RISK_CONFIG[verdict.risk] : null;

  return (
    <div
      style={{
        background: '#16161D',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      {/* Card header */}
      <div
        style={{
          padding: '9px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'rgba(255,255,255,0.45)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          {t('agents.judge.title')}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            data-testid="run-tests-btn"
            onClick={onRunTests}
            disabled={isRunning}
            style={{
              padding: '3px 10px',
              borderRadius: 5,
              border: '1px solid rgba(74,222,128,0.25)',
              background: isRunning ? 'rgba(74,222,128,0.04)' : 'rgba(74,222,128,0.08)',
              color: isRunning ? 'rgba(74,222,128,0.5)' : '#4ADE80',
              fontSize: 10,
              fontWeight: 600,
              cursor: isRunning ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t('agents.judge.runTests')}
          </button>
          <button
            data-testid="run-review-btn"
            onClick={onRunReview}
            disabled={isRunning}
            style={{
              padding: '3px 10px',
              borderRadius: 5,
              border: '1px solid rgba(124,92,255,0.25)',
              background: isRunning ? 'rgba(124,92,255,0.04)' : 'rgba(124,92,255,0.08)',
              color: isRunning ? 'rgba(196,181,253,0.5)' : '#C4B5FD',
              fontSize: 10,
              fontWeight: 600,
              cursor: isRunning ? 'default' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {isRunning ? t('agents.judge.running') : t('agents.judge.runReview')}
          </button>
        </div>
      </div>

      <div style={{ padding: '12px 14px' }}>
        {/* No verdict yet */}
        {!verdict && !isRunning && (
          <div
            style={{
              padding: '12px 0',
              textAlign: 'center',
              color: 'rgba(255,255,255,0.3)',
              fontSize: 12,
            }}
          >
            {t('agents.judge.noVerdict')}
          </div>
        )}

        {/* Running spinner */}
        {isRunning && !verdict && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 0',
              color: 'rgba(255,255,255,0.5)',
              fontSize: 12,
            }}
          >
            <span className="agent-live-dot" style={{ width: 6, height: 6 }} />
            {t('agents.judge.inProgress')}
          </div>
        )}

        {/* Verdict summary bar */}
        {verdict && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: 14,
              }}
            >
              <ScoreRing score={verdict.score} available={isVerdictScoreAvailable(verdict)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {/* R14 — a scoreUnavailable verdict means the evaluator
                      rail itself never produced a usable judgment: showing
                      "Not passed" here would read as a real rejection the
                      system never actually reached (the exact live defect
                      this task fixes — see approveGate.ts's checkApproveGate
                      doc comment). Neutral color + honest label instead of
                      the red "not passed" state, even when `verdict.passed`
                      is technically false underneath. */}
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: !isVerdictScoreAvailable(verdict) ? 'rgba(255,255,255,0.45)' : verdict.passed ? '#4ADE80' : '#F87171',
                    }}
                  >
                    {!isVerdictScoreAvailable(verdict)
                      ? t('agents.judge.evaluationUnavailable')
                      : verdict.passed ? t('agents.judge.passed') : t('agents.judge.notPassed')}
                  </span>
                  {risk && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '2px 7px',
                        borderRadius: 4,
                        background: risk.bg,
                        color: risk.color,
                        fontWeight: 600,
                      }}
                    >
                      {risk.label}
                    </span>
                  )}
                </div>
                {verdict.tests && (
                  <div
                    style={{
                      display: 'flex',
                      gap: 10,
                      marginTop: 4,
                      fontSize: 11,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    <span style={{ color: '#4ADE80' }}>
                      {t('agents.judge.testsPassed', { count: String(verdict.tests.passed) })}
                    </span>
                    {verdict.tests.failed > 0 && (
                      <span style={{ color: '#F87171' }}>
                        {t('agents.judge.testsFailed', { count: String(verdict.tests.failed) })}
                      </span>
                    )}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 10,
                    color: 'rgba(255,255,255,0.25)',
                    marginTop: 4,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  {new Date(verdict.createdAt).toLocaleTimeString()}
                </div>
              </div>
            </div>

            {/* Reviewer list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {verdict.reviewers.map((r, i) => (
                <ReviewerRow key={`${r.role}-${i}`} reviewer={r} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
