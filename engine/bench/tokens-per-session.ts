import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../src/util/config.js';

interface TokensResult {
  inject: { avg: number; p50: number; p95: number; min: number; max: number; n: number };
  capture: { avg_strip_ratio: number; avg_in: number; avg_out: number; n: number };
  summary: string;
}

interface InjectEvent {
  event: 'inject';
  ts: string;
  tokens: number;
  sections: number;
  duration_ms: number;
}

interface CaptureEvent {
  event: 'capture';
  ts: string;
  session?: string;
  tokens_in?: number;
  tokens_out_html?: number;
  strip_ratio?: number;
  duration_ms?: number;
}

function loadAll(windowHours: number): { injects: InjectEvent[]; captures: CaptureEvent[] } {
  const cfg = getConfig();
  const path = join(cfg.cachePath, 'telemetry.jsonl');
  const injects: InjectEvent[] = [];
  const captures: CaptureEvent[] = [];
  if (!existsSync(path)) return { injects, captures };
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as { event?: string; ts?: string };
      if (!evt.ts || new Date(evt.ts).getTime() < cutoff) continue;
      if (evt.event === 'inject') injects.push(evt as InjectEvent);
      else if (evt.event === 'capture') captures.push(evt as CaptureEvent);
    } catch {
      // skip
    }
  }
  return { injects, captures };
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

export function runTokensPerSession(windowHours: number): TokensResult {
  const { injects, captures } = loadAll(windowHours);
  const injTokens = injects.map((e) => e.tokens);
  const injSum = injTokens.reduce((s, n) => s + n, 0);
  const inj = {
    avg: injects.length === 0 ? 0 : Math.round(injSum / injects.length),
    p50: percentile(injTokens, 50),
    p95: percentile(injTokens, 95),
    min: injTokens.length === 0 ? 0 : Math.min(...injTokens),
    max: injTokens.length === 0 ? 0 : Math.max(...injTokens),
    n: injects.length,
  };
  const capRatios = captures.map((c) => c.strip_ratio ?? 0);
  const capIn = captures.map((c) => c.tokens_in ?? 0);
  const capOut = captures.map((c) => c.tokens_out_html ?? 0);
  const cap = {
    avg_strip_ratio:
      capRatios.length === 0 ? 0 : capRatios.reduce((s, n) => s + n, 0) / capRatios.length,
    avg_in: capIn.length === 0 ? 0 : Math.round(capIn.reduce((s, n) => s + n, 0) / capIn.length),
    avg_out:
      capOut.length === 0 ? 0 : Math.round(capOut.reduce((s, n) => s + n, 0) / capOut.length),
    n: captures.length,
  };
  return {
    inject: inj,
    capture: cap,
    summary: `inject_avg=${inj.avg} p50=${inj.p50} p95=${inj.p95} n=${inj.n}; capture_n=${cap.n}`,
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
  const r = runTokensPerSession(windowHours);
  if (pretty) {
    process.stdout.write(
      [
        `Tokens per session (${windowHours}h)`,
        '─'.repeat(40),
        `Inject (SessionStart):`,
        `  n=${r.inject.n}`,
        `  avg=${r.inject.avg}  p50=${r.inject.p50}  p95=${r.inject.p95}`,
        `  range=[${r.inject.min}, ${r.inject.max}]`,
        '',
        `Capture (sessions):`,
        `  n=${r.capture.n}`,
        `  avg in=${r.capture.avg_in}  out_html=${r.capture.avg_out}`,
        `  avg strip ratio=${r.capture.avg_strip_ratio.toFixed(2)}`,
      ].join('\n') + '\n',
    );
  } else {
    process.stdout.write(JSON.stringify(r) + '\n');
  }
}
