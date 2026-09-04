/* MemoryPanel — BRAIN-PATH TRANSPARENCY regression tests.
   Locks the contract: the brain-path display must show the REAL resolved
   path + resolution source from platform.brain.info() (backed by Rust's
   get_brain_info / resolve_unified_brain_path), instead of the old static
   "Configuré via le sidecar LazyBrain..." placeholder that never revealed
   which brain was actually in use — especially the env_override case,
   where LAZYBRAIN_BRAIN_PATH silently overrides every project's brain with
   one shared global brain.
*/

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/locales/en';
import { MemoryPanel, withTimeout, TimeoutError, formatProportion } from '../components/settings/MemoryPanel';

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

// Brain setup UI (BrainConfigSection/BrainImportSection) dynamically imports
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

// STALE HEALTH BADGE FIX: MemoryPanel now listens for the `brain://updated`
// Tauri event (same event + mock pattern as IndexingBanner.test.tsx) so the
// health refresh test below can fire it directly instead of only exercising
// the premature optimistic bump.
type ListenHandler = () => void;
let capturedUpdatedHandler: ListenHandler | null = null;
let capturedUpdatedUnlisten: ReturnType<typeof vi.fn> | null = null;

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, handler: ListenHandler) => {
    if (eventName === 'brain://updated') {
      capturedUpdatedHandler = handler;
      capturedUpdatedUnlisten = vi.fn();
      return Promise.resolve(capturedUpdatedUnlisten);
    }
    return Promise.resolve(vi.fn());
  }),
}));

// Consolidate now (handleConsolidateNow) calls `invoke` directly via a
// dynamic import of '@tauri-apps/api/core' instead of going through
// platform.brain.* — see MemoryPanel.tsx's top-of-file doc comment for why
// (src/lib/platform is a different work-stream's ownership boundary).
// Mocked the same way as '@tauri-apps/api/event' above.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { getPlatform } from '../lib/platform';
import { openFolder } from '../lib/platform/tauri';
import { invoke } from '@tauri-apps/api/core';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;
const mockOpenFolder = openFolder as ReturnType<typeof vi.fn>;
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

/** Waits for the `brain://updated` listener to register, then invokes it —
    mirrors IndexingBanner.test.tsx's fireIndexingEvent helper. */
async function fireBrainUpdated() {
  await waitFor(() => expect(capturedUpdatedHandler).not.toBeNull());
  await act(async () => {
    capturedUpdatedHandler?.();
  });
}

interface MockBrainInfo {
  path: string;
  source: 'env_override' | 'project' | 'home_fallback';
  /** BRAIN DISCOVERABILITY: optional in test call sites — defaults applied
      by withBrainInfoDefaults below so the ~30 existing call sites that
      predate noteCount/isEmpty don't all need updating. Tests that care
      about the empty-brain signal pass these explicitly. */
  noteCount?: number;
  isEmpty?: boolean;
}

interface MockPublishResult {
  ok: boolean;
  url?: string;
  message: string;
}

/** Fills in noteCount/isEmpty defaults (a populated brain, 10 notes) when a
    test doesn't care about the empty-brain signal — see MockBrainInfo. */
function withBrainInfoDefaults(info: MockBrainInfo) {
  return {
    ...info,
    noteCount: info.noteCount ?? 10,
    isEmpty: info.isEmpty ?? false,
  };
}

function makeTauriPlatform(info: MockBrainInfo, publishGithub?: ReturnType<typeof vi.fn>) {
  return {
    name: 'tauri',
    health: vi.fn().mockResolvedValue({
      brain: 'ok', git: 'ok', terminal: 'ok', model: 'ok', agentRunner: 'ok',
    }),
    brain: {
      health: vi.fn().mockResolvedValue(null),
      getProjects: vi.fn().mockResolvedValue([]),
      info: vi.fn().mockResolvedValue(withBrainInfoDefaults(info)),
      ingestProject: vi.fn().mockResolvedValue(undefined),
      publishGithub: publishGithub ?? vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://github.com/LazyGod75/lazybrain-brain',
        message: 'Published successfully.',
      } satisfies MockPublishResult),
    },
  };
}

function renderPanel() {
  return render(
    <I18nProvider>
      <MemoryPanel />
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  capturedUpdatedHandler = null;
  capturedUpdatedUnlisten = null;
});

describe('MemoryPanel — brain path transparency', () => {
  it('shows the global-override label + real path when source is env_override', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/global/lazy-brain-david/brain', source: 'env_override' }),
    );
    renderPanel();

    expect(await screen.findByText(/Global brain \(LAZYBRAIN_BRAIN_PATH\)/)).toBeInTheDocument();
    expect(screen.getByText(/\/mock\/global\/lazy-brain-david\/brain/)).toBeInTheDocument();
    // The amber callout explaining the override must also render.
    expect(screen.getByText(/shared across all your projects/)).toBeInTheDocument();
  });

  it('shows the project label + real path when source is project', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }),
    );
    renderPanel();

    expect(await screen.findByText(/Project brain/)).toBeInTheDocument();
    expect(screen.getByText(/\/mock\/my-project\/\.lazybrain\/brain/)).toBeInTheDocument();
  });

  it('shows the home-fallback label + real path when source is home_fallback', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/home/.lazybrain/brain', source: 'home_fallback' }),
    );
    renderPanel();

    expect(await screen.findByText(/Default brain/)).toBeInTheDocument();
  });

  it('does NOT show the global-override callout for a project-local brain', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }),
    );
    renderPanel();

    await screen.findByText(/Project brain/);
    expect(screen.queryByText(/LAZYBRAIN_BRAIN_PATH/)).toBeNull();
  });
});

describe('MemoryPanel — publish brain to GitHub', () => {
  it('shows the publish section with a collapsed action button', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }),
    );
    renderPanel();

    expect(await screen.findByText('Publish the brain to GitHub')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish to GitHub' })).toBeInTheDocument();
  });

  it('expands to show the active brain path and the confirm checkbox on click', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Publish to GitHub' }));

    // Exact match (not a substring regex): BrainPathSection above also shows
    // this same path prefixed with "Project brain: " in one text node, so
    // a partial-match query would ambiguously match both. This section's
    // path lives in its own <span> with no prefix, so the exact string is
    // unique to it.
    expect(await screen.findByText('/mock/my-project/.lazybrain/brain')).toBeInTheDocument();
    // 2026-08-12 privacy-copy rewrite: the confirm label now names exactly
    // what gets published (all notes and memory) and states the repo is
    // always private, instead of the old bare "to GitHub".
    expect(
      screen.getByText(/I confirm I want to publish this brain \(all notes and memory\) to a private GitHub repository/),
    ).toBeInTheDocument();
    // A project-local brain must NOT show the personal-data warning.
    expect(screen.queryByText(/your global personal brain/)).toBeNull();
  });

  it('warns about personal data and adjusts the confirm label when source is env_override', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/global/lazy-brain-david/brain', source: 'env_override' }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Publish to GitHub' }));

    expect(await screen.findByText(/your global personal brain/)).toBeInTheDocument();
    expect(screen.getByText(/including my personal data/)).toBeInTheDocument();
  });

  it('keeps the Publish button disabled until the confirm checkbox is checked', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Publish to GitHub' }));
    const publishButton = await screen.findByRole('button', { name: 'Publish' });
    expect(publishButton).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(publishButton).not.toBeDisabled();
  });

  it('calls platform.brain.publishGithub with the entered URL and renders the returned link on success', async () => {
    const publishGithub = vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://github.com/LazyGod75/Lazy-Brain-David',
      message: 'Published successfully.',
    } satisfies MockPublishResult);
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }, publishGithub),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Publish to GitHub' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByPlaceholderText('https://github.com/your-account/my-brain.git'), {
      target: { value: 'https://github.com/LazyGod75/Lazy-Brain-David.git' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(publishGithub).toHaveBeenCalledWith({
      remoteUrl: 'https://github.com/LazyGod75/Lazy-Brain-David.git',
    }));
    expect(await screen.findByText(/Published successfully/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://github.com/LazyGod75/Lazy-Brain-David' }))
      .toHaveAttribute('href', 'https://github.com/LazyGod75/Lazy-Brain-David');
  });

  it('renders the honest next-step message when publishGithub reports ok: false', async () => {
    const publishGithub = vi.fn().mockResolvedValue({
      ok: false,
      message: 'No remote configured. Create an empty GitHub repo and paste its URL, or install gh (GitHub CLI) / set a GITHUB_TOKEN env var for automatic creation.',
    } satisfies MockPublishResult);
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }, publishGithub),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Publish to GitHub' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText(/No remote configured/)).toBeInTheDocument();
  });
});

// ── Sidecar independence (BRAIN-PATH TRANSPARENCY hardening) ─────────
//
// Regression coverage for the real in-app bug: MemoryPanel stayed stuck on
// "Chargement..." and the brain-path/badge never appeared because the UI
// waited on the sidecar (health()/brain.health()) instead of rendering as
// soon as the independent, Rust-only brain.info() resolved. These tests
// mock brain.info() resolving normally while health()/brain.health() either
// reject or never resolve at all, and assert the path/source/callout still
// render.

function makeSidecarBrokenPlatform(
  info: MockBrainInfo,
  health: ReturnType<typeof vi.fn>,
  brainHealth: ReturnType<typeof vi.fn>,
) {
  return {
    name: 'tauri',
    health,
    brain: {
      health: brainHealth,
      getProjects: vi.fn().mockResolvedValue([]),
      info: vi.fn().mockResolvedValue(withBrainInfoDefaults(info)),
      publishGithub: vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://github.com/LazyGod75/lazybrain-brain',
        message: 'Published successfully.',
      } satisfies MockPublishResult),
    },
  };
}

describe('MemoryPanel — brain path renders independent of the sidecar', () => {
  it('shows the brain path and env-override callout even when health() and brain.health() reject', async () => {
    mockGetPlatform.mockReturnValue(
      makeSidecarBrokenPlatform(
        { path: '/mock/global/lazy-brain-david/brain', source: 'env_override' },
        vi.fn().mockRejectedValue(new Error('sidecar unreachable')),
        vi.fn().mockRejectedValue(new Error('sidecar unreachable')),
      ),
    );
    renderPanel();

    expect(await screen.findByText(/Global brain \(LAZYBRAIN_BRAIN_PATH\)/)).toBeInTheDocument();
    expect(screen.getByText(/shared across all your projects/)).toBeInTheDocument();
  });

  it('shows the brain path even when health() and brain.health() never resolve', async () => {
    mockGetPlatform.mockReturnValue(
      makeSidecarBrokenPlatform(
        { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
        vi.fn(() => new Promise(() => {})),
        vi.fn(() => new Promise(() => {})),
      ),
    );
    renderPanel();

    // brain.info() resolves fast and independently — the path renders
    // without ever waiting on the (permanently pending) sidecar health call.
    expect(await screen.findByText(/Project brain/)).toBeInTheDocument();
    // The memory-health section, by contrast, legitimately stays on its
    // loading copy since its own promises never settle — proving the health
    // fetches are NOT combined into brain.info()'s loading state. P4 further
    // decoupled health()'s sidecar-status fetch from brain.health()'s
    // metrics fetch, so with BOTH permanently pending there are now TWO
    // independent "Chargement..." indicators, not one. (jsdom resolves
    // navigator.language to English, hence the English string here — see
    // i18n/index.tsx.)
    expect(screen.getAllByText(en['common.loading']).length).toBeGreaterThanOrEqual(1);
  });
});

describe('MemoryPanel — honest sidecar-unavailable state', () => {
  it('shows an honest message instead of an infinite spinner when the sidecar health check rejects', async () => {
    mockGetPlatform.mockReturnValue(
      makeSidecarBrokenPlatform(
        { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      ),
    );
    renderPanel();

    expect(await screen.findByText(/Brain sidecar unavailable/)).toBeInTheDocument();
    // P4 decoupled the sidecar-status and brain-health-metrics fetches into
    // two independent effects — wait for BOTH to settle (not just the one
    // findByText above happened to observe) before asserting neither is
    // still showing its own loading copy.
    await waitFor(() => expect(screen.queryByText(en['common.loading'])).toBeNull());
  });
});

// ── Health/live consistency — STALE HEALTH BADGE FIX ─────────────────
//
// A successful "Rebuild index" must at least re-trigger the refreshKey-gated
// fetches (BrainPathSection/BrainPublishSection/BrainConfigSection/
// MemoryHealthSection) instead of leaving them showing whatever they fetched
// at mount time.
//
// UPDATE — this comment previously claimed brain.rebuildGraph() (Rust:
// brain_rebuild_graph) "only runs index-rebuild + graph, never health-score".
// That is no longer accurate: brain_rebuild_graph (src-tauri/src/commands/
// brain/capture.rs) now runs index-rebuild -> graph -> build-index ->
// health-score, the last two non-fatal. The REAL bug this fix addresses is
// timing, not a missing step: that whole pipeline runs on an un-awaited
// `tokio::task::spawn_blocking` — the Tauri command resolves back to
// `await platform.brain.rebuildGraph()` almost immediately, long before
// health-score has actually written the fresh <meta name="cerveau-health">
// tag. handleRebuildIndex's immediate bumpBrainVersion() (below) therefore
// only re-fetches health WHILE the real computation is still running,
// showing a stale/0 score for as long as that background pipeline takes
// (~20s on a real project per QA). MemoryPanel now ALSO listens for
// `brain://updated` — the event the Rust side emits once the pipeline
// genuinely finishes (same event BrainSpace's graph view already refreshes
// on) — and bumps brainVersion again then, so the real score appears
// promptly after rebuild actually completes instead of only after some
// unrelated later remount/refetch.

describe('MemoryPanel — Rebuild index re-triggers refreshKey-gated fetches', () => {
  it('calls brain.info() again immediately after a successful rebuild (optimistic bump)', async () => {
    const infoMock = vi.fn().mockResolvedValue({ path: '/mock/project/.lazybrain/brain', source: 'project', noteCount: 10, isEmpty: false });
    const rebuildGraphMock = vi.fn().mockResolvedValue(undefined);
    mockGetPlatform.mockReturnValue({
      name: 'tauri',
      health: vi.fn().mockResolvedValue({
        brain: 'ok', git: 'ok', terminal: 'ok', model: 'ok', agentRunner: 'ok',
      }),
      brain: {
        health: vi.fn().mockResolvedValue(null),
        getProjects: vi.fn().mockResolvedValue([]),
        info: infoMock,
        rebuildGraph: rebuildGraphMock,
        publishGithub: vi.fn().mockResolvedValue({ ok: true, message: 'Published.' }),
      },
    });
    renderPanel();

    await screen.findByText(/Project brain/);
    const callsBeforeRebuild = infoMock.mock.calls.length;

    fireEvent.click(await screen.findByRole('button', { name: 'Rebuild index' }));

    await waitFor(() => expect(rebuildGraphMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(infoMock.mock.calls.length).toBeGreaterThan(callsBeforeRebuild));
  });

  it('refetches brain.health() again when brain://updated fires AFTER the optimistic bump — the real fix', async () => {
    // A rebuild whose background pipeline is still computing health-score
    // when rebuildGraph()'s own promise resolves: BOTH the initial mount
    // fetch AND the immediate optimistic bump (handleRebuildIndex, fired
    // right after rebuildGraph() resolves — well before the background
    // pipeline's health-score step is actually done) read the stale score
    // (0). Only the LATER brain://updated event (fired once health-score
    // has genuinely finished) must trigger the refetch that reveals the
    // real one — modeled here as the mock's base resolved value, returned
    // for every call past the two queued "still stale" ones.
    const brainHealthMock = vi.fn()
      .mockResolvedValueOnce({ score: 0, orphans: 0, brokenLinks: 0, stale: 0, dupes: 0 }) // mount
      .mockResolvedValueOnce({ score: 0, orphans: 0, brokenLinks: 0, stale: 0, dupes: 0 }) // optimistic bump — still stale
      .mockResolvedValue({ score: 75, orphans: 1, brokenLinks: 0, stale: 0, dupes: 0 });   // brain://updated bump onward — real value
    const rebuildGraphMock = vi.fn().mockResolvedValue(undefined);
    mockGetPlatform.mockReturnValue({
      name: 'tauri',
      health: vi.fn().mockResolvedValue({
        brain: 'ok', git: 'ok', terminal: 'ok', model: 'ok', agentRunner: 'ok',
      }),
      brain: {
        health: brainHealthMock,
        getProjects: vi.fn().mockResolvedValue([]),
        info: vi.fn().mockResolvedValue({ path: '/mock/project/.lazybrain/brain', source: 'project', noteCount: 10, isEmpty: false }),
        rebuildGraph: rebuildGraphMock,
        publishGithub: vi.fn().mockResolvedValue({ ok: true, message: 'Published.' }),
      },
    });
    renderPanel();

    // Initial mount fetch — first mocked resolution: still-stale score 0.
    expect(await screen.findByText('0 / 100')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Rebuild index' }));
    await waitFor(() => expect(rebuildGraphMock).toHaveBeenCalledTimes(1));

    // Optimistic bump re-fetched too, but the background pipeline hasn't
    // emitted brain://updated yet — second queued resolution is ALSO stale
    // (0), so the badge has nothing new to show yet. Now the Rust side
    // finishes for real and emits the event:
    await fireBrainUpdated();

    // Real score now visible — proves the brain://updated listener bumped
    // brainVersion and MemoryHealthSection refetched brain.health() again.
    expect(await screen.findByText('75 / 100')).toBeInTheDocument();
  });

  it('unsubscribes from brain://updated on unmount', async () => {
    mockGetPlatform.mockReturnValue({
      name: 'tauri',
      health: vi.fn().mockResolvedValue({
        brain: 'ok', git: 'ok', terminal: 'ok', model: 'ok', agentRunner: 'ok',
      }),
      brain: {
        health: vi.fn().mockResolvedValue(null),
        getProjects: vi.fn().mockResolvedValue([]),
        info: vi.fn().mockResolvedValue({ path: '/mock/project/.lazybrain/brain', source: 'project', noteCount: 10, isEmpty: false }),
        rebuildGraph: vi.fn().mockResolvedValue(undefined),
        publishGithub: vi.fn().mockResolvedValue({ ok: true, message: 'Published.' }),
      },
    });
    const { unmount } = renderPanel();

    await waitFor(() => expect(capturedUpdatedHandler).not.toBeNull());
    const unlistenForThisRender = capturedUpdatedUnlisten;
    unmount();

    expect(unlistenForThisRender).toHaveBeenCalledTimes(1);
  });
});

// ── Consolidate now (brain_consolidate_now) ──────────────────────────
//
// Unlike every other MemoryPanel action, handleConsolidateNow calls `invoke`
// directly (see MemoryPanel.tsx's top-of-file doc comment) instead of going
// through platform.brain.* — so these tests mock '@tauri-apps/api/core'
// (mockInvoke, above) rather than extending makeTauriPlatform's `brain`
// object the way the Rebuild-index tests above extend `rebuildGraph`.

describe('MemoryPanel — Consolidate now', () => {
  it('calls invoke("brain_consolidate_now") on click and shows the returned summary on success', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }),
    );
    mockInvoke.mockResolvedValue(
      'Consolidation complete: 5/5 steps ok (dream=ok, prune=ok, compress=ok, interlink=ok, profile-update=ok)',
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Consolidate now' }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('brain_consolidate_now'));
    expect(await screen.findByText(/5\/5 steps ok/)).toBeInTheDocument();
  });

  it('shows the in-progress label and disables the button while the call is pending, then re-enables it', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }),
    );
    let resolveInvoke: (v: string) => void = () => {};
    mockInvoke.mockReturnValue(new Promise<string>((resolve) => { resolveInvoke = resolve; }));
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Consolidate now' }));

    const pendingButton = await screen.findByRole('button', { name: 'Consolidating…' });
    expect(pendingButton).toBeDisabled();

    await act(async () => {
      resolveInvoke('Consolidation complete: 5/5 steps ok');
    });

    expect(await screen.findByRole('button', { name: 'Consolidate now' })).not.toBeDisabled();
  });

  it('shows an error message when invoke rejects', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }),
    );
    mockInvoke.mockRejectedValue(new Error('lazybrain.js not found'));
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Consolidate now' }));

    expect(await screen.findByText(/Consolidation failed: lazybrain\.js not found/)).toBeInTheDocument();
  });

  it('does not affect the Rebuild index button — the two actions stay independent', async () => {
    const rebuildGraphMock = vi.fn().mockResolvedValue(undefined);
    mockGetPlatform.mockReturnValue({
      ...makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }),
      brain: {
        ...makeTauriPlatform({ path: '/mock/my-project/.lazybrain/brain', source: 'project' }).brain,
        rebuildGraph: rebuildGraphMock,
      },
    });
    mockInvoke.mockResolvedValue('Consolidation complete: 5/5 steps ok');
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Rebuild index' }));
    await waitFor(() => expect(rebuildGraphMock).toHaveBeenCalledTimes(1));
    // Rebuild must not trigger the Consolidate invoke. (BrainStatsSection
    // independently calls invoke('brain_stats') on mount, so a blanket
    // not.toHaveBeenCalled() is no longer the right assertion — scope it to
    // the consolidate command this test actually cares about.)
    expect(mockInvoke).not.toHaveBeenCalledWith('brain_consolidate_now');
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
// Covers: BrainConfigSection's scope choice calling brain.setConfig(),
// BrainImportSection calling brain.importFromGithub(), the env_override
// precedence note, and the native folder dialog (openFolder()) wiring.

function makePlatformWithSetup(
  info: MockBrainInfo,
  brainOverrides?: Record<string, unknown>,
  platformOverrides?: Record<string, unknown>,
) {
  return {
    name: 'tauri',
    health: vi.fn().mockResolvedValue({
      brain: 'ok', git: 'ok', terminal: 'ok', model: 'ok', agentRunner: 'ok',
    }),
    brain: {
      health: vi.fn().mockResolvedValue(null),
      getProjects: vi.fn().mockResolvedValue([]),
      info: vi.fn().mockResolvedValue(withBrainInfoDefaults(info)),
      publishGithub: vi.fn().mockResolvedValue({
        ok: true,
        url: 'https://github.com/LazyGod75/lazybrain-brain',
        message: 'Published successfully.',
      } satisfies MockPublishResult),
      graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      setConfig: vi.fn().mockResolvedValue({ path: '/mock/configured/brain', source: 'ui_config', noteCount: 10, isEmpty: false }),
      importFromGithub: vi.fn().mockResolvedValue({ path: '/mock/imported/brain', source: 'ui_config', noteCount: 10, isEmpty: false }),
      ...brainOverrides,
    },
    ...platformOverrides,
  };
}

describe('MemoryPanel — brain setup: scope choice calls setConfig', () => {
  it('calls setConfig({mode:"project"}) immediately when "This project\'s brain" is clicked', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /This project's brain/ }));

    await waitFor(() => expect(platform.brain.setConfig).toHaveBeenCalledWith({ mode: 'project', path: undefined }));
    expect(await screen.findByText(/Active brain: \/mock\/configured\/brain/)).toBeInTheDocument();
  });

  it('calls setConfig({mode:"global", path}) after typing a path and confirming', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Shared global brain/ }));
    fireEvent.change(screen.getByPlaceholderText('/path/to/shared/brain'), {
      target: { value: '/home/user/shared-brain' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this brain' }));

    await waitFor(() => expect(platform.brain.setConfig).toHaveBeenCalledWith({
      mode: 'global',
      path: '/home/user/shared-brain',
    }));
  });

  it('calls setConfig({mode:"custom", path}) after typing a path and confirming', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Custom folder/ }));
    fireEvent.change(screen.getByPlaceholderText('/path/to/folder'), {
      target: { value: '/home/user/my-custom-brain' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use this brain' }));

    await waitFor(() => expect(platform.brain.setConfig).toHaveBeenCalledWith({
      mode: 'custom',
      path: '/home/user/my-custom-brain',
    }));
  });

  it('populates the global path field from the native folder dialog (openFolder())', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Shared global brain/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }));

    await waitFor(() => expect(mockOpenFolder).toHaveBeenCalled());
    expect(await screen.findByDisplayValue('/picked/via/dialog')).toBeInTheDocument();
  });

  it('keeps "Use this brain" disabled and never calls setConfig when no path is entered', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /Custom folder/ }));
    expect(screen.getByRole('button', { name: 'Use this brain' })).toBeDisabled();
    expect(platform.brain.setConfig).not.toHaveBeenCalled();
  });

  it('shows an honest error message when setConfig rejects', async () => {
    const platform = makePlatformWithSetup(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      { setConfig: vi.fn().mockRejectedValue(new Error('disk full')) },
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /This project's brain/ }));

    expect(await screen.findByText(/Configuration failed: disk full/)).toBeInTheDocument();
  });

  it('shows the env_override precedence note — the UI choice is a fallback while the env var is set', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/global/lazy-brain-david/brain', source: 'env_override' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    expect(await screen.findByText(/LAZYBRAIN_BRAIN_PATH is set in your environment/)).toBeInTheDocument();
    expect(screen.getByText(/takes precedence over the choice below/)).toBeInTheDocument();
  });

  it('does NOT show the precedence note for a project-scoped brain', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    await screen.findByRole('button', { name: /This project's brain/ });
    expect(screen.queryByText(/takes precedence over the choice below/)).toBeNull();
  });
});

describe('MemoryPanel — import a brain from GitHub (BrainImportSection)', () => {
  it('calls importFromGithub with the entered url + dest and shows the resulting path', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Import from GitHub' }));
    fireEvent.change(screen.getByPlaceholderText('https://github.com/account/brain-to-import.git'), {
      target: { value: 'https://github.com/LazyGod75/shared-brain.git' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/destination'), {
      target: { value: '/home/user/imported-brain' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(platform.brain.importFromGithub).toHaveBeenCalledWith({
      url: 'https://github.com/LazyGod75/shared-brain.git',
      dest: '/home/user/imported-brain',
    }));
    expect(await screen.findByText(/Brain imported and activated: \/mock\/imported\/brain/)).toBeInTheDocument();
  });

  it('populates the destination field from the native folder dialog (openFolder())', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Import from GitHub' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }));

    await waitFor(() => expect(mockOpenFolder).toHaveBeenCalled());
    expect(await screen.findByDisplayValue('/picked/via/dialog')).toBeInTheDocument();
  });

  it('keeps "Importer" disabled until the confirm checkbox and both fields are filled', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Import from GitHub' }));
    const importButton = screen.getByRole('button', { name: 'Import' });
    expect(importButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('https://github.com/account/brain-to-import.git'), {
      target: { value: 'https://github.com/x/y.git' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/destination'), {
      target: { value: '/tmp/dest' },
    });
    expect(importButton).toBeDisabled(); // still unconfirmed

    fireEvent.click(screen.getByRole('checkbox'));
    expect(importButton).not.toBeDisabled();

    expect(platform.brain.importFromGithub).not.toHaveBeenCalled();
  });

  it('shows an honest error message when importFromGithub rejects', async () => {
    const platform = makePlatformWithSetup(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      { importFromGithub: vi.fn().mockRejectedValue(new Error('repository not found')) },
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Import from GitHub' }));
    fireEvent.change(screen.getByPlaceholderText('https://github.com/account/brain-to-import.git'), {
      target: { value: 'https://github.com/x/does-not-exist.git' },
    });
    fireEvent.change(screen.getByPlaceholderText('/path/to/destination'), {
      target: { value: '/tmp/dest' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('repository not found')).toBeInTheDocument();
  });
});

describe('MemoryPanel — health/live consistency (graph() fallback)', () => {
  it('shows the sidecar as available when health()/brain.health() reject but brain.graph() succeeds', async () => {
    const platform = makePlatformWithSetup(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      { health: vi.fn().mockRejectedValue(new Error('down')), graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }) },
      { health: vi.fn().mockRejectedValue(new Error('down')) },
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    // aria-label goes through t() (unlike the hardcoded-French "Sidecar
    // brain indisponible" banner below), and jsdom resolves navigator.
    // language to English (see i18n/index.tsx) — build the expected string
    // from the same `en` locale table rather than hardcoding a language, so
    // this doesn't depend on the resolved locale. It's also unique to the
    // HealthDot, unlike the bare status word which could otherwise collide
    // with this panel's own brain-setup copy.
    expect(await screen.findByLabelText(`sidecar ${en['settings.memory.status.active']}`)).toBeInTheDocument();
    expect(screen.queryByText(/Brain sidecar unavailable/)).toBeNull();
    expect(platform.brain.graph).toHaveBeenCalled();
  });

  it('still shows the sidecar as unavailable when health(), brain.health() AND brain.graph() all fail', async () => {
    const platform = makePlatformWithSetup(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      { health: vi.fn().mockRejectedValue(new Error('down')), graph: vi.fn().mockRejectedValue(new Error('down')) },
      { health: vi.fn().mockRejectedValue(new Error('down')) },
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    expect(await screen.findByLabelText(`sidecar ${en['settings.memory.status.down']}`)).toBeInTheDocument();
    expect(await screen.findByText(/Brain sidecar unavailable/)).toBeInTheDocument();
  });
});

// ── BRAIN DISCOVERABILITY — empty-brain CTA in BrainConfigSection ───────

describe('MemoryPanel — empty-brain notice in BrainConfigSection', () => {
  it('shows the empty-brain notice when the resolved brain has 0 notes', async () => {
    const platform = makePlatformWithSetup({
      path: '/mock/my-project/.lazybrain/brain', source: 'project', noteCount: 0, isEmpty: true,
    });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    expect(await screen.findByText(/This brain is empty \(0 notes\)/)).toBeInTheDocument();
  });

  it('does NOT show the empty-brain notice when the resolved brain has notes', async () => {
    const platform = makePlatformWithSetup({
      path: '/mock/my-project/.lazybrain/brain', source: 'project', noteCount: 42, isEmpty: false,
    });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    await screen.findByRole('button', { name: /This project's brain/ });
    expect(screen.queryByText(/This brain is empty/)).toBeNull();
  });
});

// ── HEALTH PANEL METRICS decoupling (P4) ─────────────────────────────
//
// Regression coverage for the QA bug: the numeric "Santé de la mémoire"
// grid vanished entirely whenever platform.health() was slow/failed, even
// though platform.brain.health() (the metrics themselves) had already
// resolved successfully — because both were gated behind a single
// Promise.all. Each fetch must now render independently.

describe('MemoryPanel — HEALTH PANEL METRICS decoupling (P4)', () => {
  it('shows brain.health() metrics even while platform.health() never resolves', async () => {
    const platform = makePlatformWithSetup(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      { health: vi.fn().mockResolvedValue({ score: 80, orphans: 2, brokenLinks: 0, stale: 1, dupes: 0 }) },
      { health: vi.fn(() => new Promise(() => {})) }, // platform.health() never settles
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    // The metrics grid renders from brain.health() alone — it must not wait
    // on the permanently-pending top-level health() call.
    expect(await screen.findByText('80 / 100')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // orphans
  });

  it('shows sidecar status even while brain.health() never resolves', async () => {
    const platform = makePlatformWithSetup(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      { health: vi.fn(() => new Promise(() => {})) }, // platform.brain.health() never settles
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    // Sidecar status renders from platform.health() alone (default mock
    // resolves { brain: 'ok', ... }) — it must not wait on the
    // permanently-pending brain.health() call.
    expect(await screen.findByLabelText(`sidecar ${en['settings.memory.status.active']}`)).toBeInTheDocument();
  });

  it('shows an honest "metrics unavailable" note when brain.health() rejects, independent of sidecar status', async () => {
    const platform = makePlatformWithSetup(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      { health: vi.fn().mockRejectedValue(new Error('brain.health down')) },
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    expect(await screen.findByText(/Brain health metrics unavailable/)).toBeInTheDocument();
    // Sidecar status must still show as active — the two fetches are independent.
    expect(screen.getByLabelText(`sidecar ${en['settings.memory.status.active']}`)).toBeInTheDocument();
  });
});

// ── formatProportion (TASK 3 — legibility) ───────────────────────────

describe('formatProportion', () => {
  it('renders "count / total (pct%)" with one decimal under 10%', () => {
    expect(formatProportion(3047, 53268)).toBe('3047 / 53268 (5.7%)');
  });

  it('rounds to a whole number at 10% and above', () => {
    expect(formatProportion(2990, 7531)).toBe('2990 / 7531 (40%)');
  });

  it('degrades to a bare count when total is undefined (unknown denominator)', () => {
    expect(formatProportion(14, undefined)).toBe('14');
  });

  it('degrades to a bare count when total is 0 (avoids divide-by-zero/NaN%)', () => {
    expect(formatProportion(0, 0)).toBe('0');
  });
});

// ── TASK 2 — remediation UI: read-only "view details" dry-run ────────
//
// Settings > Memory previously showed 3047 broken links / 2990 duplicates
// with no way to act on them. MetricRow now grows a "View details" button
// for actionable, non-zero metrics (orphans / brokenLinks / duplicates —
// NOT stale/score), which opens DetailPanel: a read-only preview backed by
// platform.brain.healthDetail(), never a mutation.

describe('MemoryPanel — health remediation: view details (TASK 2)', () => {
  function makePlatformWithHealthDetail(
    brainHealth: { score: number; orphans: number; brokenLinks: number; stale: number; dupes: number; totalNotes?: number; totalLinks?: number },
    healthDetail: ReturnType<typeof vi.fn>,
  ) {
    return makePlatformWithSetup(
      { path: '/mock/my-project/.lazybrain/brain', source: 'project' },
      { health: vi.fn().mockResolvedValue(brainHealth), healthDetail },
    );
  }

  it('shows proportions when totalNotes/totalLinks are present', async () => {
    const platform = makePlatformWithHealthDetail(
      { score: 70, orphans: 14, brokenLinks: 3047, stale: 2, dupes: 2990, totalNotes: 7531, totalLinks: 53268 },
      vi.fn(),
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    expect(await screen.findByText('3047 / 53268 (5.7%)')).toBeInTheDocument();
    expect(screen.getByText('2990 / 7531 (40%)')).toBeInTheDocument();
    expect(screen.getByText('14 / 7531 (0.2%)')).toBeInTheDocument();
  });

  it('shows a "View details" button only for non-zero actionable metrics, not stale or score', async () => {
    const platform = makePlatformWithHealthDetail(
      { score: 70, orphans: 14, brokenLinks: 3047, stale: 2, dupes: 2990, totalNotes: 7531, totalLinks: 53268 },
      vi.fn(),
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    await screen.findByText('3047 / 53268 (5.7%)');
    const viewDetailsButtons = screen.getAllByRole('button', { name: en['settings.memory.detail.viewButton'] });
    // orphans, brokenLinks, dupes — exactly 3, none for stale/score.
    expect(viewDetailsButtons).toHaveLength(3);
  });

  it('does not show a "View details" button for a zero-count actionable metric', async () => {
    const platform = makePlatformWithHealthDetail(
      { score: 100, orphans: 0, brokenLinks: 0, stale: 0, dupes: 0, totalNotes: 100, totalLinks: 10 },
      vi.fn(),
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    await screen.findByText(en['settings.memory.health.title']);
    expect(screen.queryByRole('button', { name: en['settings.memory.detail.viewButton'] })).not.toBeInTheDocument();
  });

  it('clicking "View details" on broken links calls healthDetail(\'brokenLinks\') and renders the read-only preview', async () => {
    const healthDetail = vi.fn().mockResolvedValue({
      category: 'brokenLinks',
      total: 2,
      shown: 2,
      truncated: false,
      brokenLinks: [
        { fromId: 'a', fromTitle: 'Source note A', toId: 'ghost-1' },
        { fromId: 'b', fromTitle: 'Source note B', toId: 'ghost-2' },
      ],
    });
    const platform = makePlatformWithHealthDetail(
      { score: 70, orphans: 0, brokenLinks: 2, stale: 0, dupes: 0 },
      healthDetail,
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    const button = await screen.findByRole('button', { name: en['settings.memory.detail.viewButton'] });
    fireEvent.click(button);

    await waitFor(() => expect(healthDetail).toHaveBeenCalledWith('brokenLinks'));
    expect(await screen.findByText('2 item(s) found')).toBeInTheDocument();
    expect(screen.getByText(/Source note A \(#a\) → ghost-1/)).toBeInTheDocument();
    expect(screen.getByText(/Source note B \(#b\) → ghost-2/)).toBeInTheDocument();
    // Honesty copy: read-only, and the apply step is explicitly not implemented.
    expect(screen.getByText(en['settings.memory.detail.readOnlyNote'])).toBeInTheDocument();
    expect(screen.getByText(en['settings.memory.detail.applyFollowUp'])).toBeInTheDocument();
  });

  it('shows an honest error when healthDetail() rejects', async () => {
    const healthDetail = vi.fn().mockRejectedValue(new Error('sidecar unreachable'));
    const platform = makePlatformWithHealthDetail(
      { score: 70, orphans: 3, brokenLinks: 0, stale: 0, dupes: 0 },
      healthDetail,
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: en['settings.memory.detail.viewButton'] }));
    expect(await screen.findByText(/Could not load details: sidecar unreachable/)).toBeInTheDocument();
  });

  it('closes the detail panel via the close button', async () => {
    const healthDetail = vi.fn().mockResolvedValue({ category: 'orphans', total: 0, shown: 0, truncated: false, orphans: [] });
    const platform = makePlatformWithHealthDetail(
      { score: 70, orphans: 3, brokenLinks: 0, stale: 0, dupes: 0 },
      healthDetail,
    );
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: en['settings.memory.detail.viewButton'] }));
    await screen.findByText(en['settings.memory.detail.readOnlyNote']);

    fireEvent.click(screen.getByRole('button', { name: en['common.close'] }));
    await waitFor(() => expect(screen.queryByText(en['settings.memory.detail.readOnlyNote'])).not.toBeInTheDocument());
  });
});

// ── DEAD EMBEDDINGS TOGGLE removed (P3) ──────────────────────────────
//
// The lazy.brain.embeddings toggle never controlled anything real
// (LAZYBRAIN_EMBEDDINGS=1 is hardcoded at every Rust sidecar/CLI spawn
// site) — replaced with an honest read-only status instead of a
// misleading control.

describe('MemoryPanel — embeddings toggle replaced with read-only status (P3)', () => {
  it('shows the semantic-recall status text without an interactive switch for it', async () => {
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    expect(await screen.findByText(/Semantic recall \(embeddings\) — always on/)).toBeInTheDocument();
    // Only the "Memory scopes" toggle remains a real switch — the
    // embeddings control was removed entirely, not just disabled.
    expect(screen.getAllByRole('switch')).toHaveLength(1);
  });

  it('no longer persists anything to the legacy lazy.brain.embeddings localStorage key', async () => {
    localStorage.removeItem('lazy.brain.embeddings');
    const platform = makePlatformWithSetup({ path: '/mock/my-project/.lazybrain/brain', source: 'project' });
    mockGetPlatform.mockReturnValue(platform);
    renderPanel();

    await screen.findByText(/Semantic recall \(embeddings\) — always on/);
    expect(localStorage.getItem('lazy.brain.embeddings')).toBeNull();
  });
});

// ── Diagnostics card (brain_stats) ───────────────────────────────────
//
// BrainStatsSection surfaces the engine `stats` command via
// invoke('brain_stats') (same direct-invoke pattern as Consolidate). It must
// render the router distribution / latency / avg-injected metrics on success
// and degrade to a muted dash on any failure — never throw out of the panel.

describe('MemoryPanel — diagnostics card (brain_stats)', () => {
  it('renders routing distribution, p50 latency, avg injected tokens and note totals', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/p/.lazybrain/brain', source: 'project' }),
    );
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'brain_stats') {
        return Promise.resolve({
          window_hours: 24,
          totals: { notes_total: 12, notes_active: 10, notes_invalidated: 2 },
          by_type: [{ type: 'decision', n: 5 }],
          queries_total: 8,
          routing_distribution_pct: { L1: '50.0', L2: '25.0', L3: '25.0', L4: '0.0' },
          l1_routing_rate_pct: '50.0',
          latency_p50_ms_by_level: { L1: 2, L2: 6 },
          captures_count: 3,
          avg_inject_tokens: 640,
        });
      }
      return Promise.resolve(undefined);
    });
    renderPanel();

    expect(await screen.findByText('Diagnostics')).toBeInTheDocument();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('brain_stats'));
    expect(await screen.findByText(/L1 50\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/L1 2ms/)).toBeInTheDocument();
    expect(screen.getByText('640')).toBeInTheDocument();
    expect(screen.getByText('10 / 12')).toBeInTheDocument();
    // queries_total is 8 (> 0) — the real numbers show, never the
    // fresh-brain "awaiting queries" placeholder.
    expect(screen.queryByText(en['settings.memory.stats.awaitingQueries'])).toBeNull();
  });

  it('shows a muted "awaiting queries" placeholder (not a wall of 0.0%/0) for a fresh brain with no queries', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/p/.lazybrain/brain', source: 'project' }),
    );
    // A brain that has been indexed (12 notes) but never queried: every router
    // level is 0.0%, no latency samples, 0 avg-injected tokens — all REAL, but
    // rendered verbatim they read as "broken".
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'brain_stats') {
        return Promise.resolve({
          window_hours: 24,
          totals: { notes_total: 12, notes_active: 10, notes_invalidated: 2 },
          by_type: [],
          queries_total: 0,
          routing_distribution_pct: { L1: '0.0', L2: '0.0', L3: '0.0', L4: '0.0' },
          l1_routing_rate_pct: '0.0',
          latency_p50_ms_by_level: {},
          captures_count: 0,
          avg_inject_tokens: 0,
        });
      }
      return Promise.resolve(undefined);
    });
    renderPanel();

    expect(await screen.findByText('Diagnostics')).toBeInTheDocument();
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('brain_stats'));

    // routing + latency + avg-inject collapse to the muted placeholder…
    await waitFor(() =>
      expect(screen.getAllByText(en['settings.memory.stats.awaitingQueries'])).toHaveLength(3),
    );
    // …instead of the misleading "L1 0.0% · L2 0.0% · …" wall of zeros.
    expect(screen.queryByText(/L1 0\.0%/)).toBeNull();
    // Notes totals are independent of query traffic — still the real count.
    expect(screen.getByText('10 / 12')).toBeInTheDocument();
  });

  it('degrades to an honest "unavailable" line when brain_stats rejects (fail-soft)', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/p/.lazybrain/brain', source: 'project' }),
    );
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'brain_stats'
        ? Promise.reject(new Error('lazybrain.js not found'))
        : Promise.resolve(undefined),
    );
    renderPanel();

    expect(await screen.findByText('Diagnostics unavailable.')).toBeInTheDocument();
  });
});

// ── Danger zone — Reset brain (brain_wipe) ───────────────────────────
//
// DangerZoneSection is the destructive reset: it must reveal the EXACT brain
// path, keep the confirm button disabled until the literal RESET token is
// typed, call invoke('brain_wipe') on confirm, and warn extra-hard when the
// active brain is the shared global/personal one (source === 'env_override').

describe('MemoryPanel — danger zone reset (brain_wipe)', () => {
  it('reveals the exact brain path and only arms reset once RESET is typed', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/p/.lazybrain/brain', source: 'project' }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset brain' }));
    // The bare path is unique to the (now-expanded) danger zone — BrainPathSection
    // shows it only prefixed with "Project brain: ", and the publish section's
    // own bare-path node is not expanded here.
    expect(await screen.findByText('/mock/p/.lazybrain/brain')).toBeInTheDocument();

    const confirmBtn = screen.getByRole('button', { name: 'Reset brain permanently' });
    expect(confirmBtn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('RESET'), { target: { value: 'RESET' } });
    expect(confirmBtn).not.toBeDisabled();
  });

  it('keeps reset disabled for a wrong confirmation word', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/p/.lazybrain/brain', source: 'project' }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset brain' }));
    fireEvent.change(await screen.findByPlaceholderText('RESET'), { target: { value: 'reset please' } });
    expect(screen.getByRole('button', { name: 'Reset brain permanently' })).toBeDisabled();
  });

  it('calls invoke("brain_wipe") on confirm and shows the deleted-count success', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/p/.lazybrain/brain', source: 'project' }),
    );
    mockInvoke.mockImplementation((cmd: string) =>
      cmd === 'brain_wipe'
        ? Promise.resolve({ path: '/mock/p/.lazybrain/brain', report: { notesDeleted: 7 } })
        : Promise.resolve(undefined),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset brain' }));
    fireEvent.change(await screen.findByPlaceholderText('RESET'), { target: { value: 'RESET' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset brain permanently' }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('brain_wipe'));
    expect(await screen.findByText(/7 notes deleted/)).toBeInTheDocument();
  });

  it('warns that the target is the global/personal brain when source is env_override', async () => {
    mockGetPlatform.mockReturnValue(
      makeTauriPlatform({ path: '/mock/global/lazy-brain-david/brain', source: 'env_override' }),
    );
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Reset brain' }));
    expect(await screen.findByText(/your global personal brain/)).toBeInTheDocument();
  });
});
