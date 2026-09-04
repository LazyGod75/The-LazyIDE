#!/usr/bin/env node
/**
 * bench/run.mjs
 * LazyBrain benchmark harness — entry point.
 *
 * Usage:
 *   node bench/run.mjs                # fixture mode, dry agent run (deterministic)
 *   BENCH_LIVE=1 node bench/run.mjs   # live lazybrain CLI recall + dry agent
 *   BENCH_AGENT_LIVE=1 ANTHROPIC_API_KEY=sk-... node bench/run.mjs  # live agent
 *   BENCH_TOP_K=5 node bench/run.mjs  # change recall top-k
 *
 * Output:
 *   - stdout: human-readable report
 *   - bench/results/latest.json: full structured results
 *
 * No external dependencies — pure Node ESM.
 * This file does NOT import any app source code.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRecallBench } from './lib/recall.mjs';
import { runAgentBench } from './lib/agent-tasks.mjs';
import { runSweBench } from './lib/swe-tasks.mjs';
import { runIdePerfBench } from './lib/ide-perf.mjs';
import { runOrchestratorBench } from './lib/orchestrator.mjs';
import { renderReport } from './lib/reporter.mjs';
import { runAblationBench, writeAblationReport } from './lib/ablation.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dir, 'results');

async function main() {
  const live = process.env.BENCH_LIVE === '1';
  const agentLive = process.env.BENCH_AGENT_LIVE === '1';
  const topK = parseInt(process.env.BENCH_TOP_K ?? '3', 10);
  const skipPerf = process.env.BENCH_PERF_SKIP === '1';

  // Ablation mode: --ablate or --ablate=<component>
  const ablateArg = process.argv.find((a) => a.startsWith('--ablate'));
  if (ablateArg) {
    const component = ablateArg.includes('=') ? ablateArg.split('=')[1] : null;
    process.stdout.write('Lazy IDE Ablation bench (build-to-delete)...\n');
    const result = await runAblationBench({
      live: agentLive,
      components: component ? [component] : undefined,
    });
    process.stdout.write(writeAblationReport(result) + '\n');
    return;
  }

  process.stdout.write('Lazy IDE Benchmark — starting...\n');

  const t0 = Date.now();

  process.stdout.write('  [1/5] Running memory recall bench...\n');
  const recallResult = await runRecallBench({ live, topK });

  process.stdout.write('  [2/5] Running agent task bench...\n');
  const agentResult = await runAgentBench({ live: agentLive });

  process.stdout.write('  [3/5] Running SWE-bench-like tasks...\n');
  const sweResult = await runSweBench({ live: agentLive });

  if (!skipPerf) {
    process.stdout.write('  [4/5] Running IDE performance bench (Playwright)...\n');
  } else {
    process.stdout.write('  [4/5] IDE performance bench skipped (BENCH_PERF_SKIP=1)\n');
  }
  const perfResult = skipPerf ? null : await runIdePerfBench();

  process.stdout.write('  [5/5] Running orchestrator bench...\n');
  const orchestratorResult = await runOrchestratorBench({ live: agentLive });

  const durationMs = Date.now() - t0;

  const report = renderReport(recallResult, agentResult, sweResult, perfResult, durationMs, orchestratorResult);
  process.stdout.write(report + '\n');

  // Write structured results
  mkdirSync(RESULTS_DIR, { recursive: true });
  const output = {
    version: 3,
    timestamp: new Date().toISOString(),
    durationMs,
    recall: recallResult,
    agent: agentResult,
    swe: sweResult,
    perf: perfResult,
    orchestrator: orchestratorResult,
  };

  const latestPath = join(RESULTS_DIR, 'latest.json');
  writeFileSync(latestPath, JSON.stringify(output, null, 2), 'utf8');
  process.stdout.write(`\nResults written to bench/results/latest.json\n`);
}

main().catch((err) => {
  process.stderr.write(`Bench failed: ${err.message ?? err}\n`);
  process.exit(1);
});
