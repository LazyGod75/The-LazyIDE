/* lazyReasoningBlocks/etraces.ts — E-trace retrieval from the Brain.
   Three tiers of steering injection, stored as brain neurons:

   E1 — Instance-level: project-scoped patterns from past agent runs.
         Gated by monitor signals (only retrieved when monitors fire).
         Stored with tag 'lazyreasoning:etrace-e1'.

   E2 — Pattern-level: failure-mode patterns, narrowed by failure_type.
         Retrieved when monitors fire a specific failure type.
         Stored with tag 'lazyreasoning:etrace-e2'.

   E3 — Universal rules: fired once on the first call (step 0).
         Stored with tag 'lazyreasoning:etrace-e3'.

   All E-traces are captured via brainNotation.ts and retrieved via
   platform.brain.search/recallScoped — no external API.
*/

import { getPlatform } from '../../platform/index.js';
import type { MonitorResult, MonitorName } from './monitors.js';

// ── Types ─────────────────────────────────────────────────────────

export type ETraceTier = 'e1' | 'e2' | 'e3';

export interface ETrace {
  tier: ETraceTier;
  text: string;
  source?: string;
  failureType?: string;
}

export interface ETraceRetrievalResult {
  traces: ETrace[];
  e1Injected: boolean;
  e2Injected: boolean;
  e3Injected: boolean;
}

// ── E3: Universal rules (fired once at step 0) ───────────────────

const E3_UNIVERSAL_RULES: ETrace[] = [
  {
    tier: 'e3',
    text: 'Always verify your changes compile and pass tests before calling FINAL. Use run_tests or run_command to verify.',
    source: 'universal',
  },
  {
    tier: 'e3',
    text: 'When stuck on an error, search the brain for similar past failures before retrying the same approach.',
    source: 'universal',
  },
  {
    tier: 'e3',
    text: 'Prefer minimal, targeted edits over large rewrites. Read the file first, understand the context, then edit.',
    source: 'universal',
  },
];

// ── E1: Instance-level (project-scoped) ──────────────────────────

/**
 * Retrieve E1 traces from the brain — project-scoped patterns from past agent runs.
 * Only called when monitors fired or composite > 0.15 (gated by FSM).
 */
async function retrieveE1(
  projectId: string,
  failureType: string | null,
): Promise<ETrace[]> {
  try {
    const platform = getPlatform();
    if (!platform?.brain?.search) return [];

    // Search for project-scoped agent patterns
    const query = `lazyreasoning etrace-e1 ${projectId} ${failureType ?? ''}`;
    const results = await platform.brain.search(query, 3);

    return results
      .filter((r) => r.snippet.includes('lazyreasoning:etrace-e1') || r.title.includes('lazyreasoning:etrace-e1'))
      .slice(0, 1) // top_k=1
      .map((r) => ({
        tier: 'e1' as const,
        text: r.snippet?.slice(0, 500) ?? r.title,
        source: r.id,
        failureType: failureType ?? undefined,
      }));
  } catch {
    return [];
  }
}

// ── E2: Pattern-level (failure-mode) ─────────────────────────────

/**
 * Retrieve E2 traces from the brain — failure-mode patterns narrowed by failure_type.
 * Called when a monitor fires with a specific failure type.
 */
async function retrieveE2(
  failureType: MonitorName | null,
): Promise<ETrace[]> {
  if (!failureType) return [];

  try {
    const platform = getPlatform();
    if (!platform?.brain?.search) return [];

    const query = `lazyreasoning etrace-e2 failure:${failureType}`;
    const results = await platform.brain.search(query, 5);

    return results
      .filter((r) => r.snippet.includes('lazyreasoning:etrace-e2') || r.title.includes('lazyreasoning:etrace-e2'))
      .filter((r) => r.snippet.includes(`failure:${failureType}`) || r.title.includes(`failure:${failureType}`))
      .slice(0, 2) // top_k=2
      .map((r) => ({
        tier: 'e2' as const,
        text: r.snippet?.slice(0, 400) ?? r.title,
        source: r.id,
        failureType,
      }));
  } catch {
    return [];
  }
}

// ── E3: Universal rules ──────────────────────────────────────────

function retrieveE3(): ETrace[] {
  return E3_UNIVERSAL_RULES;
}

// ── Main retrieval ───────────────────────────────────────────────

export interface ETraceRetrievalOpts {
  projectId: string;
  step: number;
  monitorResult: MonitorResult | null;
  e1Allowed: boolean;
  e1MaxCalls: number;
  e2MaxCalls: number;
  e3Fired: boolean;
}

export async function retrieveETraces(opts: ETraceRetrievalOpts): Promise<ETraceRetrievalResult> {
  const { projectId, step, monitorResult, e1Allowed, e1MaxCalls, e2MaxCalls, e3Fired } = opts;

  const traces: ETrace[] = [];
  let e1Injected = false;
  let e2Injected = false;
  let e3Injected = false;

  // E3: fire once at step 0
  if (step === 0 && !e3Fired) {
    traces.push(...retrieveE3());
    e3Injected = true;
  }

  // E2: fire when monitors produce a failure type (max e2MaxCalls per run)
  if (monitorResult && monitorResult.failureType && e2MaxCalls > 0) {
    const e2Traces = await retrieveE2(monitorResult.failureType as MonitorName);
    if (e2Traces.length > 0) {
      traces.push(...e2Traces);
      e2Injected = true;
    }
  }

  // E1: gated by monitor signals (max e1MaxCalls per run)
  if (e1Allowed && e1MaxCalls > 0 && monitorResult) {
    const e1Traces = await retrieveE1(projectId, monitorResult.failureType);
    if (e1Traces.length > 0) {
      traces.push(...e1Traces);
      e1Injected = true;
    }
  }

  return { traces, e1Injected, e2Injected, e3Injected };
}

// ── Rendering ────────────────────────────────────────────────────

export function renderETraces(traces: ETrace[]): string {
  if (traces.length === 0) return '';

  const blocks = traces.map((t) => {
    const tag = t.tier === 'e3' ? 'E3-UNIVERSAL' : t.tier === 'e2' ? 'E2-PATTERN' : 'E1-INSTANCE';
    return `[${tag}] ${t.text}`;
  });

  return blocks.join('\n');
}
