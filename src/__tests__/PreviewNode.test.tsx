/**
 * PreviewNode.test.tsx — R7 (living surfaces). Covers the localhost-only URL
 * restriction (`isAllowedPreviewUrl`), the honest loading/unreachable/
 * reachable states (driven by a mocked `fetch`, same `no-cors` reachability
 * probe technique src/lib/platform/web.ts's `checkBrainReachable` already
 * uses elsewhere in this app), and the NodeResizer -> canvasStore wiring
 * (same convention as TerminalNode.test.tsx).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { PREVIEW_FOCUS_MIN_ZOOM, type SurfaceSpec } from '../components/agents/canvas/canvasTypes';
import { on } from '../lib/bus';
import { _resetPreviewLiveCoordinatorForTests } from '../components/agents/canvas/nodes/previewLiveCoordinator';
import { setSystemPressureForTests, resetSystemPressureForTests } from '../lib/agents/systemPressure';

interface CapturedResizerProps {
  onResizeEnd?: (event: unknown, params: { x: number; y: number; width: number; height: number }) => void;
}
let capturedResizerProps: CapturedResizerProps | null = null;

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    NodeResizer: (props: CapturedResizerProps) => {
      capturedResizerProps = props;
      return null;
    },
  };
});

const openExternalMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/platform/openExternal', () => ({
  openExternal: (url: string) => openExternalMock(url),
}));

import {
  PreviewNodeCard,
  ArtifactSurfaceCard,
  isAllowedPreviewUrl,
  computeContainedLayout,
} from '../components/agents/canvas/nodes/PreviewNode';

/** Test-only stand-in for a sandboxed artifact iframe's own rendered
 *  document — see ArtifactSurfaceCard's own AUTO-SCALE FIX doc comment.
 *  jsdom has no real layout engine (scrollWidth/scrollHeight are always 0 by
 *  default), so this stubs `contentDocument` on a live iframe element to
 *  report a specific intrinsic size, then fires `load` — exactly the signal
 *  `measureSandboxedContentSize`'s own `onLoad` handler reacts to. */
function stubIframeContentSize(iframe: HTMLIFrameElement, width: number, height: number): void {
  Object.defineProperty(iframe, 'contentDocument', {
    configurable: true,
    get: () => ({
      documentElement: { scrollWidth: width, scrollHeight: height },
      body: { scrollWidth: width, scrollHeight: height },
    }),
  });
  fireEvent.load(iframe);
}

// fix/canvas-legibility — `selected` defaults to `true`: PreviewNodeCard now
// has a repli-compact tier (livingPaneCompactCard.test.tsx covers it) that
// collapses a url-less/non-full-zoom preview to a small summary card;
// `selected` always forces the full interactive card (URL bar, close,
// resizer — see PreviewNode.tsx's own doc comment on why this override is
// required), which is what every pre-existing test in this file exercises.
function renderCard(data: SurfaceSpec, selected = true) {
  return render(
    <I18nProvider>
      <PreviewNodeCard data={data} selected={selected} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  // P59 — previewLiveCoordinator.ts's single-live-slot state is module-scope
  // (process-lifetime) singleton state, same "test hygiene" reason
  // _resetCanvasStoreForTests above already exists for canvasStore.ts — every
  // test in this file uses the SAME surface id ('p1'), so a prior test's
  // attend/unattend calls must never leak into the next one.
  _resetPreviewLiveCoordinatorForTests();
  // Fix 5 — systemPressure.ts is ALSO a module-scope singleton; every
  // pre-existing test in this file must see the same 'normal' default it
  // always has, regardless of what a LATER-added pressure test sets.
  resetSystemPressureForTests();
  capturedResizerProps = null;
  vi.restoreAllMocks();
  openExternalMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resetSystemPressureForTests();
});

describe('isAllowedPreviewUrl — localhost-only restriction (security note)', () => {
  it('accepts http://localhost:*', () => {
    expect(isAllowedPreviewUrl('http://localhost:3000')).toBe(true);
    expect(isAllowedPreviewUrl('http://localhost:5173/path')).toBe(true);
  });
  it('accepts http://127.0.0.1:*', () => {
    expect(isAllowedPreviewUrl('http://127.0.0.1:8080')).toBe(true);
  });
  it('rejects a non-localhost host', () => {
    expect(isAllowedPreviewUrl('http://example.com')).toBe(false);
  });
  it('rejects https (even to localhost — dev servers here are plain http)', () => {
    expect(isAllowedPreviewUrl('https://localhost:3000')).toBe(false);
  });
  it('rejects a malformed URL rather than throwing', () => {
    expect(isAllowedPreviewUrl('not a url')).toBe(false);
  });
});

describe('PreviewNodeCard', () => {
  it('shows an honest empty state when no URL is set yet', () => {
    renderCard({ id: 'p1', kind: 'preview' });
    expect(screen.getByTestId('preview-node-empty-p1')).toBeInTheDocument();
  });

  it('rejects a non-localhost URL entered in the bar, inline, without ever updating the surface', () => {
    renderCard({ id: 'p1', kind: 'preview' });
    const input = screen.getByTestId('preview-node-url-input-p1');
    fireEvent.change(input, { target: { value: 'http://evil.example.com' } });
    fireEvent.blur(input);

    expect(screen.getByTestId('preview-node-invalid-url-p1')).toBeInTheDocument();
    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'p1')?.url).toBeUndefined();
  });

  it('accepts a localhost URL and shows "reachable" (iframe) once the probe resolves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' });

    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());
    expect(screen.getByTestId('preview-node-iframe-p1')).toHaveAttribute('src', 'http://localhost:5173');
  });

  // Bug fix (IPv6/localhost gotcha): a dev server bound to IPv4 only can be
  // genuinely up while `localhost` resolves to the unreachable IPv6 ::1 in
  // the WebView — the probe must fall back to the literal 127.0.0.1 without
  // ever touching the DISPLAYED url (iframe src stays what the user typed).
  it('treats a 127.0.0.1-reachable server as online even though only "localhost" ever resolved before (IPv6 gotcha fix)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).startsWith('http://127.0.0.1:5173')
        ? Promise.resolve({})
        : Promise.reject(new TypeError('network error')),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' });

    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());
    // The probe fetched 127.0.0.1 internally...
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:5173/', expect.objectContaining({ mode: 'no-cors' }));
    // ...but the displayed/persisted url and the iframe src are untouched.
    expect(screen.getByTestId('preview-node-iframe-p1')).toHaveAttribute('src', 'http://localhost:5173');
  });

  it('probes a non-localhost hostname (127.0.0.1) verbatim, never rewritten', async () => {
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal('fetch', fetchMock);
    renderCard({ id: 'p1', kind: 'preview', url: 'http://127.0.0.1:8080' });

    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080', expect.objectContaining({ mode: 'no-cors' }));
  });

  // R13 — the old one-shot probe used to go straight from "loading" to a
  // permanent "unreachable" after a single failed fetch. It now POLLS
  // (previewProbe.ts): a failed first attempt reads as "starting" (a cold
  // dev server still binding its port), and only reaching the full
  // PREVIEW_PROBE_TIMEOUT_MS (60s) window of failures honestly reports
  // "unreachable" — see previewProbe.ts's own header/tests for the state
  // machine itself.
  it('shows "starting" (never a premature "unreachable") after the first failed probe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' });

    await waitFor(() => expect(screen.getByTestId('preview-node-starting-p1')).toBeInTheDocument());
    expect(screen.queryByTestId('preview-node-unreachable-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-iframe-p1')).not.toBeInTheDocument();
  });

  // The full "polling exhausts the 60s window -> unreachable" transition is
  // exhaustively covered as a PURE function in previewProbe.test.ts
  // (reduceProbeResult/nextProbeDelayMs) — deliberately not re-proven here
  // via real/fake timers: even after P59's fix (probeReachable's timeout is
  // now a plain, cancellable setTimeout — see that function's own header),
  // a component-level 60s drain is still slower and less direct than the
  // pure reducer test for the exact same guarantee.

  it('the manual refresh button re-arms polling from a fresh probe — reports "reachable" once the (now-fixed) server responds', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    vi.stubGlobal('fetch', fetchMock);
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' });

    await waitFor(() => expect(screen.getByTestId('preview-node-starting-p1')).toBeInTheDocument());

    fetchMock.mockResolvedValue({}); // the server is now actually up
    fireEvent.click(screen.getByTestId('preview-node-refresh-p1'));

    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());
  });

  it('defense-in-depth: a PERSISTED (not user-typed) non-localhost url is rejected too, never probed/rendered', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    renderCard({ id: 'p1', kind: 'preview', url: 'http://evil.example.com' });

    expect(screen.getByTestId('preview-node-invalid-url-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-iframe-p1')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled(); // never even attempts the reachability probe
  });

  it('close button removes the surface', () => {
    canvasStoreVanilla.getState().addSurface({ id: 'p1', kind: 'preview' });
    renderCard({ id: 'p1', kind: 'preview' });

    fireEvent.click(screen.getByTestId('preview-node-close-p1'));

    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'p1')).toBeUndefined();
  });

  it('NodeResizer onResizeEnd persists the new size via updateSurface', () => {
    canvasStoreVanilla.getState().addSurface({ id: 'p1', kind: 'preview' });
    renderCard({ id: 'p1', kind: 'preview' });

    capturedResizerProps?.onResizeEnd?.(null, { x: 0, y: 0, width: 640, height: 420 });

    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'p1');
    expect(surface?.width).toBe(640);
    expect(surface?.height).toBe(420);
  });
});

// W-PREVIEWFIX — once previewProbe.ts's cold-start window (previewProbe.test.ts's
// own turf) gives up, PreviewNode.tsx now keeps probing forever on
// previewBackoff.ts's slow, capped schedule instead of going silent. These
// tests drive that hand-off with fake timers, deliberately WITHOUT draining
// the cold-start window's ~11 real retries one by one (the exact drain the
// pre-existing "R13" comment above already flags as flaky under fake
// timers): `vi.setSystemTime` jumps only `Date.now()` forward past the 60s
// budget, leaving the fake timer queue itself untouched, so the single
// already-scheduled cold-start retry is what discovers the timeout the
// instant it fires — no waitFor (real-timer polling) is used anywhere below.
describe('PreviewNodeCard — W-PREVIEWFIX backoff once cold-start gives up', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Renders, drains the first (immediate) failed probe, then jumps the
   *  clock past previewProbe's 60s cold-start budget so the already-
   *  scheduled retry gives up on its very next fire — landing in
   *  'unreachable' with the backoff layer now armed. `dataOverrides` lets a
   *  caller render with extra SurfaceSpec fields (e.g. `autoAdded: true`
   *  for the preview lifecycle removal tests below) without touching the
   *  many pre-existing callers that pass none.
   *
   *  act() hygiene (W-PREVIEWFIX test-fix): every fake-timer advance below
   *  is wrapped in `await act(async () => …)` — the same RTL convention
   *  useCanvasAutoComposition.test.tsx already follows — because advancing
   *  the clock fires the probe/backoff/countdown effects' React state
   *  updates (setProbe/setNextRetryAtMs/setNowTick), and React 19 flags
   *  any update landed outside act. Left raw, that error surfaces as a
   *  5000ms hang under fake timers instead of a clean pass (the countdown's
   *  setInterval(setNowTick, 1000) is exactly the case act() exists to
   *  absorb); this is precisely the regression these tests used to hit.
   *  `advanceAsync` is the single act-wrapped way to move the clock here. */
  async function advanceAsync(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function reachBackoff(fetchMock: ReturnType<typeof vi.fn>, dataOverrides: Partial<SurfaceSpec> = {}) {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173', ...dataOverrides });
    await advanceAsync(0); // first probe rejects -> 'starting'
    vi.setSystemTime(Date.now() + 61_000); // Date-only jump, timer queue untouched
    await advanceAsync(2_000); // fires the scheduled cold-start retry
    // P59 — one more 0ms flush: probeReachable's reachability-timeout is now
    // a plain, cancellable setTimeout (see that function's own header) —
    // fake-timer-visible where `AbortSignal.timeout()` never was — so the
    // jump above can leave more than one timer simultaneously overdue (the
    // retry AND a stale per-probe timeout). This extra pass drains whatever
    // that settles without changing which state is reached, just guaranteeing
    // it's actually committed before the assertions below run.
    await advanceAsync(0);
  }

  it('gives up into "unreachable" with a countdown once the cold-start window is exhausted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    await reachBackoff(fetchMock);

    expect(screen.getByTestId('preview-node-unreachable-p1')).toBeInTheDocument();
    expect(screen.getByTestId('preview-node-unreachable-p1-countdown')).toHaveTextContent('5');
  });

  it('backs off on the 5s / 15s / 45s / 120s / 300s schedule while still down', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    await reachBackoff(fetchMock);
    const callsAtBackoffStart = fetchMock.mock.calls.length;

    await advanceAsync(5_000);
    expect(fetchMock.mock.calls.length).toBe(callsAtBackoffStart + 1);
    expect(screen.getByTestId('preview-node-unreachable-p1-countdown')).toHaveTextContent('15');

    await advanceAsync(15_000);
    expect(fetchMock.mock.calls.length).toBe(callsAtBackoffStart + 2);
    expect(screen.getByTestId('preview-node-unreachable-p1-countdown')).toHaveTextContent('45');

    await advanceAsync(45_000);
    expect(fetchMock.mock.calls.length).toBe(callsAtBackoffStart + 3);
    expect(screen.getByTestId('preview-node-unreachable-p1-countdown')).toHaveTextContent('120');

    await advanceAsync(120_000);
    expect(fetchMock.mock.calls.length).toBe(callsAtBackoffStart + 4);
    expect(screen.getByTestId('preview-node-unreachable-p1-countdown')).toHaveTextContent('300');

    await advanceAsync(300_000);
    expect(fetchMock.mock.calls.length).toBe(callsAtBackoffStart + 5);
  });

  // W-PREVIEWFIX-STOP — the schedule above used to repeat its 300s cap
  // forever. Once a failure has survived a full trip down it to that
  // slowest rung, PreviewNode.tsx now gives up rather than scheduling a 6th
  // automatic retry: the countdown disappears (the existing "Serveur
  // injoignable" message is all that's left) and no further fetch fires
  // even after waiting the same delay again.
  it('gives up after a continuous failure survives the full schedule, instead of repeating the 300s cap forever', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    await reachBackoff(fetchMock);

    await advanceAsync(5_000); // 5s retry
    await advanceAsync(15_000); // 15s retry
    await advanceAsync(45_000); // 45s retry
    await advanceAsync(120_000); // 120s retry
    await advanceAsync(300_000); // 300s retry — the schedule's last rung
    const callsAfterFullSchedule = fetchMock.mock.calls.length;

    expect(screen.queryByTestId('preview-node-unreachable-p1-countdown')).not.toBeInTheDocument();
    expect(screen.getByTestId('preview-node-unreachable-p1')).toBeInTheDocument();

    // No further automatic retry, however long we wait.
    await advanceAsync(300_000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFullSchedule);
  });

  // Preview lifecycle fix — a dev server that never recovers must not leave
  // an auto-suggested card frozen on the canvas forever (real QA: a
  // "Serveur injoignable" preview surviving even across app restarts).
  it('removes an AUTO-ADDED preview from the canvas after a grace period once it permanently gives up', async () => {
    canvasStoreVanilla.getState().addSurface({ id: 'p1', kind: 'preview', url: 'http://localhost:5173', autoAdded: true });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    await reachBackoff(fetchMock, { autoAdded: true });

    await advanceAsync(5_000); // 5s retry
    await advanceAsync(15_000); // 15s retry
    await advanceAsync(45_000); // 45s retry
    await advanceAsync(120_000); // 120s retry
    await advanceAsync(300_000); // 300s retry — give-up fires, removal grace timer armed

    // Still there — the grace period has not elapsed yet.
    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'p1')).toBeDefined();

    await advanceAsync(10_000); // grace period elapses
    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'p1')).toBeUndefined();
  });

  it('never auto-removes a MANUALLY-added preview even after it permanently gives up — the user asked for this one explicitly', async () => {
    canvasStoreVanilla.getState().addSurface({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }); // no autoAdded
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    await reachBackoff(fetchMock);

    await advanceAsync(5_000);
    await advanceAsync(15_000);
    await advanceAsync(45_000);
    await advanceAsync(120_000);
    await advanceAsync(300_000); // give-up fires — no removal timer armed for a manual preview
    await advanceAsync(30_000); // well past any grace period

    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'p1')).toBeDefined();
  });

  it('a manual refresh before the grace period elapses cancels the pending removal', async () => {
    canvasStoreVanilla.getState().addSurface({ id: 'p1', kind: 'preview', url: 'http://localhost:5173', autoAdded: true });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    await reachBackoff(fetchMock, { autoAdded: true });

    await advanceAsync(5_000);
    await advanceAsync(15_000);
    await advanceAsync(45_000);
    await advanceAsync(120_000);
    await advanceAsync(300_000); // give-up — removal grace timer armed

    fetchMock.mockResolvedValue({}); // the server is actually back up
    fireEvent.click(screen.getByTestId('preview-node-refresh-p1')); // restarts the whole effect from scratch
    await advanceAsync(0);

    // Well past the grace window that WOULD have fired — the restart
    // cancelled it (see the effect's own cleanup).
    await advanceAsync(30_000);
    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'p1')).toBeDefined();
  });

  // W-PREVIEWFIX-STOP — a backgrounded/minimized app must not keep polling
  // a persisted preview it's not even rendering to anyone (same
  // `document.hidden` signal canvasPersistence.ts's autosave flush and
  // BrainGraph3D's render loop already gate on).
  it('pauses the backoff timer while the document is hidden, and fires the pending retry immediately once visible again', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    await reachBackoff(fetchMock);
    const callsAtBackoffStart = fetchMock.mock.calls.length;

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    // visibilitychange handlers update React state (the resumed backoff
    // probe) and must therefore run inside act — see advanceAsync's note.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // The already-armed 5s retry is cancelled outright — waiting it out
    // (and well past it) makes no further fetch call while hidden.
    await advanceAsync(30_000);
    expect(fetchMock.mock.calls.length).toBe(callsAtBackoffStart);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advanceAsync(0);

    expect(fetchMock.mock.calls.length).toBe(callsAtBackoffStart + 1);
  });

  it('a success during backoff reports "reachable" and clears the countdown', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    await reachBackoff(fetchMock);

    fetchMock.mockResolvedValue({}); // the server is back up
    await advanceAsync(5_000); // the first backoff retry

    expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-unreachable-p1')).not.toBeInTheDocument();
  });

  it('manual refresh during backoff retries immediately and resets the schedule', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    await reachBackoff(fetchMock);
    const callsBeforeRefresh = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByTestId('preview-node-refresh-p1'));
    await advanceAsync(0); // the refresh's own fresh probe, no wait

    expect(fetchMock.mock.calls.length).toBe(callsBeforeRefresh + 1);
    // Fresh cold-start attempt failed too -> back to "starting", NOT the
    // backoff's "unreachable" — proves the whole effect (and its backoff
    // streak) restarted from scratch rather than resuming mid-schedule.
    expect(screen.getByTestId('preview-node-starting-p1')).toBeInTheDocument();
  });

  // Console-spam fix — a capped diagnostic (console.warn/info) fires
  // exactly once per STATE TRANSITION, never once per probe/backoff
  // attempt (real QA: dozens of console lines/minute from a target stuck
  // erroring).
  describe('console-spam fix — one trace per state transition, never per attempt', () => {
    it('logs exactly one warning when the cold-start window gives up and hands off to backoff', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
      await reachBackoff(fetchMock);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('http://localhost:5173');
    });

    it('never logs again across multiple backoff retries while still failing (capped, not per attempt)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
      await reachBackoff(fetchMock);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Three more failed backoff attempts (5s/15s/45s) — the fetch mock
      // proves each one really did retry, but NONE of them adds a new log.
      const callsBefore = fetchMock.mock.calls.length;
      await advanceAsync(5_000);
      await advanceAsync(15_000);
      await advanceAsync(45_000);
      expect(fetchMock.mock.calls.length).toBe(callsBefore + 3);

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('logs exactly one more warning (total 2) when backoff permanently gives up — never one per retry along the way', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
      await reachBackoff(fetchMock); // warn #1: entering backoff

      await advanceAsync(5_000);
      await advanceAsync(15_000);
      await advanceAsync(45_000);
      await advanceAsync(120_000);
      await advanceAsync(300_000); // give-up fires here — warn #2

      expect(warnSpy).toHaveBeenCalledTimes(2);

      // Waiting arbitrarily longer never adds a third.
      await advanceAsync(300_000);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it('logs exactly one info line on recovery, and never logs the give-up warning it preempted', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
      await reachBackoff(fetchMock); // warn #1: entering backoff
      expect(warnSpy).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValue({}); // the server is back up
      await advanceAsync(5_000); // the first backoff retry succeeds

      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy.mock.calls[0][0]).toContain('http://localhost:5173');
      // Recovered — the permanent give-up branch never ran, so warn stays
      // at the single "entering backoff" line from before.
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// P48 — friction fixes: hover-visible URL input (not selection-only),
// LIVE/OFFLINE badge (also a "Réessayer" affordance), "Ouvrir dans le
// navigateur", and the auto-started project+port title.
describe('PreviewNodeCard — P48 UX', () => {
  it('a real hover reveals the full card (URL input) for an unselected, url-less preview — not selection-only anymore', () => {
    renderCard({ id: 'p1', kind: 'preview' }, false);

    // Collapsed to the compact chip while neither selected nor hovered.
    expect(screen.getByTestId('living-pane-chip-preview-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-url-input-p1')).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByTestId('preview-node-compact-p1'));
    expect(screen.getByTestId('preview-node-url-input-p1')).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByTestId('preview-node-p1'));
    expect(screen.queryByTestId('preview-node-url-input-p1')).not.toBeInTheDocument();
    expect(screen.getByTestId('living-pane-chip-preview-p1')).toBeInTheDocument();
  });

  it('shows the OFFLINE badge before the probe ever succeeds, and LIVE once the iframe renders', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' });

    expect(screen.getByTestId('preview-node-status-badge-p1')).toHaveTextContent('Offline');

    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());
    expect(screen.getByTestId('preview-node-status-badge-p1')).toHaveTextContent('Live');
  });

  it('clicking the OFFLINE badge re-probes immediately (same effect as the refresh button)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network error'));
    vi.stubGlobal('fetch', fetchMock);
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' });

    await waitFor(() => expect(screen.getByTestId('preview-node-starting-p1')).toBeInTheDocument());

    fetchMock.mockResolvedValue({}); // the server is now actually up
    fireEvent.click(screen.getByTestId('preview-node-status-badge-p1'));

    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());
  });

  it('clicking the LIVE badge does nothing (nothing to retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({});
    vi.stubGlobal('fetch', fetchMock);
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' });
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());

    const callsBeforeClick = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId('preview-node-status-badge-p1'));
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBe(callsBeforeClick);
  });

  it('"Ouvrir dans le navigateur" opens the URL via openExternal, never navigates the iframe itself', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' });

    fireEvent.click(screen.getByTestId('preview-node-open-external-p1'));

    expect(openExternalMock).toHaveBeenCalledWith('http://localhost:5173');
  });

  it('no status badge / open-external button while there is no URL yet', () => {
    renderCard({ id: 'p1', kind: 'preview' });
    expect(screen.queryByTestId('preview-node-status-badge-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-open-external-p1')).not.toBeInTheDocument();
  });

  it('shows the project name + port title for an auto-added preview, absent for a manually-added one', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:3000', projectId: 'C:\\proj\\LazySite-internet', autoAdded: true });

    expect(screen.getByTestId('preview-node-title-p1')).toHaveTextContent('LazySite-internet:3000');
  });

  it('no title for a manually-added preview even with a projectId set', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network error')));
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:3000', projectId: 'C:\\proj\\LazySite-internet' });

    expect(screen.queryByTestId('preview-node-title-p1')).not.toBeInTheDocument();
  });
});

describe('PreviewGoLiveCard — substantial collapsed card + "Voir en direct" (fix/canvas-agents-visibility)', () => {
  it('shows url + status + a "Voir en direct" button instead of the bare chip when collapsed with a url set, and clicking it asks the canvas to focus this preview', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    const focusEvents: Array<{ ref: string; minZoom?: number }> = [];
    const unsub = on('canvas:focus', (payload) => focusEvents.push(payload));

    render(
      <I18nProvider>
        <PreviewNodeCard
          data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }}
          selected={false}
          zoomLevel="compact"
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId('preview-node-compact-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('living-pane-chip-preview-p1')).not.toBeInTheDocument();
    const card = screen.getByTestId('preview-node-golive-p1');
    expect(card).toHaveTextContent('http://localhost:5173');

    fireEvent.click(screen.getByTestId('preview-node-golive-p1-view-live'));
    expect(focusEvents).toEqual([{ ref: 'preview:p1', minZoom: PREVIEW_FOCUS_MIN_ZOOM }]);

    unsub();
  });

  it('a url-less preview keeps the original bare compact chip unchanged (no go-live card)', () => {
    renderCard({ id: 'p1', kind: 'preview' }, false);
    expect(screen.getByTestId('living-pane-chip-preview-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-golive-p1')).not.toBeInTheDocument();
  });
});

describe('PreviewPausedOverlay — clickable/copiable url (fix/canvas-agents-visibility deliverable 2c)', () => {
  it('opens the url externally when clicked, and copies it via the copy button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });

    // Task 3 — a LONE reachable preview is live by default now (see the
    // "P59 live-when-attended" describe block's own module note above), so
    // a second, more-recently-online preview stages p1 as the honest loser
    // whose paused overlay this test needs to click/copy from.
    const { rerender } = render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'block' }));
    rerender(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
        <PreviewNodeCard data={{ id: 'p2', kind: 'preview', url: 'http://localhost:5174' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-paused-p1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('preview-node-paused-p1-url'));
    expect(openExternalMock).toHaveBeenCalledWith('http://localhost:5173');

    fireEvent.click(screen.getByTestId('preview-node-paused-p1-copy'));
    expect(writeText).toHaveBeenCalledWith('http://localhost:5173');
  });
});

// P59 (founder directive: "ça peut pas freeze, c'est pas normal") — the
// live-when-attended policy: the iframe stays MOUNTED at all times once
// reachable (never a reload flash), only its `display` toggles, alongside a
// paused overlay that keeps telling the truth (URL, LIVE badge, resume
// hint). The pure state-machine decisions themselves are exhaustively
// covered by previewAttendedState.test.ts / previewLiveCoordinator.test.ts —
// these are the component-level wiring proof: real hover/selection/pin
// events actually flip the iframe's `display`, never remounting it.
describe('PreviewNodeCard — P59 live-when-attended (iframe pause/resume)', () => {
  // Task 3 "PREVIEW ALIVE BY DEFAULT" (founder, verbatim: "le localhost y a
  // écrit en ligne mais on voit rien") — the policy changed: reachability
  // ALONE is now enough for a preview to claim the single live slot,
  // without requiring a human hover/select/pin first (see PreviewNode.tsx's
  // own `eligibleForLiveSlot` doc comment). The tests below were rewritten
  // to exercise that new policy; a lone reachable preview is live BY
  // DEFAULT now, so the "loser keeps its paused overlay" cases stage a
  // SECOND, more-recently-online preview to have a genuine loser to assert
  // on. Online/attended claims are also STICKY (see effect2's own doc
  // comment) — losing hover/selection/pin no longer relinquishes the slot
  // by itself; only a more-recent hover or a more-recently-online preview
  // does.
  it('a lone reachable preview is live by default — no hover/selection needed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }, false);

    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'block' }));
    const iframe = screen.getByTestId('preview-node-iframe-p1');
    expect(iframe).toHaveAttribute('src', 'http://localhost:5173');
    expect(screen.queryByTestId('preview-node-paused-p1')).not.toBeInTheDocument();
  });

  it('a preview that is NOT the live winner shows the paused overlay honestly (URL, LIVE badge, resume hint)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    const { rerender } = render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'block' }));

    // p2 comes online AFTER p1 — "most recent online wins" hands it the
    // slot, demoting p1 back to its honest paused overlay.
    rerender(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
        <PreviewNodeCard data={{ id: 'p2', kind: 'preview', url: 'http://localhost:5174' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p2')).toHaveStyle({ display: 'block' }));
    await waitFor(() => expect(screen.getByTestId('preview-node-paused-p1')).toBeInTheDocument());
    const overlay = screen.getByTestId('preview-node-paused-p1');
    expect(overlay).toHaveTextContent('http://localhost:5173');
    expect(overlay).toHaveTextContent('Live');
    expect(overlay).toHaveTextContent('Paused — hover to resume');
  });

  it('hovering reclaims the live slot from a more-recently-online preview — never remounted, src untouched — and stays live once attention moves on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    const { rerender } = render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'block' }));
    const iframeBefore = screen.getByTestId('preview-node-iframe-p1');

    rerender(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
        <PreviewNodeCard data={{ id: 'p2', kind: 'preview', url: 'http://localhost:5174' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'none' }));

    fireEvent.mouseEnter(screen.getByTestId('preview-node-p1'));

    const iframeAfter = screen.getByTestId('preview-node-iframe-p1');
    expect(iframeAfter).toBe(iframeBefore); // identical DOM node — no unmount/remount
    expect(iframeAfter).toHaveStyle({ display: 'block' });
    expect(screen.queryByTestId('preview-node-paused-p1')).not.toBeInTheDocument();

    // Sticky claim — merely looking away doesn't hand the slot back (unlike
    // the old hover-only policy) since nothing MORE recent reclaimed it.
    fireEvent.mouseLeave(screen.getByTestId('preview-node-p1'));
    expect(screen.getByTestId('preview-node-iframe-p1')).toBe(iframeBefore);
    expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'block' });
    expect(screen.queryByTestId('preview-node-paused-p1')).not.toBeInTheDocument();
  });

  it('a selected preview is live without needing hover', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    renderCard({ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }, true);

    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'block' }));
    expect(screen.queryByTestId('preview-node-paused-p1')).not.toBeInTheDocument();
  });

  it('the pin-live button reclaims the live slot from a more-recently-online preview, and stays live after un-pinning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    const { rerender } = render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'block' }));
    rerender(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
        <PreviewNodeCard data={{ id: 'p2', kind: 'preview', url: 'http://localhost:5174' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-paused-p1')).toBeInTheDocument());

    const pinButton = screen.getByTestId('preview-node-pin-live-p1');
    expect(pinButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(pinButton);
    expect(pinButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'block' });
    expect(screen.queryByTestId('preview-node-paused-p1')).not.toBeInTheDocument();

    // Sticky claim (see module note above) — un-pinning no longer
    // immediately pauses it, since nothing more-recent reclaimed the slot.
    fireEvent.click(pinButton);
    expect(pinButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'block' });
  });

  it('single-live-slot cap: hovering a different preview reclaims the slot, demoting the previous winner (never both live)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
        <PreviewNodeCard data={{ id: 'p2', kind: 'preview', url: 'http://localhost:5174' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p2')).toBeInTheDocument());

    fireEvent.mouseEnter(screen.getByTestId('preview-node-p1'));
    expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'block' });
    expect(screen.getByTestId('preview-node-iframe-p2')).toHaveStyle({ display: 'none' });

    fireEvent.mouseEnter(screen.getByTestId('preview-node-p2'));
    expect(screen.getByTestId('preview-node-iframe-p2')).toHaveStyle({ display: 'block' });
    expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'none' }); // demoted, not both live

    // Sticky claim (see module note above) — p2 stepped back from hover but
    // stays live: nothing MORE recent (another hover, another preview
    // coming online) reclaimed the slot, so "others pause" still holds
    // (never both live) without handing it back to a now-idle p1.
    fireEvent.mouseLeave(screen.getByTestId('preview-node-p2'));
    expect(screen.getByTestId('preview-node-iframe-p2')).toHaveStyle({ display: 'block' });
    expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'none' });
  });

  it('gesturePaused forces the paused overlay even for a selected, reachable preview', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected gesturePaused />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());
    expect(screen.getByTestId('preview-node-iframe-p1')).toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('preview-node-paused-p1')).toBeInTheDocument();
  });
});

// ── Fix 5 (system-pressure shedding) — unmounts a NOT-attended preview's
// iframe outright under HIGH pressure, instead of P59's usual
// display:none pause. Never touches an ATTENDED preview regardless of
// pressure. ──────────────────────────────────────────────────────────────

describe('PreviewNodeCard — system-pressure shedding (Fix 5)', () => {
  it('unmounts the iframe under HIGH pressure when the preview is not attended', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());

    act(() => { setSystemPressureForTests({ level: 'high' }); });

    await waitFor(() => expect(screen.queryByTestId('preview-node-iframe-p1')).not.toBeInTheDocument());
    expect(screen.getByTestId('preview-node-paused-p1')).toBeInTheDocument();
  });

  it('never unmounts a SELECTED (attended) preview\'s iframe, even under HIGH pressure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());

    act(() => { setSystemPressureForTests({ level: 'high' }); });

    // Still mounted (selected forces `attended`) — pressure never overrides
    // an actively-attended surface.
    expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument();
  });

});

// Visible-artifact fix (real founder feedback: "je n'ai toujours pas vu de
// dessin ... a quoi va ressembler") — the canvas-side render of a local
// agent-generated artifact, reusing this SAME node rather than a second one
// (this task's own explicit instruction). A separate describe block since
// this render path has none of the live-dev-server machinery above (no
// probe, no backoff, no P59 attended gating — see ArtifactSurfaceCard's own
// doc comment for why).
describe('ArtifactSurfaceCard — local artifact render (canvas apercu)', () => {
  function renderArtifactCard(data: SurfaceSpec, selected = true) {
    return render(
      <I18nProvider>
        <ArtifactSurfaceCard data={data} selected={selected} />
      </I18nProvider>,
    );
  }

  // SECURITY — `sandbox="allow-same-origin"` and NOTHING else (no scripts,
  // no forms, no popups, no top navigation). `allow-same-origin` alone (the
  // AUTO-SCALE FIX's own "belt" — see this component's own doc comment)
  // never re-admits `allow-scripts`, asserted explicitly so a future
  // accidental loosening of the sandbox string fails this test.
  it('renders the artifact HTML content in a fully-locked-down sandboxed iframe (isolated, no script escape, real-size readable only)', () => {
    renderArtifactCard({
      id: 'p1',
      kind: 'preview',
      htmlViews: [{ id: 'v1', label: 'Page 1', html: '<html><body>Hello</body></html>' }],
    });
    const iframe = screen.getByTestId('preview-node-artifact-iframe-p1');
    expect(iframe).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(iframe.getAttribute('sandbox')).not.toMatch(/allow-scripts|allow-forms|allow-popups|allow-top-navigation/);
    expect(iframe).toHaveAttribute('srcdoc', '<html><body>Hello</body></html>');
    expect(iframe).not.toHaveAttribute('src');
  });

  // AUTO-SCALE FIX — this bug's own real repro: a 1080x1080 srcDoc rendered
  // 1:1 inside a measured 218x258 frame showed only its own top-left corner
  // because this render path never scaled at all (SurfaceHtmlView carries no
  // size field). The fix measures the sandboxed document's own actual size
  // on `onLoad` and scales-to-fit from THAT, letterboxed inside the node's
  // own content area (its full width, height minus the header row).
  describe('real-measurement auto-scale (bug fix: canvas node never scaled before)', () => {
    it('scales a measured 1080x1080 view so it fits entirely inside the node, aspect ratio preserved', () => {
      renderArtifactCard({
        id: 'p1',
        kind: 'preview',
        width: 400,
        height: 300,
        htmlViews: [{ id: 'v1', label: 'Square', html: '<p>x</p>' }],
      });
      const iframe = screen.getByTestId('preview-node-artifact-iframe-p1') as HTMLIFrameElement;

      // Before measurement: fills its box unscaled (same posture as before
      // this fix for the pre-load instant).
      expect(iframe.style.transform).toBe('');

      stubIframeContentSize(iframe, 1080, 1080);

      expect(iframe).toHaveStyle({ width: '1080px', height: '1080px' });
      const scaleMatch = iframe.style.transform.match(/scale\(([^)]+)\)/);
      expect(scaleMatch).not.toBeNull();
      const scale = Number(scaleMatch![1]);
      // Fits entirely inside the node's own content area (width 400, height
      // 300 minus the header row) in BOTH dimensions — never clipped.
      expect(1080 * scale).toBeLessThanOrEqual(400 + 0.5);
      expect(1080 * scale).toBeLessThanOrEqual(270 + 0.5);
    });
  });

  describe('computeContainedLayout (pure scale-to-fit math, shared with ArtifactProposalCard.tsx)', () => {
    it('fits a 1080x1080 view inside a measured 218x258 frame, aspect ratio preserved, no overflow', () => {
      const layout = computeContainedLayout(1080, 1080, 218, 258);
      expect(layout.boxWidth).toBeLessThanOrEqual(218);
      expect(layout.boxHeight).toBeLessThanOrEqual(258);
      expect(layout.boxWidth).toBe(layout.boxHeight);
      expect(layout.scale).toBeCloseTo(218 / 1080, 5);
    });

    it('never scales up past the content\'s own natural size', () => {
      const layout = computeContainedLayout(100, 100, 220, 260);
      expect(layout.scale).toBe(1);
      expect(layout.boxWidth).toBe(100);
      expect(layout.boxHeight).toBe(100);
    });
  });

  describe('expand affordance (AGRANDIR une vue for real legibility)', () => {
    it('opens a full-panel overlay rendering the same sandboxed content, and closes on demand', () => {
      renderArtifactCard({
        id: 'p1',
        kind: 'preview',
        htmlViews: [{ id: 'v1', label: 'Page 1', html: '<p>hello</p>' }],
      });

      expect(screen.queryByTestId('preview-node-artifact-expanded-v1')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('preview-node-artifact-expand-p1'));

      const overlayIframe = screen.getByTestId('preview-node-artifact-expanded-iframe-v1');
      expect(overlayIframe).toHaveAttribute('sandbox', 'allow-same-origin');
      expect(overlayIframe).toHaveAttribute('srcdoc', '<p>hello</p>');

      fireEvent.click(screen.getByTestId('preview-node-artifact-expanded-close-v1'));
      expect(screen.queryByTestId('preview-node-artifact-expanded-v1')).not.toBeInTheDocument();
    });
  });

  it('shows a single view with no nav controls when there is only one — never assumes a fixed view count', () => {
    renderArtifactCard({
      id: 'p1',
      kind: 'preview',
      htmlViews: [{ id: 'v1', label: 'Only page', html: '<p>x</p>' }],
    });
    expect(screen.getByTestId('preview-node-artifact-view-label-p1')).toHaveTextContent('Only page');
    expect(screen.queryByTestId('preview-node-artifact-next-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-artifact-prev-p1')).not.toBeInTheDocument();
  });

  it('navigates between views (prev/next), wrapping around at both ends', () => {
    renderArtifactCard({
      id: 'p1',
      kind: 'preview',
      htmlViews: [
        { id: 'v1', label: 'Cover', html: '<p>1</p>' },
        { id: 'v2', label: 'Detail', html: '<p>2</p>' },
      ],
    });
    expect(screen.getByTestId('preview-node-artifact-view-label-p1')).toHaveTextContent('1/2 — Cover');

    fireEvent.click(screen.getByTestId('preview-node-artifact-next-p1'));
    expect(screen.getByTestId('preview-node-artifact-view-label-p1')).toHaveTextContent('2/2 — Detail');

    fireEvent.click(screen.getByTestId('preview-node-artifact-next-p1'));
    expect(screen.getByTestId('preview-node-artifact-view-label-p1')).toHaveTextContent('1/2 — Cover');

    fireEvent.click(screen.getByTestId('preview-node-artifact-prev-p1'));
    expect(screen.getByTestId('preview-node-artifact-view-label-p1')).toHaveTextContent('2/2 — Detail');
  });

  // B4 fix (real QA repro, night run 2026-07-25): the whole session ran at
  // 10-26% canvas zoom, where this card used to collapse to a static
  // "N vue(s)" count with zero way to actually page through the views —
  // only the forceFull render (selected/hovered) had prev/next buttons. The
  // chat card has no such zoom concept and always lets the user page
  // through every view; this compact tier must match that, not merely
  // summarize it.
  it('still lets the user navigate every view at compact zoom (unselected, unhovered) — never just a static count', () => {
    render(
      <I18nProvider>
        <ArtifactSurfaceCard
          data={{
            id: 'p1',
            kind: 'preview',
            htmlViews: [
              { id: 'v1', label: 'Cover', html: '<p>1</p>' },
              { id: 'v2', label: 'Detail', html: '<p>2</p>' },
              { id: 'v3', label: 'Outro', html: '<p>3</p>' },
            ],
          }}
          selected={false}
          zoomLevel="compact"
        />
      </I18nProvider>,
    );

    // Compact repli, not the full interactive card.
    expect(screen.getByTestId('preview-node-compact-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-p1')).not.toBeInTheDocument();
    // The honest count is still shown ...
    expect(screen.getByTestId('living-pane-chip-preview-p1')).toBeInTheDocument();
    // ... but N proposed views are N NAVIGABLE views, even collapsed.
    fireEvent.click(screen.getByTestId('preview-node-artifact-next-p1'));
    fireEvent.click(screen.getByTestId('preview-node-artifact-next-p1'));
    fireEvent.click(screen.getByTestId('preview-node-artifact-prev-p1'));
    expect(screen.getByTestId('preview-node-artifact-prev-p1')).toBeInTheDocument();
    expect(screen.getByTestId('preview-node-artifact-next-p1')).toBeInTheDocument();
  });

  it('shows no nav controls at compact zoom when there is only one view — never assumes a fixed count', () => {
    render(
      <I18nProvider>
        <ArtifactSurfaceCard
          data={{ id: 'p1', kind: 'preview', htmlViews: [{ id: 'v1', label: 'Only page', html: '<p>x</p>' }] }}
          selected={false}
          zoomLevel="compact"
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('preview-node-compact-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-artifact-next-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preview-node-artifact-prev-p1')).not.toBeInTheDocument();
  });

  it('persists the view switch via updateSurface(activeViewId) so it survives a reconcile', () => {
    canvasStoreVanilla.getState().addSurface({
      id: 'p1',
      kind: 'preview',
      htmlViews: [
        { id: 'v1', label: 'Cover', html: '<p>1</p>' },
        { id: 'v2', label: 'Detail', html: '<p>2</p>' },
      ],
    });
    renderArtifactCard({
      id: 'p1',
      kind: 'preview',
      htmlViews: [
        { id: 'v1', label: 'Cover', html: '<p>1</p>' },
        { id: 'v2', label: 'Detail', html: '<p>2</p>' },
      ],
    });

    fireEvent.click(screen.getByTestId('preview-node-artifact-next-p1'));

    const surface = canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'p1');
    expect(surface?.activeViewId).toBe('v2');
  });

  it('falls back to the first view when activeViewId is stale/removed, rather than rendering nothing', () => {
    renderArtifactCard({
      id: 'p1',
      kind: 'preview',
      htmlViews: [{ id: 'v1', label: 'Cover', html: '<p>1</p>' }],
      activeViewId: 'no-longer-exists',
    });
    expect(screen.getByTestId('preview-node-artifact-view-label-p1')).toHaveTextContent('Cover');
  });

  it('close button removes the surface', () => {
    canvasStoreVanilla.getState().addSurface({ id: 'p1', kind: 'preview', htmlViews: [{ id: 'v1', label: 'Cover', html: '<p>1</p>' }] });
    renderArtifactCard({ id: 'p1', kind: 'preview', htmlViews: [{ id: 'v1', label: 'Cover', html: '<p>1</p>' }] });

    fireEvent.click(screen.getByTestId('preview-node-close-p1'));

    expect(canvasStoreVanilla.getState().surfaces.find((s) => s.id === 'p1')).toBeUndefined();
  });
});

// Continuation of "system-pressure shedding (Fix 5)" above — split around
// the ArtifactSurfaceCard block (a distinct render path with no pressure
// shedding of its own) rather than interleaved with it.
describe('PreviewNodeCard — system-pressure shedding (Fix 5) [continued]', () => {
  it('never unmounts a HOVERED (attended) preview\'s iframe under HIGH pressure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());
    fireEvent.mouseEnter(screen.getByTestId('preview-node-p1'));

    act(() => { setSystemPressureForTests({ level: 'high' }); });

    expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument();
  });

  it('does NOT unmount under ELEVATED pressure — only HIGH triggers shedding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());

    act(() => { setSystemPressureForTests({ level: 'elevated' }); });

    expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument();
  });

  it('remounts the iframe once pressure drops back to normal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());

    act(() => { setSystemPressureForTests({ level: 'high' }); });
    await waitFor(() => expect(screen.queryByTestId('preview-node-iframe-p1')).not.toBeInTheDocument());

    act(() => { setSystemPressureForTests({ level: 'normal' }); });

    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());
  });

  it('remounts the iframe once the preview becomes attended again, even while pressure stays HIGH', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    render(
      <I18nProvider>
        <PreviewNodeCard data={{ id: 'p1', kind: 'preview', url: 'http://localhost:5173' }} selected={false} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument());

    act(() => { setSystemPressureForTests({ level: 'high' }); });
    await waitFor(() => expect(screen.queryByTestId('preview-node-iframe-p1')).not.toBeInTheDocument());

    fireEvent.mouseEnter(screen.getByTestId('preview-node-p1'));

    expect(screen.getByTestId('preview-node-iframe-p1')).toBeInTheDocument();
  });
});
