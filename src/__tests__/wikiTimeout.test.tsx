/**
 * wikiTimeout.test.tsx
 *
 * v0.1.5 W2.7 — the Brain Wiki can no longer hang forever. A hung bridge
 * (tree()/synthesisIndex() promises that never settle) must flip the tab to
 * an honest timeout state (EmptyState + "Réessayer") instead of spinning on
 * the loading state indefinitely. Retry re-runs the base load and renders
 * normally once the bridge answers.
 *
 * W2.10 — tree()/synthesisIndex() are now timed out independently
 * (SIDECAR_TIMEOUT_MS = 30s each, see WikiTab.tsx) and a first total failure
 * where at least one side genuinely timed out gets ONE bounded automatic
 * retry (AUTO_RETRY_DELAY_MS = 4s) before the honest timeout state shows —
 * a cold sidecar's tree build often finishes moments after the client gives
 * up. A never-resolving bridge exercises both hops: first 30s timeout,
 * then the 4s retry delay, then a second 30s timeout before giving up.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { WikiTab } from '../components/brain/WikiTab';
import { fr } from '../i18n/locales/fr';

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, getPlatform: vi.fn() };
});

import { getPlatform } from '../lib/platform';
import type { Brain } from '../lib/platform/types';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

const never = () => new Promise<never>(() => {});

const INDEX = {
  html:
    '<article data-cerveau-type="brain-index"><header class="wiki-header">' +
    '<h1>Demo brain recovered</h1></header></article>',
  pages: [],
};

function makePlatform(overrides: Record<string, unknown> = {}) {
  return {
    name: 'web',
    brain: {
      tree: vi.fn<Brain['tree']>(never),
      synthesisIndex: vi.fn<Brain['synthesisIndex']>(never),
      synthesisTopic: vi.fn<Brain['synthesisTopic']>(never),
      note: vi.fn<Brain['note']>(never),
      ...overrides,
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WikiTab — timeout honesty', () => {
  it('never-resolving bridge -> stays quiet through the bounded auto-retry, then shows the timeout state', async () => {
    mockGetPlatform.mockReturnValue(makePlatform());

    render(
      <I18nProvider>
        <WikiTab />
      </I18nProvider>,
    );

    expect(screen.queryByText(fr['brain.wikiTimeoutTitle'])).not.toBeInTheDocument();

    // First attempt: both calls are still hanging past their own 30s budget.
    // That alone must not surface the honest-failure UI yet — a bounded
    // auto-retry is scheduled first (the whole point of the fix: a cold
    // sidecar often answers moments later).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100);
    });
    expect(screen.queryByText(fr['brain.wikiTimeoutTitle'])).not.toBeInTheDocument();

    // Retry delay elapses and the retried attempt also hangs past its own
    // 30s budget -> only now does the honest timeout state show.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100 + 30_100);
    });

    expect(screen.getByText(fr['brain.wikiTimeoutTitle'])).toBeInTheDocument();
    expect(screen.getByText(fr['common.retry'])).toBeInTheDocument();
  });

  it('retry after a timeout reloads and renders the index once the bridge answers', async () => {
    const platform = makePlatform();
    mockGetPlatform.mockReturnValue(platform);

    render(
      <I18nProvider>
        <WikiTab />
      </I18nProvider>,
    );

    // Exhaust the initial attempt plus its one bounded auto-retry (see test
    // above) to reach the honest timeout state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100 + 30_100);
    });
    expect(screen.getByText(fr['brain.wikiTimeoutTitle'])).toBeInTheDocument();

    // Bridge comes back: retry must clear the timeout state and load the wiki.
    platform.brain.tree.mockImplementation(() => Promise.resolve({ projects: [] }));
    platform.brain.synthesisIndex.mockImplementation(() => Promise.resolve(INDEX));

    await act(async () => {
      fireEvent.click(screen.getByText(fr['common.retry']));
    });

    expect(screen.queryByText(fr['brain.wikiTimeoutTitle'])).not.toBeInTheDocument();
    expect(screen.getByText('Demo brain recovered')).toBeInTheDocument();
  });
});
