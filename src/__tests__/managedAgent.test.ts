/**
 * Tests for the managed agent path:
 *   - parseReActAction(): pure parser
 *   - planAndActManaged(): loop with mocked streamManagedAgentTurn + invoke
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock @tauri-apps/api/core ──────────────────────────────────────
// The global setup.ts already provides a vi.fn() for invoke.
// We import it here to configure per-test behaviours.
import { invoke } from '@tauri-apps/api/core';

// ── Mock managedProvider's streamManagedAgentTurn ─────────────────
vi.mock('../lib/models/managedProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/managedProvider')>();
  return {
    ...actual,
    streamManagedAgentTurn: vi.fn(),
  };
});

// ── Mock platform (brain recall) ──────────────────────────────────
vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recall: vi.fn().mockResolvedValue({
        injectedContext: '',
        nodes: [],
        tokensInjected: 0,
        tokensSaved: 0,
      }),
      capture: vi.fn().mockResolvedValue(undefined),
      startupContext: vi.fn().mockResolvedValue(''),
    },
    // attach_proof's test_run/command_output branches persist captured
    // output via storeProofText (proofs.ts) before this platform mock
    // existed only `brain` was ever exercised here, so no test hit this gap
    // — added for the run-12/M14 regression test below, which is the first
    // in this file to attach a test_run/command_output kind.
    fs: {
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  })),
}));

// ── Mock brain/context helpers ────────────────────────────────────
vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn((r: unknown) => r),
  buildPromptBrainContext: vi.fn(() => ''),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

// ── Mock agentsStorage's listAgents (persona resolution by agentName) ─────
vi.mock('../lib/agents/agentsStorage', () => ({
  listAgents: vi.fn().mockResolvedValue([]),
}));

// ── Mock the journal client (T0.4 instrumentation — see the "journal
// instrumentation" / "settled spend correction" describe blocks near the
// end of this file). ────────────────────────────────────────────────
vi.mock('../lib/journal/journal', () => ({
  emitBuffered: vi.fn(),
  emitEvent: vi.fn(),
}));

// ── Mock supabase/env — only exercised by the "settled spend correction"
// describe block below, which uses vi.importActual to drive the REAL
// streamManagedAgentTurn (bypassing the vi.mock('../lib/models/managedProvider',
// ...) override above, just for those tests). Harmless for every other test
// in this file: none of them ever call a method on the real supabase client
// — see managedProvider.test.ts for the identical mocking pattern. ───
vi.mock('../lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-token' } } }),
    },
  },
}));
vi.mock('../lib/env', () => ({
  supabaseAnonKey: 'test-anon-key',
  getAiProxyUrl: () => 'https://mock.proxy/ai',
}));

import {
  parseReActAction,
  planAndActManaged,
  stripVerbatimPrefix,
  toManagedOpenRouterModel,
} from '../lib/agents/managedAgent';
import type { PlanStep, ActionEvent } from '../lib/agents/types';
import { streamManagedAgentTurn } from '../lib/models/managedProvider';
import type { RealUsage } from '../lib/models/managedProvider';
import { listAgents } from '../lib/agents/agentsStorage';
import { saveProjectPermissions } from '../lib/agents/toolPermissions';
import { emitBuffered } from '../lib/journal/journal';
import type { JournalEventInput } from '../lib/journal/eventTypes';
import { getPlatform } from '../lib/platform';
import type { ProofArtifact } from '../lib/agents/types';
import { MISSION_HISTORY_CHAR_BUDGET } from '../lib/agents/missionHistoryWindow';

// ── Helpers ───────────────────────────────────────────────────────

const mockedStream = streamManagedAgentTurn as ReturnType<typeof vi.fn>;
const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

/** The exact shape the top-level `vi.mock('../lib/platform', ...)` factory
 *  returns — reused by the mission-summary-capture describe block below to
 *  restore the default (all-resolving) platform after each test that
 *  overrides `brain.capture` to reject, so the override never leaks into
 *  unrelated tests later in this file (vi.clearAllMocks() in the global
 *  beforeEach clears mock.calls but does NOT undo a custom mockImplementation). */
function defaultPlatformMock() {
  return {
    brain: {
      recall: vi.fn().mockResolvedValue({
        injectedContext: '',
        nodes: [],
        tokensInjected: 0,
        tokensSaved: 0,
      }),
      capture: vi.fn().mockResolvedValue(undefined),
      startupContext: vi.fn().mockResolvedValue(''),
    },
    fs: {
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
}
const mockedListAgents = listAgents as ReturnType<typeof vi.fn>;
const mockedEmitBuffered = emitBuffered as ReturnType<typeof vi.fn>;

/** Creates an async generator that yields a single text chunk. */
async function* makeStream(text: string): AsyncIterable<string> {
  yield text;
}

function makeSteps(): PlanStep[] {
  return [
    { label: 'Initialisation', state: 'todo' as const },
    { label: 'Analyse', state: 'todo' as const },
    { label: 'Implémentation', state: 'todo' as const },
    { label: 'Tests', state: 'todo' as const },
    { label: 'Diff', state: 'todo' as const },
  ];
}

function makeOpts(overrides: Partial<Parameters<typeof planAndActManaged>[0]> = {}) {
  const onStep = vi.fn();
  const onAction = vi.fn();
  const onProgress = vi.fn();
  const stopSignal = vi.fn(() => false);

  return {
    missionId: 'test-mission-1',
    missionTitle: 'Test task',
    worktreePath: '/tmp/wt/test',
    steps: makeSteps(),
    onStep,
    onAction,
    onProgress,
    stopSignal,
    model: 'anthropic/claude-sonnet-5',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedInvoke.mockResolvedValue(undefined);
  mockedListAgents.mockResolvedValue([]);
  // toolPermissions.ts persists rules to localStorage (project/user) —
  // clear it so no test's seeded permission rules leak into another.
  localStorage.clear();
});

// ── parseReActAction tests ─────────────────────────────────────────

describe('parseReActAction', () => {
  it('parses a valid THOUGHT/ACTION/ARGS block', () => {
    const text = `THOUGHT: I should read the file first
ACTION: read_file
ARGS: {"path": "src/index.ts"}`;
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('read_file');
    expect(result?.args).toEqual({ path: 'src/index.ts' });
  });

  it('parses FINAL action with summary', () => {
    const text = `THOUGHT: All done
ACTION: FINAL
ARGS: {"summary": "Task completed successfully"}`;
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('FINAL');
    expect(result?.args).toEqual({ summary: 'Task completed successfully' });
  });

  it('handles code-fenced ARGS (```json ... ```)', () => {
    const text = `THOUGHT: Writing the file
ACTION: write_file
ARGS: \`\`\`json
{"path": "output.txt", "content": "hello world"}
\`\`\``;
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('write_file');
    expect(result?.args).toEqual({ path: 'output.txt', content: 'hello world' });
  });

  it('strips reasoning prefix \\x1b[reasoning] before parsing', () => {
    const text = `\x1b[reasoning]Some internal thinking\nTHOUGHT: Proceeding with action
ACTION: read_dir
ARGS: {"path": "."}`;
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('read_dir');
    expect(result?.args).toEqual({ path: '.' });
  });

  it('returns null for empty text', () => {
    expect(parseReActAction('')).toBeNull();
  });

  it('returns null for malformed text with no ACTION line', () => {
    const text = 'This is just some prose without any format.';
    expect(parseReActAction(text)).toBeNull();
  });

  it('handles extra prose before THOUGHT', () => {
    const text = `Let me think about this...

THOUGHT: I need to write a file
ACTION: write_file
ARGS: {"path": "test.ts", "content": "export {}"}`;
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('write_file');
    expect(result?.args.path).toBe('test.ts');
  });

  it('returns FINAL with empty args when ARGS line is missing for FINAL action', () => {
    const text = `THOUGHT: Done
ACTION: FINAL`;
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('FINAL');
    expect(result?.args).toEqual({});
  });

  it('tolerates a no-arg tool whose ARGS line is omitted entirely (deepseek-class models)', () => {
    const text = `THOUGHT: I need to start a browser.
ACTION: cloud_browser_open`;
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('cloud_browser_open');
    expect(result?.args).toEqual({});
  });

  it('parses a bare JSON object on the line after ACTION without an ARGS: prefix', () => {
    const text = `THOUGHT: Now navigate to the site.
ACTION: cloud_browser_navigate
{"url": "https://example.com"}`;
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('cloud_browser_navigate');
    expect(result?.args).toEqual({ url: 'https://example.com' });
  });

  it('does not confuse prose braces before ACTION with bare args', () => {
    const text = `THOUGHT: The component looks like function Foo({ bar }) { return 1; }
ACTION: cloud_browser_navigate
ARGS: {"url": "https://x.com"}`;
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('cloud_browser_navigate');
    expect(result?.args).toEqual({ url: 'https://x.com' });
  });

  it('returns null when ARGS has invalid JSON', () => {
    const text = `THOUGHT: Invalid
ACTION: read_file
ARGS: {not valid json}`;
    expect(parseReActAction(text)).toBeNull();
  });

  // ── M6 incident (2026-08-14) — real-money parse-retry loop: a mission
  // burned 224 credits over ~40min on a one-line React prop change because
  // "Could not parse agent response" retried repeatedly. Root cause: the
  // model's write_file `content` for the JSX/TSX file contained a raw,
  // unescaped newline (breaks strict JSON.parse), AND — a second,
  // independent bug — the balanced-brace fallback used to rescan the WHOLE
  // response from its first `{`, which lands in THOUGHT prose (any
  // React/JSX task puts a brace there) instead of the real ARGS object.
  // These two tests are the regression coverage for both fixes.

  it('recovers ARGS content with a raw (unescaped) newline — the common write_file/edit_file near-miss', () => {
    const text = [
      'THOUGHT: Adding the baz prop to the Foo component.',
      'ACTION: write_file',
      'ARGS: {"path": "src/Foo.tsx", "content": "function Foo({ bar, baz }: Props) {\n  return <div>{bar}{baz}</div>;\n}"}',
    ].join('\n');
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('write_file');
    expect(result?.args.path).toBe('src/Foo.tsx');
    expect(result?.args.content).toBe(
      'function Foo({ bar, baz }: Props) {\n  return <div>{bar}{baz}</div>;\n}',
    );
  });

  it('recovers the real ARGS object even when THOUGHT contains an earlier, unrelated `{` (React/JSX prose) and trailing prose follows ARGS', () => {
    // multiLineMatch's own regex already selects the right substring here,
    // but a raw newline inside content still breaks strict JSON.parse,
    // forcing the fallback path — which is exactly what must NOT anchor on
    // THOUGHT's earlier brace.
    const text = [
      'THOUGHT: The component currently looks like function Foo({ bar }) { return <div>{bar}</div>; } — I will add a prop.',
      'ACTION: write_file',
      'ARGS: {"path": "src/Foo.tsx", "content": "function Foo({ bar, baz }: Props) {\n  return <div>{bar}{baz}</div>;\n}"}',
      'This satisfies the requirement.',
    ].join('\n');
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('write_file');
    expect(result?.args.path).toBe('src/Foo.tsx');
  });

  it('still returns null for genuinely unparseable ARGS (never silently accepts garbage)', () => {
    const text = `THOUGHT: broken on purpose
ACTION: write_file
ARGS: {"path": "x.ts", "content": not even close to json}`;
    expect(parseReActAction(text)).toBeNull();
  });

  // ── SEARCH/REPLACE file-edit protocol (2026-08-15 — root-cause fix for
  // the M6 incident class above: see searchReplaceProtocol.ts's header).
  // edit_file/multi_edit/write_file now accept file CONTENT in a fenced
  // block instead of a JSON string value, so it is never round-tripped
  // through JSON.parse at all — this is the direct regression test for
  // "a multi-line JSX edit round-trips without escaping damage" (verify
  // gate #4 of the harness-hardening task).

  it('parses an edit_file SEARCH/REPLACE block with real multi-line JSX — no JSON escaping needed', () => {
    const text = [
      'THOUGHT: Adding the baz prop to the Foo component.',
      'ACTION: edit_file',
      'FILE: src/Foo.tsx',
      '<<<<<<< SEARCH',
      'function Foo({ bar }: Props) {',
      '  return <div>{bar}</div>;',
      '}',
      '=======',
      'function Foo({ bar, baz }: Props) {',
      '  return <div>{bar}{baz}</div>;',
      '}',
      '>>>>>>> REPLACE',
    ].join('\n');
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('edit_file');
    expect(result?.args.path).toBe('src/Foo.tsx');
    expect(result?.args.old_string).toBe('function Foo({ bar }: Props) {\n  return <div>{bar}</div>;\n}');
    expect(result?.args.new_string).toBe(
      'function Foo({ bar, baz }: Props) {\n  return <div>{bar}{baz}</div>;\n}',
    );
  });

  it('parses a multi_edit block with two SEARCH/REPLACE pairs under one FILE: line', () => {
    const text = [
      'THOUGHT: two changes',
      'ACTION: multi_edit',
      'FILE: src/Foo.tsx',
      '<<<<<<< SEARCH',
      'const a = 1;',
      '=======',
      'const a = 2;',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'const b = 1;',
      '=======',
      'const b = 2;',
      '>>>>>>> REPLACE',
    ].join('\n');
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('multi_edit');
    expect(result?.args.path).toBe('src/Foo.tsx');
    expect(result?.args.edits).toEqual([
      { old_string: 'const a = 1;', new_string: 'const a = 2;' },
      { old_string: 'const b = 1;', new_string: 'const b = 2;' },
    ]);
  });

  it('parses a write_file FILE + fenced content block (no ARGS/JSON)', () => {
    const text = [
      'THOUGHT: new file',
      'ACTION: write_file',
      'FILE: src/NewFile.tsx',
      '```tsx',
      'export function NewFile() {',
      '  return <div>hi</div>;',
      '}',
      '```',
    ].join('\n');
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.action).toBe('write_file');
    expect(result?.args.path).toBe('src/NewFile.tsx');
    expect(result?.args.content).toBe('export function NewFile() {\n  return <div>hi</div>;\n}');
  });

  it('falls back to ARGS/JSON for edit_file when no FILE:/SEARCH marker is present (backward compatible)', () => {
    const text = 'THOUGHT: legacy shape\nACTION: edit_file\nARGS: {"path": "a.ts", "old_string": "x", "new_string": "y"}';
    const result = parseReActAction(text);
    expect(result).not.toBeNull();
    expect(result?.args).toEqual({ path: 'a.ts', old_string: 'x', new_string: 'y' });
  });
});

// ── stripVerbatimPrefix (Windows \\?\ / \\?\UNC\ handling) ─────────
// Regression coverage for: managed-loop read_file failing on worktree paths
// that carry the Windows extended-length ("verbatim") prefix. write_file is
// unaffected by design — see the planAndActManaged test below that exercises
// both invoke calls from a single edit_file action.

describe('stripVerbatimPrefix', () => {
  it('strips a plain Windows verbatim prefix', () => {
    const prefixed = String.raw`\\?\C:\Users\dev\wt\test`;
    expect(stripVerbatimPrefix(prefixed)).toBe(String.raw`C:\Users\dev\wt\test`);
  });

  it('strips a UNC verbatim prefix down to a standard UNC path', () => {
    const prefixed = String.raw`\\?\UNC\server\share\wt\test`;
    expect(stripVerbatimPrefix(prefixed)).toBe(String.raw`\\server\share\wt\test`);
  });

  it('is a no-op for POSIX paths', () => {
    expect(stripVerbatimPrefix('/tmp/wt/test/file.ts')).toBe('/tmp/wt/test/file.ts');
  });

  it('is a no-op for already-normal Windows paths without the verbatim prefix', () => {
    const normal = String.raw`C:\Users\dev\wt\test`;
    expect(stripVerbatimPrefix(normal)).toBe(normal);
  });
});

// ── planAndActManaged loop tests ───────────────────────────────────

describe('planAndActManaged', () => {
  it('calls invoke write_file with worktree-resolved path and stops on FINAL', async () => {
    const writeTurn = `THOUGHT: Writing the output file
ACTION: write_file
ARGS: {"path": "result.ts", "content": "export const result = 42;"}`;

    const finalTurn = `THOUGHT: All done
ACTION: FINAL
ARGS: {"summary": "File written successfully"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? writeTurn : finalTurn);
    });

    mockedInvoke.mockResolvedValue(undefined);

    const opts = makeOpts();
    await planAndActManaged(opts);

    // invoke('write_file') should have been called with the worktree-prefixed path
    expect(mockedInvoke).toHaveBeenCalledWith('write_file', {
      path: '/tmp/wt/test/result.ts',
      content: 'export const result = 42;',
    });

    // onAction should have been called at least once
    expect(opts.onAction).toHaveBeenCalled();

    // Should have called onProgress at 100 on completion
    expect(opts.onProgress).toHaveBeenCalledWith(100);
  });

  it('feeds observations back as user messages in the next turn', async () => {
    const readTurn = `THOUGHT: I need to read the file
ACTION: read_file
ARGS: {"path": "src/main.ts"}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Read and processed"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? readTurn : finalTurn);
    });

    mockedInvoke.mockResolvedValue('// file content here');

    const opts = makeOpts();
    await planAndActManaged(opts);

    // The second call to streamManagedAgentTurn should include the observation
    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg).toBeDefined();
    expect(observationMsg?.content).toContain('file content here');
  });

  it('stops at MAX_STEPS (100) if no FINAL is emitted', async () => {
    // Always emit a read_file action — never FINAL. Path varies per call
    // (2026-08-15, stuck-detector task) so this scenario is genuinely
    // "many different, individually harmless steps with no completion" —
    // not the repeated-identical-call shape the NEW stuck detector now
    // correctly aborts early (see the dedicated describe block below); a
    // static path here would legitimately hit that fix and defeat this
    // test's own purpose (proving the MAX_STEPS ceiling itself).
    let n = 0;
    mockedStream.mockImplementation(() => {
      n += 1;
      return makeStream(`THOUGHT: Still reading\nACTION: read_file\nARGS: {"path": "file-${n}.ts"}`);
    });
    mockedInvoke.mockResolvedValue('file content');

    const opts = makeOpts();
    await planAndActManaged(opts);

    // Should have called streamManagedAgentTurn exactly 102 times:
    // 100 main steps (MAX_STEPS raised 20 -> 40 -> 60 -> 100 for DeepSeek
    // verbose verification loops, 2026-08-05)
    // + 2 PRM verifier calls (at step=5 and step=10, capped at PRM_MAX=2)
    expect(mockedStream).toHaveBeenCalledTimes(102);

    // Should have called onProgress with 100 at the end
    expect(opts.onProgress).toHaveBeenCalledWith(100);

    // onAction should mention max steps
    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Max steps') || t.includes('100'))).toBe(true);
  });

  it('bounds the transcript sent to the LLM on a long mission (missionHistoryWindow.ts, token-efficiency 2026-08-14)', async () => {
    // Every step reads a "file" and gets a sizeable observation back —
    // simulates a real coding mission's growing transcript. Before
    // missionHistoryWindow.ts was wired in, `messages` grew unbounded and
    // every one of these observations was resent, verbatim, on every
    // subsequent step.
    const bigObservation = 'line of file content\n'.repeat(150); // ~3.3k chars
    // Path varies per call (2026-08-15, stuck-detector task) — same
    // rationale as the MAX_STEPS test above: a static path here would
    // legitimately hit the new stuck detector (repeated-action-observation)
    // and cut the mission short before the transcript actually grows large
    // enough to exercise windowing, defeating this test's own purpose.
    let n = 0;
    mockedStream.mockImplementation(() => {
      n += 1;
      return makeStream(`THOUGHT: Still reading\nACTION: read_file\nARGS: {"path": "file-${n}.ts"}`);
    });
    mockedInvoke.mockResolvedValue(bigObservation);

    const opts = makeOpts();
    await planAndActManaged(opts);

    // Sanity: this scenario really would have exceeded the budget many
    // times over without windowing (100 steps × ~3.3k chars ≈ 330k chars).
    const lastCallMessages = mockedStream.mock.calls[mockedStream.mock.calls.length - 1][0].messages as Array<{
      role: string;
      content: string;
    }>;
    const lastCallChars = lastCallMessages.reduce((sum, m) => sum + m.content.length, 0);
    expect(lastCallChars).toBeLessThan(MISSION_HISTORY_CHAR_BUDGET + 8_000); // pinned-task cap + marker headroom
    // The mission's task/standing goal must still be reachable in the
    // windowed transcript (never silently lost, even once dropped).
    expect(lastCallMessages[0].content).toContain('Test task');
  });

  it('stops immediately when stopSignal returns true', async () => {
    const readTurn = `THOUGHT: reading
ACTION: read_file
ARGS: {"path": "file.ts"}`;

    mockedStream.mockImplementation(() => makeStream(readTurn));
    mockedInvoke.mockResolvedValue('content');

    // stopSignal returns true after the first step
    let calls = 0;
    const stopSignal = vi.fn(() => {
      calls += 1;
      return calls > 1; // stop after first invocation
    });

    const opts = makeOpts({ stopSignal });
    await planAndActManaged(opts);

    // Should have been invoked but stopped early
    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.toLowerCase().includes('stop'))).toBe(true);

    // streamManagedAgentTurn should have been called at most once
    expect(mockedStream.mock.calls.length).toBeLessThanOrEqual(2);
  });

  // Money incident (2026-08-14, real-app QA — "Stoppe tout" clicked, credit
  // balance kept falling with no new mission launched): the test above only
  // proves stopSignal prevents the NEXT turn from starting — it says nothing
  // about a turn that is ALREADY streaming when Stop is clicked, which is
  // exactly the gap that kept billing. `signal` (PlanAndActManagedOpts, see
  // its own doc comment) is the real mid-stream cancellation channel,
  // forwarded into streamAgentTurn -> streamManagedAgentTurn (this file's
  // mock) so an abort reaches the in-flight call directly, the same way
  // managedProvider.ts's real fetch(..., { signal }) does.
  it('aborts an in-flight turn via `signal` and makes no further provider call (stop must cancel work already streaming, not just prevent the next turn)', async () => {
    const controller = new AbortController();
    let callCount = 0;
    mockedStream.mockImplementation(async function* () {
      callCount += 1;
      yield 'THOUGHT: working\n';
      // Simulate the user clicking Stop/"Stoppe tout" WHILE this turn is
      // still streaming — managedProvider.ts's real fetch(..., { signal })
      // rejects the in-flight read with a DOMException named 'AbortError'
      // the instant the caller's AbortController fires; this mirrors that
      // exact shape rather than a generic network error.
      controller.abort();
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      throw abortError;
    });
    mockedInvoke.mockResolvedValue('content');

    const opts = makeOpts({ signal: controller.signal, stopSignal: vi.fn(() => false) });
    await planAndActManaged(opts);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Agent stopped by user'))).toBe(true);
    // Exactly one call: the aborted one. No retry as a transient failure, no
    // format-retry, no second turn — the loop must exit the instant the
    // in-flight request is cancelled, never attempt another billed call.
    expect(callCount).toBe(1);
    expect(mockedStream.mock.calls.length).toBe(1);
  });

  it('calls onAction with live=true when agent starts', async () => {
    const finalTurn = `THOUGHT: Done immediately
ACTION: FINAL
ARGS: {"summary": "nothing to do"}`;

    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts();
    await planAndActManaged(opts);

    const liveActions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => (c[0] as ActionEvent))
      .filter((e: ActionEvent) => e.isLive);
    expect(liveActions.length).toBeGreaterThan(0);
  });

  // ── New tool tests (edit_file, run_command, glob, brain_query, brain_record) ──

  it('edit_file: reads file, replaces old_string, writes back', async () => {
    const editTurn = `THOUGHT: Need to edit the file
ACTION: edit_file
ARGS: {"path": "src/config.ts", "old_string": "const x = 1", "new_string": "const x = 2"}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Edited config"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? editTurn : finalTurn);
    });

    // First invoke: read_file returns content with old_string
    // Second invoke: write_file with updated content
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('const x = 1\nrest');
      if (cmd === 'write_file') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    // Should have called read_file then write_file
    const calls = mockedInvoke.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('read_file');
    expect(calls).toContain('write_file');

    // The write_file call should contain the updated content
    const writeCall = mockedInvoke.mock.calls.find(
      (c: unknown[]) => c[0] === 'write_file',
    );
    expect(writeCall).toBeDefined();
    const writeArg = writeCall![1] as { path: string; content: string };
    expect(writeArg.content).toContain('const x = 2');
    expect(writeArg.content).not.toContain('const x = 1');
  });

  it('edit_file: strips the Windows verbatim prefix for read_file but leaves write_file unchanged', async () => {
    const editTurn = `THOUGHT: Need to edit the file
ACTION: edit_file
ARGS: {"path": "src/config.ts", "old_string": "const x = 1", "new_string": "const x = 2"}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Edited config"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? editTurn : finalTurn);
    });

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('const x = 1\nrest');
      if (cmd === 'write_file') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    // Simulates a worktreePath canonicalized by the Rust side on Windows
    // (std::fs::canonicalize always returns a \\?\-prefixed path there).
    const verbatimWorktree = String.raw`\\?\C:\Users\dev\wt\test`;
    const opts = makeOpts({ worktreePath: verbatimWorktree });
    await planAndActManaged(opts);

    const readCall = mockedInvoke.mock.calls.find((c: unknown[]) => c[0] === 'read_file');
    const writeCall = mockedInvoke.mock.calls.find((c: unknown[]) => c[0] === 'write_file');
    expect(readCall).toBeDefined();
    expect(writeCall).toBeDefined();

    // read_file must NOT carry the \\?\ verbatim prefix — the Rust guard rejects it.
    // resolvePath joins through paths.ts's joinPath (T5.4), which reuses
    // whatever separator the base already contains throughout — so a
    // backslash-based verbatim base produces an all-backslash result, never
    // the old mixed "base\...\rel/rel" string a hardcoded '/' join produced.
    const readPath = (readCall![1] as { path: string }).path;
    expect(readPath).toBe(String.raw`C:\Users\dev\wt\test\src\config.ts`);

    // write_file keeps receiving the original worktree-resolved path, unchanged
    // (still verbatim-prefixed, still all-backslash).
    const writePath = (writeCall![1] as { path: string }).path;
    expect(writePath).toBe(String.raw`\\?\C:\Users\dev\wt\test\src\config.ts`);
  });

  it('edit_file: returns error when old_string not found', async () => {
    const editTurn = `THOUGHT: Trying to edit
ACTION: edit_file
ARGS: {"path": "missing.ts", "old_string": "NOT_FOUND", "new_string": "replacement"}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Could not edit"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? editTurn : finalTurn);
    });

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('some content without the target');
      return Promise.resolve(undefined);
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    // The observation should contain ERROR
    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg).toBeDefined();
    expect(observationMsg?.content).toContain('ERROR');
    expect(observationMsg?.content).toContain('old_string not found');
  });

  it('run_command: executes shell command and returns output', async () => {
    const cmdTurn = `THOUGHT: Running lint
ACTION: run_command
ARGS: {"command": "npm run lint", "timeout_ms": 10000}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Lint passed"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? cmdTurn : finalTurn);
    });

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') {
        return Promise.resolve({ stdout: '0 errors', stderr: '', exitCode: 0 });
      }
      return Promise.resolve(undefined);
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    // Should have called run_shell
    const shellCall = mockedInvoke.mock.calls.find(
      (c: unknown[]) => c[0] === 'run_shell',
    );
    expect(shellCall).toBeDefined();
    const shellArg = shellCall![1] as { command: string; cwd: string; timeoutMs: number };
    expect(shellArg.command).toBe('npm run lint');
    expect(shellArg.cwd).toBe('/tmp/wt/test');

    // Observation should contain the output
    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg).toBeDefined();
    expect(observationMsg?.content).toContain('0 errors');
    expect(observationMsg?.content).toContain('[exit 0]');
  });

  it('glob: finds files matching pattern', async () => {
    const globTurn = `THOUGHT: Finding all TS files
ACTION: glob
ARGS: {"pattern": "*.ts"}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Found files"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? globTurn : finalTurn);
    });

    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_dir') {
        return Promise.resolve([
          { name: 'index.ts', path: '/tmp/wt/test/index.ts', kind: 'file' },
          { name: 'config.ts', path: '/tmp/wt/test/config.ts', kind: 'file' },
          { name: 'README.md', path: '/tmp/wt/test/README.md', kind: 'file' },
          { name: 'src', path: '/tmp/wt/test/src', kind: 'dir' },
        ]);
      }
      return Promise.resolve(undefined);
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    // Observation should list matching files
    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg).toBeDefined();
    expect(observationMsg?.content).toContain('index.ts');
    expect(observationMsg?.content).toContain('config.ts');
    expect(observationMsg?.content).not.toContain('README.md');
  });

  it('brain_query: queries brain and returns context', async () => {
    const queryTurn = `THOUGHT: Checking brain for prior solutions
ACTION: brain_query
ARGS: {"query": "how to configure auth"}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Found brain context"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? queryTurn : finalTurn);
    });

    mockedInvoke.mockResolvedValue(undefined);

    const opts = makeOpts();
    await planAndActManaged(opts);

    // The observation should be fed back
    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg).toBeDefined();
    // Should contain brain query result or "No brain results"
    expect(
      observationMsg?.content.includes('No brain results') ||
      observationMsg?.content.includes('brain')
    ).toBe(true);
  });

  it('brain_record: captures discovery to brain via platform', async () => {
    const recordTurn = `THOUGHT: Recording a discovery
ACTION: brain_record
ARGS: {"kind": "success", "title": "Auth config works", "description": "Setting JWT_SECRET env var fixes auth", "tags": ["auth", "config"]}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Recorded to brain"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? recordTurn : finalTurn);
    });

    mockedInvoke.mockResolvedValue(undefined);

    const opts = makeOpts();
    await planAndActManaged(opts);

    // The observation should mention recording to brain
    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg).toBeDefined();
    expect(observationMsg?.content).toContain('Recorded to brain');
    expect(observationMsg?.content).toContain('Auth config works');
  });
});

// ── attach_proof: the tool must build the artifact AND forward the FULL
// accumulated list via onProofsAttached (T1.4's "does the mission actually
// carry the artifact" seam — runtime.ts's runMission wires this callback
// straight into Mission.proofs via onUpdate; see managedAgent.ts's
// PlanAndActManagedOpts.onProofsAttached doc comment). ───────────────────

describe('planAndActManaged — attach_proof', () => {
  it('screenshot kind: builds the artifact and forwards it via onProofsAttached', async () => {
    const attachTurn = `THOUGHT: Capturing evidence of the working feature
ACTION: attach_proof
ARGS: {"kind": "screenshot", "path": "/tmp/wt/test/proof.png", "label": "Feature working"}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Task completed with proof"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? attachTurn : finalTurn);
    });

    const onProofsAttached = vi.fn();
    const opts = makeOpts({
      onProofsAttached,
      proofRequirements: [{ kind: 'screenshot' }],
    });
    await planAndActManaged(opts);

    expect(onProofsAttached).toHaveBeenCalledTimes(1);
    expect(onProofsAttached).toHaveBeenCalledWith([
      { kind: 'screenshot', path: '/tmp/wt/test/proof.png', label: 'Feature working' },
    ] satisfies ProofArtifact[]);

    // The dedicated audit event fires alongside the callback.
    const proofEvent = mockedEmitBuffered.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'mission.proof_attached',
    );
    expect(proofEvent).toBeDefined();
    expect((proofEvent![0] as { payload: unknown }).payload).toEqual({
      kind: 'screenshot',
      path: '/tmp/wt/test/proof.png',
      label: 'Feature working',
    });
  });

  it('accumulates multiple attach_proof calls: each onProofsAttached call carries the FULL list so far, immutably', async () => {
    const attachTurn1 = `THOUGHT: First piece of evidence
ACTION: attach_proof
ARGS: {"kind": "screenshot", "path": "/tmp/wt/test/before.png", "label": "Before"}`;

    const attachTurn2 = `THOUGHT: Second piece of evidence
ACTION: attach_proof
ARGS: {"kind": "behavior_diff", "before": "old behavior", "after": "new behavior"}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Task completed with two proofs"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return makeStream(attachTurn1);
      if (callCount === 2) return makeStream(attachTurn2);
      return makeStream(finalTurn);
    });

    const onProofsAttached = vi.fn();
    const opts = makeOpts({ onProofsAttached });
    await planAndActManaged(opts);

    expect(onProofsAttached).toHaveBeenCalledTimes(2);
    // First call: just the screenshot.
    expect(onProofsAttached.mock.calls[0][0]).toEqual([
      { kind: 'screenshot', path: '/tmp/wt/test/before.png', label: 'Before' },
    ]);
    // Second call: BOTH artifacts, and NOT the same array reference as the
    // first call (immutable append — see proofs.ts's addProof/module header).
    expect(onProofsAttached.mock.calls[1][0]).toEqual([
      { kind: 'screenshot', path: '/tmp/wt/test/before.png', label: 'Before' },
      { kind: 'behavior_diff', before: 'old behavior', after: 'new behavior' },
    ]);
    expect(onProofsAttached.mock.calls[0][0]).not.toBe(onProofsAttached.mock.calls[1][0]);
  });

  it('invalid/incomplete args: returns an ERROR observation and does not call onProofsAttached', async () => {
    const attachTurn = `THOUGHT: Attaching without the required fields
ACTION: attach_proof
ARGS: {"kind": "screenshot"}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Done anyway"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? attachTurn : finalTurn);
    });

    const onProofsAttached = vi.fn();
    const opts = makeOpts({ onProofsAttached });
    await planAndActManaged(opts);

    expect(onProofsAttached).not.toHaveBeenCalled();

    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg?.content).toContain('ERROR');
  });

  // Run-12/M14 regression: the agent's real ReAct turn for a `npm test` that
  // failed before producing a script to run at all ("Missing script: test")
  // — it knows the command and the raw output, but not a clean exit code.
  // Before the fix, omitting exitCode nulled the whole test_run artifact
  // (see proofs.ts's buildProofArtifact), so the ONLY proof that ever made
  // it into the mission was a later, unrelated command_output — tripping
  // "Preuves manquantes : test_run" despite this ACTION having genuinely run.
  it('run-12/M14 regression: a declared test_run for a failing npm test with no exitCode is stored as test_run, not dropped or downgraded', async () => {
    const attachTurn = `THOUGHT: The test script is missing, but this is still the test_run evidence for this contract
ACTION: attach_proof
ARGS: {"kind": "test_run", "command": "npm test", "content": "npm ERR! Missing script: \\"test\\"\\nnpm ERR! \\nnpm ERR! To see a list of scripts, run:\\nnpm ERR!   npm run"}`;

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Task completed; test script absent, reported honestly"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? attachTurn : finalTurn);
    });

    const onProofsAttached = vi.fn();
    const opts = makeOpts({
      onProofsAttached,
      proofRequirements: [{ kind: 'test_run' }],
    });
    await planAndActManaged(opts);

    expect(onProofsAttached).toHaveBeenCalledTimes(1);
    const attached = onProofsAttached.mock.calls[0][0] as ProofArtifact[];
    expect(attached).toHaveLength(1);
    expect(attached[0].kind).toBe('test_run');
    expect(attached[0]).toMatchObject({ kind: 'test_run', command: 'npm test' });
  });

  // V6 completion gate (this session's hardening): the missing half of the
  // run-12/M14 fix. buildProofArtifact no longer drops a genuinely-declared
  // test_run, but M14's REAL transcript shows the agent never even tried —
  // its one and only attach_proof call declared kind "command_output" for a
  // `type README.md` command, against a contract requiring test_run, then
  // went straight to FINAL. Nothing stopped it. checkApproveGate caught the
  // mismatch only at the human-approve step, too late to do anything but
  // force "Merger quand même". FINAL must now bounce back while a required
  // kind is still missing, giving the agent a real chance to attach it.
  it('FINAL is bounced back (not accepted) while a required proof kind is missing, then succeeds once the agent attaches it', async () => {
    const attachWrongKind = `THOUGHT: Let me just show the file content
ACTION: attach_proof
ARGS: {"kind": "command_output", "command": "type README.md", "content": "# alpha"}`;

    const finalAttempt1 = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Finished"}`;

    const attachCorrectKind = `THOUGHT: Right, the contract needs test_run specifically
ACTION: attach_proof
ARGS: {"kind": "test_run", "command": "npm test", "exitCode": 1, "content": "npm ERR! Missing script: \\"test\\""}`;

    const finalAttempt2 = `THOUGHT: Done for real
ACTION: FINAL
ARGS: {"summary": "Finished with the right proof"}`;

    const turns = [attachWrongKind, finalAttempt1, attachCorrectKind, finalAttempt2];
    let callCount = 0;
    mockedStream.mockImplementation(() => {
      const turn = turns[callCount] ?? finalAttempt2;
      callCount += 1;
      return makeStream(turn);
    });

    const onProofsAttached = vi.fn();
    const onAction = vi.fn();
    const opts = makeOpts({
      onProofsAttached,
      onAction,
      proofRequirements: [{ kind: 'test_run' }],
    });
    await planAndActManaged(opts);

    // Both attach_proof calls went through — command_output first, test_run second.
    expect(onProofsAttached).toHaveBeenCalledTimes(2);
    expect(onProofsAttached.mock.calls[1][0]).toEqual([
      expect.objectContaining({ kind: 'command_output' }),
      expect.objectContaining({ kind: 'test_run' }),
    ]);

    // The FIRST FINAL attempt must have been bounced back with a nudge
    // naming the still-missing kind, not silently accepted.
    const nudgeCall = onAction.mock.calls.find(
      (c) => typeof (c[0] as { text?: string }).text === 'string' && (c[0] as { text: string }).text.includes('Preuve manquante'),
    );
    expect(nudgeCall).toBeDefined();

    const bouncedMessages = mockedStream.mock.calls[2][0].messages as Array<{ role: string; content: string }>;
    const nudgeObservation = bouncedMessages.find(
      (m) => m.role === 'user' && m.content.startsWith('ERROR:') && m.content.includes('test_run'),
    );
    expect(nudgeObservation).toBeDefined();

    // The mission only completes on the SECOND FINAL, after test_run exists.
    const doneCall = onAction.mock.calls.find(
      (c) => typeof (c[0] as { text?: string }).text === 'string' && (c[0] as { text: string }).text.startsWith('Agent done:'),
    );
    expect(doneCall).toBeDefined();
    expect((doneCall![0] as { text: string }).text).toContain('Finished with the right proof');
  });

  it('FINAL is eventually let through after MAX_PROOF_NUDGES bounces even if the required proof is never attached (mission must still terminate)', async () => {
    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Finished without proof"}`;

    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const onProofsAttached = vi.fn();
    const onAction = vi.fn();
    const opts = makeOpts({
      onProofsAttached,
      onAction,
      proofRequirements: [{ kind: 'test_run' }],
    });
    await planAndActManaged(opts);

    // Never attached anything — the gate can never be satisfied.
    expect(onProofsAttached).not.toHaveBeenCalled();

    // Bounced exactly MAX_PROOF_NUDGES (2) times, then accepted on the 3rd FINAL —
    // the mission must still terminate rather than loop or burn all MAX_STEPS.
    const nudgeCalls = onAction.mock.calls.filter(
      (c) => typeof (c[0] as { text?: string }).text === 'string' && (c[0] as { text: string }).text.includes('Preuve manquante'),
    );
    expect(nudgeCalls).toHaveLength(2);

    const doneCall = onAction.mock.calls.find(
      (c) => typeof (c[0] as { text?: string }).text === 'string' && (c[0] as { text: string }).text.startsWith('Agent done:'),
    );
    expect(doneCall).toBeDefined();
    expect(mockedStream).toHaveBeenCalledTimes(3);
  });
});

// ── Mission-summary capture (FINAL handler): must never let a rejection —
// conflict or otherwise — escape as an unhandled promise rejection (run-7:
// an un-awaited platform.brain.capture() surfaced a same-day re-run's "Note
// already exists" as a raw [pageerror] instead of being handled here). ───

describe('planAndActManaged — mission summary capture defensive handling', () => {
  afterEach(() => {
    // Restore the default (all-resolving) platform mock so this override
    // never leaks into later tests in this file — see defaultPlatformMock's
    // doc comment above.
    mockedGetPlatform.mockImplementation(defaultPlatformMock);
  });

  it('a "Note already exists" conflict on the FINAL capture is swallowed as success — no warning, mission still completes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedGetPlatform.mockImplementation(() => ({
      brain: {
        ...defaultPlatformMock().brain,
        capture: vi.fn().mockRejectedValue(
          new Error(
            'lazybrain: Note already exists: notes/2026-07/mission-qa-append-readme-line-2026-07-10.html. Pass overwrite to replace.',
          ),
        ),
      },
    }));

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Task completed"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts();
    await expect(planAndActManaged(opts)).resolves.toBeUndefined();

    expect(opts.onProgress).toHaveBeenCalledWith(100);
    const warnedAboutCapture = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes('mission summary capture failed'),
    );
    expect(warnedAboutCapture).toBe(false);
    warnSpy.mockRestore();
  });

  it('a genuine (non-conflict) capture failure on FINAL is caught and logged, without failing the mission', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedGetPlatform.mockImplementation(() => ({
      brain: {
        ...defaultPlatformMock().brain,
        capture: vi.fn().mockRejectedValue(new Error('ECONNREFUSED: sidecar not running')),
      },
    }));

    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Task completed"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts();
    await expect(planAndActManaged(opts)).resolves.toBeUndefined();

    expect(opts.onProgress).toHaveBeenCalledWith(100);
    const warnedAboutCapture = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes('mission summary capture failed'),
    );
    expect(warnedAboutCapture).toBe(true);
    warnSpy.mockRestore();
  });
});

// ── Persona: agent identity reaching the system prompt ─────────────

describe('planAndActManaged — persona', () => {
  it('composes agentSystemPrompt + agentDisplayName into the system prompt sent to the model', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts({
      agentName: 'security-reviewer',
      agentDisplayName: 'Security Reviewer',
      agentSystemPrompt: 'You are a senior security engineer. Look for vulnerabilities.',
    });
    await planAndActManaged(opts);

    expect(mockedStream).toHaveBeenCalled();
    const firstCallSystem = mockedStream.mock.calls[0][0].system as string;
    expect(firstCallSystem).toContain('Security Reviewer');
    expect(firstCallSystem).toContain('You are a senior security engineer. Look for vulnerabilities.');
    // The mandatory ReAct protocol must still be present alongside the persona
    expect(firstCallSystem).toContain('ACTION:');
    expect(firstCallSystem).toContain('THOUGHT:');

    // listAgents() is skipped entirely when agentSystemPrompt is provided directly
    expect(mockedListAgents).not.toHaveBeenCalled();
  });

  it('falls back to the generic system prompt when no agentName/agentSystemPrompt is given', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts();
    await planAndActManaged(opts);

    const firstCallSystem = mockedStream.mock.calls[0][0].system as string;
    expect(firstCallSystem).toContain('autonomous coding agent');
    expect(firstCallSystem).not.toContain('You are "');
  });

  // Chantier-2 integration audit (2026-07-28): steeringPipeline.applyPromptCaching
  // (managedAgent.ts) used to route every step's system prompt through
  // withPromptCaching (lazyReasoningBlocks/promptCaching.ts), which appended a
  // literal "[CACHE_BREAKPOINT]" text marker on the (false) claim that
  // managedProvider.ts would parse it into a real cache_control block —
  // nothing ever did, so the marker was sent to the model as visible text on
  // every single step for zero caching benefit. withPromptCaching is now a
  // no-op (see its own header); this proves the fix end-to-end through the
  // real mission step loop, not just the isolated unit.
  it('never leaks the retired [CACHE_BREAKPOINT] prompt-cache marker into the system prompt actually sent to the model', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts({ model: 'anthropic/claude-sonnet-5' });
    await planAndActManaged(opts);

    expect(mockedStream).toHaveBeenCalled();
    const firstCallSystem = mockedStream.mock.calls[0][0].system as string;
    expect(firstCallSystem).not.toContain('[CACHE_BREAKPOINT]');
  });

  it('resolves the persona via agentName through listAgents() when agentSystemPrompt is not provided directly', async () => {
    mockedListAgents.mockResolvedValueOnce([
      {
        scope: 'project',
        agent: {
          id: 'agent-1',
          name: 'test-writer',
          displayName: 'Test Writer',
          description: 'Writes tests',
          color: 'green',
          tags: [],
          systemPrompt: 'You are a TDD expert. Write tests first.',
          modelTier: 'sonnet',
          triggers: { manual: true },
          scope: 'project',
          createdAt: new Date().toISOString(),
        },
      },
    ]);

    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts({ agentName: 'test-writer' });
    await planAndActManaged(opts);

    expect(mockedListAgents).toHaveBeenCalled();
    const firstCallSystem = mockedStream.mock.calls[0][0].system as string;
    expect(firstCallSystem).toContain('Test Writer');
    expect(firstCallSystem).toContain('You are a TDD expert. Write tests first.');
  });

  it('falls back to the generic prompt when agentName does not match any stored agent', async () => {
    mockedListAgents.mockResolvedValueOnce([]);
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts({ agentName: 'unknown-agent' });
    await planAndActManaged(opts);

    const firstCallSystem = mockedStream.mock.calls[0][0].system as string;
    expect(firstCallSystem).toContain('autonomous coding agent');
  });
});

// ── Tool policy: permissionMode / allowedTools / deniedTools ───────

describe('planAndActManaged — tool policy enforcement', () => {
  it('plan mode blocks write_file and feeds back a read-only ERROR observation', async () => {
    const writeTurn = `THOUGHT: Writing the output file
ACTION: write_file
ARGS: {"path": "result.ts", "content": "export const result = 42;"}`;
    const finalTurn = `THOUGHT: Acknowledged
ACTION: FINAL
ARGS: {"summary": "Blocked by plan mode"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? writeTurn : finalTurn);
    });

    const opts = makeOpts({ permissionMode: 'plan' });
    await planAndActManaged(opts);

    // write_file must never reach the Tauri bridge
    expect(mockedInvoke).not.toHaveBeenCalledWith('write_file', expect.anything());

    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg).toBeDefined();
    expect(observationMsg?.content).toContain('ERROR');
    expect(observationMsg?.content.toLowerCase()).toContain('plan mode');
  });

  it('plan mode still allows read_file', async () => {
    const readTurn = `THOUGHT: Reading
ACTION: read_file
ARGS: {"path": "src/main.ts"}`;
    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Read only"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? readTurn : finalTurn);
    });
    mockedInvoke.mockResolvedValue('// content');

    const opts = makeOpts({ permissionMode: 'plan' });
    await planAndActManaged(opts);

    expect(mockedInvoke).toHaveBeenCalledWith('read_file', expect.anything());
    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg?.content).not.toContain('ERROR: read-only');
  });

  it('deniedTools blocks the listed tool and feeds back an ERROR observation', async () => {
    const cmdTurn = `THOUGHT: Running a command
ACTION: run_command
ARGS: {"command": "rm -rf /", "timeout_ms": 5000}`;
    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Blocked"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? cmdTurn : finalTurn);
    });

    const opts = makeOpts({ deniedTools: ['run_command'] });
    await planAndActManaged(opts);

    expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());
    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg).toBeDefined();
    expect(observationMsg?.content).toContain('ERROR');
    expect(observationMsg?.content.toLowerCase()).toContain('denied');
  });

  it('allowedTools restricts execution to only the listed tools', async () => {
    const writeTurn = `THOUGHT: Writing
ACTION: write_file
ARGS: {"path": "x.ts", "content": "export {}"}`;
    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "Blocked"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? writeTurn : finalTurn);
    });

    const opts = makeOpts({ allowedTools: ['read_file', 'grep_file'] });
    await planAndActManaged(opts);

    expect(mockedInvoke).not.toHaveBeenCalledWith('write_file', expect.anything());
    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const observationMsg = secondCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('Observation:'),
    );
    expect(observationMsg?.content).toContain('ERROR');
    expect(observationMsg?.content.toLowerCase()).toContain('allowed');
  });

  it('system prompt advertises active restrictions upfront', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts({ permissionMode: 'plan', deniedTools: ['brain_record'] });
    await planAndActManaged(opts);

    const firstCallSystem = mockedStream.mock.calls[0][0].system as string;
    expect(firstCallSystem).toContain('ACTIVE RESTRICTIONS');
    expect(firstCallSystem).toContain('PLAN MODE');
    expect(firstCallSystem).toContain('brain_record');
  });
});

// ── onMetrics: Observability panel parity with the native loop ─────

describe('planAndActManaged — onMetrics', () => {
  it('invokes onMetrics once on FINAL with a sane AgentMetrics shape', async () => {
    const writeTurn = `THOUGHT: Writing
ACTION: write_file
ARGS: {"path": "result.ts", "content": "export const x = 1;"}`;
    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "done"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? writeTurn : finalTurn);
    });
    mockedInvoke.mockResolvedValue(undefined);

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    expect(onMetrics).toHaveBeenCalledTimes(1);
    const metrics = onMetrics.mock.calls[0][0];
    expect(metrics).toEqual({
      durationMs: expect.any(Number),
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      costUsd: expect.any(Number),
      toolCount: expect.any(Number),
      // The mock never calls onUsage, so every turn falls back to the
      // chars/4 estimate — see the "real usage" describe block below for
      // the 'real'/'mixed' cases.
      tokensSource: 'estimated',
    });
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.inputTokens).toBeGreaterThan(0);
    expect(metrics.outputTokens).toBeGreaterThan(0);
    expect(metrics.toolCount).toBe(1); // one write_file call before FINAL
    expect(metrics.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('invokes onMetrics on MAX_STEPS exhaustion too', async () => {
    const readTurn = `THOUGHT: Still reading
ACTION: read_file
ARGS: {"path": "file.ts"}`;
    mockedStream.mockImplementation(() => makeStream(readTurn));
    mockedInvoke.mockResolvedValue('file content');

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    expect(onMetrics).toHaveBeenCalledTimes(1);
    const metrics = onMetrics.mock.calls[0][0];
    // V5 dedup: every step emits the IDENTICAL read_file call, so only the
    // first one actually executes (toolCallCount) — later ones are deduped
    // into a nudge observation instead of re-running the tool. onMetrics is
    // still called exactly once regardless of WHICH termination path fires
    // next (2026-08-15: the identical repeated nudge itself now trips the
    // NEW stuck detector — repeated-action-observation — well before
    // MAX_STEPS, see the dedicated describe block below; onMetrics/
    // toolCount's accounting is unaffected by which of the two termination
    // reasons ends the loop, which is exactly what this test verifies).
    expect(metrics.toolCount).toBe(1);
  });

  it('does not invoke onMetrics when the agent is stopped mid-run', async () => {
    const readTurn = `THOUGHT: reading
ACTION: read_file
ARGS: {"path": "file.ts"}`;
    mockedStream.mockImplementation(() => makeStream(readTurn));
    mockedInvoke.mockResolvedValue('content');

    let calls = 0;
    const stopSignal = vi.fn(() => {
      calls += 1;
      return calls > 1;
    });

    const onMetrics = vi.fn();
    const opts = makeOpts({ stopSignal, onMetrics });
    await planAndActManaged(opts);

    expect(onMetrics).not.toHaveBeenCalled();
  });

  it('does not throw when onMetrics is not provided', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts();
    await expect(planAndActManaged(opts)).resolves.toBeUndefined();
  });
});

// ── onMetrics: real settled usage vs the chars/4 estimate ──────────
// See managedProvider.ts's streamManagedAgentTurn/onUsage and ai-proxy's
// settleAndRecord (\x1b[usage] marker). streamManagedAgentTurn itself is
// mocked at the module level (see the top of this file) — these tests
// exercise the mock's `onUsage` callback the same way the real
// implementation invokes it, to verify planAndActManaged's own
// preference/aggregation logic (addTurnTokens + emitMetrics's
// tokensSource), independent of the marker-parsing tests in
// managedProvider.test.ts.

describe('planAndActManaged — onMetrics real usage vs estimate', () => {
  it('reports tokensSource "real" and exact totals when every turn provides real usage via onUsage', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    const realUsage: RealUsage = { inputTokens: 500, outputTokens: 120, costUsd: 0.0456 };

    mockedStream.mockImplementation((callOpts: { onUsage?: (u: RealUsage) => void }) => {
      callOpts.onUsage?.(realUsage);
      return makeStream(finalTurn);
    });

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    expect(onMetrics).toHaveBeenCalledTimes(1);
    const metrics = onMetrics.mock.calls[0][0];
    expect(metrics.tokensSource).toBe('real');
    // Exact totals (not "greater than 0"): real usage is used as-is, not
    // blended with the chars/4 estimate.
    expect(metrics.inputTokens).toBe(realUsage.inputTokens);
    expect(metrics.outputTokens).toBe(realUsage.outputTokens);
    expect(metrics.costUsd).toBeCloseTo(realUsage.costUsd, 10);
  });

  it('reports tokensSource "estimated" (unchanged) when onUsage is never called — old ai-proxy compat', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    const metrics = onMetrics.mock.calls[0][0];
    expect(metrics.tokensSource).toBe('estimated');
    expect(metrics.inputTokens).toBeGreaterThan(0);
    expect(metrics.outputTokens).toBeGreaterThan(0);
  });

  it('reports tokensSource "mixed" when some turns have real usage and others fall back to the estimate', async () => {
    const writeTurn = `THOUGHT: Writing\nACTION: write_file\nARGS: {"path": "result.ts", "content": "export const x = 1;"}`;
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    const realUsage: RealUsage = { inputTokens: 80, outputTokens: 20, costUsd: 0.002 };

    let callCount = 0;
    mockedStream.mockImplementation((callOpts: { onUsage?: (u: RealUsage) => void }) => {
      callCount += 1;
      if (callCount === 1) {
        // First turn: no real usage reported (simulates an older ai-proxy,
        // or a settlement that failed and produced no marker) — falls back
        // to the chars/4 estimate.
        return makeStream(writeTurn);
      }
      // Second turn: real usage reported.
      callOpts.onUsage?.(realUsage);
      return makeStream(finalTurn);
    });
    mockedInvoke.mockResolvedValue(undefined);

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    expect(onMetrics).toHaveBeenCalledTimes(1);
    const metrics = onMetrics.mock.calls[0][0];
    expect(metrics.tokensSource).toBe('mixed');
  });

  it('the retry/Reflexion/PRM auxiliary turns also report real usage through onUsage (runTurn, not just the main loop)', async () => {
    // A tool ERROR triggers a Reflexion turn (CHEAP_MODEL) right after the
    // main turn — verifies runTurn (not just the main-loop call site) wires
    // onUsage into addTurnTokens too.
    const editTurn = `THOUGHT: editing\nACTION: edit_file\nARGS: {"path": "missing.ts", "old_string": "NOT_FOUND", "new_string": "x"}`;
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    const mainUsage: RealUsage = { inputTokens: 100, outputTokens: 30, costUsd: 0.01 };
    const reflectUsage: RealUsage = { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 };

    let callCount = 0;
    mockedStream.mockImplementation((callOpts: { model: string; onUsage?: (u: RealUsage) => void }) => {
      callCount += 1;
      if (callOpts.model === 'deepseek/deepseek-v4-flash') {
        // Reflexion turn — also reports real usage.
        callOpts.onUsage?.(reflectUsage);
        return makeStream('no reflection tag here');
      }
      callOpts.onUsage?.(mainUsage);
      return makeStream(callCount === 1 ? editTurn : finalTurn);
    });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('some content without the target');
      return Promise.resolve(undefined);
    });

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    expect(onMetrics).toHaveBeenCalledTimes(1);
    const metrics = onMetrics.mock.calls[0][0];
    // Every turn (main + Reflexion) reported real usage — no estimate mixed in.
    expect(metrics.tokensSource).toBe('real');
    expect(metrics.inputTokens).toBeGreaterThanOrEqual(mainUsage.inputTokens + reflectUsage.inputTokens);
  });
});

// ── toManagedOpenRouterModel: defensive tier -> OpenRouter mapping ─
// Backstops the upstream call-site fix: under managed mode, streamAgentTurn
// must never forward a bare tier/native id to the ai-proxy as-is (it would
// reject with "Modèle non supporté").

describe('toManagedOpenRouterModel', () => {
  it('maps bare tier "haiku"/"sonnet"/"opus" to the matching Anthropic OpenRouter id', () => {
    expect(toManagedOpenRouterModel('haiku')).toBe('anthropic/claude-haiku-4.5');
    expect(toManagedOpenRouterModel('sonnet')).toBe('anthropic/claude-sonnet-5');
    expect(toManagedOpenRouterModel('opus')).toBe('anthropic/claude-opus-5');
  });

  it('maps a display label to the matching OpenRouter id', () => {
    expect(toManagedOpenRouterModel('Claude Haiku 4.5')).toBe('anthropic/claude-haiku-4.5');
  });

  it('maps a native Claude CLI id to the matching OpenRouter id', () => {
    expect(toManagedOpenRouterModel('claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
  });

  it('passes an already-valid OpenRouter id through unchanged', () => {
    expect(toManagedOpenRouterModel('anthropic/claude-opus-5')).toBe('anthropic/claude-opus-5');
    expect(toManagedOpenRouterModel('deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash');
  });

  it('falls back to the catalog default for an unrecognized label/id', () => {
    expect(toManagedOpenRouterModel('some-unknown-model-xyz')).toBe('anthropic/claude-sonnet-5');
    expect(toManagedOpenRouterModel('')).toBe('anthropic/claude-sonnet-5');
  });
});

describe('planAndActManaged — defensive model normalization (managed mode)', () => {
  it('normalizes a bare tier Mission.model before it reaches the managed proxy', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts({ model: 'haiku' });
    await planAndActManaged(opts);

    expect(mockedStream).toHaveBeenCalled();
    const firstCallModel = mockedStream.mock.calls[0][0].model as string;
    expect(firstCallModel).toBe('anthropic/claude-haiku-4.5');
  });

  it('passes an already-valid OpenRouter Mission.model through unchanged', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts({ model: 'anthropic/claude-opus-5' });
    await planAndActManaged(opts);

    const firstCallModel = mockedStream.mock.calls[0][0].model as string;
    expect(firstCallModel).toBe('anthropic/claude-opus-5');
  });
});

// ── V4: consecutive-failure escalation ─────────────────────────────
// Tracks consecutive errored steps (tool ERROR / parse-retry / model error);
// after MAX_CONSECUTIVE_FAILURES (3) with no progress, the mission stops
// with an escalation observation instead of burning all MAX_STEPS (20) on
// the same failure. Reset on any successful step.

describe('planAndActManaged — V4 consecutive-failure escalation', () => {
  it('escalates and stops after 3 consecutive model/network errors instead of burning all MAX_STEPS', async () => {
    mockedStream.mockImplementation(() => {
      throw new Error('network blip');
    });

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    // One streamManagedAgentTurn call per failed step (no reflexion on a
    // model-error retry) — 3 consecutive failures reach the cap.
    expect(mockedStream).toHaveBeenCalledTimes(3);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(
      actions.some((t: string) => t.includes('Escalade: 3') && t.includes('intervention requise')),
    ).toBe(true);

    // Parity with the MAX_STEPS-exhausted branch: metrics still reported.
    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(opts.onProgress).toHaveBeenCalledWith(100);
  });

  it('escalates and stops after 3 consecutive tool ERROR observations, well before MAX_STEPS', async () => {
    const editTurn = `THOUGHT: retrying the same edit
ACTION: edit_file
ARGS: {"path": "missing.ts", "old_string": "NOT_FOUND", "new_string": "x"}`;

    // Reflexion turns route through CHEAP_MODEL — return harmless text so
    // parseReflectBlock finds no <reflect> tag and the loop just continues.
    mockedStream.mockImplementation((callOpts: { model: string }) => {
      if (callOpts.model === 'deepseek/deepseek-v4-flash') return makeStream('no reflection tag here');
      return makeStream(editTurn);
    });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('some content without the target');
      return Promise.resolve(undefined);
    });

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    // Nowhere near MAX_STEPS (20) — stops within a handful of turns.
    expect(mockedStream.mock.calls.length).toBeLessThan(10);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Escalade: 3'))).toBe(true);
    expect(actions.filter((t: string) => t.includes('Observation:')).length).toBe(3);
    expect(onMetrics).toHaveBeenCalledTimes(1);
  });

  it('escalates and stops after 3 consecutive unparseable responses (format retry fails too)', async () => {
    const unparseable = 'I am just thinking out loud with no structured format at all.';
    mockedStream.mockImplementation(() => makeStream(unparseable));

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    expect(mockedStream.mock.calls.length).toBeLessThan(10);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Escalade: 3'))).toBe(true);
    expect(onMetrics).toHaveBeenCalledTimes(1);
  });

  // M6 incident (2026-08-14) — a parse failure costs 2 model calls per
  // attempt (main turn + format retry), double every other failure mode.
  // These three tests are the regression coverage for the cost/UX fix:
  // fast-track escalation on an identical repeat, no fast-track when each
  // failure is genuinely different, and a clear user-facing reason.

  it('fast-tracks escalation when the SAME unparseable response repeats verbatim — 4 calls, not 6', async () => {
    const unparseable = 'I am just thinking out loud with no structured format at all.';
    mockedStream.mockImplementation(() => makeStream(unparseable));

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    // 2 failed steps × 2 calls each (main turn + format retry) = 4 — the
    // identical-repeat signature check reaches the cap one full step
    // earlier than 3 DIFFERENT failures would (see the contrasting test
    // below), because a second guaranteed-identical failure is decisive.
    expect(mockedStream).toHaveBeenCalledTimes(4);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Escalade: 3'))).toBe(true);
    expect(onMetrics).toHaveBeenCalledTimes(1);
  });

  it('does NOT fast-track when each unparseable response is different — still takes the full 3-step/6-call budget', async () => {
    let n = 0;
    mockedStream.mockImplementation(() => {
      n += 1;
      // A different sentence every call (main turn AND format retry) — the
      // signature never repeats, so the model might genuinely be finding
      // its way and deserves the full budget.
      return makeStream(`Unstructured thought number ${n}, still no ACTION/ARGS format here.`);
    });

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    expect(mockedStream).toHaveBeenCalledTimes(6);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Escalade: 3'))).toBe(true);
    expect(onMetrics).toHaveBeenCalledTimes(1);
  });

  it('surfaces a clear, attempt-numbered failure reason on every parse-failure step (never a bare unchanging line)', async () => {
    const unparseable = 'I am just thinking out loud with no structured format at all.';
    mockedStream.mockImplementation(() => makeStream(unparseable));

    const opts = makeOpts();
    await planAndActManaged(opts);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    // Step 1: attempt 1/3 — new signature, no fast-track yet.
    expect(actions.some((t: string) => t.includes('step 1') && t.includes('attempt 1/3'))).toBe(true);
    // Step 2: identical repeat fast-tracks straight to attempt 3/3 (the cap)
    // instead of quietly reporting "attempt 2/3" and burning a 3rd step.
    expect(actions.some((t: string) => t.includes('step 2') && t.includes('attempt 3/3'))).toBe(true);
  });

  it('a single transient parse failure recovers via the format retry — no failure counted, mission continues', async () => {
    const badTurn = 'I am just thinking out loud with no structured format at all.';
    const goodTurn = `THOUGHT: Recovered on the re-emit nudge\nACTION: FINAL\nARGS: {"summary": "done"}`;

    let mainCallCount = 0;
    mockedStream.mockImplementation((callOpts: { model: string }) => {
      if (callOpts.model === 'deepseek/deepseek-v4-flash') return makeStream('no reflection tag here');
      mainCallCount += 1;
      // 1st call = the original turn (unparseable); 2nd = the format retry
      // (recovers cleanly to a valid FINAL).
      return makeStream(mainCallCount === 1 ? badTurn : goodTurn);
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    // Exactly 2 calls: the original turn + the one format retry that
    // recovered it — no third step was ever needed.
    expect(mockedStream).toHaveBeenCalledTimes(2);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    // The retry recovering means parsed is truthy — the failure branch
    // (and its "Could not parse..." message) must never fire.
    expect(actions.some((t: string) => t.includes('Could not parse'))).toBe(false);
    expect(actions.some((t: string) => t.includes('Escalade'))).toBe(false);
    expect(actions.some((t: string) => t.includes('Agent done'))).toBe(true);
  });

  it('resets the consecutive-failure counter on a successful step, so intermittent errors never escalate', async () => {
    const failTurn = `THOUGHT: retry
ACTION: edit_file
ARGS: {"path": "missing.ts", "old_string": "NOT_FOUND", "new_string": "x"}`;
    const okTurn = `THOUGHT: read instead
ACTION: read_file
ARGS: {"path": "src/main.ts"}`;
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;

    // Two failures, then a success, then FINAL — never 3 CONSECUTIVE failures.
    const mainSequence = [failTurn, failTurn, okTurn, finalTurn];
    let mainCallIdx = 0;
    mockedStream.mockImplementation((callOpts: { model: string }) => {
      if (callOpts.model === 'deepseek/deepseek-v4-flash') return makeStream('no reflection tag here');
      const turn = mainSequence[Math.min(mainCallIdx, mainSequence.length - 1)];
      mainCallIdx += 1;
      return makeStream(turn);
    });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('some content without the target');
      return Promise.resolve(undefined);
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Escalade'))).toBe(false);
    expect(actions.some((t: string) => t.includes('Agent done'))).toBe(true);
  });
});

// ── Stuck detector (task #4, harness hardening 2026-08-15 — see
// scratch/_harness-research.md and stuckDetector.ts's header) ────────
// Closes the gap V4 above cannot: V4's consecutiveFailures counter resets
// to 0 on ANY successful step, so an agent alternating a failing edit_file
// with an unrelated successful read_file never escalates — this is exactly
// that shape, plus the "same call, same result, no progress" shape V5
// dedup only ever NUDGES (never aborts). Both abort the mission with a
// clear reason instead of grinding, per the task's explicit requirement.

describe('planAndActManaged — stuck detector (task #4)', () => {
  it('aborts on an interleaved failure pattern V4 misses (failing edit_file alternating with an unrelated successful read_file)', async () => {
    const failTurn = `THOUGHT: retry\nACTION: edit_file\nARGS: {"path": "missing.ts", "old_string": "NOT_FOUND", "new_string": "x"}`;
    const okTurn = `THOUGHT: read instead\nACTION: read_file\nARGS: {"path": "src/main.ts"}`;

    // fail, ok, fail, ok, fail — 3 edit_file failures, but never 3
    // CONSECUTIVE (V4 would never fire here; each ok step resets it to 0).
    const sequence = [failTurn, okTurn, failTurn, okTurn, failTurn, okTurn, failTurn];
    let idx = 0;
    mockedStream.mockImplementation((callOpts: { model: string }) => {
      if (callOpts.model === 'deepseek/deepseek-v4-flash') return makeStream('no reflection tag here');
      const turn = sequence[Math.min(idx, sequence.length - 1)];
      idx += 1;
      return makeStream(turn);
    });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('some content without the target');
      return Promise.resolve(undefined);
    });

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    // Aborted well before the 7-turn sequence (and nowhere near MAX_STEPS)
    // — the 3rd edit_file failure trips it even with successes in between.
    const mainCalls = mockedStream.mock.calls.filter(
      (c) => (c[0] as { model: string }).model !== 'deepseek/deepseek-v4-flash',
    );
    expect(mainCalls.length).toBeLessThan(7);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    // Never mistaken for V4's own escalation path (never reached 3 CONSECUTIVE).
    expect(actions.some((t: string) => t.includes('Escalade'))).toBe(false);
    expect(actions.some((t: string) => t.includes('Boucle bloquée détectée') && t.includes('edit_file'))).toBe(
      true,
    );
    expect(onMetrics).toHaveBeenCalledTimes(1);

    const failedEvent = mockedEmitBuffered.mock.calls
      .map((c: unknown[]) => c[0] as JournalEventInput)
      .find((e) => e.type === 'mission.failed');
    expect((failedEvent?.payload as { reason?: string } | undefined)?.reason).toBe(
      'stuck_repeated_identical_failure',
    );
  });

  it('aborts a repeated identical call+result cycle that V5 dedup only ever nudges (never aborted before this fix)', async () => {
    // The exact QA-documented incident managedAgentDedup.ts's own header
    // describes: the model keeps re-emitting the SAME read_file call. V5
    // already stops re-executing it after the 2nd time (nudge instead of a
    // real call) but, before this fix, nothing ever stopped the model from
    // just repeating the call — and the nudge — indefinitely, burning the
    // full MAX_STEPS on zero progress.
    const readTurn = `THOUGHT: reading\nACTION: read_file\nARGS: {"path": "src/components/sections/FAQSection.tsx"}`;
    mockedStream.mockImplementation(() => makeStream(readTurn));
    mockedInvoke.mockResolvedValue('file content');

    const opts = makeOpts();
    await planAndActManaged(opts);

    // Real execution happens once (step 1); the dedup nudge repeats
    // identically from step 2 on — 4 identical nudge cycles (steps 2-5)
    // trips the repeated-action-observation pattern at step 5, nowhere
    // near MAX_STEPS (100).
    expect(mockedStream.mock.calls.length).toBeLessThan(10);

    const readFileCalls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'read_file');
    expect(readFileCalls).toHaveLength(1); // V5 dedup still only executed it once

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Boucle bloquée détectée') && t.includes('read_file'))).toBe(
      true,
    );

    const failedEvent = mockedEmitBuffered.mock.calls
      .map((c: unknown[]) => c[0] as JournalEventInput)
      .find((e) => e.type === 'mission.failed');
    expect((failedEvent?.payload as { reason?: string } | undefined)?.reason).toBe(
      'stuck_repeated_action_observation',
    );
  });

  it('does NOT abort a genuinely varied, non-repeating sequence — never a false positive on real progress', async () => {
    const turns = [
      `THOUGHT: read a\nACTION: read_file\nARGS: {"path": "a.ts"}`,
      `THOUGHT: read b\nACTION: read_file\nARGS: {"path": "b.ts"}`,
      `THOUGHT: write\nACTION: write_file\nARGS: {"path": "c.ts", "content": "export const c = 1;"}`,
      `THOUGHT: done\nACTION: FINAL\nARGS: {"summary": "done"}`,
    ];
    let idx = 0;
    mockedStream.mockImplementation(() => {
      const turn = turns[Math.min(idx, turns.length - 1)];
      idx += 1;
      return makeStream(turn);
    });
    mockedInvoke.mockResolvedValue('content');

    const opts = makeOpts();
    await planAndActManaged(opts);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Boucle bloquée détectée'))).toBe(false);
    expect(actions.some((t: string) => t.includes('Agent done'))).toBe(true);
  });
});

// ── BUG-1: no_credits is terminal, never retried ───────────────────
// A `ManagedUnavailableError` with code 'no_credits' means the wallet is
// empty — retrying (like a transient network/model error) just hammers the
// same wall. This must stop after exactly one attempt with a clear French
// action message, distinct from the V4 3-strikes escalation above.

describe('planAndActManaged — BUG-1 no_credits is terminal', () => {
  it('stops after a single attempt on ManagedUnavailableError(no_credits) — no retry, no escalation', async () => {
    const { ManagedUnavailableError } = await import('../lib/models/managedProvider');
    mockedStream.mockImplementation(() => {
      throw new ManagedUnavailableError('Crédits insuffisants', 'no_credits');
    });

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    // A single attempt — never retried like a transient error.
    expect(mockedStream).toHaveBeenCalledTimes(1);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    // "Erreur agent:" prefix is intentional (runtime.ts/recovery.ts signal) —
    // see managedAgent.ts's stopForNoCredits doc comment.
    expect(actions.some((t: string) => t.startsWith('Erreur agent:') && t.includes('Crédits Pro épuisés'))).toBe(
      true,
    );
    expect(actions.some((t: string) => t.includes('Escalade'))).toBe(false);

    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(opts.onProgress).toHaveBeenCalledWith(100);

    const failedEvent = mockedEmitBuffered.mock.calls
      .map((c: unknown[]) => c[0] as JournalEventInput)
      .find((e) => e.type === 'mission.failed');
    expect(failedEvent).toBeDefined();
    expect((failedEvent?.payload as { reason?: string } | undefined)?.reason).toBe('no_credits');
  });

  it('a transient ManagedUnavailableError (not no_credits) is still retried like before', async () => {
    const { ManagedUnavailableError } = await import('../lib/models/managedProvider');
    mockedStream.mockImplementation(() => {
      throw new ManagedUnavailableError('Réponse vide du proxy géré (agent)', 'empty_response');
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    // Unchanged V4 behavior: 3 consecutive failures before escalating.
    expect(mockedStream).toHaveBeenCalledTimes(3);
    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Escalade: 3'))).toBe(true);
  });
});

// ── 2026-08-05 DeepSeek 402 incident: BYOK provider definitive error is
// terminal ───────────────────────────────────────────────────────────
// Real incident: a mission agent (M49) froze at 16% for 10+ minutes on a
// BYOK DeepSeek key that had run out of balance — every HTTP call came back
// 402, silently retried, RAM climbing, no failure status ever set. Mirrors
// the BUG-1 no_credits block above exactly, but exercises the BYOK rail
// (opts.streamTurn override — see streamAgentTurn in managedAgent.ts) instead
// of the managed/Pro streamManagedAgentTurn rail.

describe('planAndActManaged — BYOK provider definitive error is terminal (2026-08-05 DeepSeek 402 incident)', () => {
  it('stops after a single attempt on ProviderDefinitiveError(402) — no retry, honest French statusReason + raw short reason in the timeline', async () => {
    const { ProviderDefinitiveError } = await import('../lib/models/byokProviders');
    const streamTurn = vi.fn(() => {
      throw new ProviderDefinitiveError(402, 'deepseek', 'Insufficient Balance');
    });

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics, streamTurn });
    await planAndActManaged(opts);

    // Exactly ONE HTTP-equivalent attempt — never retried, since retrying
    // the identical call against an empty wallet can never succeed.
    expect(streamTurn).toHaveBeenCalledTimes(1);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    // "Erreur agent:" prefix is intentional (runtime.ts signal, same
    // convention as stopForNoCredits) — the honest French message plus the
    // raw short reason from the provider both land in the same timeline entry.
    expect(
      actions.some(
        (t: string) =>
          t.startsWith('Erreur agent:') &&
          t.includes('Clé du fournisseur inutilisable') &&
          t.includes('mission arrêtée') &&
          t.includes('Insufficient Balance'),
      ),
    ).toBe(true);
    // Never mistaken for the V4 3-strikes escalation path.
    expect(actions.some((t: string) => t.includes('Escalade'))).toBe(false);

    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(opts.onProgress).toHaveBeenCalledWith(100);

    const failedEvent = mockedEmitBuffered.mock.calls
      .map((c: unknown[]) => c[0] as JournalEventInput)
      .find((e) => e.type === 'mission.failed');
    expect(failedEvent).toBeDefined();
    expect((failedEvent?.payload as { reason?: string } | undefined)?.reason).toBe('provider_definitive_error');
  });

  it('also fails fast on an UNWRAPPED error whose message matches the definitive-error fallback pattern (401/402/403 or Insufficient Balance/invalid api key)', async () => {
    // Simulates a layer between byokProviders.ts and this loop re-throwing a
    // generic Error and losing the original ProviderDefinitiveError instance
    // — classifyDefinitiveProviderError's regex fallback must still catch it.
    const streamTurn = vi.fn(() => {
      throw new Error('DeepSeek API error 402: {"error":{"message":"Insufficient Balance"}}');
    });
    const opts = makeOpts({ streamTurn });
    await planAndActManaged(opts);

    expect(streamTurn).toHaveBeenCalledTimes(1);
    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(
      actions.some((t: string) => t.startsWith('Erreur agent:') && t.includes('Clé du fournisseur inutilisable')),
    ).toBe(true);
  });

  it('a transient BYOK error (e.g. network/5xx-shaped) is still retried like before — V4: 3 attempts then escalate', async () => {
    const streamTurn = vi.fn(() => {
      throw new Error('network timeout contacting provider');
    });
    const opts = makeOpts({ streamTurn });
    await planAndActManaged(opts);

    // Unchanged V4 behavior: not classified as definitive, so it retries.
    expect(streamTurn).toHaveBeenCalledTimes(3);
    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Escalade: 3'))).toBe(true);
  });
});

// ── V5: identical-call dedup ────────────────────────────────────────
// Real-app QA: a managed agent read the same file 4 times in a row with
// identical args (same path, no start_line/end_line change), burning 4 of
// MAX_STEPS=20 with zero progress. Mirrors assistantToolLoop.ts's
// searchedQueries dedup — see DEDUPE_ELIGIBLE_TOOLS in managedAgent.ts.

describe('planAndActManaged — V5 identical-call dedup', () => {
  it('model emits the same read_file call twice: executor invoked once, second call gets the nudge observation instead', async () => {
    const readTurn = `THOUGHT: reading the file
ACTION: read_file
ARGS: {"path": "src/components/sections/FAQSection.tsx"}`;
    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "done"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      // Same read_file call twice in a row, then FINAL.
      if (callCount <= 2) return makeStream(readTurn);
      return makeStream(finalTurn);
    });
    mockedInvoke.mockResolvedValue('file content');

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    // The Tauri bridge (and thus the shared tool executor) is only ever
    // invoked ONCE for read_file — the second identical call is deduped.
    const readFileCalls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'read_file');
    expect(readFileCalls).toHaveLength(1);

    // The second turn's observation is the nudge, not a fresh file read —
    // and it references step 1, where the call first actually ran.
    const thirdCallMessages = mockedStream.mock.calls[2][0].messages as Array<{ role: string; content: string }>;
    const observations = thirdCallMessages.filter((m) => m.role === 'user' && m.content.includes('Observation:'));
    expect(observations).toHaveLength(2);
    expect(observations[0].content).toContain('file content');
    expect(observations[1].content).toContain('You already ran this exact call at step 1');
    expect(observations[1].content).not.toContain('file content');

    // Only the one real execution counts toward billing/observability.
    expect(onMetrics).toHaveBeenCalledTimes(1);
    expect(onMetrics.mock.calls[0][0].toolCount).toBe(1);
  });

  it('does not dedup run_command even with identical args — state may have changed between calls', async () => {
    const cmdTurn = `THOUGHT: checking status
ACTION: run_command
ARGS: {"command": "git status"}`;
    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "done"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      if (callCount <= 2) return makeStream(cmdTurn);
      return makeStream(finalTurn);
    });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: 'clean', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    // Exempt tool (side-effectful/state-reading) — both identical calls
    // actually execute, unlike the read_file case above.
    const shellCalls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'run_shell');
    expect(shellCalls).toHaveLength(2);
  });

  it('a DIFFERENT read_file path is not deduped against a prior different-args call', async () => {
    const readA = `THOUGHT: reading a
ACTION: read_file
ARGS: {"path": "a.ts"}`;
    const readB = `THOUGHT: reading b
ACTION: read_file
ARGS: {"path": "b.ts"}`;
    const finalTurn = `THOUGHT: Done
ACTION: FINAL
ARGS: {"summary": "done"}`;

    const sequence = [readA, readB, finalTurn];
    let callCount = 0;
    mockedStream.mockImplementation(() => {
      const turn = sequence[Math.min(callCount, sequence.length - 1)];
      callCount += 1;
      return makeStream(turn);
    });
    mockedInvoke.mockResolvedValue('content');

    const opts = makeOpts();
    await planAndActManaged(opts);

    const readFileCalls = mockedInvoke.mock.calls.filter((c: unknown[]) => c[0] === 'read_file');
    expect(readFileCalls).toHaveLength(2);
  });
});

// ── Pause / Intervene: real mid-loop steering (agentsStore.pauseMission/
// resumeMission/interveneMission wire pauseSignal/drainIntervenes through
// runtime.ts into this loop) ────────────────────────────────────────

describe('planAndActManaged — pause/intervene', () => {
  it('honors the pause signal between steps: no model call while paused, resumes once cleared', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    // Call 1: the `if (pauseSignal())` check — true, enters the wait block.
    // Call 2: first `while (pauseSignal())` check — still true, one poll tick.
    // Call 3: second `while` check — false, exits and resumes.
    let pauseChecks = 0;
    const pauseSignal = vi.fn(() => {
      pauseChecks += 1;
      return pauseChecks <= 2;
    });

    const opts = makeOpts({ pauseSignal });
    await planAndActManaged(opts);

    // No model turn happens until the pause clears — only the post-resume
    // FINAL turn is ever streamed.
    expect(mockedStream).toHaveBeenCalledTimes(1);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions).toContain('Mission en pause');
    expect(actions).toContain('Reprise de la mission');
  });

  it('still honors stopSignal while paused, stopping instead of waiting forever', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const pauseSignal = vi.fn(() => true); // never resumes on its own

    // First stopSignal check (top of the for-loop) lets pause kick in; the
    // next check — inside the pause-wait while loop — requests a stop.
    let stopChecks = 0;
    const stopSignal = vi.fn(() => {
      stopChecks += 1;
      return stopChecks > 1;
    });

    const opts = makeOpts({ pauseSignal, stopSignal });
    await planAndActManaged(opts);

    expect(mockedStream).not.toHaveBeenCalled();
    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Agent stopped by user'))).toBe(true);
  });

  it('drains queued intervene text and injects it as a user message before the next model turn', async () => {
    const readTurn = `THOUGHT: reading\nACTION: read_file\nARGS: {"path": "file.ts"}`;
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? readTurn : finalTurn);
    });
    mockedInvoke.mockResolvedValue('file content');

    // Atomically-popped queue, same contract as agentsStore's real cell:
    // returns the instruction once, then empty on every later step.
    let drained = false;
    const drainIntervenes = vi.fn(() => {
      if (drained) return [];
      drained = true;
      return ['focus on the auth module'];
    });

    const opts = makeOpts({ drainIntervenes });
    await planAndActManaged(opts);

    const firstCallMessages = mockedStream.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    const interventionMsg = firstCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('[User intervention]'),
    );
    expect(interventionMsg).toBeDefined();
    expect(interventionMsg?.content).toContain('focus on the auth module');

    // Announced honestly on the timeline too, not just silently folded in.
    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(
      actions.some(
        (t: string) => t.includes('Intervention utilisateur') && t.includes('focus on the auth module'),
      ),
    ).toBe(true);

    // Drained exactly once — the second step must not re-inject it.
    const secondCallMessages = mockedStream.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const secondIntervention = secondCallMessages.filter(
      (m) => m.role === 'user' && m.content.includes('[User intervention]'),
    );
    expect(secondIntervention).toHaveLength(1); // carried over in history, not duplicated
  });
});

// ── toolPermissions integration: the previously-dormant allow/ask/exclude
// engine (toolPermissions.ts), wired into executeTool's gate via
// managedToolPermissions.checkToolExecution. See managedToolPermissions.
// test.ts for isolated unit coverage of the resolution/message logic
// itself; these are full-loop tests exercising real localStorage-backed
// rules (saveProjectPermissions) through the actual planAndActManaged loop.

describe('planAndActManaged — toolPermissions integration', () => {
  function rule(pattern: string, level: 'allow' | 'ask' | 'exclude') {
    return { pattern, level, source: 'project' as const, createdAt: '' };
  }

  /** Cheap-model (Reflexion) turns interleave with main-loop turns whenever
   *  a step produces an ERROR observation (see the V4 escalation suite
   *  above) — route them to a harmless response so assertions don't have
   *  to account for how many reflection turns fired in between. */
  function mockMainSequence(turns: string[]): void {
    let mainCallIdx = 0;
    mockedStream.mockImplementation((callOpts: { model: string }) => {
      if (callOpts.model === 'deepseek/deepseek-v4-flash') return makeStream('no reflection tag here');
      const turn = turns[Math.min(mainCallIdx, turns.length - 1)];
      mainCallIdx += 1;
      return makeStream(turn);
    });
  }

  /** All "Observation: …" user messages ever added, read off the LAST
   *  streamed call's full accumulated history — robust to however many
   *  cheap-model reflection turns were interleaved in between. */
  function allObservations(): string[] {
    const lastCall = mockedStream.mock.calls[mockedStream.mock.calls.length - 1];
    const messages = lastCall[0].messages as Array<{ role: string; content: string }>;
    return messages
      .filter((m) => m.role === 'user' && m.content.includes('Observation:'))
      .map((m) => m.content);
  }

  it('excluded tool is denied even in auto mode (permissionMode "full" derives it) — the old bypass is gone', async () => {
    saveProjectPermissions({ rules: [rule('Bash(rm -rf**)', 'exclude')] });

    mockMainSequence([
      'THOUGHT: cleaning up\nACTION: run_command\nARGS: {"command": "rm -rf /tmp/build"}',
      'THOUGHT: acknowledged\nACTION: FINAL\nARGS: {"summary": "blocked"}',
    ]);

    const opts = makeOpts({ permissionMode: 'full' });
    await planAndActManaged(opts);

    expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());
    const [observation] = allObservations();
    expect(observation).toContain('ERROR');
    expect(observation.toLowerCase()).toContain('excluded');
  });

  it('ask-tier rule denies in auto mode with an unattended-specific reason', async () => {
    saveProjectPermissions({ rules: [rule('Bash', 'ask')] });

    mockMainSequence([
      'THOUGHT: running tests\nACTION: run_command\nARGS: {"command": "npm test"}',
      'THOUGHT: acknowledged\nACTION: FINAL\nARGS: {"summary": "blocked"}',
    ]);

    const opts = makeOpts({ permissionAgentMode: 'auto' });
    await planAndActManaged(opts);

    expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());
    const [observation] = allObservations();
    expect(observation).toContain('ERROR');
    expect(observation.toLowerCase()).toContain('unattended');
  });

  it('ask-tier rule also denies in default (non-auto) mode — no fake approval flow', async () => {
    saveProjectPermissions({ rules: [rule('Bash', 'ask')] });

    mockMainSequence([
      'THOUGHT: running tests\nACTION: run_command\nARGS: {"command": "npm test"}',
      'THOUGHT: acknowledged\nACTION: FINAL\nARGS: {"summary": "blocked"}',
    ]);

    const opts = makeOpts(); // no permissionMode/permissionAgentMode set -> 'default'
    await planAndActManaged(opts);

    expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());
    const [observation] = allObservations();
    expect(observation).toContain('ERROR');
    expect(observation.toLowerCase()).toContain('approval');

    // A visible failed step the model can adapt to, not a crash — the
    // mission still reaches FINAL right after.
    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Agent done'))).toBe(true);
  });

  it('an explicit allow rule for one pattern does not affect other tool calls', async () => {
    saveProjectPermissions({
      rules: [rule('Bash(npm test*)', 'allow'), rule('Bash(rm -rf**)', 'exclude')],
    });

    mockMainSequence([
      'THOUGHT: run tests\nACTION: run_command\nARGS: {"command": "npm test"}',
      'THOUGHT: done\nACTION: FINAL\nARGS: {"summary": "tests ran"}',
    ]);
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: 'all green', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    expect(mockedInvoke).toHaveBeenCalledWith('run_shell', expect.objectContaining({ command: 'npm test' }));
  });

  it('run_command matches the actual command string: a scoped exclude blocks only matching commands, in the same mission', async () => {
    saveProjectPermissions({ rules: [rule('Bash(rm -rf**)', 'exclude')] });

    mockMainSequence([
      'THOUGHT: run tests first\nACTION: run_command\nARGS: {"command": "npm test"}',
      'THOUGHT: now cleanup\nACTION: run_command\nARGS: {"command": "rm -rf /tmp/build"}',
      'THOUGHT: done\nACTION: FINAL\nARGS: {"summary": "done"}',
    ]);
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    // "npm test" is unaffected by the rm -rf** rule — it actually ran.
    expect(mockedInvoke).toHaveBeenCalledWith('run_shell', expect.objectContaining({ command: 'npm test' }));
    // "rm -rf /tmp/build" matches the excluded pattern — never reached run_shell.
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      'run_shell',
      expect.objectContaining({ command: 'rm -rf /tmp/build' }),
    );

    const observations = allObservations();
    expect(observations[0]).not.toContain('ERROR'); // npm test succeeded
    expect(observations[1]).toContain('ERROR'); // rm -rf was denied
  });

  it('3 consecutive permission denials (excluded tool) escalate and stop, same as any other failed step', async () => {
    saveProjectPermissions({ rules: [rule('Bash(rm -rf**)', 'exclude')] });

    mockMainSequence(['THOUGHT: retrying the forbidden command\nACTION: run_command\nARGS: {"command": "rm -rf /"}']);

    const onMetrics = vi.fn();
    const opts = makeOpts({ onMetrics });
    await planAndActManaged(opts);

    // Never actually executed the dangerous command.
    expect(mockedInvoke).not.toHaveBeenCalledWith('run_shell', expect.anything());

    // Escalates well before MAX_STEPS (20) — parity with the existing
    // tool-ERROR / unparseable-response escalation tests above.
    const mainCalls = mockedStream.mock.calls.filter(
      (c) => (c[0] as { model: string }).model !== 'deepseek/deepseek-v4-flash',
    );
    expect(mainCalls.length).toBeLessThan(10);

    const actions = (opts.onAction as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as ActionEvent).text,
    );
    expect(actions.some((t: string) => t.includes('Escalade: 3'))).toBe(true);
    expect(actions.filter((t: string) => t.includes('Observation:')).length).toBe(3);
    expect(onMetrics).toHaveBeenCalledTimes(1);
  });
});

// ── Journal instrumentation (T0.4) ──────────────────────────────────
// mission.step / tool.called / spend.tokens / agent.handoff /
// mission.completed|failed — all emitted via emitBuffered (journal.ts),
// mocked at the top of this file (see the "Mock the journal client" block
// near the other module mocks). journal.test.ts covers the client itself
// (serialization, buffering, terminal-flush); these tests cover WHAT this
// loop emits and WHEN, driven through the same mocked-stream harness as
// the rest of this file.

describe('planAndActManaged — journal instrumentation', () => {
  function eventsOfType(type: string): JournalEventInput[] {
    return mockedEmitBuffered.mock.calls
      .map((c: unknown[]) => c[0] as JournalEventInput)
      .filter((e) => e.type === type);
  }

  it('emits mission.step (bounded to 500 chars) and spend.tokens with source "estimated" for a scripted write_file + FINAL run', async () => {
    const writeTurn = `THOUGHT: Writing\nACTION: write_file\nARGS: {"path": "result.ts", "content": "export const x = 1;"}`;
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? writeTurn : finalTurn);
    });
    mockedInvoke.mockResolvedValue(undefined);

    const opts = makeOpts({ missionId: 'mission-42' });
    await planAndActManaged(opts);

    const steps = eventsOfType('mission.step');
    expect(steps.length).toBeGreaterThanOrEqual(2); // one per iteration (write_file, FINAL)
    for (const evt of steps) {
      expect(evt.missionId).toBe('mission-42');
      expect(evt.actor).toBe('agent');
      expect(typeof evt.projectId).toBe('string');
      expect((evt.projectId as string).length).toBeGreaterThan(0);
      expect((evt.payload as { text: string }).text.length).toBeLessThanOrEqual(500);
    }
    expect(steps.some((e) => (e.payload as { text: string }).text.includes('write_file'))).toBe(true);

    const spends = eventsOfType('spend.tokens');
    expect(spends.length).toBeGreaterThan(0);
    expect(spends.every((e) => (e.payload as { source: string }).source === 'estimated')).toBe(true);
  });

  it('emits tool.called with name/durationMs/files for a real (non-deduped) tool execution', async () => {
    const writeTurn = `THOUGHT: Writing\nACTION: write_file\nARGS: {"path": "result.ts", "content": "export const x = 1;"}`;
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      return makeStream(callCount === 1 ? writeTurn : finalTurn);
    });
    mockedInvoke.mockResolvedValue(undefined);

    const opts = makeOpts();
    await planAndActManaged(opts);

    const toolCalls = eventsOfType('tool.called');
    expect(toolCalls).toHaveLength(1);
    const payload = toolCalls[0].payload as { name: string; files?: string[]; durationMs?: number };
    expect(payload.name).toBe('write_file');
    expect(payload.files).toEqual(['result.ts']);
    expect(typeof payload.durationMs).toBe('number');
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not emit tool.called for a V5-deduped repeated call, only for the real execution', async () => {
    const readTurn = `THOUGHT: reading\nACTION: read_file\nARGS: {"path": "src/main.ts"}`;
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;

    let callCount = 0;
    mockedStream.mockImplementation(() => {
      callCount += 1;
      if (callCount <= 2) return makeStream(readTurn);
      return makeStream(finalTurn);
    });
    mockedInvoke.mockResolvedValue('file content');

    const opts = makeOpts();
    await planAndActManaged(opts);

    expect(eventsOfType('tool.called')).toHaveLength(1);
  });

  it('emits mission.completed with durationMs/costUsd on FINAL, and no mission.failed', async () => {
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;
    mockedStream.mockImplementation(() => makeStream(finalTurn));

    const opts = makeOpts({ missionId: 'mission-done' });
    await planAndActManaged(opts);

    const completed = eventsOfType('mission.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].missionId).toBe('mission-done');
    const payload = completed[0].payload as { durationMs?: number; costUsd?: number };
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(payload.costUsd).toBeGreaterThanOrEqual(0);
    expect(eventsOfType('mission.failed')).toHaveLength(0);
  });

  it('emits mission.failed with reason "max_steps_exhausted" when MAX_STEPS is reached', async () => {
    // Path varies per call (2026-08-15, stuck-detector task) — a static
    // path would legitimately trip the new stuck detector first (see the
    // dedicated describe block below), which is correct product behavior
    // but not what THIS test is verifying (the MAX_STEPS ceiling itself).
    let n = 0;
    mockedStream.mockImplementation(() => {
      n += 1;
      return makeStream(`THOUGHT: Still reading\nACTION: read_file\nARGS: {"path": "file-${n}.ts"}`);
    });
    mockedInvoke.mockResolvedValue('file content');

    const opts = makeOpts();
    await planAndActManaged(opts);

    const failed = eventsOfType('mission.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as { reason: string }).reason).toBe('max_steps_exhausted');
    expect(eventsOfType('mission.completed')).toHaveLength(0);
  });

  it('emits mission.failed with reason "consecutive_failures" on V4 escalation', async () => {
    mockedStream.mockImplementation(() => {
      throw new Error('network blip');
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    const failed = eventsOfType('mission.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as { reason: string }).reason).toBe('consecutive_failures');
  });

  it('emits a mission.step with marker "reflexion" when a reflection is recorded', async () => {
    const editTurn = `THOUGHT: editing\nACTION: edit_file\nARGS: {"path": "missing.ts", "old_string": "NOT_FOUND", "new_string": "x"}`;
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;

    let callCount = 0;
    mockedStream.mockImplementation((callOpts: { model: string }) => {
      if (callOpts.model === 'deepseek/deepseek-v4-flash') {
        return makeStream('<reflect>the old_string was wrong</reflect>');
      }
      callCount += 1;
      return makeStream(callCount === 1 ? editTurn : finalTurn);
    });
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('some content without the target');
      return Promise.resolve(undefined);
    });

    const opts = makeOpts();
    await planAndActManaged(opts);

    const reflexionSteps = eventsOfType('mission.step').filter(
      (e) => (e.payload as { marker?: string }).marker === 'reflexion',
    );
    expect(reflexionSteps).toHaveLength(1);
    expect((reflexionSteps[0].payload as { text: string }).text).toContain('old_string was wrong');
  });

  it('emits a mission.step with marker "prm" when the PRM verifier runs, capped at PRM_MAX (2)', async () => {
    // Path varies per call (2026-08-15, stuck-detector task) so the mission
    // survives long enough for the PRM verifier to fire at all — a static
    // path would trip the new stuck detector (repeated-action-observation)
    // well before step 5, which is correct product behavior but would
    // starve this test of the PRM steps it's actually verifying.
    let n = 0;
    mockedStream.mockImplementation((callOpts: { model: string }) => {
      if (callOpts.model === 'deepseek/deepseek-v4-flash') return makeStream('no reflection tag here');
      n += 1;
      return makeStream(`THOUGHT: Still reading\nACTION: read_file\nARGS: {"path": "file-${n}.ts"}`);
    });
    mockedInvoke.mockResolvedValue('content');

    const opts = makeOpts();
    await planAndActManaged(opts); // runs to MAX_STEPS (100); PRM fires at step 5 and step 10

    const prmSteps = eventsOfType('mission.step').filter(
      (e) => (e.payload as { marker?: string }).marker === 'prm',
    );
    expect(prmSteps).toHaveLength(2);
  });

  it('the PRM verifier prompt lists attach_proof so it is never flagged as a non-existent tool (run-7 false positive)', async () => {
    // Run-7: "[PRM] (R) Reasoning error: The agent attempted to use a
    // non-existent tool attach_proof" fired even though attach_proof
    // existed and succeeded — the verifier's own prompt (bare
    // AGENT_SYSTEM_PROMPT, built from toolRegistry.ts's ALL_TOOLS, which
    // deliberately does NOT include the proof-gate-specific attach_proof
    // action) never told it attach_proof was valid. Fixed by listing the
    // actual registered tool names plus attach_proof/FINAL directly in the
    // PRM classification prompt.
    // Path varies per call — same rationale as the previous test (avoids
    // legitimately tripping the new stuck detector before PRM ever fires).
    let n = 0;
    mockedStream.mockImplementation((callOpts: { model: string }) => {
      if (callOpts.model === 'deepseek/deepseek-v4-flash') return makeStream('no reflection tag here');
      n += 1;
      return makeStream(`THOUGHT: Still reading\nACTION: read_file\nARGS: {"path": "file-${n}.ts"}`);
    });
    mockedInvoke.mockResolvedValue('content');

    const opts = makeOpts();
    await planAndActManaged(opts); // PRM fires at step 5 and step 10

    const prmCalls = mockedStream.mock.calls.filter((c) => {
      const messages = (c[0] as { messages: Array<{ role: string; content: string }> }).messages;
      return messages.some((m) => m.content.includes('Classify this agent trajectory'));
    });
    expect(prmCalls.length).toBeGreaterThan(0);
    for (const call of prmCalls) {
      const messages = (call[0] as { messages: Array<{ role: string; content: string }> }).messages;
      const classifyMsg = messages.find((m) => m.content.includes('Classify this agent trajectory'));
      expect(classifyMsg?.content).toContain('attach_proof');
    }
  });

  it('emits agent.handoff with contextTokens when the R7 context handoff triggers', async () => {
    // NOTE: this used to drive HANDOFF_THRESHOLD (80000) with a single huge
    // read_file tool OBSERVATION. That stopped working once LazyReasoningBlocks
    // token-saving compression landed (e2c6f37): every tool observation is now
    // run through steeringPipeline.compressOutput (managedAgent.ts:1523,
    // steering.ts:256) before being appended to `messages`
    // (managedAgent.ts:1529), which caps it at DEFAULT_TOKEN_SAVING_CONFIG's
    // maxToolOutputChars (4000 chars, tokenSaving.ts:23) no matter how large
    // the raw tool result is — so a giant read_file result alone can never
    // cross HANDOFF_THRESHOLD (80000) again. That's correct, intentional
    // behavior for tool observations, not a bug in the R7 handoff path itself
    // (its emit call at managedAgent.ts:1622-1632 is untouched and still
    // unconditional on shouldHandoff(messages)).
    //
    // Driving the same threshold via a huge model-generated turn instead
    // (uncompressed — parseReActAction pushes it to `messages` verbatim,
    // managedAgent.ts:1313) still works, but every turn's raw text is also
    // fed to steeringPipeline.run() as `stepText` (managedAgent.ts:1076-1088)
    // whose FSM/monitors scale badly with input size (empirically ~90s for
    // one ~400K-char turn) — turning this into a pathologically slow test
    // for an unrelated subsystem. The realistic, still-fast way `messages`
    // legitimately grows past the ceiling on turn one is a large initial
    // task/context prompt (missionTask, plus any brain/skill context folded
    // in — managedAgent.ts:905-921): it is never compressed and never
    // routed through the per-turn steering pipeline, so it is what this test
    // now uses to trigger a genuine handoff.
    const hugeTask = 'x'.repeat(400_000); // ceil(400_000/4) well over HANDOFF_THRESHOLD (80000)
    const readTurn = `THOUGHT: reading a file\nACTION: read_file\nARGS: {"path": "big.ts"}`;
    const finalTurn = `THOUGHT: Done\nACTION: FINAL\nARGS: {"summary": "done"}`;

    let callCount = 0;
    mockedStream.mockImplementation((callOpts: { model: string }) => {
      if (callOpts.model === 'deepseek/deepseek-v4-flash') return makeStream('summary text');
      callCount += 1;
      return makeStream(callCount === 1 ? readTurn : finalTurn);
    });
    mockedInvoke.mockResolvedValue('small content');

    const opts = makeOpts({ missionTask: hugeTask });
    await planAndActManaged(opts);

    const handoffs = eventsOfType('agent.handoff');
    expect(handoffs).toHaveLength(1);
    const payload = handoffs[0].payload as { from: string; to: string; contextTokens?: number };
    expect(payload.from).toBe(opts.model);
    expect(payload.to).toBe(opts.model);
    expect(payload.contextTokens).toBeGreaterThanOrEqual(80000);
  });
});

// ── managedProvider.ts settle path (T0.4) ────────────────────────────
// streamManagedAgentTurn is mocked (vi.fn()) throughout the rest of this
// file (see the vi.mock('../lib/models/managedProvider', ...) block near
// the top) — that mock replaces the function wholesale, so it can never
// exercise the real settle-emission code inside it. This describe block
// bypasses that one mock via vi.importActual to drive the REAL
// implementation directly (fetch mocked, supabase/env mocked at file scope
// above), the same way managedProvider.test.ts already drives the real
// streamManagedAgentTurn for the pre-existing real-usage-marker behavior —
// so the corrective 'settled' spend.tokens event is verified against
// actual code, not a re-description of it.

describe('streamManagedAgentTurn — settled spend correction (real implementation)', () => {
  it('emits a corrective spend.tokens event with source "settled" carrying the ai-proxy settled totals', async () => {
    const { streamManagedAgentTurn: realStreamManagedAgentTurn } = await vi.importActual<
      typeof import('../lib/models/managedProvider')
    >('../lib/models/managedProvider');

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('THOUGHT: done\nACTION: FINAL\nARGS: {}\n'));
        controller.enqueue(
          encoder.encode('\x1b[usage]{"inputTokens":42,"outputTokens":17,"costUsd":0.0033}'),
        );
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, body } as unknown as Response);

    const chunks: string[] = [];
    for await (const chunk of realStreamManagedAgentTurn({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'sys',
      model: 'anthropic/claude-sonnet-5',
      missionId: 'mission-settle-1',
      projectId: 'proj-settle-1',
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toContain('ACTION: FINAL');

    const settled = mockedEmitBuffered.mock.calls
      .map((c: unknown[]) => c[0] as JournalEventInput)
      .find((e) => e.type === 'spend.tokens' && (e.payload as { source: string }).source === 'settled');

    expect(settled).toBeDefined();
    expect(settled?.payload).toEqual({
      tokensIn: 42,
      tokensOut: 17,
      costUsd: 0.0033,
      source: 'settled',
    });
    expect(settled?.missionId).toBe('mission-settle-1');
    expect(settled?.projectId).toBe('proj-settle-1');
    expect(settled?.actor).toBe('agent');
  });

  it('does not emit a settled spend.tokens event when missionId/projectId are absent', async () => {
    const { streamManagedAgentTurn: realStreamManagedAgentTurn } = await vi.importActual<
      typeof import('../lib/models/managedProvider')
    >('../lib/models/managedProvider');

    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('done\n\x1b[usage]{"inputTokens":1,"outputTokens":1,"costUsd":0.0001}'),
        );
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, body } as unknown as Response);

    const drainedChunks: string[] = [];
    for await (const chunk of realStreamManagedAgentTurn({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'sys',
      model: 'anthropic/claude-sonnet-5',
      // no missionId/projectId supplied
    })) {
      drainedChunks.push(chunk);
    }
    expect(drainedChunks.length).toBeGreaterThan(0);

    const settledCalls = mockedEmitBuffered.mock.calls
      .map((c: unknown[]) => c[0] as JournalEventInput)
      .filter((e) => e.type === 'spend.tokens' && (e.payload as { source: string }).source === 'settled');
    expect(settledCalls).toHaveLength(0);
  });
});
