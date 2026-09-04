/**
 * bench/lib/reporter.mjs
 * Formats benchmark results as human-readable text + structured JSON.
 */

const PASS = '[PASS]';
const FAIL = '[FAIL]';
const SKIP = '[SKIP]';

function bar(fraction, width = 20) {
  const filled = Math.round(fraction * width);
  return '[' + '#'.repeat(filled) + '-'.repeat(width - filled) + ']';
}

function pct(n) {
  return (n * 100).toFixed(0) + '%';
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  return ms + 'ms';
}

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return 'n/a';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Format the memory recall section. */
function formatRecall(r) {
  const lines = [];
  lines.push('');
  lines.push('== MEMORY RECALL BENCH ==');
  lines.push(`mode       : ${r.mode}${!r.cliAvailable && r.mode !== 'fixture' ? ' (cli unavailable, fell back to fixture)' : ''}`);
  lines.push(`queries    : ${r.queryCount}`);
  lines.push(`top-k      : ${r.topK}`);
  lines.push(`precision@k: ${bar(r.avgPrecisionAtK)} ${pct(r.avgPrecisionAtK)}`);
  lines.push(`precision@1: ${bar(r.avgPrecisionAt1)} ${pct(r.avgPrecisionAt1)}`);
  lines.push(`recall@k   : ${bar(r.avgRecallAtK)} ${pct(r.avgRecallAtK)}`);
  lines.push(`MRR        : ${bar(r.avgMRR)} ${pct(r.avgMRR)}`);
  lines.push(`avg latency: ${r.avgLatencyMs.toFixed(1)} ms`);
  lines.push(`token savings (avg per query): ${r.avgSavingsPercent}% vs full-corpus baseline`);
  lines.push(`total tokens saved (all queries): ${r.totalSavedTokens.toLocaleString()}`);
  lines.push('');
  lines.push('  Per-query results:');

  for (const q of r.queries) {
    const p = q.precisionAt1 >= 1 ? PASS : q.precisionAtK > 0 ? '[PART]' : FAIL;
    lines.push(`  ${p} "${q.query}"`);
    lines.push(`        expected: [${q.expectedIds.join(', ')}]`);
    lines.push(`        got     : [${q.resultIds.join(', ')}]`);
    lines.push(`        P@1=${pct(q.precisionAt1)}  P@k=${pct(q.precisionAtK)}  R@k=${pct(q.recallAtK)}  MRR=${q.reciprocalRank}  latency=${q.latencyMs}ms  saved=${q.savingsPercent}%`);
  }

  return lines.join('\n');
}

/** Format the agent tasks section. */
function formatAgent(a) {
  const lines = [];
  lines.push('');
  lines.push('== AGENT TASK BENCH (pure functions) ==');
  lines.push(`mode        : ${a.mode}${!a.cliAvailable && a.mode === 'dry' ? ' (dry run — set BENCH_AGENT_LIVE=1 and ANTHROPIC_API_KEY to run real agents)' : ''}`);
  lines.push(`tasks       : ${a.taskCount}`);
  lines.push(`graded      : ${a.gradedCount} (output files found)`);
  lines.push(`avg score   : ${a.avgScore !== null ? pct(a.avgScore) : 'n/a (no output to grade)'}`);
  lines.push('');

  for (const t of a.tasks) {
    const statusIcon = t.hasOutput ? (t.score >= 0.8 ? PASS : t.score >= 0.5 ? '[PART]' : FAIL) : SKIP;
    lines.push(`  ${statusIcon} [${t.id}] ${t.title}`);
    lines.push(`        status : ${t.status}`);
    if (t.hasOutput) {
      lines.push(`        score  : ${pct(t.score)} (${t.passedChecks}/${t.totalChecks} checks)`);
      for (const c of t.checks) {
        lines.push(`          ${c.passed ? PASS : FAIL} ${c.id}: ${c.description} — ${c.detail}`);
      }
    } else {
      lines.push(`        To grade: place agent output at ${t.implPath} and ${t.testPath}`);
      lines.push(`        Or run:   BENCH_AGENT_LIVE=1 node bench/run.mjs`);
    }
  }

  return lines.join('\n');
}

/** Format the SWE-bench-like tasks section. */
function formatSwe(s) {
  const lines = [];
  lines.push('');
  lines.push('== SWE-BENCH-LIKE TASKS ==');
  lines.push(`mode        : ${s.mode}${!s.cliAvailable && s.mode === 'dry' ? ' (dry run — set BENCH_AGENT_LIVE=1 to run real agents)' : ''}`);
  lines.push(`tasks       : ${s.taskCount}`);
  lines.push(`graded      : ${s.gradedCount}`);
  lines.push(`tests passed: ${s.passedCount}/${s.taskCount} (${pct(s.passRate)})`);
  lines.push(`avg score   : ${s.avgScore !== null ? pct(s.avgScore) : 'n/a'}`);
  lines.push('');

  for (const t of s.tasks) {
    const statusIcon = t.testPassed ? PASS : (t.hasImpl ? FAIL : SKIP);
    lines.push(`  ${statusIcon} [${t.category}] ${t.title}`);
    lines.push(`        status     : ${t.status}`);
    lines.push(`        difficulty : ${t.difficulty}`);
    if (t.hasImpl) {
      lines.push(`        score      : ${pct(t.score)} (${t.passedChecks}/${t.totalChecks} checks)`);
      lines.push(`        tests      : ${t.testPassed ? 'PASS' : 'FAIL'}`);
      for (const c of t.checks) {
        lines.push(`          ${c.passed ? PASS : FAIL} ${c.id}: ${c.description} — ${c.detail}`);
      }
    } else {
      lines.push(`        No implementation found. Run with BENCH_AGENT_LIVE=1 to generate.`);
    }
  }

  return lines.join('\n');
}

/** Format the IDE performance section. */
function formatPerf(p) {
  const lines = [];
  lines.push('');
  lines.push('== IDE PERFORMANCE BENCH ==');

  if (!p || p.mode === 'skipped') {
    lines.push(`  [SKIP] ${p?.reason ?? 'skipped'}`);
    return lines.join('\n');
  }

  if (p.mode === 'error') {
    lines.push(`  [ERROR] ${p.reason}`);
    return lines.join('\n');
  }

  lines.push(`mode        : ${p.mode}`);
  lines.push(`url         : ${p.url}`);
  lines.push(`iterations  : ${p.iterations}`);
  lines.push(`duration    : ${p.durationMs}ms`);
  lines.push('');

  const m = p.metrics;
  if (m.coldStartupMs) {
    lines.push(`  Cold Startup:`);
    lines.push(`    median: ${fmtMs(m.coldStartupMs.median)}  mean: ${fmtMs(m.coldStartupMs.mean)}  p95: ${fmtMs(m.coldStartupMs.p95)}  min: ${fmtMs(m.coldStartupMs.min)}  max: ${fmtMs(m.coldStartupMs.max)}`);
  }
  if (m.inputLatencyMs && m.inputLatencyMs.samples > 0) {
    lines.push(`  Input Latency:`);
    lines.push(`    median: ${fmtMs(m.inputLatencyMs.median)}  mean: ${fmtMs(m.inputLatencyMs.mean)}  p95: ${fmtMs(m.inputLatencyMs.p95)}`);
  } else {
    lines.push(`  Input Latency: n/a (no editor/input element found)`);
  }
  if (m.spaceSwitchMs && m.spaceSwitchMs.samples > 0) {
    lines.push(`  Space Switch:`);
    lines.push(`    median: ${fmtMs(m.spaceSwitchMs.median)}  mean: ${fmtMs(m.spaceSwitchMs.mean)}  p95: ${fmtMs(m.spaceSwitchMs.p95)}`);
  } else {
    lines.push(`  Space Switch: n/a (no nav buttons found)`);
  }
  if (m.memory) {
    lines.push(`  Memory (JS Heap):`);
    lines.push(`    used: ${fmtBytes(m.memory.usedJSHeapSize)}  total: ${fmtBytes(m.memory.totalJSHeapSize)}  limit: ${fmtBytes(m.memory.jsHeapSizeLimit)}`);
  } else {
    lines.push(`  Memory: n/a (performance.memory not available)`);
  }
  lines.push(`  DOM Nodes: ${m.domNodes ?? 'n/a'}`);

  return lines.join('\n');
}

/** Format the overall summary. */
function formatSummary(recall, agent, swe, perf, durationMs) {
  const lines = [];
  lines.push('');
  lines.push('='.repeat(60));
  lines.push('  LAZY IDE BENCHMARK SUMMARY');
  lines.push('='.repeat(60));
  lines.push(`  memory recall precision@1 : ${pct(recall.avgPrecisionAt1)}`);
  lines.push(`  memory recall MRR         : ${pct(recall.avgMRR)}`);
  lines.push(`  memory recall recall@${recall.topK}    : ${pct(recall.avgRecallAtK)}`);
  lines.push(`  avg token savings         : ${recall.avgSavingsPercent}%`);
  lines.push(`  agent tasks graded        : ${agent.gradedCount}/${agent.taskCount}`);
  lines.push(`  SWE tasks tests passed    : ${swe.passedCount}/${swe.taskCount} (${pct(swe.passRate)})`);
  if (perf && perf.metrics) {
    const m = perf.metrics;
    lines.push(`  IDE cold startup (median) : ${fmtMs(m.coldStartupMs?.median)}`);
    lines.push(`  IDE input latency (median): ${fmtMs(m.inputLatencyMs?.median)}`);
    if (m.memory) {
      lines.push(`  IDE memory (used JS heap) : ${fmtBytes(m.memory.usedJSHeapSize)}`);
    }
  }
  lines.push(`  total bench duration      : ${durationMs} ms`);
  lines.push('='.repeat(60));
  return lines.join('\n');
}

/** Format the orchestrator section. */
function formatOrchestrator(o) {
  if (!o) return '';
  const lines = [];
  lines.push('');
  lines.push('== ORCHESTRATOR BENCH ==');
  lines.push(`scenarios  : ${o.scenarios}`);
  if (o.scenarios === 0) return lines.join('\n');
  lines.push(`routing acc: ${bar(o.routingAccuracy.score)} ${pct(o.routingAccuracy.score)}`);
  lines.push(`topology eff: ${bar(o.topologyEfficiency.score)} ${pct(o.topologyEfficiency.score)}`);
  lines.push(`macro reuse: ${bar(o.macroReuse.score)} ${pct(o.macroReuse.score)}`);
  if (o.promptQuality.skipped) {
    lines.push(`prompt qual: ${SKIP} ${o.promptQuality.reason ?? 'skipped'}`);
  } else {
    lines.push(`prompt qual: ${bar(o.promptQuality.score)} ${pct(o.promptQuality.score)}`);
  }
  lines.push(`overall    : ${bar(o.overall)} ${pct(o.overall)}`);
  if (o.perScenario) {
    lines.push('');
    lines.push('  Per-scenario results:');
    for (const s of o.perScenario) {
      lines.push(`  [${s.id}] ${s.name}`);
      lines.push(`    routing: ${pct(s.routing.score)} (${s.routing.correct}/${s.routing.total})  topology: ${pct(s.topology.score)}  macro: ${pct(s.macro.score)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render a full human-readable report string.
 */
export function renderReport(recall, agent, swe, perf, durationMs, orchestrator) {
  const sections = [
    'Lazy IDE Benchmark Report',
    `Date: ${new Date().toISOString()}`,
    formatRecall(recall),
    formatAgent(agent),
    formatSwe(swe),
    formatPerf(perf),
    formatOrchestrator(orchestrator),
    formatSummary(recall, agent, swe, perf, durationMs),
  ];
  return sections.join('\n');
}
