import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../src/util/config.js';

interface RecallResult {
  total_queries: number;
  l1_count: number;
  structural_recall_rate_pct: number;
  by_level: Record<string, number>;
}

interface TelemetryQueryEvent {
  event: 'query';
  ts: string;
  level: string;
  latency_ms: number;
  results: number;
}

function loadEvents(windowHours: number): TelemetryQueryEvent[] {
  const cfg = getConfig();
  const path = join(cfg.cachePath, 'telemetry.jsonl');
  if (!existsSync(path)) return [];
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const out: TelemetryQueryEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as { event?: string; ts?: string };
      if (evt.event !== 'query' || !evt.ts) continue;
      if (new Date(evt.ts).getTime() >= cutoff) out.push(evt as TelemetryQueryEvent);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function runStructuralRecall(windowHours: number): RecallResult {
  const events = loadEvents(windowHours);
  const byLevel: Record<string, number> = { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 };
  for (const evt of events) {
    byLevel[evt.level] = (byLevel[evt.level] ?? 0) + 1;
  }
  const total = events.length;
  const l1 = byLevel.L1 ?? 0;
  const rate = total > 0 ? (l1 / total) * 100 : 0;
  return {
    total_queries: total,
    l1_count: l1,
    structural_recall_rate_pct: Math.round(rate * 100) / 100,
    by_level: byLevel,
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  let windowHours = 24;
  let pretty = false;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--window-hours') {
      windowHours = parseInt(process.argv[i + 1] ?? '24', 10);
      i++;
    } else if (process.argv[i] === '--pretty') {
      pretty = true;
    }
  }
  const r = runStructuralRecall(windowHours);
  if (pretty) {
    process.stdout.write(
      [
        `Structural recall (${windowHours}h):`,
        `  queries: ${r.total_queries}`,
        `  L1 hits: ${r.l1_count}`,
        `  rate: ${r.structural_recall_rate_pct}%`,
        '  distribution:',
        ...Object.entries(r.by_level).map(([k, v]) => `    ${k}: ${v}`),
      ].join('\n') + '\n',
    );
  } else {
    process.stdout.write(JSON.stringify(r) + '\n');
  }
}
