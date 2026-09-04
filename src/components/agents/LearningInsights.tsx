/* LearningInsights.tsx — Marketing-style continuous improvement panel.
   Shows the learning loop results in a human-readable, non-numeric way
   that communicates the value of the brain-driven improvement cycle.

   This is the "marketing" face of the learning loop — no raw numbers,
   just a clear narrative of how the brain learns and adapts.
*/

import { useState } from 'react';
import type { LearningInsight, InsightKind } from '../../lib/agents/learningLoop';
import { generateLearningNarrative } from '../../lib/agents/learningLoop';
import { useI18n } from '../../i18n';

// ── Insight icon mapping ──────────────────────────────────────────

const INSIGHT_ICONS: Record<InsightKind, string> = {
  success_pattern: '✅',
  failure_pattern: '⚠️',
  test_insight: '🧪',
  security_insight: '🔒',
  performance_insight: '⚡',
  brain_adaptation: '🧠',
  workflow_suggestion: '💡',
};

const INSIGHT_COLORS: Record<InsightKind, { bg: string; border: string; color: string }> = {
  success_pattern: { bg: 'rgba(74,222,128,0.08)', border: 'rgba(74,222,128,0.20)', color: '#4ADE80' },
  failure_pattern: { bg: 'rgba(251,185,36,0.08)', border: 'rgba(251,185,36,0.20)', color: '#FBB924' },
  test_insight: { bg: 'rgba(124,92,255,0.08)', border: 'rgba(124,92,255,0.20)', color: '#C4B5FD' },
  security_insight: { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.20)', color: '#F87171' },
  performance_insight: { bg: 'rgba(96,165,250,0.08)', border: 'rgba(96,165,250,0.20)', color: '#60A5FA' },
  brain_adaptation: { bg: 'rgba(124,92,255,0.06)', border: 'rgba(124,92,255,0.15)', color: '#A78BFF' },
  workflow_suggestion: { bg: 'rgba(251,185,36,0.06)', border: 'rgba(251,185,36,0.15)', color: '#FBB924' },
};

// ── Single insight card ───────────────────────────────────────────

function InsightCard({ insight }: { insight: LearningInsight }) {
  const colors = INSIGHT_COLORS[insight.kind];
  const icon = INSIGHT_ICONS[insight.kind];

  return (
    <div
      style={{
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
      }}
    >
      <span style={{ fontSize: 16, flexShrink: 0, lineHeight: 1.4 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: colors.color, marginBottom: 3 }}>
          {insight.title}
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>
          {insight.description}
        </div>
        {insight.suggestion && (
          <div
            style={{
              marginTop: 6,
              padding: '5px 8px',
              background: 'rgba(255,255,255,0.04)',
              borderRadius: 5,
              fontSize: 11,
              color: 'rgba(255,255,255,0.45)',
              fontStyle: 'italic',
            }}
          >
            💡 {insight.suggestion}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────

interface LearningInsightsProps {
  insights: LearningInsight[];
  brainAdapted?: boolean;
  compact?: boolean;
}

export function LearningInsights({ insights, brainAdapted, compact }: LearningInsightsProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(!compact);
  const narrative = generateLearningNarrative(insights, t);

  if (insights.length === 0 && !brainAdapted) return null;

  return (
    <div
      data-testid="learning-insights"
      style={{
        background: 'rgba(124,92,255,0.04)',
        border: '1px solid rgba(124,92,255,0.15)',
        borderRadius: 10,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Header with brain icon */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: compact ? 'pointer' : 'default',
        }}
        onClick={compact ? () => setExpanded(!expanded) : undefined}
      >
        <span style={{ fontSize: 18 }}>🧠</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#C4B5FD' }}>
            {t('agents.learning.continuousImprovement')}
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
            {narrative}
          </div>
        </div>
        {compact && (
          <span style={{ fontSize: 11, color: '#A78BFF' }}>
            {expanded ? '▼' : '▶'}
          </span>
        )}
      </div>

      {/* Brain adaptation badge */}
      {brainAdapted && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 20,
            background: 'rgba(124,92,255,0.10)',
            border: '1px solid rgba(124,92,255,0.25)',
            fontSize: 11,
            color: '#C4B5FD',
            fontWeight: 500,
            alignSelf: 'flex-start',
          }}
        >
          <span style={{ fontSize: 10 }}>⚡</span>
          {t('agents.learning.brainAdaptedPlan')}
        </div>
      )}

      {/* Insights list */}
      {expanded && insights.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {insights.map((insight) => (
            <InsightCard key={insight.id} insight={insight} />
          ))}
        </div>
      )}

      {/* Footer — continuous improvement message */}
      {expanded && (
        <div
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.35)',
            textAlign: 'center',
            padding: '4px 0 0',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            marginTop: 4,
          }}
        >
          {t('agents.learning.footerMessage')}
        </div>
      )}
    </div>
  );
}

// ── Compact banner for mission cards / list view ──────────────────

export function LearningBadge({ insights, brainAdapted }: { insights: LearningInsight[]; brainAdapted?: boolean }) {
  const { t } = useI18n();
  if (insights.length === 0 && !brainAdapted) return null;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 12,
        background: brainAdapted ? 'rgba(124,92,255,0.12)' : 'rgba(124,92,255,0.06)',
        border: '1px solid rgba(124,92,255,0.18)',
        fontSize: 10,
        color: '#A78BFF',
        fontWeight: 500,
      }}
    >
      <span style={{ fontSize: 9 }}>🧠</span>
      {brainAdapted ? t('agents.learning.brainAdaptedBadge') : t('agents.learning.activeLearningBadge')}
    </div>
  );
}
