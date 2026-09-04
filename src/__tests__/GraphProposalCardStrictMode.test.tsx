/**
 * GraphProposalCardStrictMode.test.tsx — 2026-08 second verification pass
 * (see GraphProposalCard.tsx's own top header and
 * previewLayoutWorkerClient.ts's `getOrComputeCachedPreviewLayout` doc
 * comment). The founder's own CDP probe showed `layoutPreviewGraph`
 * resolving in ~20ms for a proposal whose CARD stayed permanently stuck on
 * the watchdog banner. The working hypothesis was that React StrictMode's
 * dev-only double effect invoke (mount -> cleanup -> mount again,
 * synchronously) caused the signature cache to hand a superseded/cancelled
 * caller's in-flight promise to a later identical request, poisoning it.
 *
 * This suite is the test that would have caught the underlying class of
 * bug regardless of whether StrictMode double-invoke turns out to be the
 * PRECISE trigger: GraphProposalCard.test.tsx's existing suite never
 * mounts under `<StrictMode>` and never simulates a real asynchronous
 * (message-passing) worker, so it could pass while the real app hangs
 * (jsdom has no `Worker` — see elkWorkerBundling files' own headers — every
 * existing test therefore takes the synchronous, effectively-instant
 * fallback path, which never exercises the multi-effect-invocation timing
 * this bug lives in). This file forces BOTH: real `<StrictMode>` AND a
 * genuinely asynchronous (setTimeout-based) worker stand-in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { GraphProposalCard } from '../components/lazyManager/GraphProposalCard';
import type { ManagerMessage } from '../lib/agents/types';
import { _resetPreviewLayoutClientForTests } from '../components/agents/canvas/previewLayoutWorkerClient';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return { ...actual, getProviderMode: vi.fn(() => 'pro') };
});

beforeEach(async () => {
  // elk-worker.min.js's own exported `Worker` (module id 2 in
  // elk.bundled.js too — see elkLayoutWorker.ts's header) is a
  // self-contained, GENUINELY ASYNCHRONOUS (real `setTimeout(fn, 0)`,
  // never synchronous) in-process worker simulation — using it as
  // global.Worker forces layout.ts's `layoutPreviewGraph` down the REAL
  // worker code path with REAL async message-passing timing, instead of
  // jsdom's usual "no Worker at all" instant-synchronous-fallback path
  // every other GraphProposalCard test takes (which never reproduces this
  // class of timing bug).
  try { _resetPreviewLayoutClientForTests(); } catch { /* the fake worker has no .terminate() */ }
  const workerModule = await import('elkjs/lib/elk-worker.min.js');
  const FakeWorkerCtor = (workerModule as unknown as { Worker: typeof Worker }).Worker;
  vi.stubGlobal('Worker', FakeWorkerCtor);
});

afterEach(() => {
  vi.unstubAllGlobals();
  try { _resetPreviewLayoutClientForTests(); } catch { /* the fake worker has no .terminate() */ }
});

function makeProposalMessage(stepCount = 12): ManagerMessage {
  return {
    id: 'msg-strict',
    role: 'assistant',
    content: 'Here is a plan.',
    timestamp: new Date().toISOString(),
    proposal: {
      state: 'pending',
      planId: 'orch-strict',
      objective: 'A real-sized plan',
      steps: Array.from({ length: stepCount }, (_, i) => ({ description: `Step ${i + 1}` })),
    },
  };
}

describe('GraphProposalCard under React.StrictMode (dev-only double effect invoke)', () => {
  it('resolves the real layout and never shows the degraded banner, with a real async worker and StrictMode double-mount', async () => {
    const msg = makeProposalMessage();
    render(
      <React.StrictMode>
        <I18nProvider>
          <GraphProposalCard msg={msg} onAccept={vi.fn()} onReject={vi.fn()} />
        </I18nProvider>
      </React.StrictMode>,
    );

    // The real regression: this must resolve well within a normal test
    // timeout — a poisoned cache entry would hang here until the SUITE's
    // own timeout, not layout.ts's internal bounds, because nothing would
    // ever settle the awaited promise at all.
    const svg = await screen.findByTestId('graph-proposal-minigraph', {}, { timeout: 3000 });
    expect(svg).toBeInTheDocument();
    expect(screen.queryByTestId('graph-proposal-layout-degraded')).not.toBeInTheDocument();
    // Every plan step actually laid out — not a partial/degenerate result.
    for (let i = 0; i < 12; i++) {
      expect(screen.getByTestId(`graph-proposal-node-${i}`)).toBeInTheDocument();
    }
  });

  it('two SEPARATE cards for the identical proposal shape (same signature) both resolve independently — no cross-contamination via the shared cache', async () => {
    const msgA = makeProposalMessage(5);
    const msgB = { ...makeProposalMessage(5), id: 'msg-strict-b', proposal: { ...makeProposalMessage(5).proposal! } };

    render(
      <React.StrictMode>
        <I18nProvider>
          <div>
            <GraphProposalCard msg={msgA} onAccept={vi.fn()} onReject={vi.fn()} />
            <GraphProposalCard msg={msgB} onAccept={vi.fn()} onReject={vi.fn()} />
          </div>
        </I18nProvider>
      </React.StrictMode>,
    );

    const svgs = await screen.findAllByTestId('graph-proposal-minigraph', {}, { timeout: 3000 });
    expect(svgs).toHaveLength(2);
    expect(screen.queryByTestId('graph-proposal-layout-degraded')).not.toBeInTheDocument();
  });
});
