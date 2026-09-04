/* loopMetrics.ts — Generic external-metric ingestion + synthesis (spec §6
   "Ingestion d'une mesure externe").

   Deliberately generic: a metric is just { metricName, source, value }
   attached to a past execution (missionId) — never a schema specific to a
   social network or content format. `metricName` is caller-defined free
   text (e.g. "engagement_rate", "conversion", "watch_time" — anything),
   `source` says where it came from (e.g. "instagram_insights", "manual",
   a webhook name), and `value` is a plain number. The synthesis step below
   is what makes the learning axis real (spec: "sans mesure nommée ... l'axe
   auto-améliorant reste décoratif") — it turns a metric history into a
   compact, generic trend summary a loop's next iteration prompt can read
   (see loopScheduler.ts's use of formatMetricSynthesisText), and into the
   decline signal loopGate.ts's circuit breaker consumes.
*/

import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';

const METRICS_FILE = '.lazy/loop-metrics.json';

export interface ExternalMetricEntry {
  /** The past execution (a loop ITERATION mission, typically) this metric
   *  attaches to. */
  missionId: string;
  /** The owning loop's own mission id, when known — denormalized so lookups
   *  by loop don't need a separate mission-id join at read time. Absent for
   *  a metric attached to a one-time mission's own output. */
  loopId?: string;
  /** Caller-defined generic metric name — never a fixed enum. */
  metricName: string;
  /** Where the value came from (a human, a webhook, an API poll — free
   *  text, never validated against a fixed provider list). */
  source: string;
  value: number;
  recordedAt: string;
}

interface MetricsStore {
  entries: ExternalMetricEntry[];
}

async function readStore(repoPath: string): Promise<MetricsStore> {
  const platform = getPlatform();
  if (!platform?.fs) return { entries: [] };
  try {
    const raw = await platform.fs.readFile(joinPath(repoPath, METRICS_FILE));
    return JSON.parse(raw) as MetricsStore;
  } catch {
    return { entries: [] };
  }
}

async function writeStore(repoPath: string, store: MetricsStore): Promise<void> {
  const platform = getPlatform();
  if (!platform?.fs) return;
  try {
    await platform.fs.createDir(joinPath(repoPath, '.lazy'));
    await platform.fs.writeFile(joinPath(repoPath, METRICS_FILE), JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn('[loopMetrics] Failed to persist:', err);
  }
}

/** Attaches one named metric to a past execution — append-only (never edits
 *  or removes a previously recorded value, same audit-trail convention as
 *  every other `.lazy/` store in this codebase). */
export async function recordExternalMetric(
  repoPath: string,
  entry: Omit<ExternalMetricEntry, 'recordedAt'>,
): Promise<ExternalMetricEntry> {
  const store = await readStore(repoPath);
  const recorded: ExternalMetricEntry = { ...entry, recordedAt: new Date().toISOString() };
  await writeStore(repoPath, { entries: [...store.entries, recorded] });
  return recorded;
}

/** Every metric ever attached to one mission, oldest first. */
export async function getMetricsForMission(repoPath: string, missionId: string): Promise<ExternalMetricEntry[]> {
  const store = await readStore(repoPath);
  return store.entries.filter((e) => e.missionId === missionId).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/** Every metric ever attached to any iteration of one loop, oldest first —
 *  optionally narrowed to a single named metric (the common case: a
 *  charter names exactly ONE learning measure per spec §5). */
export async function getMetricsForLoop(
  repoPath: string,
  loopId: string,
  metricName?: string,
): Promise<ExternalMetricEntry[]> {
  const store = await readStore(repoPath);
  return store.entries
    .filter((e) => e.loopId === loopId && (metricName === undefined || e.metricName === metricName))
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

export interface MetricTrendSynthesis {
  metricName: string;
  count: number;
  latest?: number;
  /** Average of the most recent half of the history (or the single latest
   *  value when there are too few points to split). */
  recentAverage?: number;
  /** Average of the older half — undefined when there aren't enough points
   *  to form two groups (need at least 2 entries). */
  priorAverage?: number;
  /** Percent change of recentAverage vs priorAverage (negative = decline).
   *  Undefined whenever priorAverage is undefined — never fabricated from a
   *  single data point. */
  declinePct?: number;
}

/**
 * Pure: splits a metric's chronological history into an older half and a
 * more recent half, and reports the percent change between their averages.
 * Requires at least 2 entries to compute a trend at all; with exactly 1 it
 * reports `latest` only (no decline claim from a single point — "never
 * fabricate a decline nobody measured").
 */
export function synthesizeMetricTrend(entries: readonly ExternalMetricEntry[], metricName: string): MetricTrendSynthesis {
  const relevant = entries.filter((e) => e.metricName === metricName);
  if (relevant.length === 0) return { metricName, count: 0 };
  const latest = relevant[relevant.length - 1].value;
  if (relevant.length === 1) return { metricName, count: 1, latest };

  const mid = Math.floor(relevant.length / 2);
  const older = relevant.slice(0, mid);
  const recent = relevant.slice(mid);
  const avg = (xs: readonly ExternalMetricEntry[]) => xs.reduce((sum, x) => sum + x.value, 0) / xs.length;
  const priorAverage = avg(older);
  const recentAverage = avg(recent);
  const declinePct = priorAverage !== 0 ? ((recentAverage - priorAverage) / Math.abs(priorAverage)) * 100 : undefined;

  return { metricName, count: relevant.length, latest, recentAverage, priorAverage, declinePct };
}

/** Compact, generic text block for injection into a loop iteration's prompt
 *  (mirrors loopScheduler.ts's own "[PREVIOUS ITERATIONS CONTEXT]"
 *  convention) — the actual "synthesis step" (spec §6) that lets the named
 *  measure influence subsequent executions. `null` when there is nothing
 *  measured yet (never fabricates a synthesis from zero data). */
export function formatMetricSynthesisText(synthesis: MetricTrendSynthesis): string | null {
  if (synthesis.count === 0 || synthesis.latest === undefined) return null;
  const parts = [`latest ${synthesis.latest}`];
  if (synthesis.declinePct !== undefined) {
    const trend = synthesis.declinePct >= 0 ? `+${synthesis.declinePct.toFixed(1)}%` : `${synthesis.declinePct.toFixed(1)}%`;
    parts.push(`trend ${trend} vs previous`);
  }
  return `[LEARNED METRIC] ${synthesis.metricName}: ${parts.join(', ')} (${synthesis.count} recorded). Adjust future executions (subject/format/timing) accordingly when the trend is negative.`;
}
