/* BrainSpace — BRAIN-PATH TRANSPARENCY regression tests.
   Locks the contract: when platform.brain.info() reports source
   'env_override', BrainSpace must show a "Path override" status badge next
   to the scope toggle (with the real path in its tooltip and aria-label) —
   so a LAZYBRAIN_BRAIN_PATH override that silently replaces every
   project's brain is never mistaken for a brain private to the open
   project. The badge was previously labelled "Brain global", which read as
   a third scope value contradicting the neighboring This project/All
   brains tabs even though it answers an unrelated question (which brain
   FILE loaded, not how much of it is queried) — renamed plus given
   role="status" so it can no longer be misread as a toggle.

   Heavy/WebGL subcomponents (BrainGraph3D, BrainControls, BrainWiki) are
   irrelevant to this contract and are stubbed out so the test does not
   need a real WebGL context or graph/wiki data. Assertions are made in
   English/French-agnostic terms (waiting on the mock call, not translated
   scope-toggle text) so they don't depend on the resolved i18n locale.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/locales/en';
import { BrainSpace, withTimeout, TimeoutError } from '../spaces/BrainSpace';

vi.mock('../components/brain', () => ({
  BrainControls: () => null,
  BrainWiki: () => null,
  // IndexingBanner has its own dedicated coverage in
  // IndexingBanner.test.tsx — stubbed here so BrainSpace's mocked barrel
  // still satisfies the `IndexingBanner` import BrainSpace.tsx uses.
  IndexingBanner: () => null,
  // WikiTab (the Wiki view) has its own coverage in WikiTab.test.tsx — stubbed
  // here so the mocked barrel still satisfies BrainSpace's import. Most tests
  // never switch to the Wiki tab, so it is never rendered anyway. Renders a
  // recognizable marker (rather than null) so the "Brain tab a11y + wiring"
  // block below can assert the Wiki tab's own panel actually mounts, and
  // that switching away from it unmounts it again.
  WikiTab: () => React.createElement('div', { 'data-testid': 'wiki-tab-panel' }, 'wiki-tab-stub'),
  // TimelineScrubber (time-travel date-axis control) is unrelated to this
  // file's brain-path-transparency / sidecar-recovery contracts — stubbed so
  // the mocked barrel still satisfies BrainSpace's import.
  TimelineScrubber: () => null,
}));

vi.mock('../components/brain/BrainGraph3D', () => ({
  BrainGraph3D: () => null,
}));

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => undefined),
}));

// STALE HEALTH BADGE FIX: captures the 'brain://updated' handler so the
// health-refresh regression test below can fire it directly — same event +
// mock pattern as MemoryPanel.test.tsx's own brain://updated coverage.
// Other event names (e.g. 'project://changed') fall through to a generic
// resolved no-op unlisten, matching the global setup.ts default they'd
// otherwise get.
type ListenHandler = () => void;
let capturedUpdatedHandler: ListenHandler | null = null;

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, handler: ListenHandler) => {
    if (eventName === 'brain://updated') {
      capturedUpdatedHandler = handler;
    }
    return Promise.resolve(vi.fn());
  }),
}));

// Keep isTauri real (via importOriginal) — i18n's fetchOsLocale imports it
// directly, and it already resolves safely to `false` in jsdom via the
// global setup.ts (no window.__TAURI_INTERNALS__). Only getPlatform is
// overridden here — same pattern as assistantStore.test.tsx.
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: vi.fn(),
  };
});

// ImportBrainDialog (empty-brain onboarding) dynamically imports
// openFolder() from tauri.ts to reuse the app's native folder-open dialog
// (same helper AppContext.tsx's openProject() uses). Mocked here so tests
// can assert it's invoked without depending on a real Tauri runtime/jsdom
// plugin resolution.
vi.mock('../lib/platform/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform/tauri')>();
  return {
    ...actual,
    openFolder: vi.fn().mockResolvedValue('/picked/via/dialog'),
  };
});

import { getPlatform } from '../lib/platform';
import { openFolder } from '../lib/platform/tauri';
import { emit } from '../lib/bus';
import { invoke } from '@tauri-apps/api/core';
import {
  startSeed,
  initSeedProgressListener,
  resetSeedProgressForTests,
} from '../lib/brain/seedProgressStore';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;
const mockOpenFolder = openFolder as ReturnType<typeof vi.fn>;
const mockEmit = emit as ReturnType<typeof vi.fn>;
// invoke is globally mocked in setup.ts (vi.mock('@tauri-apps/api/core', ...))
// to resolve undefined by default; individual tests below override its
// per-command behavior to exercise the get_brain_connection auth wiring.
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

const EMPTY_GRAPH = { nodes: [], edges: [] };

interface MockBrainInfo {
  path: string;
  source: 'env_override' | 'project' | 'home_fallback';
}

interface MockPublishResult {
  ok: boolean;
  url?: string;
  message: string;
}

function makeTauriPlatform(info: MockBrainInfo, publishGithub?: ReturnType<typeof vi.fn>) {
  return {
    name: 'tauri',
    brain: {
      graph: vi.fn().mockResolvedValue(EMPTY_GRAPH),
      graphAll: vi.fn().mockResolvedValue(EMPTY_GRAPH),
      health: vi.fn().mockResolvedValue(null),
      info: vi.fn().mockResolvedValue(info),
      retrySidecar: vi.fn().mockResolvedValue(false),
      publishGithub: publishGithub ?? vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://github.com/LazyGod75/lazybrain-brain',
        message: 'Published successfully.',
      } satisfies MockPublishResult),
    },
  };
}

function renderSpace(info: MockBrainInfo, publishGithub?: ReturnType<typeof vi.fn>) {
  const platform = makeTauriPlatform(info, publishGithub);
  mockGetPlatform.mockReturnValue(platform);
  render(
    <I18nProvider>
      <BrainSpace />
    </I18nProvider>,
  );
  return platform;
}

afterEach(() => {
  vi.clearAllMocks();
  capturedUpdatedHandler = null;
});

describe('BrainSpace — brain path-override status badge (brain-path transparency)', () => {
  it('shows the "Path override" badge when brain.info() reports source env_override', async () => {
    renderSpace({ path: '/mock/global/lazy-brain-david/brain', source: 'env_override' });

    expect(await screen.findByText(en['brain.pathOverride.label'])).toBeInTheDocument();
  });

  it('renders the badge as a non-interactive status readout (role="status"), not a toggle control', async () => {
    renderSpace({ path: '/mock/global/lazy-brain-david/brain', source: 'env_override' });

    const badge = await screen.findByRole('status', { name: new RegExp(en['brain.pathOverride.label']) });
    expect(badge).toBeInTheDocument();
    // Never a clickable control — this is a status readout on a different
    // axis than the BrainTabs scope toggle, not a competing scope option.
    expect(badge.tagName).not.toBe('BUTTON');
  });

  it('exposes the real override path via the badge tooltip', async () => {
    renderSpace({ path: '/mock/global/lazy-brain-david/brain', source: 'env_override' });

    const badge = await screen.findByText(en['brain.pathOverride.label']);
    const tooltipHost = badge.closest('[title]');
    expect(tooltipHost?.getAttribute('title')).toContain('/mock/global/lazy-brain-david/brain');
  });

  it('does NOT show the badge when brain.info() reports source project', async () => {
    const platform = renderSpace({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });

    // Wait for the info() effect to resolve before asserting absence.
    await waitFor(() => expect(platform.brain.info).toHaveBeenCalled());
    expect(screen.queryByText(en['brain.pathOverride.label'])).toBeNull();
  });

  it('does NOT show the badge when brain.info() reports source home_fallback', async () => {
    const platform = renderSpace({ path: '/mock/home/.lazybrain/brain', source: 'home_fallback' });

    await waitFor(() => expect(platform.brain.info).toHaveBeenCalled());
    expect(screen.queryByText(en['brain.pathOverride.label'])).toBeNull();
  });
});

describe('BrainSpace — publish brain to GitHub dialog', () => {
  it('shows a "Publier sur GitHub" action next to the brain badges', async () => {
    renderSpace({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });

    expect(await screen.findByRole('button', { name: en['settings.memory.publish.titleShort'] })).toBeInTheDocument();
  });

  it('opens the confirm dialog with the active brain path on click', async () => {
    renderSpace({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });

    fireEvent.click(await screen.findByRole('button', { name: en['settings.memory.publish.titleShort'] }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // Exact match — the path lives in its own <span> with no prefix text.
    expect(screen.getByText('/mock/my-project/.lazybrain/brain')).toBeInTheDocument();
  });

  it('warns about personal data when source is env_override', async () => {
    renderSpace({ path: '/mock/global/lazy-brain-david/brain', source: 'env_override' });

    fireEvent.click(await screen.findByRole('button', { name: en['settings.memory.publish.titleShort'] }));

    expect(await screen.findByText(en['settings.memory.publish.personalBrainWarning'])).toBeInTheDocument();
  });

  it('keeps Publier disabled until confirmed, then calls publishGithub and shows the result', async () => {
    const publishGithub = vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://github.com/LazyGod75/lazybrain-brain',
      message: 'Published successfully.',
    } satisfies MockPublishResult);
    renderSpace({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }, publishGithub);

    fireEvent.click(await screen.findByRole('button', { name: en['settings.memory.publish.titleShort'] }));
    const publishButton = await screen.findByRole('button', { name: en['settings.memory.publish.publishButton'] });
    expect(publishButton).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(publishButton).not.toBeDisabled();

    fireEvent.click(publishButton);
    await waitFor(() => expect(publishGithub).toHaveBeenCalled());
    expect(await screen.findByText(new RegExp(en['settings.memory.publish.successPrefix']))).toBeInTheDocument();
  });
});

// ── Sidecar independence (BRAIN-PATH TRANSPARENCY hardening) ─────────
//
// Regression coverage for the real in-app bug: BrainSpace stayed stuck on
// "Connexion au brain..." and the "Path override" badge never appeared
// because the UI (in effect) waited on the sidecar (health()/graph()/
// graphAll()) instead of rendering brainInfo as soon as the independent,
// Rust-only brain.info() resolved. These tests mock brain.info() resolving
// normally while health()/graph()/graphAll() either reject or never resolve
// at all, and assert the badge still renders — plus that a fully-failed
// sidecar surfaces an honest message instead of spinning forever.

function makeSidecarBrokenPlatform(
  info: MockBrainInfo,
  graph: ReturnType<typeof vi.fn>,
  graphAll: ReturnType<typeof vi.fn>,
  health: ReturnType<typeof vi.fn>,
) {
  return {
    name: 'tauri',
    brain: {
      graph,
      graphAll,
      health,
      info: vi.fn().mockResolvedValue(info),
      retrySidecar: vi.fn().mockResolvedValue(false),
      publishGithub: vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://github.com/LazyGod75/lazybrain-brain',
        message: 'Published successfully.',
      } satisfies MockPublishResult),
    },
  };
}

describe('BrainSpace — brain info renders independent of the sidecar', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the "Path override" badge even when brain.health() rejects and graph()/graphAll() never resolve', async () => {
    mockGetPlatform.mockReturnValue(
      makeSidecarBrokenPlatform(
        { path: '/mock/global/lazy-brain-david/brain', source: 'env_override' },
        vi.fn(() => new Promise(() => {})),
        vi.fn(() => new Promise(() => {})),
        vi.fn().mockRejectedValue(new Error('sidecar unreachable')),
      ),
    );
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    // brain.info() resolves fast and independently — the badge renders
    // without ever waiting on the (permanently pending/rejecting) sidecar.
    expect(await screen.findByText(en['brain.pathOverride.label'])).toBeInTheDocument();
  });

  it('shows an honest "sidecar unavailable" message when graph()/graphAll() and the HTTP fallback all fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED (test stub)')));
    mockGetPlatform.mockReturnValue(
      makeSidecarBrokenPlatform(
        { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
        vi.fn().mockRejectedValue(new Error('sidecar down')),
        vi.fn().mockRejectedValue(new Error('sidecar down')),
        vi.fn().mockRejectedValue(new Error('sidecar down')),
      ),
    );
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    // BrainSpace now renders the i18n-backed settings.memory.health.sidecarUnavailable
    // key (previously hardcoded French regardless of locale) — I18nProvider
    // resolves to 'en' in jsdom (see the "web platform" describe block's own
    // comment below), so the rendered text is en.ts's English copy.
    expect(await screen.findByText(/Brain sidecar unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Connexion au brain/)).toBeNull();
  });

  it('attaches the sidecar Bearer token (from get_brain_connection) to the direct HTTP fallback fetch', async () => {
    // Force the primary invoke-based path to fail so BrainSpace falls
    // through to the direct-fetch path (127.0.0.1:<port>/_api/graph).
    // get_brain_connection resolves a distinctive port + token; every other
    // invoke call keeps the default (undefined) from setup.ts.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_brain_connection') {
        return Promise.resolve({ port: 45123, token: 'sidecar-secret-xyz' });
      }
      return Promise.resolve(undefined);
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(EMPTY_GRAPH),
    });
    vi.stubGlobal('fetch', fetchMock);

    mockGetPlatform.mockReturnValue(
      makeSidecarBrokenPlatform(
        { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
        vi.fn().mockRejectedValue(new Error('sidecar down')),
        vi.fn().mockRejectedValue(new Error('sidecar down')),
        vi.fn().mockResolvedValue(null),
      ),
    );
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:45123/_api/graph');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sidecar-secret-xyz');
  });
});

describe('withTimeout (BRAIN-PATH TRANSPARENCY hardening)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves with the value when the promise settles before the timeout', async () => {
    const p = withTimeout(Promise.resolve('ok'), 5000, 'test');
    await expect(p).resolves.toBe('ok');
  });

  it('rejects with the original error when the promise rejects before the timeout', async () => {
    const original = new Error('boom');
    const p = withTimeout(Promise.reject(original), 5000, 'test');
    await expect(p).rejects.toBe(original);
  });

  it('rejects with a TimeoutError once the timeout elapses without the promise settling', async () => {
    const neverSettles = new Promise<string>(() => {});
    const p = withTimeout(neverSettles, 5000, 'test-label');
    // Attach rejection handlers BEFORE advancing timers (same precaution as
    // streamTimeout.test.ts) so the rejection is never momentarily unhandled.
    const isTimeoutError = expect(p).rejects.toBeInstanceOf(TimeoutError);
    const hasMessage = expect(p).rejects.toMatchObject({ message: 'test-label timed out after 5000ms' });
    await vi.advanceTimersByTimeAsync(5001);
    await isTimeoutError;
    await hasMessage;
  });
});

// ── Brain setup UI (natural, UI-driven brain configuration) ──────────
//
// Covers: BrainSetupCard shows only when the brain genuinely has zero
// neurons (never while loading/unreachable, never once it has any
// neurons), its "Utiliser un brain de projet" quick action calling
// brain.setConfig(), its "Ouvrir Reglages > Memoire" link, and
// ImportBrainDialog calling brain.importFromGithub().

function makeGraphData(nodeCount: number) {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `n${i}`, title: `Node ${i}`, type: 'concept', topic: null, importance: 0.5,
    })),
    edges: [] as unknown[],
  };
}

function makePlatformWithSetup(
  info: MockBrainInfo,
  nodeCount: number,
  brainOverrides?: Record<string, unknown>,
) {
  const graphData = makeGraphData(nodeCount);
  return {
    name: 'tauri',
    brain: {
      graph: vi.fn().mockResolvedValue(graphData),
      graphAll: vi.fn().mockResolvedValue(graphData),
      health: vi.fn().mockResolvedValue(null),
      info: vi.fn().mockResolvedValue(info),
      retrySidecar: vi.fn().mockResolvedValue(false),
      publishGithub: vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://github.com/LazyGod75/lazybrain-brain',
        message: 'Published successfully.',
      } satisfies MockPublishResult),
      setConfig: vi.fn().mockResolvedValue({ path: '/mock/my-project/.lazybrain/brain', source: 'ui_config' }),
      importFromGithub: vi.fn().mockResolvedValue({ path: '/mock/imported/brain', source: 'ui_config' }),
      ...brainOverrides,
    },
  };
}

describe('BrainSpace — empty-brain onboarding card', () => {
  it('shows "Configurez votre brain" when the brain has zero neurons', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }, 0);
    mockGetPlatform.mockReturnValue(platform);
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    expect(await screen.findByText('Configurez votre brain')).toBeInTheDocument();
  });

  it('does NOT show the setup card once the brain has neurons', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }, 3);
    mockGetPlatform.mockReturnValue(platform);
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    await waitFor(() => expect(platform.brain.graph).toHaveBeenCalled());
    expect(screen.queryByText('Configurez votre brain')).toBeNull();
  });

  it('does NOT show the setup card while the sidecar is unavailable (that state has its own honest message)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED (test stub)')));
    const platform = makePlatformWithSetup(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      0,
      {
        graph: vi.fn().mockRejectedValue(new Error('sidecar down')),
        graphAll: vi.fn().mockRejectedValue(new Error('sidecar down')),
      },
    );
    mockGetPlatform.mockReturnValue(platform);
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    // BrainSpace now renders the i18n-backed settings.memory.health.sidecarUnavailable
    // key (previously hardcoded French regardless of locale) — I18nProvider
    // resolves to 'en' in jsdom (see the "web platform" describe block's own
    // comment below), so the rendered text is en.ts's English copy.
    expect(await screen.findByText(/Brain sidecar unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('Configurez votre brain')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('"Utiliser un brain de projet" calls setConfig({mode:"project"})', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }, 0);
    mockGetPlatform.mockReturnValue(platform);
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Utiliser un brain de projet' }));

    await waitFor(() => expect(platform.brain.setConfig).toHaveBeenCalledWith({ mode: 'project' }));
  });

  it('shows an honest error on the card when setConfig rejects', async () => {
    const platform = makePlatformWithSetup(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      0,
      { setConfig: vi.fn().mockRejectedValue(new Error('disk full')) },
    );
    mockGetPlatform.mockReturnValue(platform);
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Utiliser un brain de projet' }));

    expect(await screen.findByText('disk full')).toBeInTheDocument();
  });

  it('"Ouvrir Reglages > Memoire" emits nav:navigateSpace(\'settings\')', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }, 0);
    mockGetPlatform.mockReturnValue(platform);
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Ouvrir Réglages/ }));

    expect(mockEmit).toHaveBeenCalledWith('nav:navigateSpace', 'settings');
  });
});

describe('BrainSpace — import a brain from GitHub (ImportBrainDialog)', () => {
  it('opens the dialog, confirms, and calls importFromGithub with the entered url + dest', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }, 0);
    mockGetPlatform.mockReturnValue(platform);
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Importer depuis GitHub' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(en['settings.memory.import.urlPlaceholder']), {
      target: { value: 'https://github.com/LazyGod75/shared-brain.git' },
    });
    fireEvent.change(screen.getByPlaceholderText(en['settings.memory.import.destPlaceholder']), {
      target: { value: '/home/user/imported-brain' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: en['settings.memory.import.importButton'] }));

    await waitFor(() => expect(platform.brain.importFromGithub).toHaveBeenCalledWith({
      url: 'https://github.com/LazyGod75/shared-brain.git',
      dest: '/home/user/imported-brain',
    }));
    expect(await screen.findByText(/Brain imported and activated/)).toBeInTheDocument();
  });

  it('populates the destination field from the native folder dialog (openFolder())', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }, 0);
    mockGetPlatform.mockReturnValue(platform);
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Importer depuis GitHub' }));
    fireEvent.click(await screen.findByRole('button', { name: en['settings.memory.chooseFolderButton'] }));

    await waitFor(() => expect(mockOpenFolder).toHaveBeenCalled());
    expect(await screen.findByDisplayValue('/picked/via/dialog')).toBeInTheDocument();
  });

  it('keeps "Importer" disabled until confirmed and both fields are filled', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }, 0);
    mockGetPlatform.mockReturnValue(platform);
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Importer depuis GitHub' }));
    expect(screen.getByRole('button', { name: en['settings.memory.import.importButton'] })).toBeDisabled();
    expect(platform.brain.importFromGithub).not.toHaveBeenCalled();
  });
});

// ── Web platform: /_api/graph fetch robustness (verified bug fix) ────
//
// Real bug (headless run): in web/non-Tauri mode, loadGraphData's !isTauri
// branch did a raw fetch('/_api/graph') with no try/catch. When the
// endpoint failed (e.g. `vite preview` with nothing listening behind the
// /_api proxy -> HTTP 500), the rejection escaped as an unhandled promise
// rejection (pageerror in the browser) and the graph silently stayed on
// the empty "Configurez votre brain" state. Fixed by wrapping the fetch
// flow in try/catch and falling back to platform.brain.graph() (empty
// when the sidecar is down — never a canned demo vault). These tests lock
// both outcomes: never an unhandled rejection, and a graceful (live graph
// from the platform adapter, or honest-empty) end state.

function makeWebPlatform(graph: ReturnType<typeof vi.fn>) {
  return {
    name: 'web',
    brain: { graph },
  };
}

describe('BrainSpace — web platform /_api/graph fetch robustness', () => {
  let unhandledRejections: unknown[];
  function captureUnhandledRejection(reason: unknown) {
    unhandledRejections.push(reason);
  }

  beforeEach(() => {
    unhandledRejections = [];
    process.on('unhandledRejection', captureUnhandledRejection);
  });

  afterEach(() => {
    process.removeListener('unhandledRejection', captureUnhandledRejection);
    vi.unstubAllGlobals();
  });

  it('falls back to platform.brain.graph with no unhandled rejection when fetch rejects at the network level', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED (test stub)')));
    const graph = vi.fn().mockResolvedValue(makeGraphData(3));
    const platform = makeWebPlatform(graph);
    mockGetPlatform.mockReturnValue(platform);

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    await waitFor(() => expect(graph).toHaveBeenCalled());
    expect(await screen.findByText('brain live · LazyBrain')).toBeInTheDocument();
    expect(screen.queryByText('Configurez votre brain')).toBeNull();
    expect(screen.queryByText(/Brain sidecar unavailable/)).toBeNull();

    // Let any unhandled rejection surface before asserting there is none.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });

  it('falls back to platform.brain.graph with no unhandled rejection on a non-2xx status (the reported bug: HTTP 500)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const graph = vi.fn().mockResolvedValue(makeGraphData(3));
    const platform = makeWebPlatform(graph);
    mockGetPlatform.mockReturnValue(platform);

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    await waitFor(() => expect(graph).toHaveBeenCalled());
    expect(await screen.findByText('brain live · LazyBrain')).toBeInTheDocument();
    expect(screen.queryByText('Configurez votre brain')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });

  it('shows the honest empty state with no unhandled rejection when the platform graph also fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED (test stub)')));
    const graph = vi.fn().mockRejectedValue(new Error('graph unavailable'));
    const platform = makeWebPlatform(graph);
    mockGetPlatform.mockReturnValue(platform);

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    // BrainSpace now renders the i18n-backed settings.memory.health.sidecarUnavailable
    // key (previously hardcoded French regardless of locale) — I18nProvider
    // resolves to 'en' in jsdom (see the "web platform" describe block's own
    // comment below), so the rendered text is en.ts's English copy.
    expect(await screen.findByText(/Brain sidecar unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('Configurez votre brain')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });
});

// ── Brain status badge: checking -> live/demo (W3.1 — kill "mode dev") ────
//
// The boolean isLive badge is replaced by a 3-state badge ('checking' |
// 'live' | 'demo'): 'checking' is the honest initial state before the first
// load settles, 'live' is real graph data. 'demo' is kept on the type for
// the unused badge mapping but is no longer assigned by the loader.

describe('BrainSpace — brain status badge (checking/live/demo)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the neutral "checking" badge before the first load resolves (web platform)', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const graph = vi.fn(() => new Promise(() => {}));
    mockGetPlatform.mockReturnValue(makeWebPlatform(graph));

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    // Synchronous — first paint, before any promise settles. loading starts
    // false on the web platform, so only the badge chip (not the full-page
    // overlay, which is gated on `loading`) renders brain.connecting here.
    expect(screen.getByText('Connecting to brain…')).toBeInTheDocument();
    expect(screen.queryByText(/brain live/)).toBeNull();
    expect(screen.queryByText(/brain demo/)).toBeNull();
  });

  it('flips to the "live" badge once real graph data resolves (Tauri invoke path)', async () => {
    const platform = makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    expect(await screen.findByText('brain live · LazyBrain')).toBeInTheDocument();
  });

  it('drops the connecting overlay once health is known even if graph() never settles (measured 2026-08-28)', async () => {
    const base = makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue({
      ...base,
      brain: {
        ...base.brain,
        graph: vi.fn(() => new Promise(() => {})),
        graphAll: vi.fn(() => new Promise(() => {})),
        health: vi.fn().mockResolvedValue({
          score: 74, orphans: 0, brokenLinks: 0, stale: 0, dupes: 0,
        }),
      },
    });
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );
    expect(await screen.findByText('74%')).toBeInTheDocument();
    expect(await screen.findByText('brain live · LazyBrain')).toBeInTheDocument();
    expect(screen.queryAllByText('Connecting to brain…')).toHaveLength(0);
    expect(await screen.findByTestId('brain-setup-card')).toBeInTheDocument();
    expect(screen.getByText('Configurez votre brain')).toBeInTheDocument();
  });

  it('treats a graph timeout as an empty live vault when health already scored (not sidecar-unavailable)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED (test stub)')));
    const base = makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue({
      ...base,
      brain: {
        ...base.brain,
        graph: vi.fn().mockRejectedValue(new Error('graph timed out')),
        graphAll: vi.fn().mockRejectedValue(new Error('graph timed out')),
        health: vi.fn().mockResolvedValue({
          score: 74, orphans: 0, brokenLinks: 0, stale: 0, dupes: 0,
        }),
      },
    });
    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );
    expect(await screen.findByText('74%')).toBeInTheDocument();
    expect(await screen.findByText('brain live · LazyBrain')).toBeInTheDocument();
    expect(screen.queryByText(/Brain sidecar unavailable/)).toBeNull();
    expect(await screen.findByTestId('brain-setup-card')).toBeInTheDocument();
  });
});

// ── Non-blocking build progress banner (SeedBuildBanner) ───────────────
//
// C.3 of the non-blocking-onboarding fix: while a history-import seed
// (started by onboarding's BrainSetupStep or Settings' HistoryReimportSection
// — both funnel through the shared seedProgressStore) is actively building a
// brain that currently shows zero neurons, BrainSpace must show a live
// progress banner with the real percentage INSTEAD of BrainSetupCard's
// static "Configurez votre brain" empty-state prompt (which is misleading
// while a build is genuinely already in flight).

describe('BrainSpace — non-blocking build progress banner (SeedBuildBanner)', () => {
  beforeEach(() => {
    resetSeedProgressForTests();
  });

  function makeTauriPlatformWithSeed(
    info: MockBrainInfo,
    seedBrain: ReturnType<typeof vi.fn>,
    onSeedProgress: ReturnType<typeof vi.fn>,
  ) {
    const base = makeTauriPlatform(info);
    return { ...base, brain: { ...base.brain, seedBrain, onSeedProgress } };
  }

  it('shows the build banner with the real percent instead of the empty-state setup card while a seed is active, then hides it once the seed completes', async () => {
    let capturedCb: ((p: Record<string, unknown>) => void) | null = null;
    const onSeedProgress = vi.fn((cb: (p: Record<string, unknown>) => void) => {
      capturedCb = cb;
      return vi.fn();
    });
    let resolveSeed: (v: { imported: number; skipped: number }) => void = () => {};
    const seedBrain = vi.fn().mockReturnValue(
      new Promise<{ imported: number; skipped: number }>((resolve) => { resolveSeed = resolve; }),
    );

    const platform = makeTauriPlatformWithSeed(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      seedBrain,
      onSeedProgress,
    );
    mockGetPlatform.mockReturnValue(platform);

    // Simulate the app-level subscription (AppShell) plus a seed already
    // kicked off (e.g. by onboarding's BrainSetupStep) BEFORE BrainSpace
    // itself mounts — the "user navigates to the Brain page while it is
    // still building" scenario the banner exists for.
    initSeedProgressListener();
    void startSeed({ sources: ['claude-code'], useLlm: false });

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    // Empty graph (makeTauriPlatform's EMPTY_GRAPH) + active seed -> the
    // banner takes over the slot BrainSetupCard would otherwise occupy.
    await screen.findByText('Building your Brain — 0%');
    expect(screen.queryByText('Configurez votre brain')).toBeNull();

    act(() => {
      capturedCb!({ done: 0, total: 1, phase: 'import', percent: 42 });
    });
    await screen.findByText('Building your Brain — 42%');

    act(() => {
      capturedCb!({
        done: 3, total: 3, phase: 'done', percent: 100,
        imported: 10, skipped: 0, notesTotal: 10, served: true,
      });
      resolveSeed({ imported: 10, skipped: 0 });
    });

    await waitFor(() => {
      expect(screen.queryByText(/Building your Brain/)).toBeNull();
    });
  });

  it('does not show the build banner when no seed is active (unaffected default behavior)', async () => {
    const platform = makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    await waitFor(() => expect(platform.brain.graph).toHaveBeenCalled());
    expect(screen.queryByText(/Building your Brain/)).toBeNull();
  });

  // ── Precedence over the connecting spinner / sidecar-unavailable error ──
  //
  // Regression coverage for the reported bug: a real first-run history
  // import's sidecar legitimately is not up yet for most of the build (it
  // only starts at the seed's own 'serving' phase — see history_import.rs's
  // run_post_seed_pipeline), so `loading`/`sidecarUnavailable` are routinely
  // true WHILE a seed is active. The two tests above never exercised that
  // overlap (their mocked `graph()`/`graphAll()` resolve near-instantly to
  // EMPTY_GRAPH, so `loading`/`sidecarUnavailable` are already settled false
  // by the time the banner assertion runs) — these do, by holding the
  // sidecar calls pending/rejecting for the whole test.

  it('shows the build banner instead of the connecting spinner while the sidecar has not come up yet (seed active during initial connect)', async () => {
    let capturedCb: ((p: Record<string, unknown>) => void) | null = null;
    const onSeedProgress = vi.fn((cb: (p: Record<string, unknown>) => void) => {
      capturedCb = cb;
      return vi.fn();
    });
    const seedBrain = vi.fn().mockReturnValue(new Promise(() => {}));

    const base = makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    const platform = {
      ...base,
      brain: {
        ...base.brain,
        // Never resolve — reproduces "sidecar isn't up yet early in the
        // build" instead of the fast EMPTY_GRAPH resolution the other
        // tests in this describe block use.
        graph: vi.fn(() => new Promise(() => {})),
        graphAll: vi.fn(() => new Promise(() => {})),
        seedBrain,
        onSeedProgress,
      },
    };
    mockGetPlatform.mockReturnValue(platform);

    initSeedProgressListener();
    void startSeed({ sources: ['claude-code'], useLlm: false });

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    // The banner must win even though brain.graph()/graphAll() never
    // settle (loading stays true for BrainSpace's entire mounted lifetime
    // in this test) — the old precedence (`!loading && ...`) hid the
    // banner behind "Connecting to brain..." for exactly this scenario.
    await screen.findByText('Building your Brain — 0%');
    // BrainSubHeader's own "checking" status badge (brainStatus, a
    // separate concern from the full-page overlays this fix touches) also
    // renders this same i18n string and legitimately keeps doing so here
    // (brainStatus never leaves 'checking' since graph()/graphAll() never
    // settle) — assert exactly ONE match (that badge) rather than zero, so
    // this proves the full-page connecting OVERLAY specifically is gone
    // without over-reaching into that unrelated badge's own contract.
    expect(screen.getAllByText('Connecting to brain…')).toHaveLength(1);

    act(() => {
      capturedCb!({ done: 0, total: 1, phase: 'import', percent: 17 });
    });
    await screen.findByText('Building your Brain — 17%');
  });

  it('shows the build banner instead of the sidecar-unavailable error once all sidecar paths have failed while a seed is active', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED (test stub)')));
    let capturedCb: ((p: Record<string, unknown>) => void) | null = null;
    const onSeedProgress = vi.fn((cb: (p: Record<string, unknown>) => void) => {
      capturedCb = cb;
      return vi.fn();
    });
    const seedBrain = vi.fn().mockReturnValue(new Promise(() => {}));

    const base = makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    const platform = {
      ...base,
      brain: {
        ...base.brain,
        graph: vi.fn().mockRejectedValue(new Error('sidecar down')),
        graphAll: vi.fn().mockRejectedValue(new Error('sidecar down')),
        seedBrain,
        onSeedProgress,
      },
    };
    mockGetPlatform.mockReturnValue(platform);

    initSeedProgressListener();
    void startSeed({ sources: ['claude-code'], useLlm: false });

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    // Every sidecar path (invoke + HTTP fallback) fails -> sidecarUnavailable
    // flips true — the banner must still win instead of the honest
    // "Brain sidecar unavailable" error overlay.
    await screen.findByText('Building your Brain — 0%');
    expect(screen.queryByText(/Brain sidecar unavailable/)).toBeNull();

    act(() => {
      capturedCb!({ done: 0, total: 1, phase: 'import', percent: 30 });
    });
    await screen.findByText('Building your Brain — 30%');

    vi.unstubAllGlobals();
  });
});

// ── Health badge live refresh — STALE HEALTH BADGE FIX ────────────────
//
// HealthBadge (renders `{score}%`) was previously fetched ONCE on mount and
// never again — after a later seed/rebuild actually finishes, the badge kept
// showing whatever (possibly 0/stale) score it captured at that first
// fetch. The brain://updated listener now re-fetches health the same way
// MemoryPanel's own brain://updated listener does (see MemoryPanel.test.tsx's
// identically-motivated "STALE HEALTH BADGE FIX" describe block).

describe('BrainSpace — health badge refreshes on brain://updated (STALE HEALTH BADGE FIX)', () => {
  it('re-fetches brain.health() and shows the updated score once brain://updated fires', async () => {
    const healthMock = vi.fn()
      .mockResolvedValueOnce({ score: 0, orphans: 0, brokenLinks: 0, stale: 0, dupes: 0 }) // mount
      .mockResolvedValue({ score: 82, orphans: 1, brokenLinks: 0, stale: 0, dupes: 0 });   // post brain://updated

    const base = makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    const platform = { ...base, brain: { ...base.brain, health: healthMock } };
    mockGetPlatform.mockReturnValue(platform);

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    // Initial mount fetch — first mocked resolution: score 0.
    expect(await screen.findByText('0%')).toBeInTheDocument();

    await waitFor(() => expect(capturedUpdatedHandler).not.toBeNull());
    act(() => {
      capturedUpdatedHandler!();
    });

    expect(await screen.findByText('82%')).toBeInTheDocument();
    expect(healthMock).toHaveBeenCalledTimes(2);
  });
});

// ── Sidecar supervision: bounded auto-retry + terminal state ─────────
//
// Regression coverage for the real robustness gap found live: the sidecar
// PROCESS dying mid-session (killed, OOM, crashed) previously left the
// Brain space stuck on "Reconnecting…" forever, because the old retry path
// only re-attempted a socket/HTTP connection to a process that no longer
// existed. `retrySidecar()` (platform.brain.retrySidecar -> Tauri's
// `brain_retry_sidecar` -> `start_or_restart_brain_sidecar` in
// src-tauri/src/commands/brain/sidecar.rs) already does a REAL respawn
// (stop the dead child if any, spawn a fresh one, wait for it to answer) —
// these tests lock in that both the bounded auto-retry loop and the manual
// "Réessayer" button go through that exact respawn path (never a bare
// reconnect probe), that the auto-retry loop backs off exponentially and
// is bounded (never a hot infinite loop), and that exhausting it surfaces
// an honest terminal message instead of an eternal spinner.
describe('BrainSpace — sidecar supervision: bounded auto-retry + terminal state', () => {
  beforeEach(() => {
    // A prior describe block's active seed (SeedBuildBanner) takes visual
    // precedence over the sidecar-unavailable overlay (see showSeedBanner's
    // doc comment in BrainSpace.tsx) — reset the shared seedProgressStore
    // singleton so it doesn't leak across files/blocks and mask these
    // assertions, same as the SeedBuildBanner describe block's own reset.
    resetSeedProgressForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeDownPlatform(retrySidecar: ReturnType<typeof vi.fn>) {
    const base = makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    return {
      ...base,
      brain: {
        ...base.brain,
        graph: vi.fn().mockRejectedValue(new Error('sidecar down')),
        graphAll: vi.fn().mockRejectedValue(new Error('sidecar down')),
        retrySidecar,
      },
    };
  }

  it('process gone -> auto-retry calls the real respawn path (retrySidecar) with bounded exponential backoff', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED (test stub)')));
    const retrySidecar = vi.fn().mockResolvedValue(false);
    const platform = makeDownPlatform(retrySidecar);
    mockGetPlatform.mockReturnValue(platform);

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    // Let the initial (mount) load attempt settle — its rejections resolve
    // via the microtask queue, which fake timers never block.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText(/Brain sidecar unavailable/)).toBeInTheDocument();
    expect(retrySidecar).not.toHaveBeenCalled();

    // First auto-retry tick fires after the base 4s backoff delay.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_001); });
    expect(retrySidecar).toHaveBeenCalledTimes(1);

    // Second tick backs off to 8s, not another 4s (exponential, not fixed).
    await act(async () => { await vi.advanceTimersByTimeAsync(4_001); });
    expect(retrySidecar).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_001); });
    expect(retrySidecar).toHaveBeenCalledTimes(2);
  });

  it('repeated failure -> bounded terminal state: exhausts auto-retry, shows an honest message, and never hot-loops further', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED (test stub)')));
    const retrySidecar = vi.fn().mockResolvedValue(false);
    const platform = makeDownPlatform(retrySidecar);
    mockGetPlatform.mockReturnValue(platform);

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByTestId('brain-sidecar-retries-exhausted')).toBeNull();

    // Advance through the full bounded backoff schedule (4+8+16+32+60+60s)
    // plus slack — 6 attempts total, never more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000 + 8_000 + 16_000 + 32_000 + 60_000 + 60_000 + 5_000);
    });

    expect(retrySidecar).toHaveBeenCalledTimes(6);
    expect(screen.getByTestId('brain-sidecar-retries-exhausted')).toBeInTheDocument();

    // Bounded, not eternal: no further attempts even after much more time.
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(retrySidecar).toHaveBeenCalledTimes(6);
  });

  it('success -> reconnected: the manual Retry button calls the real respawn path, and a healthy respawn clears the error and reloads the graph', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED (test stub)')));
    let sidecarUp = false;
    const graphData = makeGraphData(3);
    const base = makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    const retrySidecar = vi.fn().mockImplementation(() => {
      sidecarUp = true;
      return Promise.resolve(true);
    });
    const platform = {
      ...base,
      brain: {
        ...base.brain,
        graph: vi.fn().mockImplementation(() =>
          sidecarUp ? Promise.resolve(graphData) : Promise.reject(new Error('sidecar down'))),
        graphAll: vi.fn().mockImplementation(() =>
          sidecarUp ? Promise.resolve(graphData) : Promise.reject(new Error('sidecar down'))),
        retrySidecar,
      },
    };
    mockGetPlatform.mockReturnValue(platform);

    render(
      <I18nProvider>
        <BrainSpace />
      </I18nProvider>,
    );

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const retryBtn = screen.getByTestId('brain-sidecar-retry-btn');

    await act(async () => {
      fireEvent.click(retryBtn);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    // The button must go through the real respawn command (retrySidecar),
    // never a bare reconnect probe.
    expect(retrySidecar).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Brain sidecar unavailable/)).toBeNull();
  });
});

// ── Rules / Skills tabs (harness UI mount) ───────────────────────────
//
// RulesPanel/SkillsPanel (src/components/agents/RulesPanel.tsx,
// SkillsPanel.tsx) are standalone, brain-backed panels previously built but
// never mounted anywhere in the UI — mounted here as two more Brain space
// tabs, same full-body-swap pattern the Wiki tab already uses. These tests
// lock the mount: selecting the tab renders the panel, and its honest empty
// state shows once loading settles (the mocked platform above has no
// queryCss, and both panels already degrade to an empty list rather than
// crash in that case — see listRules()/loadAllSkills()'s own guards).

describe('BrainSpace — Rules tab (RulesPanel mount)', () => {
  it('shows the Rules panel with its empty state once the tab is selected', async () => {
    renderSpace({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });

    fireEvent.click(await screen.findByRole('button', { name: en['brain.rulesTab'] }));

    // I18nProvider resolves to 'en' in jsdom (navigator.language defaults to
    // en-US, no saved localStorage preference) — see src/i18n/index.tsx.
    // RulesPanel used to hardcode these strings in French regardless of
    // locale; af5f474 routed them through t() (see
    // RulesPanelI18nEnglish.test.tsx), so the mount now honestly renders
    // English here.
    expect(await screen.findByText(en['rulesPanel.header'])).toBeInTheDocument();
    expect(await screen.findByText(en['rulesPanel.empty'])).toBeInTheDocument();
  });
});

describe('BrainSpace — Skills tab (SkillsPanel mount)', () => {
  it('shows the Skills panel with its empty state once the tab is selected', async () => {
    renderSpace({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });

    fireEvent.click(await screen.findByRole('button', { name: en['brain.skillsTab'] }));

    expect(await screen.findByText('Skills (brain)')).toBeInTheDocument();
    // I18nProvider resolves to 'en' in jsdom (navigator.language defaults to
    // en-US, no saved localStorage preference) — see src/i18n/index.tsx.
    // SkillsPanel used to hardcode this string in French regardless of
    // locale; af5f474 routed it through t() (see
    // SkillsPanelI18nEnglish.test.tsx), so the mount now honestly renders
    // English here.
    expect(await screen.findByText(en['skillsPanel.empty'])).toBeInTheDocument();
  });
});

// ── Brain tab a11y + wiring (data-testid, aria-current, panel swap) ─────
//
// The five BrainTabs buttons ('This project' / 'All brains' / 'Wiki' /
// 'Rules' / 'Skills') previously had no data-testid and no aria-current (or
// any other current-state attribute) — a screen-reader user could not tell
// which tab was active, and tests had no stable hook besides matching on
// translated visible text. Fixed in BrainTabs (src/spaces/BrainSpace.tsx)
// by giving every tab button `data-testid="brain-tab-<tab>"` and
// `aria-current={isActive ? 'page' : undefined}` — the exact same
// data-testid + aria-current convention TopNav's NavPill already uses (see
// aaa1a24, "fix(nav): give TopNav's gear a real accessible name and expose
// current state").
//
// These assertions fail against the pre-fix BrainTabs (no data-testid to
// query, aria-current absent on every button) and pass once the fix lands.

describe('BrainSpace — Brain tab a11y + wiring (data-testid, aria-current, panel swap)', () => {
  const TAB_TEST_IDS = [
    'brain-tab-project',
    'brain-tab-all',
    'brain-tab-wiki',
    'brain-tab-rules',
    'brain-tab-skills',
  ] as const;

  function getTabs() {
    return TAB_TEST_IDS.map((testId) => screen.getByTestId(testId));
  }

  function currentTabs() {
    return getTabs().filter((el) => el.getAttribute('aria-current') === 'page');
  }

  it('gives every tab a stable data-testid hook', async () => {
    renderSpace({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });

    await screen.findByTestId('brain-tab-project');
    for (const testId of TAB_TEST_IDS) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });

  it('marks exactly one tab as aria-current="page" at a time, following every click', async () => {
    renderSpace({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    await screen.findByTestId('brain-tab-project');

    // Default: the 'project' scope tab is current on first render.
    expect(currentTabs()).toHaveLength(1);
    expect(screen.getByTestId('brain-tab-project')).toHaveAttribute('aria-current', 'page');

    for (const testId of ['brain-tab-all', 'brain-tab-wiki', 'brain-tab-rules', 'brain-tab-skills', 'brain-tab-project'] as const) {
      fireEvent.click(screen.getByTestId(testId));
      const current = currentTabs();
      expect(current).toHaveLength(1);
      expect(current[0]).toHaveAttribute('data-testid', testId);
    }
  });

  it('renders each tab\'s own panel on click, and unmounts the previous tab\'s panel', async () => {
    renderSpace({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });

    fireEvent.click(await screen.findByTestId('brain-tab-wiki'));
    expect(await screen.findByTestId('wiki-tab-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('brain-tab-rules'));
    expect(await screen.findByText(en['rulesPanel.header'])).toBeInTheDocument();
    expect(screen.queryByTestId('wiki-tab-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('brain-tab-skills'));
    expect(await screen.findByText('Skills (brain)')).toBeInTheDocument();
    expect(screen.queryByText(en['rulesPanel.header'])).toBeNull();
  });
});
