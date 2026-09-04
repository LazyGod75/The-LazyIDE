import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AssistantStoreProvider, useAssistantStore } from '../components/assistant/assistantStore';
import { MAX_CHAT_MESSAGES } from '../lib/ai/chatPersistence';
import { I18nProvider } from '../i18n';

// Persistence (lib/ai/chatPersistence.ts) now saves regardless of
// projectRoot (DEFECT 1 fix) and a fresh AssistantStoreProvider auto-
// restores the latest persisted session on mount (DEFECT 2 fix) — so every
// `send()` call below writes real localStorage, and a later test's mount
// would otherwise pick up an earlier test's conversation. Same isolation
// convention as managerPersistence.test.ts's identical beforeEach.
beforeEach(() => {
  localStorage.clear();
});

// Mock brain capture so it doesn't invoke Tauri — but keep the REAL
// stripLeakedReasoning (via importOriginal) since assistantStore.tsx now
// calls it directly at its finalize points (FIX 5); mocking it out to
// undefined would throw the instant any test calls send().
vi.mock('../lib/brain/capture', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/brain/capture')>();
  return {
    ...actual,
    captureAssistant: vi.fn(),
    captureChatLearning: vi.fn(),
  };
});

// Mock AppContext — AssistantStoreProvider needs projectRoot
vi.mock('../app/AppContext', () => ({
  useAppContext: vi.fn(() => ({ projectRoot: '' })),
}));

// Mock useLazyRules — no filesystem in tests
vi.mock('../lib/ai/lazyRules', () => ({
  useLazyRules: vi.fn(() => ({ rules: null, loading: false, reload: vi.fn() })),
  buildRulesSystemPrompt: vi.fn(() => ''),
}));

// Mock the platform brain wrapper with a fast, empty-by-default recall so
// existing tests behave exactly as they do against the real WebPlatform (no
// brain reachable in a test environment), while letting specific tests below
// override recallScoped to simulate a timeout/error. Keep isTauri real (via
// importOriginal) — i18n's fetchOsLocale imports it directly.
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: vi.fn(() => ({
      brain: {
        recallScoped: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensSaved: 0 }),
        startupContext: vi.fn().mockResolvedValue(''),
      },
    })),
  };
});

// Mock the provider selector — return a mock provider that streams predictably
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProvider: vi.fn(() => ({
      id: 'mock',
      label: 'Mock',
      listModels: () => actual.ALL_MODELS,
      streamChat: async function* () {
        yield 'Hello ';
        yield 'world';
      },
    })),
    describeProviderReadiness: vi.fn(() => ({ ready: true })),
  };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <AssistantStoreProvider>{children}</AssistantStoreProvider>
    </I18nProvider>
  );
}

describe('assistantStore', () => {
  it('initialises with empty messages and isStreaming=false', () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.isStreaming).toBe(false);
  });

  it('send appends a user message and an assistant message', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    await act(async () => {
      await result.current.send('What does auth.ts do?');
    });

    expect(result.current.messages.length).toBeGreaterThanOrEqual(2);
    const userMsg = result.current.messages.find(m => m.role === 'user');
    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(userMsg).toBeDefined();
    expect(assistantMsg).toBeDefined();
  });

  it('send accumulates streamed content into assistant message', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    await act(async () => {
      await result.current.send('Hello?');
    });

    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Hello world');
  });

  it('send sets isStreaming=false after completion', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    await act(async () => {
      await result.current.send('Test');
    });

    expect(result.current.isStreaming).toBe(false);
  });

  it('send with empty content is ignored', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    await act(async () => {
      await result.current.send('   ');
    });

    expect(result.current.messages).toHaveLength(0);
  });

  it('send with whitespace-only content is ignored', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    await act(async () => {
      await result.current.send('\t\n  ');
    });

    expect(result.current.messages).toHaveLength(0);
  });

  it('clearConversation resets messages to empty', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    await act(async () => {
      await result.current.send('First message');
    });

    act(() => {
      result.current.clearConversation();
    });

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.isStreaming).toBe(false);
  });

  it('setMode updates the selected mode', () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    act(() => {
      result.current.setMode('plan');
    });

    expect(result.current.selectedMode).toBe('plan');
  });

  // ── ChatMessage.mode + codeBlock.targetPath (DEFECT 2 plumbing) ────
  //
  // MessageList's Apply-gating rule (mode !== 'ask' AND an explicit fence
  // target) depends on both of these being populated correctly at the
  // store level — see MessageList.tsx's canOfferApply.

  it('records the mode active when the message was generated onto the assistant message', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    act(() => { result.current.setMode('edit'); });

    await act(async () => {
      await result.current.send('Apply a change');
    });

    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.mode).toBe('edit');
  });

  it('parses an explicit fence target into codeBlock.targetPath (never guessed from prose)', async () => {
    const mod = await import('../lib/models/index');
    (mod.getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      id: 'mock',
      label: 'Mock',
      listModels: () => mod.ALL_MODELS,
      streamChat: async function* () {
        yield '```tsx src/components/Foo.tsx\nexport const Foo = () => null;\n```';
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    await act(async () => {
      await result.current.send('Show me the component');
    });

    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.codeBlock?.language).toBe('tsx');
    expect(assistantMsg?.codeBlock?.targetPath).toBe('src/components/Foo.tsx');
    expect(assistantMsg?.codeBlock?.code).toBe('export const Foo = () => null;');
  });

  it('leaves codeBlock.targetPath undefined for a plain fence with no explicit target', async () => {
    const mod = await import('../lib/models/index');
    (mod.getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      id: 'mock',
      label: 'Mock',
      listModels: () => mod.ALL_MODELS,
      streamChat: async function* () {
        yield '```tsx\nexport const Foo = () => null;\n```';
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    await act(async () => {
      await result.current.send('Show me the component');
    });

    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.codeBlock?.language).toBe('tsx');
    expect(assistantMsg?.codeBlock?.targetPath).toBeUndefined();
  });

  it('multiple sends accumulate messages', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    await act(async () => {
      await result.current.send('First');
    });
    await act(async () => {
      await result.current.send('Second');
    });

    const userMsgs = result.current.messages.filter(m => m.role === 'user');
    expect(userMsgs.length).toBe(2);
  });

  // fix(memory): AssistantStoreProvider is mounted ONCE for the app's whole
  // lifetime (no per-project remount) — before this fix, state.messages grew
  // without bound for a single long-running conversation. Proves the live
  // rendered list is capped at MAX_CHAT_MESSAGES, mirroring
  // chatPersistence.test.ts's own "saveMessages caps a session" coverage for
  // the persisted side of the exact same cap.
  it('caps the live rendered messages list at MAX_CHAT_MESSAGES so a long-running conversation never grows the array without bound', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    // Each send() appends 2 messages (user + assistant) — a few turns past
    // MAX_CHAT_MESSAGES / 2 reliably crosses the cap.
    const turnsNeeded = Math.floor(MAX_CHAT_MESSAGES / 2) + 3;
    for (let i = 0; i < turnsNeeded; i++) {
      await act(async () => {
        await result.current.send(`Turn ${i}`);
      });
    }

    expect(result.current.messages.length).toBe(MAX_CHAT_MESSAGES);
    // Keep-LAST semantics — the most recent turn is still present, the
    // earliest ones were dropped.
    expect(result.current.messages.some(m => m.content === `Turn ${turnsNeeded - 1}`)).toBe(true);
    expect(result.current.messages.some(m => m.content === 'Turn 0')).toBe(false);
  }, 30000);

  it('messages have unique ids', async () => {
    const { result } = renderHook(() => useAssistantStore(), { wrapper });

    await act(async () => {
      await result.current.send('Q1');
    });
    await act(async () => {
      await result.current.send('Q2');
    });

    const ids = result.current.messages.map(m => m.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('marks the assistant message as error when the stream times out', async () => {
    const mod = await import('../lib/models/index');
    (mod.getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      id: 'mock',
      label: 'Mock',
      listModels: () => mod.ALL_MODELS,
      streamChat: async function* () {
        await new Promise<void>(r => setTimeout(r, 60_000));
        yield 'never';
      },
    });
    vi.useFakeTimers();
    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    let sendPromise!: Promise<void>;
    act(() => { sendPromise = result.current.send('hang please'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    await act(async () => { await sendPromise; });
    vi.useRealTimers();
    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.error).toBe(true);
    expect(assistantMsg?.content).toMatch(/temps|imparti|répond|time|respond|timeout/i);
    expect(result.current.isStreaming).toBe(false);
  });

  it('shows a preflight error and does not stream when no engine is ready', async () => {
    const mod = await import('../lib/models/index');
    (mod.describeProviderReadiness as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ ready: false, reason: 'Aucun moteur détecté.' });
    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    await act(async () => { await result.current.send('hi'); });
    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.error).toBe(true);
    expect(assistantMsg?.content).toMatch(/moteur/i);
    expect(result.current.isStreaming).toBe(false);
  });

  // ── Brain recall graceful degradation (QA bug #1) ────────────────
  //
  // A brain-recall timeout/error must never block the turn: the model
  // answer must still stream in and render as a real (non-error) bubble.

  it('still renders a final answer when brain recall rejects (e.g. backend timeout)', async () => {
    const platformMod = await import('../lib/platform');
    (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      brain: {
        recallScoped: vi.fn().mockRejectedValue(new Error('brain command timed out after 30s')),
        startupContext: vi.fn().mockResolvedValue(''),
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    await act(async () => {
      await result.current.send('What does auth.ts do?');
    });

    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    // The final prose answer from the mocked provider must still render.
    expect(assistantMsg?.content).toBe('Hello world');
    expect(assistantMsg?.error).toBeFalsy();
    expect(result.current.isStreaming).toBe(false);
    // The banner error is still surfaced (degraded, not hidden) — but the
    // turn itself completed with a real answer. Match the underlying reason
    // rather than the (locale-dependent) translated prefix.
    expect(result.current.brainError).toMatch(/brain command timed out after 30s/);
  });

  it('still renders a final answer when brain recall never settles (hung backend)', async () => {
    const { BRAIN_RECALL_TIMEOUT_MS } = await import('../lib/models/brainSearchLoop');
    const platformMod = await import('../lib/platform');
    (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      brain: {
        recallScoped: vi.fn(() => new Promise(() => {})), // never settles
        startupContext: vi.fn().mockResolvedValue(''),
      },
    });

    vi.useFakeTimers();
    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    let sendPromise!: Promise<void>;
    act(() => { sendPromise = result.current.send('What does auth.ts do?'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(BRAIN_RECALL_TIMEOUT_MS + 100); });
    await act(async () => { await sendPromise; });
    vi.useRealTimers();

    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Hello world');
    expect(assistantMsg?.error).toBeFalsy();
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.brainError).toMatch(/brain recall timed out after \d+ms/);
  });

  // B17 follow-up: the WS1/WS2 scope-fallback recall (fired when the
  // primary recall succeeds but comes back empty) is bounded by the
  // SHORTER BRAIN_RECALL_FALLBACK_TIMEOUT_MS, not the full
  // BRAIN_RECALL_TIMEOUT_MS — a hung fallback must degrade well before the
  // primary recall's own budget would, so a chat turn never waits close to
  // 2x BRAIN_RECALL_TIMEOUT_MS end to end.
  it('bounds a hung scope-fallback recall by BRAIN_RECALL_FALLBACK_TIMEOUT_MS (shorter than the primary budget)', async () => {
    const { BRAIN_RECALL_FALLBACK_TIMEOUT_MS, BRAIN_RECALL_TIMEOUT_MS } = await import('../lib/models/brainSearchLoop');
    expect(BRAIN_RECALL_FALLBACK_TIMEOUT_MS).toBeLessThan(BRAIN_RECALL_TIMEOUT_MS);

    const platformMod = await import('../lib/platform');
    const recallScoped = vi.fn()
      // Primary ('current' scope) resolves fast but empty — triggers the
      // WS1 fallback to 'all'.
      .mockResolvedValueOnce({ injectedContext: '', nodes: [], tokensSaved: 0 })
      // Fallback ('all' scope) hangs forever — must be abandoned at
      // BRAIN_RECALL_FALLBACK_TIMEOUT_MS, not BRAIN_RECALL_TIMEOUT_MS.
      .mockImplementationOnce(() => new Promise(() => {}));
    (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'tauri',
      brain: {
        recallScoped,
        startupContext: vi.fn().mockResolvedValue(''),
        info: vi.fn().mockResolvedValue({ path: '/empty/brain', source: 'project', noteCount: 0, isEmpty: true }),
      },
    });

    vi.useFakeTimers();
    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    let sendPromise!: Promise<void>;
    act(() => { sendPromise = result.current.send('What does auth.ts do?'); });
    // Advance past the fallback's short budget but well short of the full
    // primary budget — the turn must already have completed.
    await act(async () => { await vi.advanceTimersByTimeAsync(BRAIN_RECALL_FALLBACK_TIMEOUT_MS + 100); });
    await act(async () => { await sendPromise; });
    vi.useRealTimers();

    const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Hello world');
    expect(assistantMsg?.error).toBeFalsy();
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.brainError).toMatch(/brain recall \(all scope fallback\) timed out after \d+ms/);
  });

  // ── Brain unreachable — retry action (brain-legacy-detection fix) ────
  //
  // The assistant chat's brainError banner previously had no recovery path
  // short of starting a whole new turn. retryBrain() wires the SAME
  // brain_retry_sidecar mechanism BrainSpace.tsx's own "Réessayer" button
  // already uses (platform.brain.retrySidecar()), scoped to this chat's own
  // brainError state. Combined with the hung-recall test above (which
  // already proves isStreaming resolves to false — no spinner forever),
  // this closes the loop: an unreachable brain surfaces an honest, actionable
  // error instead of hanging silently.

  it('retryBrain clears brainError when the sidecar comes back healthy', async () => {
    const platformMod = await import('../lib/platform');
    const retrySidecar = vi.fn().mockResolvedValue(true);
    (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      brain: {
        recallScoped: vi.fn().mockRejectedValue(new Error('brain command timed out after 30s')),
        startupContext: vi.fn().mockResolvedValue(''),
        retrySidecar,
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    await act(async () => {
      await result.current.send('What does auth.ts do?');
    });
    expect(result.current.brainError).toBeTruthy();

    await act(async () => {
      await result.current.retryBrain();
    });

    expect(retrySidecar).toHaveBeenCalledTimes(1);
    expect(result.current.brainError).toBeNull();
  });

  it('retryBrain leaves brainError in place when the sidecar is still down (no silent false-success)', async () => {
    const platformMod = await import('../lib/platform');
    const retrySidecar = vi.fn().mockResolvedValue(false);
    (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      brain: {
        recallScoped: vi.fn().mockRejectedValue(new Error('brain command timed out after 30s')),
        startupContext: vi.fn().mockResolvedValue(''),
        retrySidecar,
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    await act(async () => {
      await result.current.send('What does auth.ts do?');
    });
    expect(result.current.brainError).toBeTruthy();

    await act(async () => {
      await result.current.retryBrain();
    });

    expect(retrySidecar).toHaveBeenCalledTimes(1);
    expect(result.current.brainError).toBeTruthy();
  });

  // ── BRAIN DISCOVERABILITY — emptyBrain signal (P1) ────────────────
  //
  // Distinguishes "this query found nothing" (normal) from "the active
  // brain itself has zero notes" (actionable — BrainContextBanner shows a
  // CTA instead of the ambiguous "no relevant neurons found").

  it('sets brainRecall.emptyBrain=true when recall is empty AND the resolved brain has 0 notes', async () => {
    const platformMod = await import('../lib/platform');
    // mockReturnValue (not "Once"): send() calls getPlatform() multiple
    // times for this scenario — the primary 'current'-scope recall, the
    // WS1 'all'-scope fallback (since the primary is empty), AND
    // fetchBrainIsEmpty's own info() lookup — all three calls must observe
    // this same tauri-shaped platform.
    (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'tauri',
      brain: {
        recallScoped: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensSaved: 0 }),
        startupContext: vi.fn().mockResolvedValue(''),
        info: vi.fn().mockResolvedValue({ path: '/empty/brain', source: 'project', noteCount: 0, isEmpty: true }),
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    await act(async () => {
      await result.current.send('What does auth.ts do?');
    });

    expect(result.current.brainRecall?.emptyBrain).toBe(true);
  });

  // ROOT CAUSE regression test for the 2026-07-03 live bug: banner showed
  // "0 neurons" for a project brain get_brain_info confirmed had 120 notes.
  // Cause: state.selectedScope was stuck on 'all' (BrainScopeSelector's
  // "All brains" choice persists in localStorage across restarts AND
  // project switches with no reset), and brain_fetch_recall_scoped's "all"
  // branch fans out over get_brain_projects() — empty on a machine that
  // never used the "add project" feature — so it returns nothing
  // REGARDLESS of the active project's own brain content. The old WS1
  // fallback only broadened 'current' -> 'all'; it could never catch a
  // failing 'all' (or a specific {project}) scope. WS2 (assistantStore.tsx)
  // narrows back to 'current' whenever any OTHER scope comes back empty.
  it('WS2: falls back to "current" scope when a non-current scope (e.g. "All brains" with no registered projects) returns empty', async () => {
    const platformMod = await import('../lib/platform');
    // Primary call uses the selected 'all' scope and resolves empty (mirrors
    // brain_fetch_recall_scoped's "all" branch with zero registered
    // projects). The WS2 fallback call uses 'current' and finds real hits.
    const recallScoped = vi.fn()
      .mockResolvedValueOnce({ injectedContext: '', nodes: [], tokensSaved: 0 })
      .mockResolvedValueOnce({
        injectedContext: '- the current project DOES have relevant notes',
        nodes: [{ id: 'n1', title: 'Note', snippet: 'text', score: 1 }],
        tokensSaved: 0,
      });
    (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'tauri',
      brain: {
        recallScoped,
        startupContext: vi.fn().mockResolvedValue(''),
        info: vi.fn().mockResolvedValue({ path: '/populated/brain', source: 'project', noteCount: 120, isEmpty: false }),
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    act(() => {
      result.current.setScope('all');
    });

    await act(async () => {
      await result.current.send("Analyse la page d'accueil de ce site");
    });

    // First call used the user-selected 'all' scope; second call (the WS2
    // fallback) narrowed to 'current' once 'all' came back empty.
    expect(recallScoped).toHaveBeenCalledTimes(2);
    expect(recallScoped.mock.calls[0][1]).toBe('all');
    expect(recallScoped.mock.calls[1][1]).toBe('current');
    expect(result.current.brainRecall?.nodes.length).toBe(1);
    expect(result.current.brainRecall?.injectedContext).toContain('current project DOES have relevant notes');
  });

  it('does NOT set emptyBrain when recall is empty but the resolved brain has notes (just nothing relevant to this query)', async () => {
    const platformMod = await import('../lib/platform');
    const infoMock = vi.fn().mockResolvedValue({ path: '/populated/brain', source: 'project', noteCount: 4994, isEmpty: false });
    (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'tauri',
      brain: {
        recallScoped: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensSaved: 0 }),
        startupContext: vi.fn().mockResolvedValue(''),
        info: infoMock,
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    await act(async () => {
      await result.current.send('What does auth.ts do?');
    });

    expect(result.current.brainRecall?.emptyBrain).toBeFalsy();
    expect(infoMock).toHaveBeenCalled();
  });

  it('never calls brain.info() when recall already returned real results (no unnecessary extra IPC call)', async () => {
    const platformMod = await import('../lib/platform');
    const infoMock = vi.fn().mockResolvedValue({ path: '/populated/brain', source: 'project', noteCount: 4994, isEmpty: false });
    (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      name: 'tauri',
      brain: {
        recallScoped: vi.fn().mockResolvedValue({
          injectedContext: '- some real recalled note',
          nodes: [{ id: 'n1', title: 'Note', snippet: 'text', score: 0.9 }],
          tokensSaved: 0,
        }),
        startupContext: vi.fn().mockResolvedValue(''),
        info: infoMock,
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    await act(async () => {
      await result.current.send('What does auth.ts do?');
    });

    expect(result.current.brainRecall?.emptyBrain).toBeFalsy();
    expect(infoMock).not.toHaveBeenCalled();
  });

  it('leaves emptyBrain falsy on the web platform even with an empty recall (info() is Tauri-only)', async () => {
    // Uses the module-level default mock (no `name` field, no `info()`),
    // matching how getPlatform() behaves outside Tauri in these tests.
    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    await act(async () => {
      await result.current.send('What does auth.ts do?');
    });

    expect(result.current.brainRecall?.emptyBrain).toBeFalsy();
  });

  // ── Structured stream — thinking/tool/text kept separate (chat UX fix) ──
  //
  // The owner's complaint: "in the same message you see what it thinks,
  // the tools, and the response all mixed together." These tests prove the
  // store no longer concatenates every streamed signal into `content` —
  // thinking and tool-call steps land in `message.parts` instead, and
  // `content` ends up holding ONLY the final-answer text.

  describe('structured stream (thinking/tool/text) — parts stay separate from content', () => {
    it('routes thinking/tool events into message.parts and keeps content to just the answer text', async () => {
      const mod = await import('../lib/models/index');
      (mod.getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        id: 'mock-structured',
        label: 'Mock Structured',
        listModels: () => mod.ALL_MODELS,
        // Present so we can assert it is NOT the path actually consumed —
        // streamChatEvents must take priority when both exist.
        streamChat: async function* () {
          yield 'this string path must not be used';
        },
        streamChatEvents: async function* () {
          yield { type: 'thinking', id: 'thinking', text: 'Let me check memory.' };
          yield { type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth flow' }, status: 'running' };
          yield { type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth flow' }, status: 'done', resultSummary: 'found 2 notes' };
          yield { type: 'text', id: 'answer', text: 'Auth uses ' };
          yield { type: 'text', id: 'answer', text: 'Supabase JWT.' };
        },
      });

      const { result } = renderHook(() => useAssistantStore(), { wrapper });
      await act(async () => {
        await result.current.send('How does auth work?');
      });

      const assistantMsg = result.current.messages.find(m => m.role === 'assistant');

      // content = ONLY the concatenated text events — no thinking, no tool
      // status, no raw query text leaked in.
      expect(assistantMsg?.content).toBe('Auth uses Supabase JWT.');
      expect(assistantMsg?.content).not.toContain('Let me check memory');
      expect(assistantMsg?.content).not.toContain('auth flow');
      expect(assistantMsg?.content).not.toContain('this string path must not be used');

      // thinking + tool steps land in parts, not concatenated together.
      expect(assistantMsg?.parts).toHaveLength(2);
      const thinkingPart = assistantMsg?.parts?.find(p => p.type === 'thinking');
      const toolPart = assistantMsg?.parts?.find(p => p.type === 'tool');
      expect(thinkingPart).toEqual({ type: 'thinking', id: 'thinking', text: 'Let me check memory.' });
      expect(toolPart).toEqual({
        type: 'tool',
        id: 't1',
        name: 'brain_search',
        input: { query: 'auth flow' },
        status: 'done',
        resultSummary: 'found 2 notes',
      });
    });

    it('accumulates repeated thinking deltas into a single ordered part instead of duplicating entries', async () => {
      const mod = await import('../lib/models/index');
      (mod.getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        id: 'mock-structured',
        label: 'Mock Structured',
        listModels: () => mod.ALL_MODELS,
        streamChat: async function* () { yield ''; },
        streamChatEvents: async function* () {
          yield { type: 'thinking', id: 'thinking', text: 'First. ' };
          yield { type: 'thinking', id: 'thinking', text: 'Second.' };
          yield { type: 'text', id: 'answer', text: 'Done.' };
        },
      });

      const { result } = renderHook(() => useAssistantStore(), { wrapper });
      await act(async () => {
        await result.current.send('Explain step by step');
      });

      const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
      const thinkingParts = assistantMsg?.parts?.filter(p => p.type === 'thinking') ?? [];
      expect(thinkingParts).toHaveLength(1);
      expect(thinkingParts[0]).toMatchObject({ text: 'First. Second.' });
      expect(assistantMsg?.content).toBe('Done.');
    });

    it('leaves parts empty for a plain (non-structured) provider stream — simple completions render unchanged', async () => {
      // Uses the module-level default mock (streamChat only, no
      // streamChatEvents) — the adapter must produce zero non-text parts.
      const { result } = renderHook(() => useAssistantStore(), { wrapper });
      await act(async () => {
        await result.current.send('Hello?');
      });
      const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
      expect(assistantMsg?.content).toBe('Hello world');
      expect(assistantMsg?.parts ?? []).toHaveLength(0);
    });
  });

  // ── FIX 5: reasoning-leak defense on the COMMITTED final message ────
  //
  // capture.ts's stripLeakedReasoning already protected the brain copy; the
  // live chat UI (this store's `messages` state) did not — so a reasoning-
  // channel marker that splits across two stream chunks (no single chunk
  // contains the whole "\x1b[reasoning]" sequence, so any per-chunk
  // detector upstream misses it) used to reach the rendered/persisted
  // ChatMessage.content verbatim. This proves the FINAL committed content
  // is clean regardless of where the marker fell across chunk boundaries.

  describe('reasoning-leak defense on the committed final message', () => {
    it('strips a reasoning-channel leak that splits across stream chunks from the committed final content', async () => {
      const mod = await import('../lib/models/index');
      (mod.getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        id: 'mock',
        label: 'Mock',
        listModels: () => mod.ALL_MODELS,
        streamChat: async function* () {
          // The marker itself splits across two yielded chunks — no single
          // chunk contains the whole "\x1b[reasoning]" sequence.
          yield 'The fix uses a centralized handler.\x1b';
          yield '[reasoning]the user seems unsure about promise semantics\n';
          yield 'Errors are logged with context before the response.';
        },
      });

      const { result } = renderHook(() => useAssistantStore(), { wrapper });
      await act(async () => {
        await result.current.send('How should I handle async errors?');
      });

      const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
      expect(assistantMsg?.content).not.toContain('[reasoning]');
      expect(assistantMsg?.content).not.toContain('unsure about promise semantics');
      expect(assistantMsg?.content).toContain('The fix uses a centralized handler.');
      expect(assistantMsg?.content).toContain('Errors are logged with context before the response.');
    });
  });

  // ── Recall session-dedup id (Q3 differential-injection dedup) ──────
  //
  // search.rs's brain_fetch_recall_scoped accepts an optional session_id
  // that lets the engine skip brain notes already shown earlier in the same
  // conversation, but until now the frontend never generated/passed one, so
  // dedup was always inert (see recallScoped's doc comment in
  // lib/platform/types.ts). These tests prove assistantStore.tsx now
  // threads a STABLE per-conversation id into every recallScoped() call —
  // stable across turns of ONE conversation (so dedup can accumulate), but
  // a DIFFERENT id once a new conversation starts, so one conversation's
  // dedup state can never leak into, or hide context from, another.

  describe('recall session-dedup id (Q3 differential-injection dedup)', () => {
    it('passes the same sessionId to recallScoped across two turns of the same conversation', async () => {
      const platformMod = await import('../lib/platform');
      const recallScoped = vi.fn().mockResolvedValue({
        injectedContext: '- some real recalled note',
        nodes: [{ id: 'n1', title: 'Note', snippet: 'text', score: 0.9 }],
        tokensSaved: 0,
      });
      (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        name: 'tauri',
        brain: {
          recallScoped,
          startupContext: vi.fn().mockResolvedValue(''),
        },
      });

      const { result } = renderHook(() => useAssistantStore(), { wrapper });

      await act(async () => {
        await result.current.send('First turn');
      });
      await act(async () => {
        await result.current.send('Second turn');
      });

      // Non-empty recall on both turns -> exactly one recallScoped call per
      // turn (the WS2 empty-scope fallback never fires).
      expect(recallScoped).toHaveBeenCalledTimes(2);
      const sessionIdTurn1 = recallScoped.mock.calls[0][2];
      const sessionIdTurn2 = recallScoped.mock.calls[1][2];
      expect(typeof sessionIdTurn1).toBe('string');
      expect(sessionIdTurn1).toBeTruthy();
      expect(sessionIdTurn2).toBe(sessionIdTurn1);
    });

    it('threads the same sessionId into the StreamChatRequest given to the provider (for in-turn BRAIN_SEARCH rounds)', async () => {
      const platformMod = await import('../lib/platform');
      const recallScoped = vi.fn().mockResolvedValue({
        injectedContext: '- some note',
        nodes: [{ id: 'n1', title: 'Note', snippet: 'text', score: 0.9 }],
        tokensSaved: 0,
      });
      (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        name: 'tauri',
        brain: {
          recallScoped,
          startupContext: vi.fn().mockResolvedValue(''),
        },
      });

      const mod = await import('../lib/models/index');
      let capturedReq: { sessionId?: string } | undefined;
      (mod.getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        id: 'mock',
        label: 'Mock',
        listModels: () => mod.ALL_MODELS,
        streamChat: (req: { sessionId?: string }) => {
          capturedReq = req;
          return (async function* () {
            yield 'ok';
          })();
        },
      });

      const { result } = renderHook(() => useAssistantStore(), { wrapper });
      await act(async () => {
        await result.current.send('Hello');
      });

      const sessionIdFromRecall = recallScoped.mock.calls[0][2];
      expect(sessionIdFromRecall).toBeTruthy();
      expect(capturedReq?.sessionId).toBe(sessionIdFromRecall);
    });

    it('uses a DIFFERENT sessionId after clearConversation starts a new conversation', async () => {
      const platformMod = await import('../lib/platform');
      const recallScoped = vi.fn().mockResolvedValue({
        injectedContext: '- some note',
        nodes: [{ id: 'n1', title: 'Note', snippet: 'text', score: 0.9 }],
        tokensSaved: 0,
      });
      (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        name: 'tauri',
        brain: {
          recallScoped,
          startupContext: vi.fn().mockResolvedValue(''),
        },
      });

      const { result } = renderHook(() => useAssistantStore(), { wrapper });

      await act(async () => {
        await result.current.send('Before clear');
      });

      act(() => {
        result.current.clearConversation();
      });

      await act(async () => {
        await result.current.send('After clear');
      });

      expect(recallScoped).toHaveBeenCalledTimes(2);
      const sessionIdBefore = recallScoped.mock.calls[0][2];
      const sessionIdAfter = recallScoped.mock.calls[1][2];
      expect(sessionIdBefore).toBeTruthy();
      expect(sessionIdAfter).toBeTruthy();
      expect(sessionIdAfter).not.toBe(sessionIdBefore);
    });

    it('uses a DIFFERENT sessionId after newChatSession starts a new conversation', async () => {
      const platformMod = await import('../lib/platform');
      const recallScoped = vi.fn().mockResolvedValue({
        injectedContext: '- some note',
        nodes: [{ id: 'n1', title: 'Note', snippet: 'text', score: 0.9 }],
        tokensSaved: 0,
      });
      (platformMod.getPlatform as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        name: 'tauri',
        brain: {
          recallScoped,
          startupContext: vi.fn().mockResolvedValue(''),
        },
      });

      const { result } = renderHook(() => useAssistantStore(), { wrapper });

      await act(async () => {
        await result.current.send('Before new session');
      });

      act(() => {
        result.current.newChatSession();
      });

      await act(async () => {
        await result.current.send('After new session');
      });

      expect(recallScoped).toHaveBeenCalledTimes(2);
      const sessionIdBefore = recallScoped.mock.calls[0][2];
      const sessionIdAfter = recallScoped.mock.calls[1][2];
      expect(sessionIdAfter).not.toBe(sessionIdBefore);
    });

    it('still completes a send with no error when the platform mock only implements the pre-existing 2-arg recallScoped shape', async () => {
      // Uses the module-level default mock (recallScoped(query, scope) —
      // no third param read) — proves the extra sessionId argument this
      // feature adds is purely additive and never required.
      const { result } = renderHook(() => useAssistantStore(), { wrapper });
      await act(async () => {
        await result.current.send('Plain send, default mock');
      });
      const assistantMsg = result.current.messages.find(m => m.role === 'assistant');
      expect(assistantMsg?.error).toBeFalsy();
    });
  });
});

// ── Structural brain tools advertised to the provider ──────────────────
// Now that the shared ReAct loop can actually FIRE the BRAIN_QUERY_CSS: and
// BRAIN_NEIGHBOURS: directives (brainSearchLoop.ts), the chat surface must
// advertise the two structural tools alongside brain_search so the model
// knows they are callable — not merely taught in prose.
describe('assistantStore — structural brain tools advertised', () => {
  it('passes brain_search + brain_query_css + brain_neighbours into streamChat when the brain is enabled', async () => {
    const mod = await import('../lib/models/index');
    let capturedReq: { tools?: Array<{ name: string }> } | undefined;
    (mod.getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      id: 'mock',
      label: 'Mock',
      listModels: () => mod.ALL_MODELS,
      // No streamChatEvents on this mock -> send() adapts streamChat, so the
      // req (with its tools list) flows through here and is captured.
      streamChat: (req: { tools?: Array<{ name: string }> }) => {
        capturedReq = req;
        return (async function* () {
          yield 'ok';
        })();
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    // Guard: the tools list is gated on brainEnabled — ensure it is on.
    if (!result.current.brainEnabled) {
      act(() => {
        result.current.toggleBrain();
      });
    }

    await act(async () => {
      await result.current.send('list every active decision');
    });

    const toolNames = (capturedReq?.tools ?? []).map(t => t.name);
    expect(toolNames).toContain('brain_search');
    expect(toolNames).toContain('brain_query_css');
    expect(toolNames).toContain('brain_neighbours');
  });

  it('passes assistant tools but no brain tools when the brain is disabled', async () => {
    const mod = await import('../lib/models/index');
    let capturedReq: { tools?: Array<{ name: string }> } | undefined;
    (mod.getProvider as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      id: 'mock',
      label: 'Mock',
      listModels: () => mod.ALL_MODELS,
      streamChat: (req: { tools?: Array<{ name: string }> }) => {
        capturedReq = req;
        return (async function* () {
          yield 'ok';
        })();
      },
    });

    const { result } = renderHook(() => useAssistantStore(), { wrapper });
    if (result.current.brainEnabled) {
      act(() => {
        result.current.toggleBrain();
      });
    }

    await act(async () => {
      await result.current.send('any question');
    });

    // Brain tools are gated on brainEnabled, but general assistant tools
    // (web_search, read_file, etc.) are always available.
    const toolNames = (capturedReq?.tools ?? []).map(t => t.name);
    expect(toolNames).not.toContain('brain_search');
    expect(toolNames).not.toContain('brain_query_css');
    expect(toolNames).toContain('web_search');
    expect(toolNames).toContain('read_file');
  });
});
