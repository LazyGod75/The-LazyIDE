/* evalHarness.ts — P7.8: Evaluation harness for agent missions.

   Provides a framework for running deterministic evaluation suites against
   agent missions, comparing outputs against golden transcripts, and scoring
   results. Designed to be runnable in CI without a Tauri runtime.

   Usage:
   const harness = createEvalHarness({ suites: [...] });
   const results = await harness.run();
   console.log(harness.formatReport(results));
*/

export interface EvalTestCase {
  id: string;
  description: string;
  task: string;
  /** Expected outcome keywords or patterns. */
  expectedContains?: string[];
  expectedNotContains?: string[];
  /** Expected status: 'done' or 'failed'. */
  expectedStatus?: 'done' | 'failed';
  /** Max cost in USD. */
  maxCostUsd?: number;
  /** Max duration in ms. */
  maxDurationMs?: number;
}

export interface EvalSuite {
  id: string;
  name: string;
  cases: EvalTestCase[];
}

export interface EvalResult {
  caseId: string;
  suiteId: string;
  passed: boolean;
  score: number;
  durationMs: number;
  costUsd?: number;
  failures: string[];
  output?: string;
}

export interface EvalReport {
  totalCases: number;
  passed: number;
  failed: number;
  passRate: number;
  totalCostUsd: number;
  totalDurationMs: number;
  results: EvalResult[];
}

export interface EvalHarnessConfig {
  suites: EvalSuite[];
  /** Runner function that executes a test case and returns output. */
  runCase: (testCase: EvalTestCase) => Promise<{
    status: 'done' | 'failed';
    output: string;
    costUsd?: number;
    durationMs: number;
  }>;
}

export function createEvalHarness(config: EvalHarnessConfig) {
  return {
    async run(): Promise<EvalReport> {
      const results: EvalResult[] = [];

      for (const suite of config.suites) {
        for (const testCase of suite.cases) {
          const result = await runSingleCase(suite, testCase, config.runCase);
          results.push(result);
        }
      }

      return buildReport(results);
    },

    formatReport(report: EvalReport): string {
      const lines: string[] = [
        `# Eval Report`,
        ``,
        `- Total: ${report.totalCases}`,
        `- Passed: ${report.passed}`,
        `- Failed: ${report.failed}`,
        `- Pass rate: ${(report.passRate * 100).toFixed(1)}%`,
        `- Total cost: $${report.totalCostUsd.toFixed(4)}`,
        `- Total duration: ${(report.totalDurationMs / 1000).toFixed(1)}s`,
        ``,
      ];

      for (const result of report.results) {
        const status = result.passed ? '✓' : '✗';
        lines.push(`${status} ${result.suiteId}/${result.caseId} — score: ${result.score.toFixed(2)} (${result.durationMs}ms${result.costUsd !== undefined ? `, $${result.costUsd.toFixed(4)}` : ''})`);
        if (result.failures.length > 0) {
          for (const f of result.failures) {
            lines.push(`  - ${f}`);
          }
        }
      }

      return lines.join('\n');
    },
  };
}

async function runSingleCase(
  suite: EvalSuite,
  testCase: EvalTestCase,
  runCase: EvalHarnessConfig['runCase'],
): Promise<EvalResult> {
  const failures: string[] = [];
  let score = 1.0;

  try {
    const output = await runCase(testCase);

    if (testCase.expectedStatus && output.status !== testCase.expectedStatus) {
      failures.push(`Expected status '${testCase.expectedStatus}', got '${output.status}'`);
      score -= 0.3;
    }

    if (testCase.expectedContains) {
      for (const expected of testCase.expectedContains) {
        if (!output.output.includes(expected)) {
          failures.push(`Output missing expected text: "${expected}"`);
          score -= 0.2;
        }
      }
    }

    if (testCase.expectedNotContains) {
      for (const notExpected of testCase.expectedNotContains) {
        if (output.output.includes(notExpected)) {
          failures.push(`Output contains forbidden text: "${notExpected}"`);
          score -= 0.2;
        }
      }
    }

    if (testCase.maxCostUsd !== undefined && output.costUsd !== undefined) {
      if (output.costUsd > testCase.maxCostUsd) {
        failures.push(`Cost $${output.costUsd.toFixed(4)} exceeds max $${testCase.maxCostUsd.toFixed(4)}`);
        score -= 0.2;
      }
    }

    if (testCase.maxDurationMs !== undefined && output.durationMs > testCase.maxDurationMs) {
      failures.push(`Duration ${output.durationMs}ms exceeds max ${testCase.maxDurationMs}ms`);
      score -= 0.1;
    }

    return {
      caseId: testCase.id,
      suiteId: suite.id,
      passed: failures.length === 0,
      score: Math.max(0, score),
      durationMs: output.durationMs,
      costUsd: output.costUsd,
      failures,
      output: output.output,
    };
  } catch (err) {
    return {
      caseId: testCase.id,
      suiteId: suite.id,
      passed: false,
      score: 0,
      durationMs: 0,
      failures: [`Exception: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

function buildReport(results: EvalResult[]): EvalReport {
  const passed = results.filter((r) => r.passed).length;
  const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

  return {
    totalCases: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length > 0 ? passed / results.length : 0,
    totalCostUsd: totalCost,
    totalDurationMs: totalDuration,
    results,
  };
}
