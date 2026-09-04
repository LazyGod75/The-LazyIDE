/**
 * MissionManagerAdviceLocale.test.tsx
 *
 * Regression test for a real gap found while investigating a live language
 * bug (2026-08-07/08): LazyManager's own chat path (agentsStore.tsx's main
 * sendManagerMessage handler) DOES thread `locale` into every
 * `runManagerTurn({ context: ... })` call — traced and confirmed correct.
 * But MissionManagerAdvice.tsx's own DIRECT `runManagerTurn` call (the
 * "Avis du manager" card, D13 graft (a) — see its own module doc comment)
 * used to build `context: { agents: [], missions: [mission] }` with no
 * `locale` at all, even though `useI18n()` was already called at the top of
 * the component for `t`. Same bug SHAPE as agentsStoreRunMissionI18n.test.tsx's
 * `t`-not-threaded-into-runMission regression: an optional field nothing on
 * this call path ever actually populated, so the LANGUAGE rule's fallback
 * (managerEngine.ts) always saw `locale: undefined` for this specific
 * card's advice call regardless of the app's real UI language.
 *
 * Two guards, same convention as agentsStoreRunMissionI18n.test.tsx:
 *   1. Static — the source's runManagerTurn call site must include a
 *      `locale` property in its context object literal.
 *   2. Live — renders the real component with a real (mocked) English
 *      useI18n() locale and asserts the actual runManagerTurn mock call
 *      received `context.locale === 'en'`.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { render, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MissionManagerAdvice } from '../components/agents/MissionManagerAdvice';
import { runManagerTurn } from '../lib/agents/managerEngine';
import type { Mission } from '../lib/agents/types';

vi.mock('../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en', setLocale: vi.fn(), LOCALES: [] }),
}));

vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStore: () => ({
    managerModel: 'sonnet',
    interveneMission: vi.fn(),
    updateMission: vi.fn(),
    retryMission: vi.fn(),
  }),
}));

vi.mock('../components/agents/approveGate', () => ({
  isJudgeRejected: () => false,
}));

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  // managerAdvice.ts's buildManagerAdvicePrompt imports formatMissionDetail
  // from this SAME module — a bare `{ runManagerTurn: vi.fn() }` mock (no
  // importOriginal) would silently break that unrelated export too, so
  // preserve everything else real, same convention as
  // agentsStoreRunMissionI18n.test.tsx's runtime.ts mock.
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn().mockResolvedValue({ responseText: 'Plan alternatif : retry with more context.', actions: [] }),
  };
});

const mockedRunManagerTurn = vi.mocked(runManagerTurn);

function makeFailedMission(): Mission {
  return {
    id: 'm1',
    title: 'Fix the pricing table',
    status: 'failed',
    model: 'sonnet',
  } as Mission;
}

describe('MissionManagerAdvice.tsx — source always threads locale into runManagerTurn', () => {
  const srcPath = path.resolve(__dirname, '../components/agents/MissionManagerAdvice.tsx');
  const src = readFileSync(srcPath, 'utf8');

  it('the runManagerTurn(...) context object literal includes a `locale` property', () => {
    const callIdx = src.indexOf('runManagerTurn({');
    expect(callIdx).toBeGreaterThan(-1);
    const contextIdx = src.indexOf('context:', callIdx);
    expect(contextIdx).toBeGreaterThan(-1);
    const contextLineEnd = src.indexOf('\n', contextIdx);
    // The context object here is a single-line literal
    // (`{ agents: [], missions: [mission], locale }`) — scoped narrowly on
    // purpose so this stays a tight, exact tripwire.
    const contextSlice = src.slice(contextIdx, contextLineEnd);
    expect(contextSlice).toMatch(/(^|[^a-zA-Z0-9_.])locale(\s*[,}]|\s*:)/);
  });
});

describe('MissionManagerAdvice — live: the REAL English locale reaches runManagerTurn', () => {
  it('clicking "Ask" calls runManagerTurn with context.locale === "en", not undefined', async () => {
    mockedRunManagerTurn.mockClear();
    const mission = makeFailedMission();
    const { getByTestId } = render(<MissionManagerAdvice mission={mission} />);

    fireEvent.click(getByTestId('manager-advice-ask-btn'));

    await waitFor(() => expect(mockedRunManagerTurn).toHaveBeenCalled());
    const call = mockedRunManagerTurn.mock.calls[0][0];
    expect(call.context?.locale).toBe('en');
    expect(call.context?.locale).not.toBeUndefined();
  });
});
