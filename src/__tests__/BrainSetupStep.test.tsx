/**
 * BrainSetupStep.test.tsx
 *
 * Regression coverage for the NON-BLOCKING onboarding fix (owner directive):
 * once "Lancer l'import" is clicked, the user must be able to continue
 * immediately — the brain build keeps running in the background, tracked by
 * the shared seedProgressStore (src/lib/brain/seedProgressStore.ts), and
 * this step's own unmount must never abandon or otherwise disturb that
 * background run (previously, the "Continuer" button stayed disabled for
 * the WHOLE import — sometimes 40+ minutes — because progress was only
 * observable through a subscription tied to this component's own lifetime).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/locales/en';
import { BrainSetupStep } from '../components/onboarding/steps/BrainSetupStep';
import {
  getSeedProgressState,
  initSeedProgressListener,
  resetSeedProgressForTests,
} from '../lib/brain/seedProgressStore';
import type { HistorySource, SeedEstimate } from '../lib/platform/types';

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: vi.fn(),
  };
});

import { getPlatform } from '../lib/platform';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

const ONE_SOURCE: HistorySource[] = [
  { source: 'claude-code', label: 'Claude Code conversations', available: true, itemCount: 1800 },
];

const ESTIMATE: SeedEstimate = {
  items: 1800,
  estTokens: 500_000,
  estMinutes: 12,
  backend: 'Claude Code CLI',
  llmAvailable: true,
};

type SeedProgressCallback = (p: Record<string, unknown>) => void;

/** Mirrors seedProgressStore.test.ts's mock platform helper: captures the
    onSeedProgress callback so tests can simulate backend events, and lets
    the caller control exactly when seedBrain()'s promise settles. */
function makeMockPlatform() {
  let capturedCb: SeedProgressCallback | null = null;
  const onSeedProgress = vi.fn((cb: SeedProgressCallback) => {
    capturedCb = cb;
    return vi.fn(); // unlisten
  });

  let resolveSeed: (v: { imported: number; skipped: number }) => void = () => {};
  const seedBrainPromise = new Promise<{ imported: number; skipped: number }>((resolve) => {
    resolveSeed = resolve;
  });
  const seedBrain = vi.fn().mockReturnValue(seedBrainPromise);

  const platform = {
    name: 'tauri',
    brain: {
      detectHistorySources: vi.fn().mockResolvedValue(ONE_SOURCE),
      seedEstimate: vi.fn().mockResolvedValue(ESTIMATE),
      seedBrain,
      onSeedProgress,
    },
  };

  return {
    platform,
    resolveSeed,
    emit: (payload: Record<string, unknown>) => {
      expect(capturedCb).not.toBeNull();
      capturedCb!(payload);
    },
  };
}

function renderStep(onNext = vi.fn(), onBack = vi.fn()) {
  localStorage.setItem('lazy.locale', 'en');
  const view = render(
    <I18nProvider>
      <BrainSetupStep onNext={onNext} onBack={onBack} />
    </I18nProvider>,
  );
  return { onNext, onBack, ...view };
}

/** Drives the step from mount through to "Lancer l'import" clicked —
    auto-detect preselects "seed" (ONE_SOURCE has itemCount > 0), then
    estimate, then confirm. Returns once the seeding view is showing. */
async function driveToSeeding() {
  await screen.findByText(en['onboarding.brain.estimateCost']);
  fireEvent.click(screen.getByRole('button', { name: en['onboarding.brain.estimateCost'] }));
  await screen.findByText(en['onboarding.brain.startImport']);
  fireEvent.click(screen.getByRole('button', { name: en['onboarding.brain.startImport'] }));
  await screen.findByText(en['onboarding.brain.backgroundNote']);
}

beforeEach(() => {
  resetSeedProgressForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('BrainSetupStep — non-blocking seed (owner directive)', () => {
  it('keeps the Continue button enabled while a seed is actively running', async () => {
    const { platform } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();
    renderStep();

    await driveToSeeding();

    const continueBtn = screen.getByRole('button', { name: en['onboarding.model.continue'] });
    expect(continueBtn).not.toBeDisabled();
  });

  it('shows the explicit background-build note once seeding starts', async () => {
    const { platform } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();
    renderStep();

    await driveToSeeding();

    expect(screen.getByText(en['onboarding.brain.backgroundNote'])).toBeInTheDocument();
  });

  it('clicking Continue while the seed is still active calls onNext immediately (does not wait for completion)', async () => {
    const { platform } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();
    const { onNext } = renderStep();

    await driveToSeeding();

    fireEvent.click(screen.getByRole('button', { name: en['onboarding.model.continue'] }));
    expect(onNext).toHaveBeenCalledTimes(1);

    // The seed itself is still unsettled at this point — proves onNext did
    // not implicitly wait for it.
    expect(getSeedProgressState().active).toBe(true);
  });

  it('reflects live progress events from the shared store while this step stays mounted', async () => {
    const { platform, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();
    renderStep();

    await driveToSeeding();

    act(() => {
      emit({ done: 0, total: 1, phase: 'import', message: 'Importing from claude-code', percent: 37 });
    });

    await waitFor(() => {
      expect(screen.getByText('37% · 0 / 1')).toBeInTheDocument();
    });
  });

  it('unmounting this step does NOT cancel the running seed — the shared store keeps tracking it to completion', async () => {
    const { platform, resolveSeed, emit } = makeMockPlatform();
    mockGetPlatform.mockReturnValue(platform);
    initSeedProgressListener();
    const { unmount } = renderStep();

    await driveToSeeding();
    expect(getSeedProgressState().active).toBe(true);

    // Simulate the onboarding modal closing / navigating away.
    unmount();

    // The backend keeps running regardless — simulate its remaining events
    // and final resolution arriving AFTER this component is gone.
    emit({ done: 1, total: 1, phase: 'import', percent: 90 });
    emit({
      done: 3, total: 3, phase: 'done', percent: 100,
      imported: 1800, skipped: 12, notesTotal: 1812, served: true,
    });
    resolveSeed({ imported: 1800, skipped: 12 });

    await waitFor(() => {
      const s = getSeedProgressState();
      expect(s.active).toBe(false);
      expect(s.result).toEqual({ imported: 1800, skipped: 12 });
    });
    // No throw / no unhandled rejection reaching the test — the whole point
    // of this test is that none of the above blows up post-unmount.
  });
});
