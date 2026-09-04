/* PreviewNode.tsx — R7 "living surfaces": a live preview of a running local
   dev server rendered as its own canvas node next to the mission/zone that
   produced it (October.dev's "see the result run live" idea, reimplemented).

   SECURITY NOTE (deliberate, not an oversight): the URL bar only ever
   accepts `http://localhost:*` / `http://127.0.0.1:*` — this node exists to
   preview the user's OWN local dev server, never an arbitrary remote origin
   inside an app-privileged iframe. A non-localhost URL is rejected inline
   (the iframe's `src` is never updated to it) with an honest message — never
   silently "upgraded" or proxied. The iframe itself carries a narrow
   `sandbox` allowlist (`allow-scripts allow-same-origin allow-forms
   allow-popups`) — same posture a plain browser tab already has for a page
   the user chose to open, not an escalation.

   Loading/error state is HONEST: a real reachability probe (`fetch` with
   `mode: 'no-cors'`, same technique src/lib/platform/web.ts's
   `checkBrainReachable` already uses elsewhere in this app) decides between
   "chargement…" and "serveur injoignable" — never a fake "it's running"
   guess, and the iframe is only pointed at the URL once that probe (or the
   iframe's own onLoad) resolves.

   W-PREVIEWFIX: a PERSISTED preview pointed at a dev server that was never
   restarted used to keep probing on the cold-start window's fast cadence
   (previewProbe.ts, 2-8s) — real QA logged 11 net::ERR_CONNECTION_REFUSED
   in ~4 minutes. Once that cold-start window gives up, probing continues on
   a much slower, capped backoff (previewBackoff.ts: 5s/15s/45s/2min/5min)
   instead, surfaced as a next-retry countdown next to the existing "serveur
   injoignable" message. This does NOT eliminate the browser's own
   per-attempt network-error console line for a genuinely dead port
   (`probeReachable`'s try/catch only stops OUR code from throwing —
   Chromium logs a failed fetch's `net::ERR_*` to the console independent of
   any JS-side catch, for any fetch/XHR/resource load; there is no
   JS-callable way to suppress that browser diagnostic) — the mitigation is
   fewer, backed-off attempts, not a silent probe.

   W-PREVIEWFIX-STOP: the backoff above used to repeat its 5-minute cap
   forever. Two more conditions now stop it outright, both reusing the
   existing "serveur injoignable" state (no new UI/i18n needed — the
   countdown just stops updating):
    - past previewBackoff.ts's PREVIEW_BACKOFF_GIVE_UP_MS of continuous
      failure, no further automatic retry is scheduled at all — the user
      has to act (manual refresh, a new url, or a completed mission's
      refreshRequestedAtMs) to re-arm it;
    - while `document.hidden` (app backgrounded/minimized — same signal
      canvasPersistence.ts's autosave flush and BrainGraph3D's render loop
      already gate on), no backoff timer is armed at all; the very next
      `visibilitychange` back to visible fires the retry that WOULD have
      fired instead of waiting out a stale delay. The fast cold-start phase
      (previewProbe.ts, capped at 60s total) is deliberately left ungated —
      short-lived and already bounded, not worth the extra complexity.
      A node scrolled/panned fully off the canvas is already handled
      separately: CanvasView.tsx's `onlyRenderVisibleElements` unmounts it,
      which tears down this whole effect via its cleanup.

   CONSOLE-SPAM FIX (real QA: dozens of console lines/minute from a target
   stuck erroring): the backoff schedule above already caps how OFTEN
   `probeReachable` itself is called while consecutively failing — what it
   never had was any deliberate diagnostic of its own, so the only signal a
   developer saw was the browser's uncontrollable per-attempt net::ERR_*
   line (module header above: no JS-callable way to suppress that). Three
   `console.warn`/`console.info` calls, each gated to fire exactly ONCE per
   STATE TRANSITION rather than once per attempt, now mark the moments that
   actually matter: cold-start giving up into backoff, backoff permanently
   giving up, and recovery. At most 3 lines for an entire failure episode,
   regardless of how many probes or backoff retries it took — never a
   per-attempt log.

   P59 (founder directive, verbatim: "hygiène naturelle et auto, fais en
   sorte que l'app soit opti et sature pas, ça peut pas freeze c'est pas
   normal") — real QA repro: a preview's heavy animated (three.js) local dev
   site rendered CONTINUOUSLY inside its iframe regardless of whether anyone
   was even looking at it; under software rendering that alone froze the
   whole app (30s+ screenshot timeouts, 120s+ stalled wheel events).

   FIX — "live-when-attended", NOT the zoom-adaptive hiding W-CARDS already
   bans: the node keeps its FULL chrome (header, URL bar, status badge) at
   EVERY zoom exactly as before; only the IFRAME's own liveness is gated.
   `display: none` (not unmount) is the mechanism deliberately — a hidden
   iframe's rAF/timers are throttled/paused by the browser itself, but its
   DOM node, `src`, and live document all survive untouched, so re-attending
   shows the SAME page instantly (no reload flash). "Chrome stays, content
   pauses" — the opposite of hiding the node itself.

   Three independent, individually pure-tested pieces (previewProbe.ts/
   previewBackoff.ts's own "state machine as its own file" precedent):
   previewAttendedState.ts (attended + reachable + single-live-slot-winner +
   not-mid-gesture => iframeLive), previewLiveCoordinator.ts (the hard cap of
   ONE live iframe across the canvas — most-recently-attended wins, a
   demoted id resumes once the winner steps back down), and this file's own
   `useCanvasGesturePause` (chrome/canvasGesturePause.ts) — the Lod
   broadcaster is the single `useViewport()` subscriber; preview cards
   only re-render on the paused true/false edges, not per pan frame.

   VISIBLE-ARTIFACT FIX (real founder feedback, verbatim: "comment tu me
   montres les designs proposes ?"): when `data.htmlViews` is set
   (SurfaceSpec's own doc comment), this node renders LOCAL agent-generated
   content via `srcDoc` instead of probing/loading `data.url` — a second,
   entirely separate render branch from the live-dev-server path above, with
   NONE of that path's reachability probing, backoff, or P59
   attended/pressure gating (a static rendered artifact has no network
   liveness to poll and negligible runtime cost, unlike a live dev server).
   SECURITY (deliberate, not an oversight, distinct from the module header's
   own note on the LIVE-preview iframe above): this content is UNTRUSTED
   agent output, not the user's own local server — the sandbox is
   `"allow-same-origin"` and NOTHING else (no scripts, no forms, no popups,
   no top navigation), never the live path's
   `allow-scripts allow-same-origin allow-forms allow-popups` allowlist. A
   fully-locked-down sandboxed `srcDoc` iframe still renders HTML/CSS fully
   (sandbox restricts CAPABILITIES, not rendering) while giving the content
   zero way to touch the rest of the app or the user's session —
   `allow-same-origin` WITHOUT `allow-scripts` grants no such way in either
   direction (a document that can never execute any code can't exploit being
   nominally "same-origin"); see the AUTO-SCALE FIX note directly below for
   the one thing that token actually buys.

   AUTO-SCALE FIX (real DOM inspection, verbatim repro: a proposed 1080x1080
   slide rendered 1:1 inside a measured 218x258 frame showed only its own
   top-left 80px margin — "un rectangle vide"). The OLD scaling here simply
   never existed for this render path (unlike ArtifactProposalCard.tsx's own
   chat-card thumbnail, which at least scaled off DECLARED `view.width`/
   `height` metadata) — `SurfaceHtmlView` carries no size field at all, so
   this iframe always filled its box unscaled regardless of the real
   content's own dimensions. The fix measures the SANDBOXED document's own
   real rendered size on `onLoad` (`measureSandboxedContentSize` below,
   verbatim duplicate of ArtifactProposalCard.tsx's own function — the two
   files are independently scoped with no shared util module between them,
   kept in sync by hand) and scales-to-fit from THAT, letterboxed and
   centered inside the content area, aspect ratio always preserved, never
   deformed, never overflowing. `ArtifactSurfaceExpandedOverlay` (further
   down) gives the same content a full-panel enlarge affordance — a
   scaled-down 64px title is illegible at the node's own default size, and
   the user must be able to actually judge a design, not guess its
   silhouette.
*/

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import { makeRef, PREVIEW_FOCUS_MIN_ZOOM, type SurfaceHtmlView, type SurfaceSpec } from '../canvasTypes';
import { useI18n } from '../../../../i18n';
import { emit } from '../../../../lib/bus';
import { useCanvasStore } from '../canvasStore';
import { PREVIEW_NODE_SIZE } from '../reconcilerZones';
import {
  initialProbeSnapshot,
  reduceProbeResult,
  type PreviewProbeSnapshot,
} from './previewProbe';
import { hasGivenUpBackoff, nextBackoffDelayMs } from './previewBackoff';
import { dismissAutoPreview } from '../hooks/autoPreviewPrefs';
import { useZoomLevel } from '../chrome/useZoomLevel';
import { useCanvasGesturePause } from '../chrome/canvasGesturePause';
import { isDevServerManaged, stopDevServer } from '../../../../lib/agents/devPreview';
import { LivingPaneCompactCard } from './LivingPaneCompactCard';
import { openExternal } from '../../../../lib/platform/openExternal';
import { basename } from '../../../../lib/paths';
import { derivePreviewAttendedState } from './previewAttendedState';
import { attendPreview, subscribePreviewLiveWinner, unattendPreview } from './previewLiveCoordinator';
import { getSystemPressure, subscribeSystemPressure, type SystemPressureSnapshot } from '../../../../lib/agents/systemPressure';
import { PreviewGlyph } from './PreviewGlyph';
import { PreviewStatus } from './PreviewStatus';
import { PreviewPausedOverlay } from './PreviewPausedOverlay';
import { PreviewPinLiveButton } from './PreviewPinLiveButton';
import { PreviewLiveBadgeButton } from './PreviewLiveBadgeButton';

export type PreviewFlowNode = Node<SurfaceSpec & Record<string, unknown>, 'preview'>;

const MIN_WIDTH = 340;
const MIN_HEIGHT = 260;
const REACHABILITY_TIMEOUT_MS = 2500;
/** Preview lifecycle fix — once the backoff schedule below has permanently
 *  given up (previewBackoff.ts's PREVIEW_BACKOFF_GIVE_UP_MS, 5min of
 *  continuous failure), an AUTO-ADDED preview is removed from the canvas
 *  this long afterwards rather than left sitting there forever showing
 *  "Serveur injoignable" for a dev server that is never coming back. Short
 *  enough to actually clean up the frozen card, long enough that a probe
 *  succeeding right as give-up fires (the schedule's own last rung) is
 *  never a race with the removal. A MANUALLY-added preview is never
 *  auto-removed this way — see the give-up branch's own doc comment. */
const AUTO_PREVIEW_REMOVE_GRACE_MS = 10_000;

/** `http://localhost:*` / `http://127.0.0.1:*` only — see module header's
 *  security note. Exported for the creation paths (CanvasContextMenu.tsx/
 *  CanvasPalette.tsx) that need the SAME check before ever calling
 *  `addSurface`/`updateSurface`, not just at render/edit time here. */
export function isAllowedPreviewUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
}

/** Bug fix (IPv6/localhost gotcha, real QA repro: "Serveur injoignable"
 *  shown while `curl 127.0.0.1:PORT` succeeds): a dev server commonly binds
 *  IPv4 only, but `localhost` can resolve to the IPv6 loopback (`::1`)
 *  first in the WebView's own resolver — nothing listens there, so the
 *  probe fails even though the server is genuinely up. Rewrites the probe's
 *  OWN fetch target to the literal `127.0.0.1`, never the DISPLAYED/persisted
 *  `SurfaceSpec.url` or the iframe's `src` (both stay exactly what the user
 *  typed/saw — this only changes what `probeReachable` itself fetches).
 *  Any hostname other than `localhost` (already `127.0.0.1`, the only other
 *  value `isAllowedPreviewUrl` accepts) passes through unchanged. Malformed
 *  input falls through to the original string — `probeReachable`'s own
 *  fetch/catch below already turns that into an honest 'unreachable',
 *  never a thrown error here. */
function toProbeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'localhost') return url;
    parsed.hostname = '127.0.0.1';
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Best-effort reachability probe — `no-cors` mode means the response body/
 *  status is opaque (can't be read), but the PROMISE itself still rejects on
 *  a real network failure (connection refused/DNS failure), which is exactly
 *  the "is anything listening on this port" signal this needs — same
 *  technique `checkBrainReachable` (src/lib/platform/web.ts) already uses for
 *  an identical "is my local server up" question.
 *
 *  P59 hygiene fix (founder directive: "hygiène naturelle et auto"): a plain
 *  `AbortController` + `setTimeout`/`clearTimeout` here, NOT
 *  `AbortSignal.timeout()` — that convenience API schedules its OWN internal
 *  timer outside the global `setTimeout` binding, so it (a) is never
 *  cancelled once the fetch settles, leaking a real ~2.5s background timer
 *  on EVERY probe call for the lifetime of the app (a persisted preview
 *  against a live server probes indefinitely — see this file's own
 *  W-PREVIEWFIX history — so these genuinely accumulate), and (b) is immune
 *  to `vi.useFakeTimers()`, which is exactly the documented cause of this
 *  test file's own "component-level 60-second drain flaky/non-deterministic"
 *  comment further down. Clearing the timeout in `finally` (success,
 *  failure, or the timeout firing itself) fixes both at once. */
async function probeReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
  try {
    await fetch(toProbeUrl(url), { mode: 'no-cors', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * P46+P48 — "the node title shows the project name + port" for an
 * auto-started preview. `data.projectId` is ALREADY the project's
 * normalized root path (see journal/projectId.ts's `projectIdFromRoot` —
 * not a hash), so its basename is a legible project name with no extra
 * lookup needed; the port is read straight off `data.url`. Returns null
 * when there is nothing legible to show (no projectId, or a basename that
 * reduces to empty) — the caller simply omits the label in that case.
 */
function deriveAutoStartedTitle(projectId: string | undefined, url: string | undefined): string | null {
  if (!projectId) return null;
  const name = basename(projectId);
  if (!name) return null;
  if (!url) return name;
  try {
    const port = new URL(url).port;
    return port ? `${name}:${port}` : name;
  } catch {
    return name;
  }
}

/** fix/canvas-agents-visibility (deliverable 2a) — replaces the bare
 *  LivingPaneCompactCard chip for a preview that HAS a url but isn't
 *  currently live (collapsed by zoom, or simply unattended right now): a
 *  real dev server the user would want to jump to deserves more than an
 *  anonymous chip. Shows the url + the honest probe status + a "Voir en
 *  direct" action that asks the canvas to pan/zoom onto this node at a
 *  legible level (reuses the SAME 'canvas:focus' bus event + minZoom floor
 *  the LazyManager's own start_preview action already uses — see
 *  PREVIEW_FOCUS_MIN_ZOOM's doc comment in canvasTypes.ts) — this NEVER
 *  forces the iframe itself live; that stays gated by
 *  previewAttendedState.ts's own attention/single-live-slot/perf rules
 *  (this file's own module header), completely unchanged by this card. */
export interface PreviewGoLiveCardProps {
  testId: string;
  url: string;
  statusLabel: string;
  statusColor: string;
  viewLiveLabel: string;
  onViewLive: () => void;
}

export function PreviewGoLiveCard({ testId, url, statusLabel, statusColor, viewLiveLabel, onViewLive }: PreviewGoLiveCardProps) {
  return (
    <div
      data-testid={testId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--color-panel-2)',
        border: `1px solid ${statusColor}`,
        minWidth: 220,
        maxWidth: 260,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <PreviewGlyph />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 10.5,
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {url}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 9.5, fontWeight: 700, color: statusColor }}>{statusLabel}</span>
        <button
          type="button"
          data-testid={`${testId}-view-live`}
          className="nodrag"
          onClick={(e) => {
            e.stopPropagation();
            onViewLive();
          }}
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '3px 8px',
            borderRadius: 5,
            border: 'none',
            background: 'var(--color-accent)',
            color: '#14141C',
            cursor: 'pointer',
            fontFamily: 'inherit',
            flexShrink: 0,
          }}
        >
          {viewLiveLabel}
        </button>
      </div>
    </div>
  );
}

interface PreviewNodeCardProps {
  data: SurfaceSpec;
  selected?: boolean;
  /** Test-only escape hatch — see TerminalNodeCard's identical prop doc
   *  comment. Defaults to 'full' so every pre-existing fixture render is
   *  unaffected. */
  zoomLevel?: 'chip' | 'compact' | 'full';
  /** P59 — true for a short tail after ANY canvas pan/zoom, computed by the
   *  OUTER `PreviewNode` (the one rendered inside `<ReactFlow>`, see
   *  `usePreviewGesturePause` below) and threaded down as a plain prop —
   *  same RF-context-stays-in-the-wrapper split `zoomLevel` above already
   *  uses, which is why every pre-existing test here can keep rendering
   *  `PreviewNodeCard` with no `ReactFlowProvider` ancestor. Defaults to
   *  `false` so every such fixture is unaffected. */
  gesturePaused?: boolean;
}

export function PreviewNodeCard({ data, selected, zoomLevel = 'full', gesturePaused = false }: PreviewNodeCardProps) {
  const { t } = useI18n();
  const removeSurface = useCanvasStore((s) => s.removeSurface);
  const updateSurface = useCanvasStore((s) => s.updateSurface);
  const width = data.width ?? PREVIEW_NODE_SIZE.width;
  const height = data.height ?? PREVIEW_NODE_SIZE.height;

  const [draftUrl, setDraftUrl] = useState(data.url ?? '');
  const [invalidUrlError, setInvalidUrlError] = useState(false);
  const [probe, setProbe] = useState<PreviewProbeSnapshot>(initialProbeSnapshot());
  // Bumping this re-arms the polling effect below from a fresh snapshot —
  // the manual refresh button's whole job (R13). A plain counter rather than
  // re-deriving from `data.url` so a refresh works identically whether the
  // last attempt ended in 'reachable' (server since went down) or
  // 'unreachable' (timed out) — both are valid reasons to try again.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // W-PREVIEWFIX — epoch ms of the next scheduled backoff retry once
  // previewProbe.ts's cold-start window has given up, or null while not
  // backing off (still cold-starting, or reachable). Drives the countdown
  // text only — never read by the scheduling logic itself.
  const [nextRetryAtMs, setNextRetryAtMs] = useState<number | null>(null);
  // Ticks once a second while nextRetryAtMs is set, purely to force the
  // countdown text to re-render as time passes.
  const [nowTick, setNowTick] = useState(() => Date.now());
  // P48 — "URL input visible on hover AND selection (not selection-only)":
  // a real mouse hover forces the same full-card render `selected` already
  // does (see the repli-compact override below), so a freshly-created,
  // url-less preview no longer needs to STAY selected just to keep its only
  // way of entering a URL on screen.
  const [isHovered, setIsHovered] = useState(false);
  const handleMouseEnter = useCallback(() => setIsHovered(true), []);
  const handleMouseLeave = useCallback(() => setIsHovered(false), []);
  // P59 — "expand to a live panel": an explicit, durable "keep THIS one
  // live" choice, independent of hover/selection (pin button below).
  // Local-only, same "session preference, not durable data" posture
  // `isHovered` already takes.
  const [pinnedLive, setPinnedLive] = useState(false);
  const togglePinnedLive = useCallback(() => setPinnedLive((v) => !v), []);

  // P59 — previewLiveCoordinator.ts's single-live-slot verdict for THIS
  // id. Only joins the coordinator while there's something real to compete
  // for (see previewAttendedState.ts's own header for why `attended` alone
  // isn't the gate). `probe.state` directly — the `reach` alias below is
  // the same value, declared later purely for the render's readability.
  //
  // Still drives `forceFull`/the memory-pressure exemption below exactly as
  // before — task 3 (below) only changes WHO gets to compete for the live
  // slot, never this local "is a human paying attention right now" signal.
  const attended = selected === true || isHovered || pinnedLive;

  // Fix 5 (system-pressure shedding) — same getSystemPressure/
  // subscribeSystemPressure store SystemPressureBadge.tsx already reads,
  // just consumed locally here instead of hoisted into a shared hook (only
  // two call sites app-wide; see systemPressure.ts's own doc comment on why
  // it stays framework-agnostic rather than exporting a React hook itself).
  const [pressureSnapshot, setPressureSnapshot] = useState<SystemPressureSnapshot>(getSystemPressure);
  useEffect(() => subscribeSystemPressure(setPressureSnapshot), []);
  // Under HIGH machine pressure, a preview that is NOT attended is unmounted
  // outright rather than merely `display: none`'d (P59's existing pause,
  // module header above): a hidden-but-mounted iframe's own JS/rAF loop
  // stays resident (throttled, not freed) — exactly the "heavy animated
  // preview froze the app" scenario this module's header already describes,
  // just not yet reclaimed for the case where the WHOLE MACHINE, not just
  // this app's render loop, is under pressure. Never touches an ATTENDED
  // preview regardless of pressure — the safety floor
  // systemPressureShedding.ts's own header commits to for every action it
  // triggers.
  const unloadForPressure = pressureSnapshot.level === 'high' && !attended;

  // fix/canvas-graph-legibility, task "PREVIEW ALIVE BY DEFAULT" (founder,
  // verbatim: "le localhost y a écrit en ligne mais on voit rien") — a
  // human no longer needs to hover/select/pin FIRST for a reachable preview
  // to be considered for the single live slot: eligibility is now
  // reachability alone, so the MOST RECENT preview to come online
  // auto-registers with previewLiveCoordinator.ts and — since that module's
  // own ordering is unchanged ("most-recently-attended wins") — auto-claims
  // the slot. The hard one-live-iframe-max cap itself is untouched (still
  // enforced entirely by that coordinator); every other reachable-but-
  // losing preview simply never becomes the winner, same as before.
  const eligibleForLiveSlot = Boolean(data.url) && !invalidUrlError && probe.state === 'reachable';
  const [isLiveWinner, setIsLiveWinner] = useState(false);
  useEffect(() => {
    if (!eligibleForLiveSlot) {
      setIsLiveWinner(false);
      return;
    }
    const unsubscribe = subscribePreviewLiveWinner(data.id, setIsLiveWinner);
    attendPreview(data.id);
    return () => {
      unattendPreview(data.id);
      unsubscribe();
    };
  }, [eligibleForLiveSlot, data.id]);
  // Additive — a human explicitly starting to attend (hover/select/pin)
  // still IMMEDIATELY reclaims the slot, even when this preview was already
  // registered purely from being online for a while (the effect above only
  // re-attends on a genuine eligibility EDGE, which reachability alone may
  // have already crossed well before this hover starts).
  useEffect(() => {
    if (attended && eligibleForLiveSlot) attendPreview(data.id);
  }, [attended, eligibleForLiveSlot, data.id]);

  useEffect(() => {
    setDraftUrl(data.url ?? '');
  }, [data.url]);

  // W-PREVIEWFIX — countdown ticker: only runs while actually backing off.
  useEffect(() => {
    if (nextRetryAtMs === null) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nextRetryAtMs]);

  useEffect(() => {
    // Defense-in-depth (never trust a value that could come from a hand-edited
    // layout.json — same "never trust a file on disk" rule
    // canvasPersistence.ts's own validators follow): the URL bar's `commitUrl`
    // below is the interactive path's gate, but a PERSISTED surface's `url`
    // reaches this component directly, so the security restriction is
    // re-checked here too, not just on user entry.
    if (!data.url) {
      setProbe({ state: 'unreachable', attempt: 0, elapsedMs: 0 });
      setNextRetryAtMs(null);
      return;
    }
    if (!isAllowedPreviewUrl(data.url)) {
      setInvalidUrlError(true);
      setProbe({ state: 'unreachable', attempt: 0, elapsedMs: 0 });
      setNextRetryAtMs(null);
      return;
    }
    setInvalidUrlError(false);

    // R13 — polling state machine (previewProbe.ts): a cold dev server can
    // take well past the old one-shot 2.5s window to bind its port. Retries
    // on an exponential-ish schedule (nextProbeDelayMs) for up to
    // PREVIEW_PROBE_TIMEOUT_MS (60s) total before honestly giving up —
    // never a single fixed-window guess.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Preview lifecycle fix — armed only once the backoff schedule below
    // permanently gives up on an AUTO-ADDED preview (see that branch's own
    // doc comment); cleared on cleanup like `timer` above so a refresh/new
    // url/unmount before the grace window elapses cancels the pending
    // removal instead of racing it.
    let removeTimer: ReturnType<typeof setTimeout> | undefined;
    const url = data.url;
    const startedAtMs = Date.now();
    setProbe(initialProbeSnapshot());
    setNextRetryAtMs(null);

    // W-PREVIEWFIX-STOP — backoff-phase-only visibility gate (see module
    // header for why the fast cold-start phase is left ungated). `armedFire`
    // remembers what the currently-armed `timer` would call, so a
    // visibilitychange to hidden mid-countdown can cancel it outright
    // instead of letting it fire once more into the void; `pendingResume`
    // remembers the same thing for the case where we were ALREADY hidden
    // when a retry tried to schedule. Either way, the very next
    // visibilitychange back to visible fires it immediately.
    let armedFire: (() => void) | null = null;
    let pendingResume: (() => void) | null = null;
    let backoffStartedAtMs: number | null = null;
    const isHidden = () => typeof document !== 'undefined' && document.hidden;

    function onVisibilityChange(): void {
      if (cancelled) return;
      if (isHidden()) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
          pendingResume = armedFire;
          armedFire = null;
        }
        return;
      }
      const resume = pendingResume;
      pendingResume = null;
      if (resume) resume();
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    async function runProbe(current: PreviewProbeSnapshot): Promise<void> {
      const ok = await probeReachable(url);
      if (cancelled) return;
      const elapsedMs = Date.now() - startedAtMs;
      const { snapshot, shouldContinue, nextDelayMs } = reduceProbeResult(current, ok, elapsedMs);
      setProbe(snapshot);
      if (shouldContinue) {
        timer = setTimeout(() => void runProbe(snapshot), nextDelayMs);
        return;
      }
      // W-PREVIEWFIX — previewProbe.ts's cold-start window only ever gives
      // up when `ok` is false (a success always transitions straight to
      // 'reachable' with shouldContinue: false too, see reduceProbeResult) —
      // guard on it explicitly anyway rather than assuming, so a future
      // change to that reducer can't silently make this fall through.
      if (ok) return;
      // Console-spam fix (real QA: dozens of console lines/minute from a
      // target stuck erroring) — ONE capped diagnostic per STATE
      // TRANSITION (cold-start window giving up), never per individual
      // probe attempt. This is deliberately NOT an attempt to match or
      // replace the browser's own per-attempt net::ERR_* console line for
      // each failed fetch during the cold-start window above (module
      // header: there is no JS-callable way to suppress that) — it is a
      // single, rate-limited, informative line marking the handoff into
      // previewBackoff.ts's much slower schedule.
      console.warn(`[previewNode] ${url} unreachable after ${snapshot.attempt} attempt(s) — backing off.`);
      scheduleBackoffRetry(1);
    }

    // W-PREVIEWFIX — once the cold-start window above honestly gives up,
    // a PERSISTED preview must not go silent forever (the old behaviour —
    // see this file's + previewBackoff.ts's headers) nor keep hammering the
    // dead port on the cold-start's fast cadence (11 net::ERR_CONNECTION_REFUSED
    // in ~4 real minutes, observed in QA). It instead keeps probing on
    // previewBackoff.ts's much slower, capped schedule, surfaced to the
    // user as the next-retry countdown alongside the existing "Serveur
    // injoignable" message.
    function scheduleBackoffRetry(failureStreak: number): void {
      if (backoffStartedAtMs === null) backoffStartedAtMs = Date.now();
      // W-PREVIEWFIX-STOP — past PREVIEW_BACKOFF_GIVE_UP_MS of continuous
      // failure, stop scheduling entirely rather than repeat the schedule's
      // capped final step forever: the countdown disappears (nextRetryAtMs
      // stays null, see the render's `secondsUntilRetry` derivation) and the
      // existing "Serveur injoignable" message is all that's left — the
      // user has to act (manual refresh, a new url, or refreshRequestedAtMs)
      // to restart this whole effect and re-arm it.
      if (hasGivenUpBackoff(Date.now() - backoffStartedAtMs)) {
        setNextRetryAtMs(null);
        // Console-spam fix — ONE capped diagnostic for this transition
        // (still-consecutively-failing -> permanently given up), never
        // repeated on every subsequent render/effect while in this state
        // (this branch only runs once, right when hasGivenUpBackoff first
        // flips true — see this file's own module header for the full
        // "one trace per transition, not per attempt" rationale).
        console.warn(`[previewNode] ${url} permanently unreachable after ${failureStreak} backoff attempt(s) — giving up automatic retries.`);
        // Preview lifecycle fix — a dev server that never recovers must not
        // leave an auto-suggested card frozen on the canvas forever (the
        // exact "shows offline, sits there forever, even across restarts"
        // bug this fix addresses). Grace-delayed (AUTO_PREVIEW_REMOVE_GRACE_MS)
        // rather than immediate, in case a success lands right as give-up
        // fires. A MANUALLY-added preview (data.autoAdded absent/false) is
        // left alone — the user asked for this one explicitly and can close
        // it themselves; only the system's own suggestion cleans up after
        // itself, same "who gets to decide" split SurfaceSpec.autoAdded's
        // own doc comment already establishes for the dismiss preference.
        if (data.autoAdded) {
          removeTimer = setTimeout(() => removeSurface(data.id), AUTO_PREVIEW_REMOVE_GRACE_MS);
        }
        return;
      }
      const delayMs = nextBackoffDelayMs(failureStreak);
      setNextRetryAtMs(Date.now() + delayMs);
      setNowTick(Date.now());
      const fire = () => void runBackoffProbe(failureStreak);
      if (isHidden()) {
        pendingResume = fire;
        return;
      }
      armedFire = fire;
      timer = setTimeout(fire, delayMs);
    }

    async function runBackoffProbe(failureStreak: number): Promise<void> {
      const ok = await probeReachable(url);
      if (cancelled) return;
      if (ok) {
        // Console-spam fix — ONE capped diagnostic marking recovery, the
        // last of the (at most 3) log lines this whole failure episode
        // ever produces: entering backoff, then EITHER this OR the
        // permanent give-up above, never both, never one per attempt.
        console.info(`[previewNode] ${url} reachable again after ${failureStreak} backoff attempt(s).`);
        // Any success resets the schedule: a LATER failure (this surface's
        // effect re-running from data.url/refreshNonce, or a future probe
        // going back down) starts over at the fast step, never resuming
        // from wherever this streak left off.
        setProbe({ state: 'reachable', attempt: failureStreak, elapsedMs: Date.now() - startedAtMs });
        setNextRetryAtMs(null);
        return;
      }
      scheduleBackoffRetry(failureStreak + 1);
    }

    void runProbe(initialProbeSnapshot());
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (removeTimer !== undefined) clearTimeout(removeTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
    // refreshNonce is a deliberate re-arm trigger (manual refresh button) —
    // not read inside the effect, only used to force this effect to re-run.
    // W-UX3 core deliverable 3c — data.refreshRequestedAtMs is the SAME kind
    // of re-arm trigger, bumped externally by
    // useCanvasAutoComposition.ts (via updateSurface) whenever a mission
    // completes in this surface's zone — "the site updates before your
    // eyes" without the user touching the refresh button themselves.
    // Bumping either one also resets the W-PREVIEWFIX backoff above, since
    // this whole effect (and its local failureStreak/nextRetryAtMs) restarts
    // from scratch — the manual refresh button's "retry now, reset backoff"
    // requirement falls out of that restart for free. data.autoAdded/data.id/
    // removeSurface (preview lifecycle fix) are read only inside the
    // give-up branch above; included here for honesty even though
    // autoAdded/id are fixed for a mounted card's whole lifetime and
    // removeSurface (a zustand action) is a stable reference — none of the
    // three ever actually trigger a re-run in practice.
  }, [data.url, refreshNonce, data.refreshRequestedAtMs, data.autoAdded, data.id, removeSurface]);

  const handleRefresh = useCallback(() => setRefreshNonce((n) => n + 1), []);
  const reach = probe.state;
  // fix/canvas-preview-controls (owner brief: "controls — open in browser,
  // restart, stop, copy URL?") — devPreview.ts already owns a real dev-
  // server lifecycle (`ensureDevServerForProject` spawns `npm run dev` via
  // the app's own PTY, `stopDevServer` is that module's own doc comment,
  // verbatim: "Exposed directly ... for a future explicit 'stop preview' UI
  // action" — this IS that action). `isDevServerManaged` is only true for a
  // server THIS app itself spawned — a server the user started by hand in
  // their own terminal (devPreview's "reuse-if-running" path) is never
  // tracked here, so Stop deliberately never appears for one: this app must
  // never offer to kill a process it doesn't own. Read directly in the
  // render body (a plain synchronous Map lookup, not a subscription) — this
  // component already re-renders on every probe/heartbeat tick, so the
  // control appears/disappears within a beat of the underlying server
  // actually starting/stopping; a dedicated store subscription for one
  // rarely-changing boolean would be more machinery than this is worth.
  //
  // Deliberately NOT adding a "restart" button in this pass: the safe
  // restart path (re-spawn via `ensureDevServerForProject`) needs the
  // project's real worktree list to pick the right target when a mission is
  // running in a worktree — `useCanvasAutoComposition.ts`'s own tick loop
  // already has and threads that (`worktreeRels`), this node does not. A
  // restart that skipped it could spawn a second server for the wrong
  // checkout. Stop is safe standalone (it only ever kills a process this
  // module itself started); the existing auto-composition tick loop already
  // re-ensures a stopped server the next time it's needed, so "stop then let
  // it come back on its own" is the honest v1 rather than a hand-rolled
  // restart that risks a duplicate/wrong-worktree server.
  const managed = data.projectId ? isDevServerManaged(data.projectId) : false;
  const [urlJustCopied, setUrlJustCopied] = useState(false);
  const copyUrl = useCallback(() => {
    if (!data.url) return;
    navigator.clipboard?.writeText(data.url).catch(() => {
      // Best-effort, same posture as every other clipboard/openExternal call
      // in this file (module header) — no dedicated error UI.
    });
    setUrlJustCopied(true);
    window.setTimeout(() => setUrlJustCopied(false), 1500);
  }, [data.url]);
  // W-PREVIEWFIX — whole seconds remaining until the next backoff retry, or
  // null while not backing off (cold-starting, reachable, or no url).
  const secondsUntilRetry = nextRetryAtMs === null ? null : Math.max(0, Math.ceil((nextRetryAtMs - nowTick) / 1000));
  // P59 — the actual `display: none` vs `display: block` verdict for the
  // iframe (see previewAttendedState.ts's own header for each gate). NEVER
  // used to decide whether the CARD collapses to its compact repli tier —
  // that stays exactly the pre-existing `forceFull`/zoom-level logic below,
  // per this fix's own "chrome stays, content pauses" rule.
  // Task 3 — previewAttendedState.ts's own reducer formula is out of this
  // wave's file boundary (only the canvas *.tsx node files are in scope),
  // so its existing `pinnedLive` OR-branch carries the coordinator's own
  // verdict back in here instead of editing that pure function: a preview
  // that auto-claimed the live slot from reachability alone (isLiveWinner)
  // is, behaviorally, asking for exactly what an explicitly pinned preview
  // already gets — full chrome, live iframe — until a more-recently-claimed
  // preview takes the slot back. The real `pinnedLive` React state (the pin
  // button's own toggle, above) is still ORed in unchanged, so an explicit
  // user pin keeps working exactly as before.
  const { iframeLive } = derivePreviewAttendedState({
    selected: selected === true,
    hovered: isHovered,
    pinnedLive: pinnedLive || isLiveWinner,
    isLiveWinner,
    gesturePaused,
    reachable: reach === 'reachable',
  });

  function commitUrl(): void {
    const trimmed = draftUrl.trim();
    if (!trimmed) return;
    if (!isAllowedPreviewUrl(trimmed)) {
      setInvalidUrlError(true);
      return;
    }
    setInvalidUrlError(false);
    updateSurface(data.id, { url: trimmed });
  }

  // fix/canvas-legibility — repli compact: no URL yet is the EXACT QA
  // repro ("empty browser pane saying 'Aucune adresse'" rendering as a
  // huge near-black rectangle) — the honest signal to collapse is already
  // available (`!data.url`), no field needs inventing. Below full zoom this
  // ALSO collapses (same LOD tier every other living pane now shares). A
  // preview WITH a url and `reach === 'reachable'` at full zoom is
  // deliberately never collapsed — cross-origin content can't be read to
  // produce a better proxy for "useful content present" than "the probe
  // says something is listening", so hiding the live iframe there would
  // discard real information without justification.
  //
  // Plan deviation (documented): `selected` OR a real mouse `isHovered`
  // always forces the full card, same override TerminalNodeCard's own
  // idle-repli tier uses for `selected` alone. Required, not optional — the
  // URL bar (the ONLY way to give a freshly-created, url-less preview a URL
  // at all) lives inside the full render; without this override a brand-new
  // preview with no url would permanently collapse to a non-interactive
  // compact chip with no path back to the input field. P48 adds hover
  // alongside selection: "the user wants to work with THIS node right now"
  // is just as true while hovering it as while it's selected — selection
  // alone was the ORIGINAL "finicky" friction (had to click and keep the
  // node selected just to type a URL). P59 reuses this exact same union as
  // `attended` above (adding `pinnedLive` as a third trigger) rather than
  // duplicating the boolean: a pinned-live preview needs its full chrome on
  // screen for the same reason a selected/hovered one does.
  const forceFull = attended;
  if (!forceFull && (zoomLevel !== 'full' || !data.url)) {
    return (
      <div
        data-testid={`preview-node-compact-${data.id}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{ display: 'inline-flex' }}
      >
        <NodeResizer
          isVisible={selected}
          minWidth={MIN_WIDTH}
          minHeight={MIN_HEIGHT}
          onResizeEnd={(_event, params) => updateSurface(data.id, { width: params.width, height: params.height })}
        />
        {/* fix/canvas-agents-visibility (deliverable 2a) — a preview that
            already has a url gets the substantial go-live card (url +
            status + "Voir en direct"), never the anonymous chip; a
            url-less preview (nothing to watch yet) keeps the original bare
            repli unchanged. */}
        {data.url ? (
          <PreviewGoLiveCard
            testId={`preview-node-golive-${data.id}`}
            url={data.url}
            statusLabel={t(`canvas.preview.${reach}`)}
            statusColor={reach === 'reachable' ? 'var(--color-success-text)' : 'var(--color-text-disabled)'}
            viewLiveLabel={t('canvas.preview.viewLive')}
            onViewLive={() => emit('canvas:focus', { ref: makeRef('preview', data.id), minZoom: PREVIEW_FOCUS_MIN_ZOOM })}
          />
        ) : (
          <LivingPaneCompactCard
            testId={`living-pane-chip-preview-${data.id}`}
            title={t('canvas.preview.noUrl')}
            liveness="neutral"
            lastEventLine={t(`canvas.preview.${reach}`)}
          />
        )}
      </div>
    );
  }

  const autoStartedTitle = data.autoAdded ? deriveAutoStartedTitle(data.projectId, data.url) : null;

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        onResizeEnd={(_event, params) => updateSurface(data.id, { width: params.width, height: params.height })}
      />
      <div
        data-testid={`preview-node-${data.id}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          width,
          height,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 10,
          overflow: 'hidden',
          // Design pass — aligned onto the SAME tokens
          // chrome/nodeChrome.tsx's shared NodeCard shell uses for every
          // mission/draft/router/join card (`--canvas-node-bg`/
          // `--canvas-node-border-resting`), not the generic panel/border
          // vars this hand-rolled card used before: a preview used to sit a
          // shade darker with a slightly different hairline than its
          // sibling cards, a subtle "does this belong to the same family"
          // mismatch. Corner radius (10) and shadow already matched.
          background: 'var(--canvas-node-bg)',
          border: selected ? '2px solid var(--color-accent)' : '1px solid var(--canvas-node-border-resting)',
          boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
        }}
      >
        <div
          className="nodrag"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 8px',
            background: 'var(--color-panel-2)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            flexShrink: 0,
          }}
        >
          <PreviewGlyph />
          {/* P46+P48 — auto-started label: "the node title shows the project
              name + port" once devPreview.ts's orchestration attached this
              preview automatically. Absent for a manually-added preview
              (data.autoAdded is absent/false there) — no misleading label on
              a URL the user typed in themselves. */}
          {autoStartedTitle && (
            <span
              data-testid={`preview-node-title-${data.id}`}
              title={autoStartedTitle}
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: 'var(--color-text-secondary)',
                flexShrink: 0,
                maxWidth: 96,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {autoStartedTitle}
            </span>
          )}
          <input
            type="text"
            data-testid={`preview-node-url-input-${data.id}`}
            value={draftUrl}
            placeholder={t('canvas.preview.urlPlaceholder')}
            onChange={(e) => {
              setDraftUrl(e.target.value);
              setInvalidUrlError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitUrl();
            }}
            onBlur={commitUrl}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-text)',
              background: 'var(--color-panel-3)',
              border: '1px solid var(--color-border-3)',
              borderRadius: 5,
              padding: '3px 6px',
            }}
          />
          {data.url && !invalidUrlError && (
            <PreviewLiveBadgeButton
              testId={`preview-node-status-badge-${data.id}`}
              reachable={reach === 'reachable'}
              liveLabel={t('canvas.preview.badgeLive')}
              offlineLabel={t('canvas.preview.badgeOffline')}
              retryLabel={t('canvas.preview.retryNow')}
              onRetry={handleRefresh}
            />
          )}
          {/* P48 — open the live URL in the system browser (never inside the
              app-privileged iframe/webview) — the honest escape hatch when
              the user wants to actually USE the site, not just preview it. */}
          {data.url && !invalidUrlError && (
            <button
              type="button"
              data-testid={`preview-node-open-external-${data.id}`}
              aria-label={t('canvas.preview.openExternal')}
              title={t('canvas.preview.openExternal')}
              onClick={(e) => {
                e.stopPropagation();
                openExternal(data.url as string).catch(() => {
                  // Best-effort — openExternal itself already surfaces a
                  // thrown error to whichever caller wants to toast it; this
                  // node has no dedicated error UI for it, so a failure here
                  // simply does nothing rather than crash the canvas.
                });
              }}
              style={{
                width: 18,
                height: 18,
                lineHeight: '16px',
                borderRadius: 4,
                border: 'none',
                background: 'transparent',
                color: 'var(--color-text-disabled)',
                cursor: 'pointer',
                fontSize: 12,
                flexShrink: 0,
              }}
            >
              ↗
            </button>
          )}
          {/* fix/canvas-preview-controls — "copy URL" always available from
              the header (not only inside the paused overlay, which only ever
              renders while `reach === 'reachable'` — every other state, and
              the far more common "reachable but not the single live winner"
              case, had no copy affordance at all). Same clipboard write +
              transient confirmation glyph as PreviewPausedOverlay's own copy
              button (this file's `copyUrl` above). */}
          {data.url && !invalidUrlError && (
            <button
              type="button"
              data-testid={`preview-node-copy-url-${data.id}`}
              aria-label={urlJustCopied ? t('canvas.preview.copied') : t('canvas.preview.copyUrl')}
              title={urlJustCopied ? t('canvas.preview.copied') : t('canvas.preview.copyUrl')}
              onClick={(e) => {
                e.stopPropagation();
                copyUrl();
              }}
              style={{
                width: 18,
                height: 18,
                lineHeight: '16px',
                borderRadius: 4,
                border: 'none',
                background: 'transparent',
                color: urlJustCopied ? 'var(--color-success-text)' : 'var(--color-text-disabled)',
                cursor: 'pointer',
                fontSize: 12,
                flexShrink: 0,
              }}
            >
              {urlJustCopied ? '✓' : '⧉'}
            </button>
          )}
          {data.url && !invalidUrlError && (
            <PreviewPinLiveButton
              testId={`preview-node-pin-live-${data.id}`}
              pinned={pinnedLive}
              label={t(pinnedLive ? 'canvas.preview.unpinLive' : 'canvas.preview.pinLive')}
              onToggle={togglePinnedLive}
            />
          )}
          {/* R13 — manual refresh: re-arms the polling probe from a fresh
              snapshot (initialProbeSnapshot), independent of the automatic
              schedule — the honest escape hatch for "I know it's up now,
              stop waiting for the backoff timer". Available in every state
              (including mid-poll) since there is no harm in restarting the
              probe early. */}
          <button
            type="button"
            data-testid={`preview-node-refresh-${data.id}`}
            aria-label={t('canvas.preview.refresh')}
            title={t('canvas.preview.refresh')}
            onClick={(e) => {
              e.stopPropagation();
              handleRefresh();
            }}
            style={{
              width: 18,
              height: 18,
              lineHeight: '16px',
              borderRadius: 4,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-disabled)',
              cursor: 'pointer',
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            ↻
          </button>
          {/* fix/canvas-preview-controls — stops the REAL dev-server process,
              only ever shown for a server this app itself spawned (`managed`
              above) — see this file's own doc comment on `managed` for why a
              reused/user-launched server never gets this control. Stopping
              removes the node too: `stopDevServer` emits
              `devPreview:serverStopped`, which the app's existing bus wiring
              (that function's own doc comment) already uses to drop the
              matching preview surface — the honest outcome of "I stopped the
              server" is the dead preview disappearing, not sitting there
              forever reading "Serveur injoignable" for a shutdown the user
              asked for. */}
          {managed && (
            <button
              type="button"
              data-testid={`preview-node-stop-server-${data.id}`}
              aria-label={t('canvas.preview.stopServer')}
              title={t('canvas.preview.stopServer')}
              onClick={(e) => {
                e.stopPropagation();
                if (data.projectId) stopDevServer(data.projectId);
              }}
              style={{
                width: 18,
                height: 18,
                lineHeight: '16px',
                borderRadius: 4,
                border: 'none',
                background: 'transparent',
                color: 'var(--color-danger-text)',
                cursor: 'pointer',
                fontSize: 12,
                flexShrink: 0,
              }}
            >
              ■
            </button>
          )}
          <button
            type="button"
            data-testid={`preview-node-close-${data.id}`}
            aria-label={t('canvas.preview.close')}
            onClick={(e) => {
              e.stopPropagation();
              // W-UX3 core deliverable 3a — dismissing an AUTO-ADDED
              // preview is remembered per-project (never re-suggested); a
              // manually-added preview's close is unaffected (autoAdded is
              // absent/false there).
              if (data.autoAdded && data.projectId) dismissAutoPreview(data.projectId);
              removeSurface(data.id);
            }}
            style={{
              width: 18,
              height: 18,
              lineHeight: '16px',
              borderRadius: 4,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-disabled)',
              cursor: 'pointer',
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {invalidUrlError && (
          <div
            data-testid={`preview-node-invalid-url-${data.id}`}
            style={{ padding: '4px 8px', fontSize: 10.5, color: 'var(--color-danger-text)', background: 'rgba(239,68,68,0.08)' }}
          >
            {t('canvas.preview.invalidUrl')}
          </div>
        )}

        <div
          className="nodrag"
          style={{
            flex: 1,
            minHeight: 0,
            position: 'relative',
            background: '#0E0E12',
            // Design pass — "l'iframe live avec un cadre lumineux qui dit
            // c'est vivant": a soft inward accent ring, ONLY while the
            // iframe is actually attended-and-rendering (`iframeLive` —
            // never while merely reachable-but-paused/backing-off/loading,
            // so this never contradicts the paused overlay's own "chrome
            // stays, content pauses" honesty rule). Inset (not an outer
            // glow) so it never bleeds past this card's own rounded corners
            // or competes with the selection ring.
            boxShadow: iframeLive
              ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-success) 55%, transparent), inset 0 0 14px -4px color-mix(in srgb, var(--color-success) 65%, transparent)'
              : 'none',
            transition: 'box-shadow 300ms ease',
          }}
        >
          {!data.url && (
            <PreviewStatus testId={`preview-node-empty-${data.id}`} text={t('canvas.preview.noUrl')} />
          )}
          {data.url && reach === 'checking' && (
            <PreviewStatus testId={`preview-node-loading-${data.id}`} text={t('canvas.preview.loading')} spinner />
          )}
          {/* R13 — 'starting': at least one probe already failed and polling
              is still within its window (previewProbe.ts) — a cold dev
              server binding its port, not a dead one. Distinct wording +
              spinner from both 'checking' (first attempt) and the final
              'unreachable' (timed out) so the user isn't told "unreachable"
              prematurely on attempt 2 of ~15. */}
          {data.url && !invalidUrlError && reach === 'starting' && (
            <PreviewStatus testId={`preview-node-starting-${data.id}`} text={t('canvas.preview.starting')} spinner />
          )}
          {data.url && !invalidUrlError && reach === 'unreachable' && (
            <PreviewStatus
              testId={`preview-node-unreachable-${data.id}`}
              text={t('canvas.preview.unreachable')}
              // W-PREVIEWFIX — only set once the cold-start window has handed
              // off to the slow backoff (never during the initial ~60s), so
              // this reads null (no countdown line) right up until then.
              subtext={
                secondsUntilRetry === null
                  ? undefined
                  : t('canvas.preview.retryingIn', { seconds: secondsUntilRetry })
              }
              action={{ label: t('canvas.preview.refresh'), onClick: handleRefresh }}
            />
          )}
          {data.url && reach === 'reachable' && (
            <>
              {/* Fix 5 — the ONE case this iframe is not even mounted: HIGH
                  system pressure AND not attended (see `unloadForPressure`'s
                  own doc comment above). Every other case keeps the
                  pre-existing P59 mount-forever/toggle-display behavior
                  unchanged. */}
              {!unloadForPressure && (
                <iframe
                  data-testid={`preview-node-iframe-${data.id}`}
                  title={data.url}
                  src={data.url}
                  // See module header — narrow, deliberate sandbox allowlist,
                  // never fewer restrictions than a plain browser tab already has
                  // for a page the user opened themselves.
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    background: '#fff',
                    // P59 — `display: none` PAUSES (browsers throttle/suspend a
                    // hidden iframe's own rAF/timers) rather than unmounts:
                    // the element, its `src`, and its live document all stay
                    // exactly as they are, so re-attending shows the SAME
                    // running page instantly — never a reload flash.
                    display: iframeLive ? 'block' : 'none',
                  }}
                />
              )}
              {(!iframeLive || unloadForPressure) && (
                <PreviewPausedOverlay
                  testId={`preview-node-paused-${data.id}`}
                  url={data.url}
                  liveLabel={t('canvas.preview.badgeLive')}
                  hint={t('canvas.preview.pausedHint')}
                  // fix/canvas-agents-visibility (deliverable 2c) — "En
                  // ligne" must show a clickable-copiable url, not inert
                  // text. Same best-effort posture as the header's own ↗
                  // button above: no dedicated error UI for either action.
                  onOpenExternal={() => {
                    openExternal(data.url as string).catch(() => {});
                  }}
                  onCopyUrl={() => {
                    navigator.clipboard?.writeText(data.url as string)?.catch(() => {});
                  }}
                  copyLabel={t('canvas.preview.copyUrl')}
                  copiedLabel={t('canvas.preview.copied')}
                />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

const artifactNavButtonStyle: React.CSSProperties = {
  width: 18,
  height: 18,
  lineHeight: '16px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'var(--color-text-disabled)',
  cursor: 'pointer',
  fontSize: 12,
  flexShrink: 0,
};

/** Approximate rendered height of ArtifactSurfaceCard's own header row
 *  (5px top/bottom padding + the 18px icon/button row + 1px bottom border)
 *  — used only to derive the AVAILABLE content box for the scale-to-fit
 *  math below, never to actually lay out the real header (plain flexbox,
 *  unaffected by this constant). Deliberately rounded UP a couple px rather
 *  than exact: the safe direction is a SLIGHTLY smaller computed available
 *  box (a hair more empty margin around the scaled content) — never a
 *  larger one, which could reintroduce this file's own clipping bug if the
 *  real header ever grows taller than assumed. */
const ARTIFACT_HEADER_HEIGHT_PX = 30;

/** Computes a scale-to-fit-and-center layout for arbitrary intrinsic content
 *  dimensions inside an arbitrary available box. Verbatim duplicate of
 *  ArtifactProposalCard.tsx's own `computeContainedLayout` — that file's own
 *  doc comment explains why (independently-scoped files, no shared util
 *  module between components/lazyManager/** and this directory, kept in
 *  sync by hand) — exported here too for direct unit testing against this
 *  bug's own real repro numbers (a 1080x1080 view inside a measured
 *  218x258 frame).
 *
 *  Never scales UP past the content's own natural size — content smaller
 *  than its frame is centered at its real size rather than blurrily
 *  magnified. Aspect ratio is always preserved (one uniform `scale` on both
 *  axes), so the result never deforms the content and always fits entirely
 *  inside the available box in both dimensions at once. */
export function computeContainedLayout(
  intrinsicWidth: number,
  intrinsicHeight: number,
  availableWidth: number,
  availableHeight: number,
): { boxWidth: number; boxHeight: number; scale: number } {
  if (intrinsicWidth <= 0 || intrinsicHeight <= 0 || availableWidth <= 0 || availableHeight <= 0) {
    return { boxWidth: Math.max(0, availableWidth), boxHeight: Math.max(0, availableHeight), scale: 1 };
  }
  const scale = Math.min(availableWidth / intrinsicWidth, availableHeight / intrinsicHeight, 1);
  return {
    boxWidth: Math.max(1, Math.round(intrinsicWidth * scale)),
    boxHeight: Math.max(1, Math.round(intrinsicHeight * scale)),
    scale,
  };
}

/** Reads the REAL rendered size of a sandboxed artifact iframe's own
 *  content. Verbatim duplicate of ArtifactProposalCard.tsx's own
 *  `measureSandboxedContentSize` — see that function's doc comment for the
 *  full reasoning (why `allow-same-origin` without `allow-scripts` is safe,
 *  why declared metadata alone was never enough). Returns null when the
 *  document isn't accessible yet or reports no real size — the caller then
 *  falls back to filling its box unscaled, same posture as before this fix
 *  for the brief pre-measurement instant. */
export function measureSandboxedContentSize(
  iframe: HTMLIFrameElement | null,
): { width: number; height: number } | null {
  if (!iframe) return null;
  try {
    const doc = iframe.contentDocument;
    const root = doc?.documentElement;
    if (!doc || !root) return null;
    const width = Math.max(root.scrollWidth, doc.body?.scrollWidth ?? 0);
    const height = Math.max(root.scrollHeight, doc.body?.scrollHeight ?? 0);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    // Defense-in-depth — should never actually throw given
    // allow-same-origin above, but a future sandbox-attribute change here
    // must degrade to "no measurement", never crash the whole node.
    return null;
  }
}

const artifactExpandedCloseButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: -14,
  right: -14,
  width: 28,
  height: 28,
  borderRadius: '50%',
  border: 'none',
  background: '#fff',
  color: '#111',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 700,
};

/** Resolves which {@link SurfaceHtmlView} is active — `activeViewId` when it
 *  still matches one of `views`, otherwise the first view. A stale/removed
 *  id (a view deleted since `activeViewId` was last persisted) degrades to a
 *  safe default rather than rendering nothing — same defensive posture as
 *  every other "never trust a persisted value un-narrowed" guard in this
 *  file (see module header on `data.url`). */
function resolveActiveViewIndex(views: readonly SurfaceHtmlView[], activeViewId: string | undefined): number {
  if (!activeViewId) return 0;
  const idx = views.findIndex((v) => v.id === activeViewId);
  return idx >= 0 ? idx : 0;
}

export interface ArtifactSurfaceCardProps {
  data: SurfaceSpec;
  selected?: boolean;
  /** Test-only escape hatch — see PreviewNodeCardProps's identical prop doc
   *  comment. Defaults to 'full'. */
  zoomLevel?: 'chip' | 'compact' | 'full';
}

/**
 * ArtifactSurfaceCard — the "visible design preview" render path (module
 * header's VISIBLE-ARTIFACT FIX): renders `data.htmlViews` locally via
 * `srcDoc` inside a fully-locked-down sandbox, with prev/next navigation
 * across however many views the artifact carries (never a fixed count).
 * A SEPARATE component from `PreviewNodeCard` (rather than a branch inside
 * it) so the two never risk a conditional-hooks violation if a surface's
 * `htmlViews` presence ever changed across a re-render of the same mounted
 * instance — see the exported `PreviewNode` below, which picks one or the
 * other BEFORE either component's own hooks run.
 */
export function ArtifactSurfaceCard({ data, selected, zoomLevel = 'full' }: ArtifactSurfaceCardProps) {
  const { t } = useI18n();
  const removeSurface = useCanvasStore((s) => s.removeSurface);
  const updateSurface = useCanvasStore((s) => s.updateSurface);
  const width = data.width ?? PREVIEW_NODE_SIZE.width;
  const height = data.height ?? PREVIEW_NODE_SIZE.height;
  const [isHovered, setIsHovered] = useState(false);
  const handleMouseEnter = useCallback(() => setIsHovered(true), []);
  const handleMouseLeave = useCallback(() => setIsHovered(false), []);

  // AUTO-SCALE FIX (module header) — the iframe's own real rendered size,
  // measured on `onLoad`, never assumed from any declared metadata (this
  // surface's `SurfaceHtmlView` carries none). `null` until the first
  // successful measurement — the render below then falls back to filling
  // the box unscaled, same posture as before this fix.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number } | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const handleArtifactLoad = useCallback(() => {
    const measured = measureSandboxedContentSize(iframeRef.current);
    if (measured) setMeasuredSize(measured);
  }, []);

  const views = data.htmlViews ?? [];
  // Local state (initialized from `data.activeViewId`) is the RENDERED
  // source of truth — same "initialize from data, then locally driven"
  // convention `draftUrl` uses above for the live-preview path — so a click
  // updates the screen immediately and synchronously, never waiting on a
  // canvasStore round-trip + reconcile to feed a fresh `data` prop back in
  // (this component has no store subscription of its own for `htmlViews`).
  // `updateSurface` below is still called on every navigation as a
  // best-effort PERSISTENCE side effect (survives a reload/reconcile), not
  // as the mechanism driving this render.
  const [viewIndex, setViewIndex] = useState(() => resolveActiveViewIndex(views, data.activeViewId));
  // A stale index (views shrank since last set) degrades to the first view
  // rather than rendering nothing — same defensive posture as
  // resolveActiveViewIndex itself.
  const activeIndex = viewIndex < views.length ? viewIndex : 0;
  const activeView: SurfaceHtmlView | undefined = views[activeIndex];
  const hasMultipleViews = views.length > 1;

  // A fresh view (nav to a different page/screen) invalidates any prior
  // measurement — `iframeRef` is reused across a view switch (only the
  // iframe's own `key={activeView.id}` remounts the DOM node below), so
  // without this reset a stale measured size from the PREVIOUS view would
  // keep driving the scale for one render.
  useEffect(() => {
    setMeasuredSize(null);
    setIsExpanded(false);
  }, [activeView?.id]);

  function goToView(index: number): void {
    if (views.length === 0) return;
    const clamped = ((index % views.length) + views.length) % views.length;
    setViewIndex(clamped);
    const view = views[clamped];
    if (view) updateSurface(data.id, { activeViewId: view.id });
  }

  // Same "selected or hovered forces the full card" override PreviewNodeCard
  // uses (P48) — BUT unlike PreviewNodeCard, this compact branch still needs
  // its own prev/next controls (below), not just the full render's — see
  // the next comment for why.
  const forceFull = selected === true || isHovered;
  if (!forceFull && zoomLevel !== 'full') {
    // Real QA repro (B4, night run 2026-07-25): a proposed template with
    // several navigable views ("1/3 — Slide 1 — Hook" in the chat card) only
    // ever showed a static "N vue(s)" COUNT here, with zero way to actually
    // navigate them — the full render's prev/next buttons only exist past
    // the forceFull override above, and the whole QA session ran at low zoom
    // (10-26%), so the founder never once saw a way to page through a
    // multi-view proposal on the canvas. The chat card (ArtifactProposalCard
    // .tsx's VariantCard) has no such zoom concept and always lets the
    // founder page through every view — this compact tier must offer the
    // SAME capability, not a read-only summary, same
    // `preview-node-artifact-prev-/-next-${id}` testids and `goToView` used
    // by the full render below so the two stay behaviourally identical.
    return (
      <div
        data-testid={`preview-node-compact-${data.id}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
      >
        <NodeResizer
          isVisible={selected}
          minWidth={MIN_WIDTH}
          minHeight={MIN_HEIGHT}
          onResizeEnd={(_event, params) => updateSurface(data.id, { width: params.width, height: params.height })}
        />
        <LivingPaneCompactCard
          testId={`living-pane-chip-preview-${data.id}`}
          title={activeView?.label ?? t('canvas.preview.noUrl')}
          liveness="neutral"
          lastEventLine={t('canvas.preview.artifactViewCount', { count: views.length })}
        />
        {hasMultipleViews && (
          <div className="nodrag" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              data-testid={`preview-node-artifact-prev-${data.id}`}
              aria-label={t('canvas.preview.artifactPrevView')}
              title={t('canvas.preview.artifactPrevView')}
              onClick={(e) => { e.stopPropagation(); goToView(activeIndex - 1); }}
              style={artifactNavButtonStyle}
            >
              ◂
            </button>
            <span style={{ fontSize: 10, color: 'var(--color-text-disabled)' }}>
              {activeIndex + 1}/{views.length}
            </span>
            <button
              type="button"
              data-testid={`preview-node-artifact-next-${data.id}`}
              aria-label={t('canvas.preview.artifactNextView')}
              title={t('canvas.preview.artifactNextView')}
              onClick={(e) => { e.stopPropagation(); goToView(activeIndex + 1); }}
              style={artifactNavButtonStyle}
            >
              ▸
            </button>
          </div>
        )}
      </div>
    );
  }

  // Defensive — the caller (PreviewNode below) only mounts this component
  // when `htmlViews` is non-empty, but never trust that un-narrowed (same
  // discipline as every other guard in this file).
  if (!activeView) return null;

  // AUTO-SCALE FIX — the available content box is derived analytically from
  // this node's own already-known width/height (both fully reactive to a
  // NodeResizer drag via `updateSurface` above) rather than a separate DOM
  // measurement of our own trusted wrapper — same "layout driven by known
  // values, not re-measured" convention this whole file already follows for
  // its outer card dimensions. See ARTIFACT_HEADER_HEIGHT_PX's own doc
  // comment for why the header's height is subtracted this way.
  const availableWidth = width;
  const availableHeight = Math.max(1, height - ARTIFACT_HEADER_HEIGHT_PX);
  const layout = measuredSize
    ? computeContainedLayout(measuredSize.width, measuredSize.height, availableWidth, availableHeight)
    : null;

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        onResizeEnd={(_event, params) => updateSurface(data.id, { width: params.width, height: params.height })}
      />
      <div
        data-testid={`preview-node-${data.id}`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        style={{
          width,
          height,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 10,
          overflow: 'hidden',
          // Design pass — aligned onto the SAME tokens
          // chrome/nodeChrome.tsx's shared NodeCard shell uses for every
          // mission/draft/router/join card (`--canvas-node-bg`/
          // `--canvas-node-border-resting`), not the generic panel/border
          // vars this hand-rolled card used before: a preview used to sit a
          // shade darker with a slightly different hairline than its
          // sibling cards, a subtle "does this belong to the same family"
          // mismatch. Corner radius (10) and shadow already matched.
          background: 'var(--canvas-node-bg)',
          border: selected ? '2px solid var(--color-accent)' : '1px solid var(--canvas-node-border-resting)',
          boxShadow: '2px 2px 0 rgba(0,0,0,0.35)',
        }}
      >
        <div
          className="nodrag"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 8px',
            background: 'var(--color-panel-2)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            flexShrink: 0,
          }}
        >
          <PreviewGlyph />
          {hasMultipleViews && (
            <button
              type="button"
              data-testid={`preview-node-artifact-prev-${data.id}`}
              aria-label={t('canvas.preview.artifactPrevView')}
              title={t('canvas.preview.artifactPrevView')}
              onClick={(e) => { e.stopPropagation(); goToView(activeIndex - 1); }}
              style={artifactNavButtonStyle}
            >
              ◂
            </button>
          )}
          <span
            data-testid={`preview-node-artifact-view-label-${data.id}`}
            style={{
              flex: 1, minWidth: 0, fontSize: 11, fontWeight: 700, color: 'var(--color-text-secondary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {hasMultipleViews ? `${activeIndex + 1}/${views.length} — ${activeView.label}` : activeView.label}
          </span>
          {hasMultipleViews && (
            <button
              type="button"
              data-testid={`preview-node-artifact-next-${data.id}`}
              aria-label={t('canvas.preview.artifactNextView')}
              title={t('canvas.preview.artifactNextView')}
              onClick={(e) => { e.stopPropagation(); goToView(activeIndex + 1); }}
              style={artifactNavButtonStyle}
            >
              ▸
            </button>
          )}
          <button
            type="button"
            data-testid={`preview-node-artifact-expand-${data.id}`}
            aria-label={t('canvas.preview.artifactExpand')}
            title={t('canvas.preview.artifactExpand')}
            onClick={(e) => { e.stopPropagation(); setIsExpanded(true); }}
            style={artifactNavButtonStyle}
          >
            {'⤢'}
          </button>
          <button
            type="button"
            data-testid={`preview-node-close-${data.id}`}
            aria-label={t('canvas.preview.close')}
            onClick={(e) => { e.stopPropagation(); removeSurface(data.id); }}
            style={artifactNavButtonStyle}
          >
            ×
          </button>
        </div>

        <div
          className="nodrag"
          style={{ flex: 1, minHeight: 0, position: 'relative', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
        >
          {/* SECURITY (module header) — `sandbox="allow-same-origin"` only:
              still no scripts, no forms, no popups, no top navigation. This
              content is untrusted agent output, never the user's own local
              server (PreviewNodeCard's live-preview path above, which uses a
              deliberately looser allowlist for that trusted case) —
              allow-same-origin without allow-scripts grants no capability to
              the untrusted content itself (it can never run any code either
              way), only lets this app's OWN code read the rendered size back
              via `measureSandboxedContentSize` (AUTO-SCALE FIX, module
              header). `key={activeView.id}` forces a fresh iframe per view —
              srcDoc has no natural "src changed" signal of its own, so
              without this a view switch could leave stale rendered content
              on screen until the browser decides to re-parse it. */}
          <div
            style={
              layout
                ? { width: layout.boxWidth, height: layout.boxHeight, overflow: 'hidden', flexShrink: 0 }
                : { width: '100%', height: '100%' }
            }
          >
            <iframe
              key={activeView.id}
              ref={iframeRef}
              data-testid={`preview-node-artifact-iframe-${data.id}`}
              title={activeView.label}
              srcDoc={activeView.html}
              onLoad={handleArtifactLoad}
              sandbox="allow-same-origin"
              style={
                layout
                  ? {
                      width: measuredSize!.width,
                      height: measuredSize!.height,
                      border: 'none',
                      background: '#fff',
                      transform: `scale(${layout.scale})`,
                      transformOrigin: 'top left',
                    }
                  : { width: '100%', height: '100%', border: 'none', background: '#fff' }
              }
            />
          </div>
        </div>
      </div>
      {isExpanded && (
        <ArtifactSurfaceExpandedOverlay
          view={activeView}
          initialSize={measuredSize}
          onClose={() => setIsExpanded(false)}
          t={t}
        />
      )}
    </>
  );
}

interface ArtifactSurfaceExpandedOverlayProps {
  view: SurfaceHtmlView;
  /** Best-known size at the instant the overlay opened (the node card's own
   *  already-measured size, or null) — used only as the FIRST paint; this
   *  overlay re-measures its own, separately-loaded iframe on its own
   *  `onLoad` exactly like the node card does. */
  initialSize: { width: number; height: number } | null;
  onClose: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

/** Full-panel "judge the design for real" view (this task's own explicit
 *  ask: a scaled-down thumbnail can shrink a 64px title into unreadable
 *  text — the user must be able to enlarge a view to actually read it, not
 *  just guess its silhouette). Verbatim sibling of ArtifactProposalCard.tsx's
 *  own `ExpandedArtifactOverlay` (independently-scoped files, kept in sync
 *  by hand — see this file's own AUTO-SCALE FIX module note). Same sandbox
 *  posture as the node card (`allow-same-origin` only — still no
 *  scripts/forms/popups/top navigation): enlarging never loosens isolation. */
function ArtifactSurfaceExpandedOverlay({ view, initialSize, onClose, t }: ArtifactSurfaceExpandedOverlayProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number } | null>(initialSize);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));

  useEffect(() => {
    function onResize(): void {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleLoad = useCallback(() => {
    const measured = measureSandboxedContentSize(iframeRef.current);
    if (measured) setMeasuredSize(measured);
  }, []);

  const availableWidth = Math.max(1, Math.min(viewport.width * 0.9, 1400));
  const availableHeight = Math.max(1, Math.min(viewport.height * 0.9, 1000));
  const layout = measuredSize
    ? computeContainedLayout(measuredSize.width, measuredSize.height, availableWidth, availableHeight)
    : null;

  return (
    <div
      data-testid={`preview-node-artifact-expanded-${view.id}`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
        <div
          style={{
            width: layout ? layout.boxWidth : availableWidth,
            height: layout ? layout.boxHeight : availableHeight,
            overflow: 'hidden',
            background: '#fff',
            borderRadius: 8,
          }}
        >
          <iframe
            ref={iframeRef}
            data-testid={`preview-node-artifact-expanded-iframe-${view.id}`}
            title={view.label}
            srcDoc={view.html}
            onLoad={handleLoad}
            sandbox="allow-same-origin"
            style={
              layout
                ? {
                    width: measuredSize!.width,
                    height: measuredSize!.height,
                    border: 'none',
                    transform: `scale(${layout.scale})`,
                    transformOrigin: 'top left',
                  }
                : { width: '100%', height: '100%', border: 'none' }
            }
          />
        </div>
        <button
          type="button"
          data-testid={`preview-node-artifact-expanded-close-${view.id}`}
          aria-label={t('canvas.preview.artifactCollapse')}
          title={t('canvas.preview.artifactCollapse')}
          onClick={onClose}
          style={artifactExpandedCloseButtonStyle}
        >
          {'✕'}
        </button>
      </div>
    </div>
  );
}

/** P59 — canvas pan/zoom pause. Subscribes to canvasGesturePause.ts (fed
 *  by CanvasLodBroadcaster's single useViewport) rather than calling
 *  useViewport() here — N preview cards would otherwise re-render every
 *  pan frame. */
function usePreviewGesturePause(): boolean {
  return useCanvasGesturePause();
}

/**
 * P2-15 fix (real QA repro: React Flow error 008 looping in the console for
 * the whole test session) — this node used to render NO `<Handle>` at all,
 * so it had zero target-handle bounds for React Flow to anchor an edge to.
 * reconcilerEdges.ts's `buildSurfaceEdges` draws a quiet dotted edge from a
 * surface's owning mission/zone TO this node (`surface:<ownerRef>:<id>`,
 * spec §4 "what talks to what") — with no handle bounds, `getEdgePosition`
 * (xyflow/system) can't resolve a target position, calls `onError('008', …)`
 * (CanvasView.tsx's `handleFlowError` logs it every reconcile poll — the
 * observed infinite repeat) and returns null, so `EdgeWrapper` renders
 * nothing: the tether wasn't just noisy in the console, it was silently
 * NEVER drawn.
 *
 * Invisible + non-interactive (`isConnectable={false}`, opacity 0): unlike
 * MissionNode/DraftNode/JoinNode/etc.'s visible connection dots (all legal
 * chain targets per chainValidation.ts), a preview/terminal/search surface
 * is NEVER a valid chain endpoint — this handle exists purely as a
 * structural anchor for the hierarchy edge above, never a user-facing
 * "drag to connect" affordance that would only ever be rejected (same
 * "never advertise an affordance that always refuses" principle
 * IterationNode.tsx's own header already establishes for its own, deliberate
 * zero-Handle case).
 */
const SURFACE_TARGET_HANDLE_STYLE = { opacity: 0, pointerEvents: 'none' as const };

export const PreviewNode = memo(function PreviewNode({ data, selected }: NodeProps<PreviewFlowNode>) {
  const zoomLevel = useZoomLevel();
  const gesturePaused = usePreviewGesturePause();
  // VISIBLE-ARTIFACT FIX (module header) — decided BEFORE either card's own
  // hooks run, so which component TYPE mounts never risks a conditional-
  // hooks violation inside either one (see ArtifactSurfaceCard's own doc
  // comment). `htmlViews` present+non-empty always wins over `url` — see
  // SurfaceSpec.htmlViews's own "mutually exclusive in practice" note.
  const hasHtmlViews = (data.htmlViews?.length ?? 0) > 0;
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} style={SURFACE_TARGET_HANDLE_STYLE} />
      {hasHtmlViews ? (
        <ArtifactSurfaceCard data={data} selected={selected} zoomLevel={zoomLevel} />
      ) : (
        <PreviewNodeCard data={data} selected={selected} zoomLevel={zoomLevel} gesturePaused={gesturePaused} />
      )}
    </>
  );
});
