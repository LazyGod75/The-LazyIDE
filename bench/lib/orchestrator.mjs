/**
 * bench/lib/orchestrator.mjs
 * Orchestrator benchmark — measures routing accuracy, topology efficiency,
 * prompt quality (live-only), and macro reuse rate.
 *
 * Fixture mode (default): fully deterministic, no LLM calls.
 * Live mode (BENCH_AGENT_LIVE=1): prompt quality judged by LLM.
 *
 * Metrics:
 *   - routingAccuracy: did the right agent get the task? (fixture-deterministic)
 *   - topologyEfficiency: parallelism achieved vs. possible (fixture-deterministic)
 *   - promptQuality: LLM-judged (live-only, skipped in fixture/dry mode)
 *   - macroReuseRate: cached macros vs. new graphs (fixture-deterministic)
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dir, '../fixtures/orchestrator.json');

// ── Helpers ────────────────────────────────────────────────────────

function loadFixtures() {
  try {
    const raw = readFileSync(FIXTURE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { scenarios: [] };
  }
}

// ── Routing accuracy ───────────────────────────────────────────────

/**
 * Given a plan's step assignments, check if the right agent was chosen
 * for each task type. Fixture scenarios include expectedAgent per step.
 */
function scoreRoutingAccuracy(scenario) {
  const steps = scenario.steps ?? [];
  if (steps.length === 0) return { score: 1, correct: 0, total: 0 };

  let correct = 0;
  for (const step of steps) {
    if (step.expectedAgent && step.assignedAgent) {
      if (step.expectedAgent === step.assignedAgent) correct++;
    }
  }
  return { score: correct / steps.length, correct, total: steps.length };
}

// ── Topology efficiency ────────────────────────────────────────────

/**
 * Measures how much parallelism was achieved vs. what was possible.
 * Given a graph's edges and node count, compute the critical path length
 * and the actual parallelism ratio.
 */
function scoreTopologyEfficiency(scenario) {
  const nodes = scenario.nodes ?? [];
  const edges = scenario.edges ?? [];
  if (nodes.length <= 1) return { score: 1, parallelismRatio: 1, criticalPath: 1 };

  // Build adjacency list
  const deps = new Map();
  for (const node of nodes) deps.set(node.id, new Set());
  for (const edge of edges) {
    if (deps.has(edge.target)) deps.get(edge.target).add(edge.source);
  }

  // Compute longest path (critical path) via topological sort
  const inDegree = new Map();
  for (const node of nodes) inDegree.set(node.id, deps.get(node.id).size);

  const queue = nodes.filter((n) => inDegree.get(n.id) === 0).map((n) => ({ id: n.id, depth: 1 }));
  let maxDepth = 1;
  const visited = new Set();

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    visited.add(id);
    maxDepth = Math.max(maxDepth, depth);

    for (const edge of edges) {
      if (edge.source === id) {
        const newInDegree = inDegree.get(edge.target) - 1;
        inDegree.set(edge.target, newInDegree);
        if (newInDegree === 0 && !visited.has(edge.target)) {
          queue.push({ id: edge.target, depth: depth + 1 });
        }
      }
    }
  }

  const criticalPath = maxDepth;
  const maxPossibleParallelism = nodes.length;
  const parallelismRatio = 1 - (criticalPath - 1) / maxPossibleParallelism;

  return {
    score: parallelismRatio,
    parallelismRatio,
    criticalPath,
    nodeCount: nodes.length,
  };
}

// ── Macro reuse rate ───────────────────────────────────────────────

/**
 * Measures how many graph sub-patterns were reused from cached macros
 * vs. built from scratch.
 */
function scoreMacroReuse(scenario) {
  const macros = scenario.macros ?? {};
  const used = macros.used ?? 0;
  const total = macros.total ?? 0;
  const reuseRate = total > 0 ? used / total : 0;
  return { score: reuseRate, used, total, reuseRate };
}

// ── Prompt quality (live-only) ─────────────────────────────────────

async function scorePromptQuality(scenario, live) {
  if (!live) {
    return { score: null, skipped: true, reason: 'fixture mode — prompt quality is a live-only metric' };
  }

  // In live mode, we'd call the LLM to judge the prompt quality.
  // For now, return a placeholder — the actual LLM judging will be
  // wired when the evaluation harness is connected to a live model.
  return { score: null, skipped: true, reason: 'live prompt judging not yet wired' };
}

// ── Main runner ────────────────────────────────────────────────────

export async function runOrchestratorBench({ live = false } = {}) {
  const fixtures = loadFixtures();
  const scenarios = fixtures.scenarios ?? [];

  if (scenarios.length === 0) {
    return {
      name: 'orchestrator',
      scenarios: 0,
      routingAccuracy: { score: 0, correct: 0, total: 0 },
      topologyEfficiency: { score: 0, parallelismRatio: 0, criticalPath: 0 },
      macroReuse: { score: 0, used: 0, total: 0 },
      promptQuality: { score: null, skipped: true },
      overall: 0,
    };
  }

  let routingSum = 0;
  let topologySum = 0;
  let macroSum = 0;
  let promptSum = 0;
  let promptCount = 0;

  const perScenario = [];

  for (const scenario of scenarios) {
    const routing = scoreRoutingAccuracy(scenario);
    const topology = scoreTopologyEfficiency(scenario);
    const macro = scoreMacroReuse(scenario);
    const prompt = await scorePromptQuality(scenario, live);

    routingSum += routing.score;
    topologySum += topology.score;
    macroSum += macro.score;
    if (prompt.score !== null) {
      promptSum += prompt.score;
      promptCount++;
    }

    perScenario.push({
      id: scenario.id,
      name: scenario.name,
      routing,
      topology,
      macro,
      prompt,
    });
  }

  const n = scenarios.length;
  const routingAccuracy = { score: routingSum / n, correct: 0, total: 0 };
  const topologyEfficiency = { score: topologySum / n, parallelismRatio: topologySum / n, criticalPath: 0 };
  const macroReuse = { score: macroSum / n, used: 0, total: 0, reuseRate: macroSum / n };
  const promptQuality = promptCount > 0
    ? { score: promptSum / promptCount, skipped: false }
    : { score: null, skipped: true };

  // Overall score: weighted average (routing 40%, topology 30%, macro 20%, prompt 10%)
  const overall =
    (routingAccuracy.score * 0.4) +
    (topologyEfficiency.score * 0.3) +
    (macroReuse.score * 0.2) +
    (promptQuality.score !== null ? promptQuality.score * 0.1 : 0);

  return {
    name: 'orchestrator',
    scenarios: n,
    routingAccuracy,
    topologyEfficiency,
    macroReuse,
    promptQuality,
    overall,
    perScenario,
  };
}
