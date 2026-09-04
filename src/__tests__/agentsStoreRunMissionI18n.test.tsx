/**
 * agentsStoreRunMissionI18n.test.tsx
 *
 * Regression test for a real runtime bug (verified live in the app,
 * 2026-08-07): every mission action string in runtime.ts's action feed
 * (`t ? t('agents.runtime.worktreeReady') : 'Worktree prêt — démarrage du
 * loop…'`, and ~50 siblings) silently fell back to hardcoded French even
 * with the app locale set to English. The `t` plumbing existed end-to-end
 * (RunOptions.t, runtime.ts's own fallback logic, useI18n() already called
 * inside AgentsStoreProvider) — but NONE of the `runMission(...)` call
 * sites in this file actually passed `t` into the options object, so
 * `opts.t` was always `undefined` at runtime and every translated branch
 * took its French fallback.
 *
 * Existing tests (runtimeBaseBranch.test.ts, runtimeEvalDiff.test.ts, ...)
 * call `runMission` DIRECTLY WITH a `t`, so they exercise runtime.ts's own
 * translation logic just fine and never touched this gap. Nothing exercised
 * the REAL call path (AgentsStoreProvider -> runMission), which is exactly
 * what left this broken in the running app while the test suite stayed
 * green.
 *
 * Two independent guards:
 *   1. Static — every `runMission(...)` call site's options object literal
 *      in agentsStore.tsx source must include a `t` property. Cheap, exact,
 *      and catches a new call site the moment it's added without `t` —
 *      exactly the class of change that caused this bug.
 *   2. Live — actually renders AgentsStoreProvider with a real English
 *      I18nProvider, launches a mission through the real addMission path,
 *      and asserts the `t` the mocked runMission received is the REAL
 *      English translator (not undefined, not the French fallback) by
 *      checking it resolves a known key to the real `en` dictionary string.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runMission } from '../lib/agents/runtime';
import { en } from '../i18n/locales/en';
import { fr } from '../i18n/locales/fr';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../lib/agents/actionGate', () => ({
  evaluateActionGate: vi.fn(async () => ({ decision: 'allow', reason: 'test mock' })),
  evaluateActionGateSync: vi.fn(() => ({ decision: 'allow', reason: 'test mock' })),
}));

const mockedRunMission = vi.mocked(runMission);

// ── Guard 1: static source scan ──────────────────────────────────────────

/** Extracts the balanced-brace options-object literal that follows a
 *  `runMission(<mission>, <root>, {` call, starting at the index of the
 *  FIRST `{` at or after `fromIndex`. Returns the substring between (and
 *  including) that `{` and its matching `}`. */
function extractOptionsObject(src: string, fromIndex: number): string {
  const openIdx = src.indexOf('{', fromIndex);
  if (openIdx === -1) throw new Error('no options object found');
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

describe('agentsStore.tsx — every runMission(...) call site passes t', () => {
  const srcPath = path.resolve(__dirname, '../components/agents/agentsStore.tsx');
  const src = readFileSync(srcPath, 'utf8');

  // Every real call (not the doc-comment mention on the `runMission(...)`
  // line, which is prose, not a call — filtered out by requiring the
  // opening paren to be immediately followed eventually by a `{`
  // options-object within a short window, and by skipping lines that are
  // clearly comments).
  const callSites: number[] = [];
  const re = /runMission\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index));
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue; // doc comment
    callSites.push(m.index);
  }

  it('finds the expected number of real runMission(...) call sites (sanity check on the scan itself)', () => {
    // Pinned count so this test file itself is a tripwire: a NEW call site
    // added without updating this test forces a deliberate look here rather
    // than silently passing (or silently failing to scan the new site).
    expect(callSites.length).toBe(6);
  });

  it('every call site\'s options object includes a `t` property', () => {
    const missing: string[] = [];
    for (const idx of callSites) {
      const optsObj = extractOptionsObject(src, idx);
      // Matches the shorthand `t,` / `t: someExpr` property — deliberately
      // loose (word-boundary `t` immediately followed by `,` or `:`) since
      // every real call site here uses either bare shorthand `t,` or
      // `t: tRef.current,`.
      const hasT = /(^|[^a-zA-Z0-9_.])t\s*[,:]/.test(optsObj);
      if (!hasT) {
        const lineNo = src.slice(0, idx).split('\n').length;
        missing.push(`line ${lineNo}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ── Guard 2: live end-to-end proof ───────────────────────────────────────

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

describe('agentsStore — addMission threads the REAL locale-aware t into runMission', () => {
  it('runMission is called with a t that resolves to the English dictionary, not French, not undefined', async () => {
    localStorage.setItem('lazy.locale', 'en');
    mockedRunMission.mockClear();

    const { result } = renderHook(() => useAgentsStore(), { wrapper });

    await act(async () => {
      await result.current.addMission({
        title: 'Test mission',
        agentTask: 'do the thing',
        repo: '.',
        worktree: '',
        modelLabel: 'sonnet',
        orchestrator: false,
      });
    });

    expect(mockedRunMission).toHaveBeenCalled();
    const opts = mockedRunMission.mock.calls[0][2];
    expect(opts.t).toBeTypeOf('function');

    // The exact bug: `liveAction: t ? t('agents.runtime.worktreeReady') : '<French fallback>'`
    // in runtime.ts. Prove the threaded `t` is the REAL en translator, not
    // absent (which would silently take the French fallback) and not stuck
    // on French regardless of locale.
    const translated = opts.t!('agents.runtime.worktreeReady');
    expect(translated).toBe(en['agents.runtime.worktreeReady']);
    expect(translated).not.toBe(fr['agents.runtime.worktreeReady']);

    localStorage.removeItem('lazy.locale');
  });
});
