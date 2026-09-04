/* SeedProgress — shared brain "seed from history" progress UI
   (src/components/brain/SeedProgress.tsx), used by both onboarding's
   BrainSetupStep and Settings' MemoryPanel (HistoryReimportSection).

   Regression coverage for the "il se passe rien" (feels like nothing is
   happening) UX bug: the running view must render an obvious animated
   indicator + a real percentage/fraction + a phase-specific label, the done
   view must show a clear success state with a next-action button, and the
   error view must offer a retry — none of which the previous plain-text
   renders provided.
*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/locales/en';
import { SeedProgress } from '../components/brain/SeedProgress';
import type { SeedProgressEvent } from '../lib/platform/types';

function renderWithI18n(ui: React.ReactElement) {
  localStorage.setItem('lazy.locale', 'en');
  return render(<I18nProvider>{ui}</I18nProvider>);
}

/** Installs a window.matchMedia mock reporting the given
    prefers-reduced-motion state — jsdom has no built-in implementation. */
function mockPrefersReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error — jsdom has no native matchMedia; drop the per-test mock.
  delete window.matchMedia;
});

describe('SeedProgress — running state', () => {
  it('renders immediately with no progress data yet (instant feedback on click)', async () => {
    renderWithI18n(<SeedProgress status="running" progress={null} />);
    expect(await screen.findByText(en['onboarding.brain.importing'])).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows the "starting" phase label', async () => {
    const progress: SeedProgressEvent = { done: 0, total: 2, phase: 'starting' };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    expect(await screen.findByText(en['brain.seedProgress.phase.starting'])).toBeInTheDocument();
  });

  it('shows the "import" phase label plus percentage and done/total fraction', async () => {
    const progress: SeedProgressEvent = { done: 1, total: 2, phase: 'import', message: 'Importing from claude-code' };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    expect(await screen.findByText(en['brain.seedProgress.phase.import'])).toBeInTheDocument();
    expect(screen.getByText('50% · 1 / 2')).toBeInTheDocument();
    expect(screen.getByText('Importing from claude-code')).toBeInTheDocument();
  });

  it('shows the backend phase label with its raw backend message', async () => {
    const progress: SeedProgressEvent = { done: 0, total: 2, phase: 'backend', message: 'LLM backend: Claude Code CLI' };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    expect(await screen.findByText(en['brain.seedProgress.phase.backend'])).toBeInTheDocument();
    expect(screen.getByText('LLM backend: Claude Code CLI')).toBeInTheDocument();
  });

  it('shows a non-fatal per-source error inline without leaving the running view', async () => {
    const progress: SeedProgressEvent = { done: 1, total: 2, phase: 'error', message: 'import exited 1 for source cursor' };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    expect(await screen.findByText(en['brain.seedProgress.phase.sourceError'])).toBeInTheDocument();
    // Still the running card (role="status"), not the terminal error card (role="alert").
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the "indexing" post-seed phase label (step 1/3, re-based done/total)', async () => {
    const progress: SeedProgressEvent = { done: 0, total: 3, phase: 'indexing', message: 'Indexing imported notes' };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    expect(await screen.findByText(en['brain.seedProgress.phase.indexing'])).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows the "synthesizing" and "serving" post-seed phase labels', async () => {
    const synthesizing: SeedProgressEvent = { done: 1, total: 3, phase: 'synthesizing' };
    const { rerender } = renderWithI18n(<SeedProgress status="running" progress={synthesizing} />);
    expect(await screen.findByText(en['brain.seedProgress.phase.synthesizing'])).toBeInTheDocument();

    const serving: SeedProgressEvent = { done: 2, total: 3, phase: 'serving' };
    rerender(<I18nProvider><SeedProgress status="running" progress={serving} /></I18nProvider>);
    expect(await screen.findByText(en['brain.seedProgress.phase.serving'])).toBeInTheDocument();
  });

  // New post-seed pipeline steps (done/total re-based 0..5: indexing=0,
  // synthesizing=1, linking=2, scoring=3, serving=4, done=5/5) — inserted
  // between synthesizing and serving.
  it('shows the "linking" and "scoring" post-seed phase labels', async () => {
    const linking: SeedProgressEvent = { done: 2, total: 5, phase: 'linking' };
    const { rerender } = renderWithI18n(<SeedProgress status="running" progress={linking} />);
    expect(await screen.findByText(en['brain.seedProgress.phase.linking'])).toBeInTheDocument();

    const scoring: SeedProgressEvent = { done: 3, total: 5, phase: 'scoring' };
    rerender(<I18nProvider><SeedProgress status="running" progress={scoring} /></I18nProvider>);
    expect(await screen.findByText(en['brain.seedProgress.phase.scoring'])).toBeInTheDocument();
  });

  it('does not jump the progress bar/fraction from the import phase\'s source-count scale to the post-seed 3-step scale (indeterminate "…" instead of a re-based percentage) when the event carries no real percent', async () => {
    const progress: SeedProgressEvent = { done: 1, total: 3, phase: 'synthesizing' };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    await screen.findByText(en['brain.seedProgress.phase.synthesizing']);
    expect(screen.queryByText('33% · 1 / 3')).toBeNull();
    expect(screen.getByText('…')).toBeInTheDocument();
  });

  // Regression coverage for the whole-pipeline `percent` field (added
  // alongside the dead-events fix — see history_import.rs's
  // emit_seed_progress/import_phase_percent): once the backend provides a
  // real weighted percent, it must be shown CONTINUOUSLY across import AND
  // the post-seed pipeline, replacing both the naive done/total ratio and
  // the old indeterminate "…" fallback above.

  type WithPercent = SeedProgressEvent & { percent: number };

  it('prefers the backend-computed percent over the naive done/total ratio during the import phase', async () => {
    const progress: WithPercent = { done: 1, total: 2, phase: 'import', message: 'Importing from cursor', percent: 78 };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    await screen.findByText(en['brain.seedProgress.phase.import']);
    // Naive done/total would say 50% — the weighted backend value (78%) wins.
    expect(screen.queryByText('50% · 1 / 2')).toBeNull();
    expect(screen.getByText('78% · 1 / 2')).toBeInTheDocument();
  });

  it('shows the real percent during a post-seed pipeline phase instead of the indeterminate shimmer, once the event carries one', async () => {
    const progress: WithPercent = { done: 1, total: 3, phase: 'synthesizing', percent: 94 };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    await screen.findByText(en['brain.seedProgress.phase.synthesizing']);
    expect(screen.queryByText('…')).toBeNull();
    expect(screen.getByText('94%')).toBeInTheDocument();
  });

  it('renders percent-only (no done/total fraction) for post-seed phases even with a real percent — the 0..5 step count is not meaningful to show', async () => {
    const progress: WithPercent = { done: 2, total: 3, phase: 'serving', percent: 97 };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    await screen.findByText(en['brain.seedProgress.phase.serving']);
    expect(screen.queryByText('97% · 2 / 3')).toBeNull();
    expect(screen.getByText('97%')).toBeInTheDocument();
  });

  it('renders percent-only (no done/total fraction) for the new "linking" and "scoring" post-seed phases too', async () => {
    const linking: WithPercent = { done: 2, total: 5, phase: 'linking', percent: 55 };
    const { rerender } = renderWithI18n(<SeedProgress status="running" progress={linking} />);
    await screen.findByText(en['brain.seedProgress.phase.linking']);
    expect(screen.queryByText('55% · 2 / 5')).toBeNull();
    expect(screen.getByText('55%')).toBeInTheDocument();

    const scoring: WithPercent = { done: 3, total: 5, phase: 'scoring', percent: 68 };
    rerender(<I18nProvider><SeedProgress status="running" progress={scoring} /></I18nProvider>);
    await screen.findByText(en['brain.seedProgress.phase.scoring']);
    expect(screen.queryByText('68% · 3 / 5')).toBeNull();
    expect(screen.getByText('68%')).toBeInTheDocument();
  });

  it('"complete" stays in the running view instead of jumping to the success state — it is a mid-pipeline label, not the finish line', async () => {
    const progress: SeedProgressEvent = { done: 0, total: 3, phase: 'complete' };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    expect(await screen.findByText(en['brain.seedProgress.phase.complete'])).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(en['onboarding.brain.importComplete'])).toBeNull();
  });

  it('renders a Cancel button only when onCancel is provided, and calls it on click', async () => {
    const onCancel = vi.fn();
    const progress: SeedProgressEvent = { done: 0, total: 1, phase: 'starting' };
    renderWithI18n(<SeedProgress status="running" progress={progress} onCancel={onCancel} />);
    const cancelBtn = await screen.findByRole('button', { name: en['onboarding.brain.cancel'] });
    fireEvent.click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders no Cancel button when onCancel is omitted (Settings reimport has no cancellation)', async () => {
    const progress: SeedProgressEvent = { done: 0, total: 1, phase: 'starting' };
    renderWithI18n(<SeedProgress status="running" progress={progress} />);
    await screen.findByText(en['brain.seedProgress.phase.starting']);
    expect(screen.queryByRole('button', { name: en['onboarding.brain.cancel'] })).toBeNull();
  });

  it('uses a spinning indicator by default (no reduced-motion preference)', async () => {
    mockPrefersReducedMotion(false);
    const progress: SeedProgressEvent = { done: 0, total: 1, phase: 'starting' };
    const { container } = renderWithI18n(<SeedProgress status="running" progress={progress} />);
    await screen.findByText(en['brain.seedProgress.phase.starting']);
    const spinner = container.querySelector('span[aria-hidden="true"]') as HTMLElement | null;
    expect(spinner?.style.animation ?? '').toContain('spin');
  });

  it('replaces the spinner with a static pulse when prefers-reduced-motion is set', async () => {
    mockPrefersReducedMotion(true);
    const progress: SeedProgressEvent = { done: 0, total: 1, phase: 'starting' };
    const { container } = renderWithI18n(<SeedProgress status="running" progress={progress} />);
    await screen.findByText(en['brain.seedProgress.phase.starting']);
    const spinner = container.querySelector('span[aria-hidden="true"]') as HTMLElement | null;
    expect(spinner?.style.animation ?? '').toContain('lm-pulse');
    expect(spinner?.style.animation ?? '').not.toContain('spin ');
  });
});

describe('SeedProgress — done state', () => {
  it('shows the success state once status is "done" — the real finish line, reached after the post-seed pipeline\'s "done" event', async () => {
    const progress: SeedProgressEvent = { done: 3, total: 3, phase: 'done', message: 'Imported 5 notes (1 skipped) — 6 notes in brain' };
    renderWithI18n(
      <SeedProgress status="done" progress={progress} result={{ imported: 5, skipped: 1 }} />,
    );
    expect(await screen.findByText(en['onboarding.brain.importComplete'])).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the success title and the import result with the real counts', async () => {
    renderWithI18n(
      <SeedProgress status="done" progress={null} result={{ imported: 42, skipped: 3 }} />,
    );
    expect(await screen.findByText(en['onboarding.brain.importComplete'])).toBeInTheDocument();
    expect(screen.getByText('42 conversations imported, 3 skipped (already present). Your Brain is ready.')).toBeInTheDocument();
  });

  it('renders the caller-supplied next-action button and calls onDone on click', async () => {
    const onDone = vi.fn();
    renderWithI18n(
      <SeedProgress
        status="done"
        progress={null}
        result={{ imported: 1, skipped: 0 }}
        onDone={onDone}
        doneLabel="Continue"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('renders no button when onDone/doneLabel are omitted', async () => {
    renderWithI18n(<SeedProgress status="done" progress={null} result={{ imported: 1, skipped: 0 }} />);
    await screen.findByText(en['onboarding.brain.importComplete']);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('SeedProgress — error state', () => {
  it('shows the error title and the raw error message', async () => {
    renderWithI18n(
      <SeedProgress status="error" progress={null} errorMessage="Detection failed: ENOENT" />,
    );
    expect(await screen.findByText(en['brain.seedProgress.error.title'])).toBeInTheDocument();
    expect(screen.getByText('Detection failed: ENOENT')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders Retry and Close buttons and calls the right handler for each', async () => {
    const onRetry = vi.fn();
    const onDone = vi.fn();
    renderWithI18n(
      <SeedProgress
        status="error"
        progress={null}
        errorMessage="boom"
        onRetry={onRetry}
        onDone={onDone}
        doneLabel="Close"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: en['onboarding.brain.tryAgain'] }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
