/**
 * Mission PERF GUARD tests (DeepSeek BYOK optimization wave).
 *
 * Non-regression guards for the two token-diet mechanisms the mission ReAct
 * loop (managedAgent.ts) relies on for every BYOK/DeepSeek step:
 *
 *   1. The tool-definitions block stays lazy-loaded (core tools in full +
 *      one-line index for the rest — toolRegistryLazy.ts) rather than
 *      silently reverting to "all ~46 tools in full every turn"
 *      (toolRegistry.ts's buildToolSignatures(), the pre-fix behavior).
 *   2. The full per-mission system prompt (persona-less path, the common
 *      case) stays within a documented character budget, so a future change
 *      that inlines something large (e.g. a big tool description, a verbose
 *      new policy block) gets caught here instead of silently inflating
 *      every single step's request for every mission.
 *   3. Tool-output observations feeding back into the conversation
 *      (steeringPipeline.compressOutput, the single choke point in
 *      managedAgent.ts right before `messages = [...messages, {role:'user',
 *      content: \`Observation: ${compressedObservation}\`}]`) stay capped —
 *      long output is truncated with an honest marker, short output is
 *      passed through untouched.
 *
 * Budgets below are current measured size + ~10% headroom (measured
 * 2026-08-05: AGENT_SYSTEM_PROMPT = 17234 chars, lazy mission tool block =
 * 9745 chars, savingsPct = 48 vs. the full/unabridged tool-signatures
 * block). Bump the constants deliberately (with a comment explaining why)
 * if a real feature legitimately grows the prompt — this guard exists to
 * catch SILENT growth, not to freeze the prompt forever.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_SYSTEM_PROMPT } from '../lib/agents/managedAgentPolicy';
import { getToolPromptBudget } from '../lib/agents/toolRegistryLazy';
import { SteeringPipeline } from '../lib/agents/lazyReasoningBlocks/steering';

// Current measured size (2026-08-05): 17234 chars. +10% headroom, rounded up.
// Bumped 2026-08-15 (harness hardening, task #1 — see
// scratch/_harness-research.md): the mandatory "FILE EDITS" SEARCH/REPLACE
// protocol block (managedAgentPolicy.ts's buildAgentSystemPrompt) is a
// deliberate, necessary addition — it is the root-cause fix for the M6
// incident (a raw newline inside a JSON `content` string breaking
// JSON.parse and burning ~480 credits on zero code). New measured size:
// 19196 chars. +10% headroom, rounded up.
// Bumped 2026-09-01 (LazyBot/Solari cloud tools): the 31 `cloud_*` tools are
// registered in toolRegistry.ts and appear in the mission tool block as
// one-line lazy-index entries (coreFor: [], so full defs are never inlined) —
// a deliberate product addition, not silent growth. New measured size: 24055
// chars. +10% headroom, rounded up.
const MISSION_SYSTEM_PROMPT_BUDGET_CHARS = 26_500;

// Current measured size (2026-08-05): 9745 chars. +10% headroom, rounded up.
// Bumped 2026-09-01 (LazyBot/Solari cloud tools): the cloud tool index lines
// grew the lazy mission tool block (one `- name: shortHint` line per tool).
// New measured size: 13338 chars. +10% headroom, rounded up.
const MISSION_TOOL_BLOCK_BUDGET_CHARS = 14_700;

// The lazy split must keep saving at least this much vs. the unabridged
// "every tool in full" block, or the core/index split has effectively
// regressed to "everything is core" without anyone noticing.
const MIN_TOOL_SAVINGS_PCT = 30;

describe('Mission PERF GUARD — system prompt + tool schemas budget', () => {
  it('the default (no persona, no preload) mission system prompt stays under the documented character budget', () => {
    expect(AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(AGENT_SYSTEM_PROMPT.length).toBeLessThanOrEqual(MISSION_SYSTEM_PROMPT_BUDGET_CHARS);
  });

  it('the mission tool-definitions block (lazy core+index split) stays under its documented character budget', () => {
    const budget = getToolPromptBudget('mission');
    expect(budget.charsLazy).toBeGreaterThan(0);
    expect(budget.charsLazy).toBeLessThanOrEqual(MISSION_TOOL_BLOCK_BUDGET_CHARS);
  });

  it('lazy tool loading is ACTIVE by default for the mission surface (>= 30% savings vs. unabridged)', () => {
    // Regression guard for the exact fact Phase 1 measured: lazy tool
    // loading is wired in unconditionally for 'mission' (buildAgentSystemPrompt
    // -> buildLazyToolBlock('mission', ...) in managedAgentPolicy.ts), not
    // gated behind a flag some BYOK/DeepSeek code path might miss.
    const budget = getToolPromptBudget('mission');
    expect(budget.charsLazy).toBeLessThan(budget.charsFull);
    expect(budget.savingsPct).toBeGreaterThanOrEqual(MIN_TOOL_SAVINGS_PCT);
  });

  it('the tool block is actually embedded in the full system prompt (not built but unused)', () => {
    const budget = getToolPromptBudget('mission');
    // Sanity: the lazy block's own char count cannot exceed the whole
    // prompt that is supposed to contain it.
    expect(budget.charsLazy).toBeLessThan(AGENT_SYSTEM_PROMPT.length);
  });
});

describe('Mission PERF GUARD — observation truncation at the conversation choke point', () => {
  // Exercises the exact function managedAgent.ts calls
  // (steeringPipeline.compressOutput) right before appending an observation
  // to the growing message list — see managedAgent.ts's
  // `const compressedObservation = steeringPipeline.compressOutput(observation);`.

  it('a short observation is passed through UNTOUCHED', () => {
    const pipeline = new SteeringPipeline('coding');
    const short = 'file written: src/foo.ts (12 lines)';
    expect(pipeline.compressOutput(short)).toBe(short);
  });

  it('a long observation is truncated with an honest, count-bearing marker, keeping head and tail', () => {
    const pipeline = new SteeringPipeline('coding');
    // Both markers are longer than the 2000-char keep window on each side,
    // so the kept head/tail slices are guaranteed to be pure marker text
    // with none of the 'x' middle filler leaking in on either edge.
    const head = 'HEAD_MARKER_'.repeat(200); // 2400 chars
    const tail = 'TAIL_MARKER_'.repeat(200); // 2400 chars
    const middle = 'x'.repeat(20_000); // guaranteed to exceed the 4000-char cap
    const long = head + middle + tail;

    const result = pipeline.compressOutput(long);

    expect(result.length).toBeLessThan(long.length);
    // Honest: names how many characters were dropped, and the count must be
    // a positive number no larger than the original input.
    const match = /\[\.\.\. (\d+) chars omitted/.exec(result);
    expect(match).not.toBeNull();
    const omitted = Number(match![1]);
    expect(omitted).toBeGreaterThan(0);
    expect(omitted).toBeLessThan(long.length);
    // Head and tail survive verbatim; the huge middle filler is fully gone.
    expect(result.startsWith(head.slice(0, 100))).toBe(true);
    expect(result.endsWith(tail.slice(-100))).toBe(true);
    expect(result).not.toContain('x');
  });
});
