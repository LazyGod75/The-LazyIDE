import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { useAutoFix } from '../lib/ai/autoFix';
import { saveAccessSettings } from '../lib/models/accessSettings';
import { DEFAULT_MODEL, findModelById } from '../lib/models/registry';
import type { StreamChatRequest } from '../lib/models';
import { I18nProvider } from '../i18n';

// useAutoFix now calls useI18n() (2026-08 i18n wave — threads `t` into
// describeProviderReadiness/getProvider so their fallback copy translates
// instead of always rendering French) — every renderHook below needs an
// I18nProvider ancestor, same convention as agentsStoreCrossProjectRelaunch.test.ts.
function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(I18nProvider, null, children);
}

// getActiveModel() (DEFECT #1's fix) is left REAL via importOriginal — only
// provider selection is mocked, so these tests prove genuine dynamic
// resolution instead of a mocked pass-through.
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProvider: vi.fn(),
    describeProviderReadiness: vi.fn(() => ({ ready: true })),
  };
});

import { getProvider } from '../lib/models/index';

function mockStreamChat(capture: { request: StreamChatRequest | null }) {
  vi.mocked(getProvider).mockReturnValue({
    id: 'mock',
    label: 'Mock',
    listModels: () => [],
    streamChat: (req: StreamChatRequest) => {
      capture.request = req;
      return (async function* () {
        yield 'const y = 1;';
      })();
    },
  });
}

/** Wires a mock provider that streams an arbitrary raw response, so tests
 *  can simulate a fenced or narrated reply instead of the canned 'const y
 *  = 1;' chunk above. */
function mockStreamChatWithResponse(response: string, label = 'Claude Code (abonnement)') {
  vi.mocked(getProvider).mockReturnValue({
    id: 'claude-code',
    label,
    listModels: () => [],
    streamChat: () => (async function* () {
      yield response;
    })(),
  });
}

beforeEach(() => {
  localStorage.clear();
});

// autoFix.ts is the same latent bug as InlineEditBar.tsx (DEFECT #1's
// "sibling hardcode") — it hardcoded the same stale 'claude-sonnet-4-20250514'
// literal at autoFix.ts:36, breaking auto-fix identically under Claude Code CLI.

describe('useAutoFix — model resolution (DEFECT #1, sibling hardcode)', () => {
  it('sends the resolved active model to streamChat, not the stale hardcoded literal', async () => {
    const capture: { request: StreamChatRequest | null } = { request: null };
    mockStreamChat(capture);
    const { result } = renderHook(() => useAutoFix(), { wrapper });

    await act(async () => {
      await result.current.fixDiagnostic(
        "TS2304: Cannot find name 'x'",
        'foo.ts',
        'typescript',
        'const y = x;',
      );
    });

    expect(capture.request?.model).toEqual(DEFAULT_MODEL);
    expect(capture.request?.model.id).not.toBe('claude-sonnet-4-20250514');
  });

  it('honors a persisted model override instead of a hardcoded literal', async () => {
    saveAccessSettings({ model: 'claude-opus-5' });
    const capture: { request: StreamChatRequest | null } = { request: null };
    mockStreamChat(capture);
    const { result } = renderHook(() => useAutoFix(), { wrapper });

    await act(async () => {
      await result.current.fixDiagnostic(
        "TS2304: Cannot find name 'x'",
        'foo.ts',
        'typescript',
        'const y = x;',
      );
    });

    expect(capture.request?.model).toEqual(findModelById('claude-opus-5'));
  });

  it('returns the fix text from the (mocked) stream', async () => {
    const capture: { request: StreamChatRequest | null } = { request: null };
    mockStreamChat(capture);
    const { result } = renderHook(() => useAutoFix(), { wrapper });

    let fixResult: Awaited<ReturnType<typeof result.current.fixDiagnostic>> | undefined;
    await act(async () => {
      fixResult = await result.current.fixDiagnostic('err', 'foo.ts', 'typescript', 'const y = x;');
    });

    expect(fixResult?.fix).toBe('const y = 1;');
    expect(fixResult?.error).toBeNull();
  });
});

// ── HIGH DEFECT (sibling of InlineEditBar's): agentic narration ──────
// autoFix.ts shares InlineEditBar's exact contract — it treats the whole
// accumulated stream as literal replacement code — so it shared the same
// exposure to agentic narration under mode: 'edit'. Same fix: mode:
// 'transform' + sanitizeModelCodeOutput as a fail-safe gate. Unlike
// InlineEditBar, autoFix has no local diff preview of its own — its only
// caller (ProblemsPanel's "Fix" button) applies `result.fix` straight to
// the editor:applyEdit bus event when it is non-null — so returning
// `fix: null` here is what prevents the corruption, not a UI-level guard.

describe('useAutoFix — code-only output, not agentic narration (HIGH defect)', () => {
  it('sends mode "transform" (single-shot code transform), never the agentic "edit" mode', async () => {
    const capture: { request: StreamChatRequest | null } = { request: null };
    mockStreamChat(capture);
    const { result } = renderHook(() => useAutoFix(), { wrapper });

    await act(async () => {
      await result.current.fixDiagnostic("TS2304: Cannot find name 'x'", 'foo.ts', 'typescript', 'const y = x;');
    });

    expect(capture.request?.mode).toBe('transform');
  });

  it('unwraps a fenced code response before returning it as the fix', async () => {
    mockStreamChatWithResponse('```typescript\nconst y = 1;\n```');
    const { result } = renderHook(() => useAutoFix(), { wrapper });

    let fixResult: Awaited<ReturnType<typeof result.current.fixDiagnostic>> | undefined;
    await act(async () => {
      fixResult = await result.current.fixDiagnostic('err', 'foo.ts', 'typescript', 'const y = x;');
    });

    expect(fixResult?.fix).toBe('const y = 1;');
    expect(fixResult?.error).toBeNull();
  });

  it('REGRESSION: never returns agentic narration as the fix — fails safe with fix: null instead of corrupting the file', async () => {
    const narration = [
      '→ Read `foo.ts`',
      "I'll fix the undefined variable reference.",
      '→ Edit `foo.ts`',
      'Done. Defined `x` before use.',
    ].join('\n');
    mockStreamChatWithResponse(narration);
    const { result } = renderHook(() => useAutoFix(), { wrapper });

    let fixResult: Awaited<ReturnType<typeof result.current.fixDiagnostic>> | undefined;
    await act(async () => {
      fixResult = await result.current.fixDiagnostic("TS2304: Cannot find name 'x'", 'foo.ts', 'typescript', 'const y = x;');
    });

    // ProblemsPanel only emits editor:applyEdit when result.fix is truthy —
    // fix: null is what stops the narration from ever reaching the file.
    expect(fixResult?.fix).toBeNull();
    expect(fixResult?.error).toMatch(/narration|explanation/i);
    expect(fixResult?.error).toContain('Claude Code (abonnement)');
  });
});
