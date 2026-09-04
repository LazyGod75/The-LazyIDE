/* ScorecardPanel — P8.1/QW2: Honest scorecard from journal events.
   Displays real metrics computed from the event journal, with footnotes
   for features that exist but have no data yet. */

import { useEffect, useState } from 'react';
import { isTauri } from '../../../lib/platform';
import { buildScorecard, type Scorecard, type ScorecardEntry } from '../../../lib/agents/scorecardRefresh';
import { generateScorecardFootnotes, type ScorecardFootnote } from '../../../lib/agents/scorecardFootnotes';
import { queryJournalSince } from '../../../lib/journal/projections';
import { projectIdFromRoot } from '../../../lib/journal/projectId';
import { resolveProjectRoot } from '../agentsStore';
import { useI18n } from '../../../i18n';
import { formatCredits } from '../../../lib/billing';
import { pluralKey } from '../../../i18n/plural';

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Count-agreement fix (real user report, 2026-08-14 — "Sur 1 événements de
 *  coût" instead of "Sur 1 événement de coût"): scorecardRefresh.ts emits
 *  plain (unsuffixed) tooltip base keys plus raw params — it deliberately has
 *  no `t`/locale access (see that file's own doc comment). Every tooltip that
 *  carries a count needs the `<base>One`/`<base>Many` CLDR split (this
 *  codebase's established plural convention, src/i18n/plural.ts), so this
 *  resolves each known tooltip shape at render time, where `t`/`locale` are
 *  actually available. Compound tooltips (success/total, replan/total,
 *  recall/total) pluralize each half independently — same "compose two
 *  pre-pluralized fragments" pattern LeadView.tsx already established for
 *  `titleMeta` (`{humans}`/`{depts}`, each already CLDR-picked before being
 *  interpolated into the template). */
function resolveTooltip(entry: ScorecardEntry, t: Translate, locale: string): string | null {
  if (!entry.tooltipKey) return null;
  const params = entry.tooltipParams ?? {};

  switch (entry.tooltipKey) {
    case 'cockpit.scorecard.tooltip.costEventsCount':
    case 'cockpit.scorecard.tooltip.durationMissionsCount': {
      const count = Number(params.count ?? 0);
      return t(pluralKey(entry.tooltipKey, count, locale), params);
    }
    case 'cockpit.scorecard.tooltip.successBreakdown': {
      const success = Number(params.success ?? 0);
      const total = Number(params.total ?? 0);
      return t('cockpit.scorecard.tooltip.successBreakdownTemplate', {
        successPart: t(pluralKey('cockpit.scorecard.tooltip.successCount', success, locale), { count: success }),
        totalPart: t(pluralKey('cockpit.scorecard.tooltip.totalCompletedCount', total, locale), { count: total }),
      });
    }
    case 'cockpit.scorecard.tooltip.replanBreakdown': {
      const count = Number(params.count ?? 0);
      const total = Number(params.total ?? 0);
      return t('cockpit.scorecard.tooltip.replanBreakdownTemplate', {
        replanPart: t(pluralKey('cockpit.scorecard.tooltip.replanCount', count, locale), { count }),
        totalPart: t(pluralKey('cockpit.scorecard.tooltip.totalMissionsCount', total, locale), { count: total }),
      });
    }
    case 'cockpit.scorecard.tooltip.brainRecallBreakdown': {
      const count = Number(params.count ?? 0);
      const total = Number(params.total ?? 0);
      return t('cockpit.scorecard.tooltip.brainRecallBreakdownTemplate', {
        recallPart: t(pluralKey('cockpit.scorecard.tooltip.recallCount', count, locale), { count }),
        totalPart: t(pluralKey('cockpit.scorecard.tooltip.totalMissionsCount', total, locale), { count: total }),
      });
    }
    default:
      return t(entry.tooltipKey, params);
  }
}

/** Currency-leak fix (real user report, 2026-08-14): avg cost used to
 *  render as `$X.XX` — this app's standing rule is credits, never currency,
 *  for cost-of-work figures. `entry.value` is already credits-denominated
 *  for `unit: 'credits'` (scorecardRefresh.ts's computeAvgCost), so this is
 *  a pure formatting swap. */
function formatValue(entry: ScorecardEntry, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (entry.value === null) return '—';
  if (entry.unit === 'credits') return t('cockpit.budget.spent', { spent: formatCredits(entry.value) });
  if (entry.unit === '%') return `${entry.value.toFixed(1)}%`;
  if (entry.unit === 'ms') {
    if (entry.value < 1000) return `${Math.round(entry.value)}ms`;
    if (entry.value < 60000) return `${(entry.value / 1000).toFixed(1)}s`;
    return `${(entry.value / 60000).toFixed(1)}min`;
  }
  return `${entry.value}${entry.unit}`;
}

function sourceColor(source: ScorecardEntry['source']): string {
  switch (source) {
    case 'real':
      return 'var(--color-text)';
    case 'unavailable':
      return 'var(--color-text-disabled)';
    default:
      return 'var(--color-text-muted)';
  }
}

export function ScorecardPanel() {
  const { t, locale } = useI18n();
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [footnotes, setFootnotes] = useState<ScorecardFootnote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isTauri()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const root = await resolveProjectRoot();
        const projectId = projectIdFromRoot(root);
        // Query last 7 days of events
        const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const events = await queryJournalSince(projectId, sinceMs);
        if (cancelled) return;
        const sc = buildScorecard(events);
        setScorecard(sc);
        // Generate footnotes for features without data
        const hasContestData = events.some((e) => e.type === 'contest.completed');
        const hasJoinData = events.some((e) => (e.type as string) === 'join.completed');
        const hasMaxDurationData = events.some((e) => (e.type as string) === 'mission.duration_exceeded');
        setFootnotes(generateScorecardFootnotes({
          hasContestData,
          hasJoinData,
          hasMaxDurationData,
          contestFeatureExists: true,
          joinFeatureExists: true,
          maxDurationFeatureExists: true,
        }));
      } catch {
        // Best-effort — journal may not be available
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={{ padding: 16, color: 'var(--color-text-muted)' }}>{t('cockpit.scorecard.loading')}</div>;
  }

  if (!scorecard || scorecard.entries.length === 0) {
    return <div style={{ padding: 16, color: 'var(--color-text-muted)' }}>{t('cockpit.scorecard.noData')}</div>;
  }

  return (
    <div style={{ padding: '12px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {scorecard.entries.map((entry) => (
          <div
            key={entry.labelKey}
            style={{
              padding: '10px 14px',
              background: '#16161D',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.40)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 }}>
              {t(entry.labelKey)}
            </span>
            <span style={{ fontSize: 18, fontWeight: 700, color: sourceColor(entry.source), fontVariantNumeric: 'tabular-nums' }}>
              {formatValue(entry, t)}
            </span>
            {entry.tooltipKey && (
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.38)', lineHeight: 1.3 }}>
                {resolveTooltip(entry, t, locale)}
              </span>
            )}
          </div>
        ))}
      </div>

      {footnotes.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {footnotes.map((fn) => (
            <div
              key={fn.id}
              style={{
                fontSize: 11,
                color: fn.severity === 'warning' ? 'var(--color-warning)' : 'var(--color-text-muted)',
                padding: '6px 10px',
                background: 'rgba(255,255,255,0.03)',
                borderRadius: 6,
                borderLeft: `2px solid ${fn.severity === 'warning' ? 'var(--color-warning)' : 'var(--color-text-disabled)'}`,
              }}
            >
              {t(fn.textKey)}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 8, fontSize: 10, color: 'var(--color-text-disabled)' }}>
        {t('cockpit.scorecard.computedFrom', { count: scorecard.sampleSize })}
      </div>
    </div>
  );
}
