/**
 * Tests for toolRuntime.ts's write_file undo-snapshot read (FIX 3):
 *
 * Previously ANY read_file failure before a write_file call — including the
 * Rust-side 20MB read-ceiling refusal (fs.rs's ReadCapDecision::TooLarge) —
 * was swallowed in a catch-all and treated as "file doesn't exist yet".
 * That meant an existing file larger than the ceiling got silently
 * overwritten with NO undo snapshot: a CRITICAL data-loss bug. This file
 * proves the fix: only a genuinely-missing target proceeds as a new-file
 * create; any other read failure (most importantly the read-ceiling
 * refusal) aborts the tool call before write_file is ever invoked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { executeTool } from '../lib/tools/toolRuntime';
import type { ToolExecutionContext } from '../lib/tools/toolRuntime';
import { on as busOn, type BusEvents } from '../lib/bus';

// ── Mock platform (brain_record calls getPlatform().brain.capture) ──
// vi.hoisted so the mock fn is created before vi.mock's factory runs
// (which itself is hoisted above these imports) — lets individual tests
// override it (mockRejectedValueOnce) without redefining the whole module.
const { mockCapture, mockRecall } = vi.hoisted(() => ({
  mockCapture: vi.fn().mockResolvedValue({ id: 'test-id', path: '/mock', sizeBytes: 0, attrsCount: 0 }),
  mockRecall: vi.fn().mockResolvedValue({ nodes: [], tokensSaved: 0, injectedContext: '' }),
}));
vi.mock('../lib/platform', () => ({
  getPlatform: () => ({
    brain: { capture: mockCapture, recall: mockRecall },
  }),
}));

// Mock the recall-savings choke point (costStore.recordRecallSaving) so the
// brain_query/brain_synthesize wiring tests below can assert the tool
// handlers forward their measured saving there. normalizeRecall itself is
// NOT mocked in this file, so these tests exercise the real 29x estimate.
const mockRecordRecallSaving = vi.fn();
vi.mock('../lib/models/costStore', () => ({
  recordRecallSaving: (...args: unknown[]) => mockRecordRecallSaving(...args),
}));

// journal.ts's emitBuffered debounces/batches real delivery via a scheduled
// Tauri invoke (journal_emit_batch) — irrelevant to the web_search wiring
// tests below, which only assert THAT the durable 'agent.web_search' event
// was buffered with the right payload, not how/when it's flushed.
const mockEmitBuffered = vi.fn();
vi.mock('../lib/journal/journal', () => ({
  emitBuffered: (...args: unknown[]) => mockEmitBuffered(...args),
}));

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;

function makeCtx(): ToolExecutionContext {
  return {
    rootPath: '/tmp/project',
    policy: {},
    agentMode: 'default',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // toolPermissions.ts persists rules to localStorage (project/user) — clear
  // it so no other test's seeded permission rules leak in (same precaution
  // managedAgent.test.ts's beforeEach takes).
  localStorage.clear();
});

describe('executeTool — write_file undo-snapshot read (FIX 3)', () => {
  it('proceeds as a new-file create when the target does not exist yet', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') {
        // Mirrors the actual Rust error text for a missing path: fs.rs's
        // ensure_path_in_project_root calls Path::canonicalize() on the
        // target BEFORE read_file's own metadata check, so a genuinely
        // absent file fails here first — see isMissingFileReadError's doc
        // comment in toolRuntime.ts.
        return Promise.reject(
          "path canonicalize failed for '/tmp/project/new-file.ts': The system cannot find the file specified. (os error 2)",
        );
      }
      if (cmd === 'write_file') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const result = await executeTool(
      'write_file',
      { path: 'new-file.ts', content: 'export const x = 1;' },
      makeCtx(),
    );

    expect(result).toBe('Successfully wrote new-file.ts');
    const writeCall = mockedInvoke.mock.calls.find((c: unknown[]) => c[0] === 'write_file');
    expect(writeCall).toBeDefined();
    const writeArg = writeCall![1] as { path: string; content: string };
    expect(writeArg.content).toBe('export const x = 1;');
  });

  it('aborts without writing when the read fails because the file is over the read ceiling', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') {
        // Mirrors fs.rs's ReadCapDecision::TooLarge error text exactly.
        return Promise.reject(
          "read_file: '/tmp/project/big-file.ts' is 25000000 bytes, over the 20000000 byte read ceiling",
        );
      }
      if (cmd === 'write_file') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const result = await executeTool(
      'write_file',
      { path: 'big-file.ts', content: 'this must NEVER be written' },
      makeCtx(),
    );

    expect(result).toContain('ERROR');
    expect(result.toLowerCase()).toContain('not overwritten');
    // The critical assertion: write_file must never be reached.
    expect(mockedInvoke).not.toHaveBeenCalledWith('write_file', expect.anything());
  });

  it('snapshots the existing content for undo when the read succeeds, and undo_edit restores it', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'read_file') return Promise.resolve('export const x = 1; // old');
      if (cmd === 'write_file') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const ctx = makeCtx();
    const writeResult = await executeTool(
      'write_file',
      { path: 'existing.ts', content: 'export const x = 2; // new' },
      ctx,
    );
    expect(writeResult).toBe('Successfully wrote existing.ts');

    mockedInvoke.mockClear();
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'write_file') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const undoResult = await executeTool('undo_edit', { path: 'existing.ts' }, ctx);
    expect(undoResult).toContain('Reverted');
    const undoWriteCall = mockedInvoke.mock.calls.find((c: unknown[]) => c[0] === 'write_file');
    expect(undoWriteCall).toBeDefined();
    const undoArg = undoWriteCall![1] as { path: string; content: string };
    expect(undoArg.content).toBe('export const x = 1; // old');
  });
});

// ── brain_record: platform.brain.capture() must be awaited ─────────
//
// Previously an un-awaited platform.brain.capture() call here let ANY
// rejection escape as an unhandled promise rejection (the calling try/catch
// had already exited by the time the promise settled) — most commonly a
// duplicate note's "Note already exists" conflict (see captureQueue.ts's
// module header and managedAgent.ts's identical FINAL-handler fix).

// ── web_search: canvas visibility + journal audit trail (P-SEARCH) ─────
//
// Founder directive (verbatim): "la recherche web doit ouvrir une fenêtre
// liée à l'agent qui demande la recherche et on voit la recherche". These
// tests prove the two effects that make the search VISIBLE happen at the
// right time and ONLY for a real mission run (ToolExecutionContext's own
// doc comment: missionId/agentName/projectId are absent for the assistant/
// codeur chat and the LazyManager, which have no mission of their own).

function makeMissionCtx(): ToolExecutionContext {
  return {
    rootPath: '/tmp/project',
    policy: {},
    agentMode: 'default',
    missionId: 'm1',
    agentName: 'Coder',
    projectId: 'p1',
  };
}

describe('executeTool — web_search emits the live canvas surface + journal event for a real mission', () => {
  it('emits a "searching" bus event before the Rust call resolves, then a "done" one with the real results', async () => {
    let resolveInvoke!: (value: unknown) => void;
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'web_search') {
        return new Promise((resolve) => {
          resolveInvoke = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const events: Array<BusEvents['canvas:webSearchResult']> = [];
    const unsubscribe = busOn('canvas:webSearchResult', (payload) => events.push(payload));

    const callPromise = executeTool('web_search', { query: 'react flow node types' }, makeMissionCtx());

    // The 'searching' event fires synchronously before the Rust command
    // settles — this is what makes the query genuinely LIVE on the canvas.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      missionId: 'm1',
      agentName: 'Coder',
      projectId: 'p1',
      query: 'react flow node types',
      status: 'searching',
      results: [],
    });

    resolveInvoke({
      query: 'react flow node types',
      results: [{ title: 'React Flow', url: 'https://reactflow.dev', snippet: 'A library for node-based UIs.' }],
    });
    await callPromise;

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      missionId: 'm1',
      status: 'done',
      results: [{ title: 'React Flow', url: 'https://reactflow.dev', snippet: 'A library for node-based UIs.' }],
    });

    unsubscribe();
  });

  it('journals agent.web_search with the query and honest result count once the search settles', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'web_search') {
        return Promise.resolve({
          query: 'rust regex lookahead',
          results: [
            { title: 'Result A', url: 'https://a.example', snippet: '' },
            { title: 'Result B', url: 'https://b.example', snippet: '' },
          ],
        });
      }
      return Promise.resolve(undefined);
    });

    await executeTool('web_search', { query: 'rust regex lookahead' }, makeMissionCtx());

    expect(mockEmitBuffered).toHaveBeenCalledTimes(1);
    const journaled = mockEmitBuffered.mock.calls[0][0] as {
      type: string;
      projectId: string;
      missionId: string;
      payload: { query: string; resultCount: number };
    };
    expect(journaled.type).toBe('agent.web_search');
    expect(journaled.projectId).toBe('p1');
    expect(journaled.missionId).toBe('m1');
    expect(journaled.payload).toEqual({ query: 'rust regex lookahead', resultCount: 2 });
  });

  it('emits a "searching" then "error" bus event and does NOT journal when the Rust call rejects', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'web_search') return Promise.reject(new Error('network unreachable'));
      return Promise.resolve(undefined);
    });

    const events: Array<BusEvents['canvas:webSearchResult']> = [];
    const unsubscribe = busOn('canvas:webSearchResult', (payload) => events.push(payload));

    const result = await executeTool('web_search', { query: 'a failing query' }, makeMissionCtx());

    expect(result).toContain('ERROR: web_search failed');
    expect(events.map((e) => e.status)).toEqual(['searching', 'error']);
    expect(mockEmitBuffered).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('never emits a canvas event or a journal entry for the assistant/codeur chat (no mission identity)', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'web_search') {
        return Promise.resolve({ query: 'q', results: [{ title: 'T', url: 'https://x.example', snippet: '' }] });
      }
      return Promise.resolve(undefined);
    });

    const events: Array<BusEvents['canvas:webSearchResult']> = [];
    const unsubscribe = busOn('canvas:webSearchResult', (payload) => events.push(payload));

    const result = await executeTool('web_search', { query: 'q' }, makeCtx());

    expect(result).toContain('Web search results for "q"');
    expect(events).toHaveLength(0);
    expect(mockEmitBuffered).not.toHaveBeenCalled();

    unsubscribe();
  });
});

describe('executeTool — brain_record capture is awaited (conflict-as-success)', () => {
  it('a "Note already exists" conflict is swallowed as success — no unhandled rejection, no warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCapture.mockRejectedValueOnce(
      new Error('lazybrain: Note already exists: notes/2026-07/discovery-2026-07-10.html. Pass overwrite to replace.'),
    );

    const result = await executeTool(
      'brain_record',
      { kind: 'discovery', title: 'Re-run finding', description: 'Same finding as an earlier run' },
      makeCtx(),
    );

    expect(result).toBe('Recorded to brain: [discovery] Re-run finding');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── brain_query / brain_synthesize: recall savings must be recorded ────
//
// Root-cause coverage: these two structured tools already computed a real
// tokensSaved estimate via normalizeRecall, then discarded it — only the
// Codeur chat panel (assistantStore.tsx) ever forwarded its estimate to the
// usage-metrics store, so CockpitKpiBar showed 0 no matter how much a
// tool-calling agent's brain_query/brain_synthesize calls actually saved.

describe('executeTool — brain_query/brain_synthesize record their measured saving', () => {
  it('brain_query forwards a real recall to recordRecallSaving, tagged "tool"', async () => {
    mockRecall.mockResolvedValueOnce({
      nodes: [{ id: 'n1', title: 'Auth flow', snippet: 'Auth uses Supabase JWT tokens end to end.', score: 0.9 }],
      tokensSaved: 0,
      injectedContext: '',
    });

    await executeTool('brain_query', { query: 'how does auth work' }, makeCtx());

    expect(mockRecordRecallSaving).toHaveBeenCalledTimes(1);
    const [recallArg, source] = mockRecordRecallSaving.mock.calls[0];
    expect(source).toBe('tool');
    // Real normalizeRecall (not mocked here) computed a genuine positive
    // estimate from the injected snippet — never a fake floor.
    expect(recallArg.tokensSaved).toBeGreaterThan(0);
  });

  it('brain_synthesize forwards a real recall to recordRecallSaving, tagged "tool"', async () => {
    mockRecall.mockResolvedValueOnce({
      nodes: [{ id: 'n2', title: 'Billing', snippet: 'Stripe handles subscription billing.', score: 0.8 }],
      tokensSaved: 0,
      injectedContext: '',
    });

    await executeTool('brain_synthesize', { topic: 'billing' }, makeCtx());

    expect(mockRecordRecallSaving).toHaveBeenCalledTimes(1);
    expect(mockRecordRecallSaving).toHaveBeenCalledWith(expect.anything(), 'tool');
  });

  it('brain_query does not fabricate a saving when the recall found nothing', async () => {
    mockRecall.mockResolvedValueOnce({ nodes: [], tokensSaved: 0, injectedContext: '' });

    await executeTool('brain_query', { query: 'nonexistent topic' }, makeCtx());

    expect(mockRecordRecallSaving).toHaveBeenCalledTimes(1);
    const [recallArg] = mockRecordRecallSaving.mock.calls[0];
    expect(recallArg.tokensSaved).toBe(0);
  });
});

// ── Mission self-verification failure-class fix (run_command timeout floor
// + check_url) ────────────────────────────────────────────────────────
//
// Observed failure: an agent finishes a correct deliverable, then tries to
// self-verify it with a short-timeout `npx http-server` (cold npx start
// regularly exceeds 3s) or a missing `python`, exhausts find_tool
// browser_open, and the mission is reported FAILED despite a good result.
// The two tests below prove the fixes independently: run_command's timeout
// floor (so a too-short self-check timeout no longer kills a slow-starting
// command), and the new check_url tool (a bounded, never-throwing fetch
// that replaces "spawn my own server to check it").

describe('executeTool — run_command timeout floor (self-verification failure-class fix)', () => {
  it('raises a requested timeout_ms below the 10s floor, and leaves one at/above it untouched', async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'run_shell') return Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 });
      return Promise.resolve(undefined);
    });

    // Cold `npx` start scenario from the failure class: agent asks for a
    // 3s timeout, must actually get the 10s floor instead.
    await executeTool(
      'run_command',
      { command: 'npx http-server -p 8123', timeout_ms: 3000 },
      makeCtx(),
    );
    const shortCall = mockedInvoke.mock.calls.find((c: unknown[]) => c[0] === 'run_shell');
    expect(shortCall).toBeDefined();
    expect((shortCall![1] as { timeoutMs: number }).timeoutMs).toBe(10_000);

    mockedInvoke.mockClear();

    // A request already at/above the floor must pass through unchanged —
    // this is a floor, not a fixed override of every call.
    await executeTool(
      'run_command',
      { command: 'npm run build', timeout_ms: 60_000 },
      makeCtx(),
    );
    const longCall = mockedInvoke.mock.calls.find((c: unknown[]) => c[0] === 'run_shell');
    expect(longCall).toBeDefined();
    expect((longCall![1] as { timeoutMs: number }).timeoutMs).toBe(60_000);
  });
});

describe('executeTool — check_url (self-verification failure-class fix)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('OK + contains: returns status, bodyStart, and containsMatch:true when the body contains the needle', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('<html><body>Hello world</body></html>'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await executeTool(
      'check_url',
      { url: 'http://127.0.0.1:8123', contains: 'Hello world' },
      makeCtx(),
    );

    const parsed = JSON.parse(result) as { status: number; bodyStart: string; containsMatch: boolean };
    expect(parsed.status).toBe(200);
    expect(parsed.bodyStart).toBe('<html><body>Hello world</body></html>');
    expect(parsed.containsMatch).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:8123', expect.objectContaining({ signal: expect.anything() }));
  });

  it('network KO: a rejected fetch (dead server / timeout) returns an honest status:0 result, never an ERROR string or a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const result = await executeTool('check_url', { url: 'http://127.0.0.1:9999' }, makeCtx());

    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result) as { status: number; bodyStart: string; containsMatch: boolean; error?: string };
    expect(parsed.status).toBe(0);
    expect(parsed.bodyStart).toBe('');
    expect(parsed.containsMatch).toBe(false);
    expect(result).not.toMatch(/^ERROR/);
  });
});
