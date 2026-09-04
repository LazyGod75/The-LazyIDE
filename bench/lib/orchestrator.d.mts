/**
 * Type declarations for orchestrator.mjs — hand-written because the bench
 * scripts are plain JS (no build step of their own) and
 * phase7.orchestratorBench.test.ts imports this module directly to assert
 * on its real return shape. Kept in sync by hand with orchestrator.mjs's
 * own return statements (loadFixtures/scoreRoutingAccuracy/
 * scoreTopologyEfficiency/scoreMacroReuse/scorePromptQuality/
 * runOrchestratorBench).
 */

export interface RoutingScore {
  score: number;
  correct: number;
  total: number;
}

export interface TopologyScore {
  score: number;
  parallelismRatio: number;
  criticalPath: number;
  nodeCount?: number;
}

export interface MacroReuseScore {
  score: number;
  used: number;
  total: number;
  reuseRate?: number;
}

export interface PromptQualityScore {
  score: number | null;
  skipped: boolean;
  reason?: string;
}

export interface ScenarioResult {
  id: string;
  name: string;
  routing: RoutingScore;
  topology: TopologyScore;
  macro: MacroReuseScore;
  prompt: PromptQualityScore;
}

export interface OrchestratorBenchResult {
  name: 'orchestrator';
  scenarios: number;
  routingAccuracy: RoutingScore;
  topologyEfficiency: TopologyScore;
  macroReuse: MacroReuseScore;
  promptQuality: PromptQualityScore;
  overall: number;
  perScenario?: ScenarioResult[];
}

export interface RunOrchestratorBenchOptions {
  live?: boolean;
}

export function runOrchestratorBench(
  options?: RunOrchestratorBenchOptions,
): Promise<OrchestratorBenchResult>;
