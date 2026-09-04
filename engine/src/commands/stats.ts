import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDb, listAll } from '../indexer/fts.js';
import { getConfig } from '../util/config.js';

export interface StatsCliOptions {
  pretty?: boolean;
  windowHours?: number;
}

export function runStats(opts: StatsCliOptions): string {
  const cfg = getConfig();
  const db = getDb();
  const allActive = listAll({ includeExpired: false });
  const allInc = listAll({ includeExpired: true });
  const totals = {
    notes_total: allInc.length,
    notes_active: allActive.length,
    notes_invalidated: allInc.length - allActive.length,
  };

  const byType = db
    .prepare(
      `SELECT COALESCE(type, 'unknown') AS type, COUNT(*) AS n
       FROM notes WHERE valid_until IS NULL OR valid_until = ''
       GROUP BY type ORDER BY n DESC`,
    )
    .all() as { type: string; n: number }[];

  const telemetryPath = join(cfg.cachePath, 'telemetry.jsonl');
  const window = opts.windowHours ?? 24;
  const events = readRecentEvents(telemetryPath, window);

  const queries = events.filter((e) => e.event === 'query') as unknown as Array<{
    event: 'query';
    level: 'L1' | 'L2' | 'L3' | 'L4';
    latency_ms: number;
  }>;
  const captures = events.filter((e) => e.event === 'capture');
  const injects = events.filter((e) => e.event === 'inject') as unknown as Array<{
    tokens: number;
  }>;

  const levelDist: Record<string, number> = { L1: 0, L2: 0, L3: 0, L4: 0 };
  for (const q of queries) levelDist[q.level] = (levelDist[q.level] ?? 0) + 1;
  const totalQueries = queries.length || 1;

  const latencyP50 = byLevel(queries);
  // l1_routing_rate_pct: share of auto-routed queries that were served by L1
  // (structural CSS lookup). Renamed from "structural_recall_rate_pct" which
  // incorrectly implied a recall metric rather than a routing metric.
  const l1RoutingRate = (levelDist.L1 / totalQueries) * 100;
  const avgInjectTokens =
    injects.length === 0 ? 0 : injects.reduce((s, e) => s + (e.tokens ?? 0), 0) / injects.length;

  const stats = {
    window_hours: window,
    totals,
    by_type: byType,
    queries_total: queries.length,
    routing_distribution_pct: Object.fromEntries(
      Object.entries(levelDist).map(([k, v]) => [k, ((v / totalQueries) * 100).toFixed(1)]),
    ),
    l1_routing_rate_pct: l1RoutingRate.toFixed(1),
    latency_p50_ms_by_level: latencyP50,
    captures_count: captures.length,
    avg_inject_tokens: Math.round(avgInjectTokens),
  };

  if (opts.pretty) {
    return formatPretty(stats);
  }
  return JSON.stringify(stats, null, 2);
}

function readRecentEvents(
  path: string,
  windowHours: number,
): Array<Record<string, unknown> & { event: string; ts: string }> {
  if (!existsSync(path)) return [];
  // Read whole file (typical size < 5MB in week 1)
  const stat = statSync(path);
  if (stat.size === 0) return [];
  const raw = readFileSync(path, 'utf8');
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const out: Array<Record<string, unknown> & { event: string; ts: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { ts?: string; event: string };
      if (!e.ts) continue;
      if (new Date(e.ts).getTime() >= cutoff)
        out.push(e as Record<string, unknown> & { event: string; ts: string });
    } catch {
      // skip malformed
    }
  }
  return out;
}

function byLevel(queries: Array<{ level: string; latency_ms: number }>): Record<string, number> {
  const groups: Record<string, number[]> = {};
  for (const q of queries) {
    groups[q.level] ??= [];
    groups[q.level].push(q.latency_ms);
  }
  const out: Record<string, number> = {};
  for (const [level, arr] of Object.entries(groups)) {
    arr.sort((a, b) => a - b);
    out[level] = arr[Math.floor(arr.length / 2)] ?? 0;
  }
  return out;
}

function formatPretty(s: Record<string, unknown>): string {
  return [
    `LazyBrain stats (window ${s.window_hours}h)`,
    '─'.repeat(50),
    `Notes:           ${(s.totals as Record<string, number>).notes_active} active / ${(s.totals as Record<string, number>).notes_total} total`,
    `Queries:         ${s.queries_total}`,
    `Captures:        ${s.captures_count}`,
    `L1 routing rate: ${s.l1_routing_rate_pct}%`,
    `Avg inject:     ${s.avg_inject_tokens} tokens`,
    '',
    'Routing distribution (% of queries):',
    ...Object.entries(s.routing_distribution_pct as Record<string, string>).map(
      ([k, v]) => `  ${k}: ${v}%`,
    ),
    '',
    'Latency p50 by level (ms):',
    ...Object.entries(s.latency_p50_ms_by_level as Record<string, number>).map(
      ([k, v]) => `  ${k}: ${v}ms`,
    ),
  ].join('\n');
}
