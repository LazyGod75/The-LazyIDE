/* DataInspector.tsx — structured per-mission data pane (Agent Canvas W8b),
   rendered as MissionDetail's « Données » section.

   One unified view of a mission's REAL structured data:
     - the raw task/prompt actually sent (agentTask/contract.objective — see
       lib/agents/missionOutput.ts's extractSentTask; honest empty row when
       neither exists),
     - the final output (same selection order managerEngine's
       get_agent_output grounding uses — extractFinalOutput),
     - tool calls, as far as actionTimeline actually records them: managed
       missions write structured `[N] tool_name: {args}` entries
       (MissionDetailTranscript.tsx's exported parseTimelineEntry recognizes
       them — reused verbatim here); native missions often only have coarse
       French status sentences, in which case this section honestly reports
       that only coarse entries exist instead of pretending they are calls,
     - token/cost from agentMetrics with tokensSource honesty (an « estimé »
       badge whenever the numbers are not fully real — see
       AgentMetrics.tokensSource's doc comment: undefined means native/exact),
     - judgeVerdict as a structured table.

   Table/JSON toggle: both views render the SAME underlying data object —
   JSON mode is a pretty-printed dump of exactly the fields present (no
   schema invention: absent fields are absent, not null-filled). The search
   box highlights matches in both views.
*/

import { useMemo, useState } from 'react';
import type { Mission } from '../../../../lib/agents/types';
import { extractFinalOutput, extractSentTask } from '../../../../lib/agents/missionOutput';
import { isVerdictScoreAvailable } from '../../../../lib/agents/evaluator';
import { parseTimelineEntry } from '../../MissionDetailTranscript';
import { useI18n } from '../../../../i18n';
import { classifyMissionModel } from '../../../../lib/agents/runtime';
import { usdToCredits } from '../../../../lib/billing/credits';

interface DataInspectorProps {
  mission: Mission;
}

interface ToolCallRow {
  step: string;
  toolLabel: string;
  argsSummary: string;
}

/** Highlights case-insensitive `query` matches inside `text` — shared by the
 *  Table and JSON views so search behaves identically in both. */
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let index = lower.indexOf(q, cursor);
  let key = 0;
  while (index !== -1) {
    if (index > cursor) parts.push(<span key={key++}>{text.slice(cursor, index)}</span>);
    parts.push(
      <span key={key++} data-testid="inspector-match" style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent-lighter)', borderRadius: 2 }}>
        {text.slice(index, index + q.length)}
      </span>,
    );
    cursor = index + q.length;
    index = lower.indexOf(q, cursor);
  }
  if (cursor < text.length) parts.push(<span key={key}>{text.slice(cursor)}</span>);
  return <>{parts}</>;
}

function RowLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-text-disabled)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
      {children}
    </div>
  );
}

function MonoBlock({ text, query }: { text: string; query: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '8px 10px',
        background: 'var(--color-panel-3)',
        border: '1px solid var(--color-border)',
        borderRadius: 6,
        fontSize: 11,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--color-text-secondary)',
        fontFamily: 'var(--font-mono)',
        maxHeight: 180,
        overflowY: 'auto',
      }}
    >
      <Highlighted text={text} query={query} />
    </pre>
  );
}

function EmptyRow({ label }: { label: string }) {
  return <div style={{ fontSize: 12, color: 'var(--color-text-ghost)' }}>{label}</div>;
}

/* fix/canvas-ux R6a MINEUR #8 (final dogfood f29) — both the metrics table
   AND the judge-verdict table's LABEL column had no `whiteSpace`/width
   control at all: `borderCollapse: 'collapse'` alone still leaves the
   browser's default `table-layout: auto`, which — once the panel is
   narrower than the combined natural width of both columns (a long judge
   `summary` in the value column easily is) — squeezes whichever column has
   no explicit width hint, wrapping "Score"/"Résultat"/"reviewer" one
   character per line (screenshot evidence: "Sc/or/e", "Ré/su/lt/at").
   `whiteSpace: 'nowrap'` on the LABEL column is enough on its own: it tells
   the auto-layout algorithm that column's minimum content width is its
   whole label, so any squeeze the value column's long text now forces
   lands entirely on the (already wrap-tolerant) value column instead. */
const LABEL_TD_STYLE: React.CSSProperties = {
  padding: '2px 14px 2px 0',
  color: 'var(--color-text-disabled)',
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
};
const VALUE_TD_STYLE: React.CSSProperties = { padding: '2px 0', wordBreak: 'break-word', verticalAlign: 'top' };

/** « estimé »/« réel » tag, shown next to a token COUNT specifically (not
 *  just once near the whole Métriques section title, see the pre-existing
 *  `inspector-estimated-badge` above it) — the input-undercount honesty a
 *  sibling wave's evaluator/report work depends on: a token count is either
 *  a real measured value or an approximation, and that distinction matters
 *  per-value, not just "somewhere in this section". */
function TokensSourceBadge({ testId, estimated, t }: { testId: string; estimated: boolean; t: (key: string) => string }) {
  return (
    <span
      data-testid={testId}
      style={{
        marginLeft: 6,
        padding: '0 5px',
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 600,
        color: estimated ? 'var(--color-warning)' : 'var(--color-text-disabled)',
        background: estimated ? 'rgba(251,185,36,0.12)' : 'var(--color-panel-3)',
        border: `1px solid ${estimated ? 'rgba(251,185,36,0.3)' : 'var(--color-border-3)'}`,
      }}
    >
      {estimated ? t('canvas.inspector.estimatedBadge') : t('canvas.inspector.realBadge')}
    </span>
  );
}

/** Extracts structured tool calls from the timeline — ONLY entries
 *  parseTimelineEntry recognizes as real `[N] tool: {args}` actions. */
function deriveToolCalls(mission: Mission): { calls: ToolCallRow[]; coarseCount: number } {
  const timeline = mission.actionTimeline ?? [];
  const calls: ToolCallRow[] = [];
  let coarseCount = 0;
  for (const entry of timeline) {
    const parsed = parseTimelineEntry(entry.text);
    if (parsed.kind === 'action') {
      calls.push({ step: parsed.step, toolLabel: parsed.toolLabel, argsSummary: parsed.argsSummary });
    } else if (parsed.kind === 'plain') {
      coarseCount += 1;
    }
  }
  return { calls, coarseCount };
}

/** The exact structured object BOTH views render — built only from fields
 *  actually present on the mission (no schema invention). */
function buildInspectorData(mission: Mission): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const task = extractSentTask(mission);
  const output = extractFinalOutput(mission);
  const { calls } = deriveToolCalls(mission);
  if (task !== null) data.task = task;
  if (output !== null) data.output = output;
  if (calls.length > 0) data.toolCalls = calls;
  if (mission.agentMetrics) data.metrics = mission.agentMetrics;
  if (mission.judgeVerdict) data.judgeVerdict = mission.judgeVerdict;
  return data;
}

export function DataInspector({ mission }: DataInspectorProps) {
  const { t } = useI18n();
  const [view, setView] = useState<'table' | 'json'>('table');
  const [query, setQuery] = useState('');

  const task = extractSentTask(mission);
  const output = extractFinalOutput(mission);
  const { calls, coarseCount } = useMemo(() => deriveToolCalls(mission), [mission]);
  const metrics = mission.agentMetrics;
  const verdict = mission.judgeVerdict;
  const isEstimated = metrics?.tokensSource === 'estimated' || metrics?.tokensSource === 'mixed';
  // Fix D (2026-08-19 dollar-kill incident, display half) — same rail
  // classification runtime.ts dispatched this mission through
  // (classifyMissionModel); credits everywhere (usdToCredits), never a
  // dollar figure, with the native rail's number marked as a non-debited
  // equivalent (same convention as CostChip.tsx/MissionNode.tsx).
  const isNativeRail = classifyMissionModel(mission.model) === 'native';
  const costLabel =
    metrics && metrics.costUsd > 0
      ? `${isNativeRail ? '≈' : ''}${usdToCredits(metrics.costUsd).toLocaleString()} ${t('canvas.node.creditsUnit')}${isNativeRail ? ` (${t('canvas.node.costNoDebit')})` : ''}`
      : '—';
  const json = useMemo(() => JSON.stringify(buildInspectorData(mission), null, 2), [mission]);

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    padding: '3px 10px',
    borderRadius: 5,
    border: `1px solid ${active ? 'var(--color-accent-border)' : 'var(--color-border)'}`,
    background: active ? 'var(--color-accent-soft)' : 'transparent',
    color: active ? 'var(--color-accent-pale)' : 'var(--color-text-muted)',
    fontSize: 10.5,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  });

  return (
    <div data-testid="data-inspector" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Toolbar: view toggle + search */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button data-testid="inspector-view-table" onClick={() => setView('table')} style={toggleStyle(view === 'table')}>
          {t('canvas.inspector.viewTable')}
        </button>
        <button data-testid="inspector-view-json" onClick={() => setView('json')} style={toggleStyle(view === 'json')}>
          {t('canvas.inspector.viewJson')}
        </button>
        <input
          data-testid="inspector-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('canvas.inspector.searchPlaceholder')}
          style={{
            flex: 1,
            minWidth: 80,
            background: 'var(--color-input)',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 11.5,
            color: 'var(--color-text)',
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
      </div>

      {view === 'json' ? (
        <details open data-testid="inspector-json">
          <summary style={{ fontSize: 10.5, color: 'var(--color-text-disabled)', cursor: 'pointer', marginBottom: 6 }}>
            {t('canvas.inspector.jsonSummary')}
          </summary>
          <MonoBlock text={json} query={query} />
        </details>
      ) : (
        <>
          {/* Task sent */}
          <div>
            <RowLabel>{t('canvas.inspector.taskTitle')}</RowLabel>
            {task ? <MonoBlock text={task} query={query} /> : <EmptyRow label={t('canvas.inspector.taskEmpty')} />}
          </div>

          {/* Final output */}
          <div>
            <RowLabel>{t('canvas.inspector.outputTitle')}</RowLabel>
            {output ? <MonoBlock text={output} query={query} /> : <EmptyRow label={t('canvas.inspector.outputEmpty')} />}
          </div>

          {/* Tool calls */}
          <div>
            <RowLabel>{t('canvas.inspector.toolCallsTitle')}</RowLabel>
            {calls.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }} data-testid="inspector-tool-calls">
                {calls.map((call, i) => (
                  <div key={i} style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}>
                    <span style={{ fontWeight: 600 }}>
                      <Highlighted text={`#${call.step} ${call.toolLabel}`} query={query} />
                    </span>
                    {call.argsSummary && (
                      <span style={{ color: 'var(--color-text-muted)', marginLeft: 6 }}>
                        <Highlighted text={call.argsSummary} query={query} />
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : coarseCount > 0 ? (
              <EmptyRow label={t('canvas.inspector.toolCallsCoarse', { count: String(coarseCount) })} />
            ) : (
              <EmptyRow label={t('canvas.inspector.toolCallsEmpty')} />
            )}
          </div>

          {/* Metrics with tokensSource honesty */}
          <div>
            <RowLabel>
              {t('canvas.inspector.metricsTitle')}
              {isEstimated && (
                <span
                  data-testid="inspector-estimated-badge"
                  style={{
                    marginLeft: 8,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'rgba(251,185,36,0.12)',
                    border: '1px solid rgba(251,185,36,0.3)',
                    color: 'var(--color-warning)',
                    fontSize: 9,
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}
                >
                  {t('canvas.inspector.estimatedBadge')}
                </span>
              )}
            </RowLabel>
            {metrics ? (
              <table style={{ borderCollapse: 'collapse', fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}>
                <tbody>
                  {(
                    [
                      { label: t('agents.detail.metricDuration'), value: `${(metrics.durationMs / 1000).toFixed(1)}s`, tokensBadgeTestId: undefined },
                      {
                        label: t('agents.detail.metricTokensIn'),
                        value: metrics.inputTokens > 0 ? metrics.inputTokens.toLocaleString() : '—',
                        tokensBadgeTestId: 'inspector-tokens-source-badge-in',
                      },
                      {
                        label: t('agents.detail.metricTokensOut'),
                        value: metrics.outputTokens > 0 ? metrics.outputTokens.toLocaleString() : '—',
                        tokensBadgeTestId: 'inspector-tokens-source-badge-out',
                      },
                      { label: t('agents.detail.metricCost'), value: costLabel, tokensBadgeTestId: undefined },
                      { label: t('agents.detail.metricToolCalls'), value: String(metrics.toolCount), tokensBadgeTestId: undefined },
                    ] satisfies ReadonlyArray<{ label: string; value: string; tokensBadgeTestId: string | undefined }>
                  ).map(({ label, value, tokensBadgeTestId }) => (
                    <tr key={label}>
                      <td style={LABEL_TD_STYLE}>{label}</td>
                      <td style={VALUE_TD_STYLE}>
                        <Highlighted text={value} query={query} />
                        {tokensBadgeTestId && <TokensSourceBadge testId={tokensBadgeTestId} estimated={isEstimated} t={t} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyRow label={t('canvas.inspector.metricsEmpty')} />
            )}
          </div>

          {/* Judge verdict as structured table */}
          <div>
            <RowLabel>{t('canvas.inspector.judgeTitle')}</RowLabel>
            {verdict ? (
              <table data-testid="inspector-judge-table" style={{ borderCollapse: 'collapse', fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', width: '100%' }}>
                <tbody>
                  <tr>
                    <td style={LABEL_TD_STYLE}>{t('canvas.inspector.judgeScore')}</td>
                    {/* R13 — same shared rule as nodeChrome.tsx's node chip
                        (R11): a placeholder `0` (evaluator.ts's
                        `scoreUnavailable`) must never render as a real
                        score. */}
                    <td style={VALUE_TD_STYLE}>
                      {isVerdictScoreAvailable(verdict) ? `${Math.round(verdict.score)}/100` : '—'}
                    </td>
                  </tr>
                  <tr>
                    <td style={LABEL_TD_STYLE}>{t('canvas.inspector.judgePassed')}</td>
                    <td style={{ ...VALUE_TD_STYLE, color: verdict.passed ? 'var(--color-success)' : 'var(--color-danger)' }}>
                      {verdict.passed ? t('mission.detail.evalPassed') : t('mission.detail.evalFailed')}
                    </td>
                  </tr>
                  <tr>
                    <td style={LABEL_TD_STYLE}>{t('canvas.inspector.judgeRisk')}</td>
                    <td style={VALUE_TD_STYLE}>{verdict.risk}</td>
                  </tr>
                  {verdict.tests && (
                    <tr>
                      <td style={LABEL_TD_STYLE}>{t('canvas.inspector.judgeTests')}</td>
                      <td style={VALUE_TD_STYLE}>{verdict.tests.passed} ✓ / {verdict.tests.failed} ✕</td>
                    </tr>
                  )}
                  {verdict.reviewers.map((r, i) => (
                    <tr key={i}>
                      <td style={LABEL_TD_STYLE}>{r.role}</td>
                      <td style={VALUE_TD_STYLE}>
                        <Highlighted text={`${r.verdict}${typeof r.score === 'number' ? ` (${r.score}/100)` : ''} — ${r.summary}`} query={query} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyRow label={t('canvas.inspector.judgeEmpty')} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
