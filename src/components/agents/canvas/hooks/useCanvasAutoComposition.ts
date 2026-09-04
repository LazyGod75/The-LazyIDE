/* useCanvasAutoComposition.ts â€” W-UX3 core deliverable 3: "AUTO-COMPOSITION"
   ("tout doit Ãªtre fait automatiquement comme il faut", dismissable +
   remembered prefs). Three related, all mission-status-transition-driven
   behaviors, kept in one file because they share the same "diff this
   render's fleet against the previous one" scaffolding:

   (a) dev-server auto-detect â€” while a project has a running mission,
       ensures its dev server is actually running (P46+P48 â€” package.json
       `scripts.dev` + port heuristic, reuse-if-already-up, spawn via the
       real PTY infra otherwise; see lib/agents/devPreview.ts) and, once a
       URL answers, auto-adds a preview node to that zone, ONCE (never
       re-added if the user dismisses it â€” see autoPreviewPrefs.ts). Falls
       back to polling a short list of common dev-server ports when no
       detectable Node dev script exists (a non-Node project, or a
       package.json this heuristic can't confidently parse) â€” the original
       passive behavior, kept for that case.

       2026-08-05 foreign-server-adoption incident fix, layered on top of
       that passive fallback (see `tick()`'s own inline comments for the
       full mechanics): (i) a project whose own scripts.dev or static
       deliverable resolves (or whose real orchestration is only
       transiently blocked - `getDevServerSkipReason`) NEVER reaches the
       passive candidate-port loop at all - real incident: it attributed
       project "Lazy-real-test" a preview at localhost:3000 that was
       actually a DIFFERENT open project's (lazy-backoffice) Next.js dev
       server, only because 3000 answered and wasn't this app's own self
       origin; (ii) even in the genuine last resort (no scripts.dev, no
       worktree-scoped deliverable), a reachable candidate is
       content-fingerprinted (devPreview.ts's `contentFingerprintMatches` +
       `defaultFetchBodyStart`) against the project's own root index.html,
       when one resolves, before ever being adopted.
   (b) work auto-focus â€” when a mission transitions to running and at most
       2 missions are running fleet-wide, gently PAN (never rezoom, never
       mid-gesture â€” see the 5s idle gate below) so the node is on screen,
       but ONLY if it is currently fully off-viewport; already-visible work
       is left completely alone.
   (c) mission-complete flash + preview refresh â€” a mission transitioning
       to 'done' gets a transient `focus-flash` highlight (the SAME CSS
       class useCanvasFlowGraph.ts's own `justMergedId` already drives â€”
       reused here with the CORRECT ref-keyed id set rather than Cockpit's
       own `justMergedId`/`highlightIds`, which are built from bare mission
       ids and therefore never actually match a canvas node's `id`
       (`mission:<id>`) â€” a pre-existing, unrelated mismatch flagged
       separately, not fixed here to keep this wave's blast radius
       contained), and any preview surface already open in that project's
       zone gets its reachability probe re-armed (PreviewNode.tsx's
       `refreshRequestedAtMs` wiring) â€” "the site updates before your
       eyes".

   Perf note: this hook only re-derives its transition detection when
   `projects` changes (a real fleet update, already the cadence the rest of
   the canvas re-renders at) â€” no polling loop runs unless a project
   genuinely has running work, and each such loop is a single lightweight
   `no-cors` fetch (the same technique PreviewNode.tsx's own reachability
   probe already uses) on a handful of candidate ports, never a busy loop.
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import type { FleetMission, FleetProject } from '../../../../lib/agents/fleetMissions';
import {
  contentFingerprintMatches,
  defaultFetchBodyStart as fetchCandidatePortBodyStart,
  ensureDevServerForProject,
  getDevServerSkipReason,
  noteProjectMissionActivity,
  readRootDeliverableIndexHtml,
  resolveWebDeliverableRoot,
} from '../../../../lib/agents/devPreview';
import { makeRef, PREVIEW_FOCUS_MIN_ZOOM, type NodeRef } from '../canvasTypes';
import { useCanvasStore } from '../canvasStore';
import { isTauriPlatform } from '../canvasPersistence';
import { isAutoPreviewDismissed } from './autoPreviewPrefs';
import { ensureProjectPreviewSurface, findDeliverableMissionRef, findProjectPreviewSurface, findRunningMissionRef, isSelfOriginUrl } from '../previewSurface';
import type { CanvasReactFlowEdge, CanvasReactFlowNode } from '../reconciler';
import { emit, on } from '../../../../lib/bus';
import { useI18nSafe } from '../../../../i18n';
import { useToastSafe } from '../../../ui';

/** Common local dev-server ports (Vite/CRA/Next/generic) â€” deliberately
 *  short: this is a "does anything obvious answer" nudge, not a full port
 *  scanner. */
const CANDIDATE_DEV_PORTS: readonly number[] = [3000, 3001, 5173, 8080];
const PORT_PROBE_INTERVAL_MS = 4_000;
const PORT_PROBE_TIMEOUT_MS = 1_200;
/** Retry-under-pressure fix - bounds how many probe ticks a FINISHED-work
 *  project (no running mission) keeps retrying ensureDevServerForProject
 *  after a transient decline (system pressure / a deferred memory retry)
 *  before giving up honestly - see ProjectPortProbeState.pressureRetryCount.
 *  30 ticks * PORT_PROBE_INTERVAL_MS = 2 minutes, enough for a short
 *  pressure spike to clear without polling forever. */
const FINISHED_WORK_PRESSURE_RETRY_LIMIT = 30;
const FLASH_DURATION_MS = 2_500;
/** "gently ensure it's visible" gate â€” never yanks the camera within this
 *  many ms of the user's own last wheel/drag/click on the canvas. */
const AUTO_FOCUS_IDLE_GATE_MS = 5_000;
const AUTO_FOCUS_MAX_RUNNING = 2;
const AUTO_FOCUS_PAN_DURATION_MS = 450;
/** fix/canvas-graph-legibility (founder repro, screenshot 040: the ACTIVE
 *  running mission M45 was entirely off-screen while the fleet had 7
 *  signals in flight) — `panIntoViewIfOffscreen` below silently does
 *  nothing once more than {@link AUTO_FOCUS_MAX_RUNNING} missions are
 *  running fleet-wide (deliberate — see that block's own comment: don't
 *  fight a busy fleet by panning on every single new running mission). That
 *  is exactly the gap this constant covers: past the cap, a mission that
 *  just started running still gets ONE camera nudge via the SAME
 *  `canvas:focus` bus event + `PREVIEW_FOCUS_MIN_ZOOM` floor the preview
 *  auto-focus below already uses, rate-limited to at most once per this
 *  many ms so a busy fleet doesn't fight the user's camera on every
 *  transition. */
const AUTO_FOCUS_MISSION_DEBOUNCE_MS = 60_000;

/** Pure idle-gate check shared by every camera nudge in this hook (the (b)
 *  work auto-focus below, and the "camera qui présente" preview auto-focus
 *  in `addAutoPreviewIfNeeded`) — true once enough real-gesture-free time
 *  has passed to safely move the camera without fighting the user's own
 *  pan/zoom. Exported so the exact boundary is directly unit-testable
 *  without mounting the hook or faking timers. */
export function isPastAutoFocusGate(lastGestureAtMs: number, nowMs: number): boolean {
  return nowMs - lastGestureAtMs >= AUTO_FOCUS_IDLE_GATE_MS;
}

async function probePort(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`, { mode: 'no-cors', signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

export interface UseCanvasAutoCompositionParams {
  projects: readonly FleetProject[];
  reactFlowInstanceRef: React.RefObject<ReactFlowInstance<CanvasReactFlowNode, CanvasReactFlowEdge> | null>;
  /** The canvas' own outer container â€” read for its client rect (auto-focus
   *  visibility check) and to attach the lightweight real-gesture listeners
   *  the 5s idle gate needs (wheel/pointerdown; never the programmatic pans
   *  this hook itself issues, which never dispatch those). */
  containerRef: React.RefObject<HTMLElement | null>;
  /** W8d Replay â€” every behavior here is a LIVE-canvas nudge (camera moves,
   *  new preview nodes); all three are suspended while scrubbing history,
   *  same posture as useCanvasManagerEvents' own `replayActive` gate. */
  replayActive?: boolean;
}

export interface UseCanvasAutoCompositionResult {
  /** Node refs (canvas RF node ids, i.e. `mission:<id>`) currently flashing
   *  "just completed" â€” merge into CanvasView's decoratedNodes alongside
   *  managerEvents.managerHighlightIds (see that memo's own doc comment). */
  justCompletedIds: ReadonlySet<string>;
}

interface ProjectPortProbeState {
  timer: ReturnType<typeof setInterval> | null;
  /**
   * Set by `stopPortProbe` â€” checked after every `await` inside `tick()` so
   * an ALREADY IN-FLIGHT tick (mid-`ensureDevServerForProject`/`probePort`
   * when the project stops running, gains a preview, unmounts, etc.) bails
   * out instead of resuming later and adding a surface for a probe that was
   * explicitly stopped. Without this, `stopPortProbe`'s `clearInterval` only
   * ever prevented FUTURE ticks â€” an in-flight one had no way to notice it
   * had been cancelled, and could still call `addSurface` well after the
   * fact (observed as a stray extra preview surface bleeding across
   * component instances in this hook's own test suite).
   */
  cancelled: boolean;
  /**
   * Retry-under-pressure fix - counts ticks where a FINISHED-work project
   * (no running mission) got a null ensureDevServerForProject result WHILE
   * getDevServerSkipReason named a transient cause (system pressure / a
   * deferred memory retry). Only incremented in that exact case; a null
   * result with NO skip reason (genuinely no deliverable) still stops the
   * probe immediately, same as before this fix. Bounded by
   * FINISHED_WORK_PRESSURE_RETRY_LIMIT so a project stuck under sustained
   * pressure eventually gets an honest stop instead of polling forever.
   */
  pressureRetryCount: number;
}

export function useCanvasAutoComposition({
  projects,
  reactFlowInstanceRef,
  containerRef,
  replayActive = false,
}: UseCanvasAutoCompositionParams): UseCanvasAutoCompositionResult {
  const surfaces = useCanvasStore((s) => s.surfaces);
  const addSurface = useCanvasStore((s) => s.addSurface);
  const updateSurface = useCanvasStore((s) => s.updateSurface);
  const removeSurface = useCanvasStore((s) => s.removeSurface);

  // 2026-07-22 memory-pressure incident â€” devPreview.ts's auto dev-server
  // spawn (ensureDevServerForProject, called from tick() below) can defer a
  // single retry after an OS "not enough memory" spawn failure instead of
  // letting the raw OS error surface. devPreview.ts is a non-React module
  // with no ToastProvider ancestor of its own, so it bus-emits
  // 'devPreview:spawnDeferredMemory' and THIS hook â€” the sole caller of
  // ensureDevServerForProject, always mounted inside a real component tree â€”
  // shows the soft in-app notice (see bus.ts's own doc comment for the
  // wiring rationale).
  const toast = useToastSafe();
  const { t } = useI18nSafe();
  useEffect(() => {
    return on('devPreview:spawnDeferredMemory', () => {
      toast(t('devPreview.spawnDeferredMemory'), 'warning');
    });
  }, [toast, t]);

  // 2026-08-07 wrong-project-preview incident fix — devPreview.ts declined
  // to attach this project's preview to an already-answering port because it
  // has no positive record the port is THIS project's own (see bus.ts's
  // 'devPreview:portUnconfirmed' doc comment for the real incident: a stale
  // unrelated project's dev server got silently shown as "Live"). Same
  // non-React -> React bus-routing reason as the memory-pressure notice
  // above — a soft, actionable notice beats silently showing nothing (or,
  // as before this fix, silently showing the WRONG project).
  useEffect(() => {
    return on('devPreview:portUnconfirmed', ({ port, ownedByOtherProject }) => {
      toast(t(ownedByOtherProject ? 'devPreview.portOwnedByOtherProject' : 'devPreview.portUnconfirmed', { port }), 'warning');
    });
  }, [toast, t]);

  const projectsRef = useRef(projects);
  const surfacesRef = useRef(surfaces);
  const replayActiveRef = useRef(replayActive);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);
  useEffect(() => {
    surfacesRef.current = surfaces;
  }, [surfaces]);
  useEffect(() => {
    replayActiveRef.current = replayActive;
  }, [replayActive]);

  // Preview lifecycle fix â€” devPreview.ts stopped a dev server it was
  // managing (explicit stop or its own idle-timeout); same non-React ->
  // React bus-routing reason as the memory-pressure notice above. Removes
  // the project's preview surface so it never sits there polling a port
  // nothing listens on anymore (PreviewNode.tsx's own backoff eventually
  // gives up, but the stale card itself used to never go away â€” see
  // bus.ts's 'devPreview:serverStopped' doc comment). Guarded on the url
  // still matching: a user who repointed the URL bar after auto-creation
  // owns that card now, never yanked out from under them just because the
  // originally-detected port went away.
  useEffect(() => {
    return on('devPreview:serverStopped', ({ projectId, url }) => {
      const surface = findProjectPreviewSurface(surfacesRef.current, projectId);
      if (surface && surface.url === url) removeSurface(surface.id);
    });
  }, [removeSurface]);

  // â”€â”€ (b) real-gesture idle tracker â€” wheel/pointerdown on the canvas'
  // own container are always genuine user input (this hook's own
  // programmatic pans never dispatch a real wheel/pointer event), so this
  // never false-positives on its own auto-focus pans.
  const lastGestureAtRef = useRef<number>(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const markGesture = () => {
      lastGestureAtRef.current = Date.now();
    };
    el.addEventListener('wheel', markGesture, { passive: true });
    el.addEventListener('pointerdown', markGesture, { passive: true });
    return () => {
      el.removeEventListener('wheel', markGesture);
      el.removeEventListener('pointerdown', markGesture);
    };
  }, [containerRef]);

  // â”€â”€ (a) per-project dev-server port probes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const portProbesRef = useRef<Map<string, ProjectPortProbeState>>(new Map());
  // Guards against re-adding within the SAME session before the store
  // round-trips a fresh `surfaces` snapshot back into `surfacesRef`.
  const autoAddedThisSessionRef = useRef<Set<string>>(new Set());
  // P46+P48 round 2 â€” projects whose ALREADY-finished web work got its one
  // honest probe session (see the (a) block in the transition useEffect
  // below) - a single startPortProbe call; tick() itself may now retry
  // several times, bounded, under transient pressure (see
  // FINISHED_WORK_PRESSURE_RETRY_LIMIT). Prevents a startâ†’(tick
  // self-stops)â†’start loop when nothing is found.
  const finishedWebProbedRef = useRef<Set<string>>(new Set());

  const stopPortProbe = useCallback((projectId: string) => {
    const state = portProbesRef.current.get(projectId);
    if (state) state.cancelled = true; // see ProjectPortProbeState's own doc comment
    if (state?.timer) clearInterval(state.timer);
    portProbesRef.current.delete(projectId);
  }, []);

  const startPortProbe = useCallback(
    (projectId: string) => {
      // Real (Tauri) app only â€” a dev server can only exist next to a real
      // project on the user's machine. In web/harness mode a probe against
      // localhost:3000/3001/5173/8080 is (a) meaningless and (b) noisy:
      // Chromium logs every refused fetch as an unsuppressible console
      // error, which would fail the harness's zero-console-errors gate.
      if (!isTauriPlatform()) return;
      if (portProbesRef.current.has(projectId)) return; // already probing
      const state: ProjectPortProbeState = { timer: null, cancelled: false, pressureRetryCount: 0 };
      portProbesRef.current.set(projectId, state);

      // Preview-surface-correctness fix â€” return value distinguishes "this
      // candidate is handled" (a surface already existed, or one was just
      // added â€” either way, the caller's probe loop should stop) from
      // "refused, try the NEXT candidate instead of giving up the whole
      // probe" (see the self-origin guard below): a single unlucky port
      // (this app's own dev server happens to answer first) must never abort
      // the search for the project's REAL dev server on the remaining
      // candidates.
      function addAutoPreviewIfNeeded(url: string, ownerRef: NodeRef | undefined): boolean {
        if (autoAddedThisSessionRef.current.has(projectId)) return true;
        // P-SEARCH â€” a search-results surface also carries kind:'preview'
        // (SurfaceSpec.searchSurface's own doc comment); findProjectPreviewSurface
        // (previewSurface.ts) already excludes it, so a project whose agent
        // merely searched the web still gets its actual dev-server preview
        // auto-added.
        if (findProjectPreviewSurface(surfacesRef.current, projectId)) return true;
        // Preview-surface-correctness fix (real incident â€” see
        // isSelfOriginUrl's own doc comment): never adopt this app's OWN dev
        // origin as a project's preview just because it answered a probe â€”
        // verify it before ever attributing it. `typeof window` guards the
        // (non-jsdom) case where this module runs with no `window` at all;
        // `window.location.origin` is undefined then too, so the comparison
        // would simply never match â€” this guard just skips the work.
        if (typeof window !== 'undefined' && isSelfOriginUrl(url, window.location.origin)) {
          console.warn(
            '[useCanvasAutoComposition] refusing to attribute this app\'s own dev origin to a project preview:',
            url,
            projectId,
          );
          return false;
        }
        autoAddedThisSessionRef.current.add(projectId);
        const previewRef = ensureProjectPreviewSurface(
          projectId,
          url,
          { surfaces: surfacesRef.current, addSurface, updateSurface, generateId: () => `auto-preview-${projectId}-${Date.now()}` },
          { autoAdded: true, ownerRef },
        );
        // "camera qui présente" — an auto-added preview reaching the canvas
        // for the very first time gets ONE gentle pan/zoom onto it, so the
        // user actually SEES it come online instead of it silently
        // appearing off-viewport or at an illegible zoom (PreviewNode.tsx's
        // compact LOD tier below ZOOM_COMPACT). Reuses the EXACT
        // 'canvas:focus' bus event + PREVIEW_FOCUS_MIN_ZOOM floor the
        // LazyManager's own start_preview action already uses
        // (agentsStore.tsx) rather than inventing a second focus mechanism.
        // Same idle gate as the (b) work auto-focus above — never yanks the
        // camera mid-gesture. One-shot BY CONSTRUCTION, never a loop: this
        // whole function only reaches this line once per project per
        // session (guarded by `autoAddedThisSessionRef`/
        // `findProjectPreviewSurface` above), so a gated-out attempt here is
        // never retried — a missed one-shot is the safe trade-off over ever
        // surprising an actively-panning user later.
        if (isPastAutoFocusGate(lastGestureAtRef.current, Date.now())) {
          emit('canvas:focus', { ref: previewRef, minZoom: PREVIEW_FOCUS_MIN_ZOOM });
        }
        return true;
      }

      async function tick(): Promise<void> {
        // Re-check every tick â€” a project can stop running, gain a preview,
        // or get dismissed WHILE a probe round-trip is in flight.
        const project = projectsRef.current.find((p) => p.projectId === projectId);
        const hasRunning = project?.missions.some((m) => m.status === 'running') ?? false;
        // P46+P48 round 2 â€” a just-finished (review/done) mission whose
        // worktree may hold a plain-HTML deliverable also keeps the probe
        // alive for one pass (enough to resolve + serve + preview it); the
        // "no running work" self-stop below ends it when nothing is found.
        const hasFinishedWebWork =
          (project?.missions.some((m) => m.worktree && (m.status === 'review' || m.status === 'done'))) ?? false;
        // P-SEARCH â€” same exclusion as addAutoPreviewIfNeeded above.
        const hasPreview = Boolean(findProjectPreviewSurface(surfacesRef.current, projectId));
        if ((!hasRunning && !hasFinishedWebWork) || hasPreview || isAutoPreviewDismissed(projectId) || replayActiveRef.current) {
          stopPortProbe(projectId);
          return;
        }

        // R7 "living surfaces" fix â€” link the about-to-be-created preview to
        // whichever mission is actually working on this project (spec:
        // "linked to the agents/missions working on it") via
        // SurfaceSpec.ownerRef, same source `project.missions` this tick
        // already resolved above. Preview lifecycle fix - falls back to
        // findDeliverableMissionRef (previewSurface.ts) when nothing is
        // currently running: the "finished web work" case (hasFinishedWebWork
        // below) means `hasRunning` is NOT guaranteed here anymore, and a
        // preview auto-added for review/done work must still get an edge to
        // the mission that actually produced it, not degrade to no edge at
        // all just because it already finished.
        const ownerRef = project
          ? (findRunningMissionRef(project.missions) ?? findDeliverableMissionRef(project.missions))
          : undefined;

        // P46+P48 round 2 - hand the missions' worktree paths to devPreview.ts
        // so a plain-HTML deliverable in a mission's own worktree (no
        // scripts.dev) still gets resolved + served. Hoisted above the
        // ensureDevServerForProject call below (2026-08-05 fix) - the
        // foreign-server-adoption guard further down needs the SAME value.
        const worktreeRels = (project?.missions ?? [])
          .filter((m) => m.worktree)
          .map((m) => m.worktree);

        // P46+P48 â€” try the REAL dev-server orchestration first (package.json
        // scripts.dev + port heuristic, reuse-if-already-running, spawn via
        // the PTY infra otherwise â€” see lib/agents/devPreview.ts). Falls back
        // to the passive candidate-port sniff below when no detectable Node
        // dev script exists (devPreview.ts's own null result).
        if (project?.root) {
          try {
            const result = await ensureDevServerForProject(projectId, project.root, undefined, worktreeRels);
            // Re-check AFTER the await â€” stopPortProbe (mission finished,
            // preview dismissed, replay started, component unmounted) may
            // have fired WHILE this was in flight; without this an
            // already-stopped probe could still add a surface well after
            // the fact (see ProjectPortProbeState's own doc comment).
            if (state.cancelled) return;
            if (result) {
              // Preview-surface-correctness fix â€” devPreview.ts's own url is
              // derived from THIS project's own package.json (never a
              // guess), so a self-origin refusal here should be
              // near-impossible; never trust that blindly anyway â€” a
              // refusal falls through to the passive candidate-port probe
              // below rather than assuming this project genuinely has no
              // dev server.
              if (addAutoPreviewIfNeeded(result.url, ownerRef)) {
                stopPortProbe(projectId);
                return;
              }
            } else if (!hasRunning) {
              // Retry-under-pressure fix - a transient decline (system
              // pressure / a deferred memory retry - see DevServerSkipReason)
              // must NOT be treated the same as "genuinely no deliverable
              // exists": stopping outright here used to mean a project whose
              // ONLY reason for declining was machine load never got a
              // preview at all, even long after the pressure eased (bounded
              // only by a full page reload). Keep the probe alive, bounded to
              // FINISHED_WORK_PRESSURE_RETRY_LIMIT ticks, ONLY while the skip
              // reason names a transient cause; a null result with NO skip
              // reason (no scripts.dev, no static deliverable found) still
              // stops immediately - exactly as before this fix.
              const skipReason = getDevServerSkipReason(projectId);
              const isTransientSkip =
                skipReason === 'pressure_high' || skipReason === 'pressure_elevated' || skipReason === 'spawn_deferred_memory';
              if (isTransientSkip && state.pressureRetryCount < FINISHED_WORK_PRESSURE_RETRY_LIMIT) {
                state.pressureRetryCount += 1;
              } else {
                // Bound exhausted, or a genuinely empty result - one honest
                // pass (or FINISHED_WORK_PRESSURE_RETRY_LIMIT honest passes)
                // was enough; don't keep polling a project nothing is
                // actively building.
                stopPortProbe(projectId);
                return;
              }
            }
          } catch {
            // devPreview.ts's own boundaries never reject (every internal
            // failure already resolves null) â€” this catch is defense-in-depth
            // only, so a genuinely unexpected throw still falls back to the
            // passive probe below instead of breaking this project's loop.
          }
        }

        // 2026-08-05 foreign-server-adoption incident fix (a) - PRIORITY
        // ORDER. Real incident: the passive sniff below attributed project
        // "Lazy-real-test" a preview at http://localhost:3000 - actually
        // another OPEN project's (lazy-backoffice) Next.js dev server -
        // because 3000 answered and wasn't this app's own self origin.
        // A project whose own dev script or static deliverable resolves
        // must NEVER fall through to the blind candidate-port sniff: the
        // real orchestration above either already served it (early-returned
        // before reaching here) or will keep retrying it on a future tick
        // (the pressure-retry branch above never stops the probe for a
        // transient decline) - grabbing whichever candidate happens to
        // answer in the meantime risks attributing a COMPLETELY UNRELATED
        // project's dev server to this one. The passive sniff is reserved
        // for the genuine last resort: no scripts.dev AND no resolvable
        // static deliverable at all. `getDevServerSkipReason` covers the
        // scripts.dev half without a second I/O round-trip: a defined skip
        // reason (pressure_high/pressure_elevated/spawn_deferred_memory/
        // ports_busy_foreign_content) only ever gets set AFTER
        // detectDevServerConfig/resolveWebDeliverableRoot found something
        // real to serve (devPreview.ts's own doEnsureDevServerForProject) —
        // i.e. this project DOES have its own script or deliverable, the
        // orchestration is just transiently blocked, same reasoning as
        // `ownDeliverableRoot` below. `undefined` (no skip reason at all)
        // means a genuinely empty result with nothing to name — the one case
        // that legitimately falls through.
        if (project?.root) {
          const ownDeliverableRoot = await resolveWebDeliverableRoot(project.root, worktreeRels);
          if (state.cancelled) return; // see ProjectPortProbeState's own doc comment
          if (ownDeliverableRoot || getDevServerSkipReason(projectId) !== undefined) return; // ensureDevServerForProject keeps retrying above
        }

        // 2026-08-05 foreign-server-adoption incident fix (b) - CONTENT
        // VERIFICATION, even in this genuine last resort. `worktreeRels`
        // resolution above only searches WORKTREE-scoped bases once the
        // project has any (resolveWebDeliverableRoot's own contract) - a
        // project with mission worktrees that don't themselves hold the
        // site may still have its own plain static site at the project
        // ROOT, which this root-only lookup catches separately. When it
        // resolves, every reachable candidate below is fingerprinted
        // against it before ever being adopted; a mismatch means a
        // different project is squatting that port.
        const localIndexHtml = project?.root ? await readRootDeliverableIndexHtml(project.root) : null;
        if (state.cancelled) return;

        // Deliberately sequential (not Promise.all) â€” a burst of N parallel
        // probes against N localhost ports is exactly the kind of noisy
        // background traffic a "gentle" auto-detect should avoid.
        for (const port of CANDIDATE_DEV_PORTS) {
          const reachable = await probePort(port);
          if (state.cancelled) return; // see the doc comment above
          if (reachable) {
            // 2026-08-05 foreign-server-adoption incident fix (b) - a
            // resolvable local index.html gates adoption on content actually
            // matching; a mismatch tries the NEXT candidate rather than
            // adopting a foreign project's server.
            if (localIndexHtml !== null) {
              const remoteBodyStart = await fetchCandidatePortBodyStart(port);
              if (state.cancelled) return;
              if (!contentFingerprintMatches(remoteBodyStart, localIndexHtml)) continue;
            }
            // Preview-surface-correctness fix â€” a refusal (this candidate
            // port turned out to be the app's own dev origin, e.g. 5173
            // while running `npm run dev`) keeps trying the REMAINING
            // candidates in this same tick instead of giving up outright;
            // only a genuinely handled candidate stops the probe.
            if (addAutoPreviewIfNeeded(`http://localhost:${port}`, ownerRef)) {
              stopPortProbe(projectId);
              return;
            }
          }
        }
      }

      void tick();
      state.timer = setInterval(() => void tick(), PORT_PROBE_INTERVAL_MS);
    },
    [addSurface, updateSurface, stopPortProbe],
  );

  useEffect(
    () => () => {
      for (const projectId of portProbesRef.current.keys()) stopPortProbe(projectId);
    },
    [stopPortProbe],
  );

  // â”€â”€ (b)/(c) mission status-transition watcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const prevStatusRef = useRef<Map<string, FleetMission['status']>>(new Map());
  const [justCompletedIds, setJustCompletedIds] = useState<ReadonlySet<string>>(new Set());
  const flashTimeoutsRef = useRef<Set<number>>(new Set());
  // fix/canvas-graph-legibility — last time the AUTO_FOCUS_MAX_RUNNING-busy
  // fallback below actually emitted a canvas:focus, epoch ms. 0 (never yet)
  // deliberately reads as "past the debounce" against any real Date.now().
  const lastMissionAutoFocusAtRef = useRef<number>(0);

  useEffect(() => {
    const flashTimeouts = flashTimeoutsRef.current;
    return () => {
      for (const id of flashTimeouts) window.clearTimeout(id);
      flashTimeouts.clear();
    };
  }, []);

  useEffect(() => {
    if (replayActive) return; // W8d â€” no live nudges while scrubbing history
    const prevStatus = prevStatusRef.current;
    const runningCountFleetWide = projects.reduce((n, p) => n + p.missions.filter((m) => m.status === 'running').length, 0);

    for (const project of projects) {
      let projectHasRunning = false;

      for (const mission of project.missions) {
        const prev = prevStatus.get(mission.id);
        if (mission.status === 'running') projectHasRunning = true;

        // (b) work auto-focus â€” transition INTO running. `prev !== undefined`
        // deliberately excludes a mission's FIRST observation (boot/
        // hydration snapshot): a fleet loaded with missions already running
        // is not "work just started", and panning the camera on mount would
        // be exactly the kind of yank this feature promises never to do.
        if (mission.status === 'running' && prev !== undefined && prev !== 'running') {
          const nowForFocus = Date.now();
          if (runningCountFleetWide <= AUTO_FOCUS_MAX_RUNNING) {
            if (isPastAutoFocusGate(lastGestureAtRef.current, nowForFocus)) {
              panIntoViewIfOffscreen(makeRef('mission', mission.id), reactFlowInstanceRef, containerRef);
            }
          } else if (
            isPastAutoFocusGate(lastGestureAtRef.current, nowForFocus) &&
            nowForFocus - lastMissionAutoFocusAtRef.current >= AUTO_FOCUS_MISSION_DEBOUNCE_MS
          ) {
            // Busy-fleet fallback (see AUTO_FOCUS_MISSION_DEBOUNCE_MS's own
            // doc comment) — the plain pan above silently gives up past the
            // running-count cap; a genuinely running mission still deserves
            // SOME camera presence, via the same canvas:focus mechanism (bus
            // event + PREVIEW_FOCUS_MIN_ZOOM) the preview auto-focus below
            // already uses, capped to one per AUTO_FOCUS_MISSION_DEBOUNCE_MS
            // so a busy fleet can't fight the user's camera on every tick.
            lastMissionAutoFocusAtRef.current = nowForFocus;
            emit('canvas:focus', { ref: makeRef('mission', mission.id), minZoom: PREVIEW_FOCUS_MIN_ZOOM });
          }
        }

        // (c) mission-complete flash + preview refresh â€” transition INTO done.
        if (mission.status === 'done' && prev !== undefined && prev !== 'done') {
          const ref = makeRef('mission', mission.id);
          setJustCompletedIds((current) => new Set([...current, ref]));
          const timeoutId = window.setTimeout(() => {
            flashTimeoutsRef.current.delete(timeoutId);
            setJustCompletedIds((current) => {
              const next = new Set(current);
              next.delete(ref);
              return next;
            });
          }, FLASH_DURATION_MS);
          flashTimeoutsRef.current.add(timeoutId);

          for (const surface of surfacesRef.current) {
            // P-SEARCH â€” same exclusion as addAutoPreviewIfNeeded above: a
            // search surface has no reachability probe to re-arm.
            if (surface.kind === 'preview' && !surface.searchSurface && surface.projectId === project.projectId) {
              updateSurface(surface.id, { refreshRequestedAtMs: Date.now() });
            }
          }
        }

        prevStatus.set(mission.id, mission.status);
      }

      // R7 "living surfaces" fix â€” keep an existing preview's ownerRef in
      // sync with whichever mission is CURRENTLY running for this project
      // (spec: "linked to the agents/missions working on it" â€” a link fixed
      // forever at creation time would go stale the moment that mission
      // finishes and a different one picks up the work). The auto-detect
      // probe below only ever sets ownerRef ONCE, at creation (it stops
      // polling entirely once a preview exists â€” see startPortProbe's own
      // tick()), so this per-render pass is what keeps a LONG-LIVED
      // preview's link current afterwards. A no-op when nothing is running
      // right now, or the ref is already up to date.
      const preview = findProjectPreviewSurface(surfacesRef.current, project.projectId);
      if (preview) {
        const ownerRef = findRunningMissionRef(project.missions);
        if (ownerRef && preview.ownerRef !== ownerRef) updateSurface(preview.id, { ownerRef });
      }

      // (a) start/stop the port probe for this project based on its CURRENT
      // running state (idempotent â€” startPortProbe/stopPortProbe both no-op
      // if already in the requested state).
      //
      // P46+P48 round 2 â€” ALSO start one probe pass when the project has
      // finished web work already on screen (missions in review/done with a
      // worktree): a mid-run reload/boot must still surface the
      // deliverable. `finishedWebProbedRef` gates it to ONE honest pass per
      // project â€” without it, a project whose finished work yields no
      // deliverable would alternate startâ†’(tick self-stops)â†’start forever.
      const hasFinishedWebWork = project.missions.some(
        (m) => m.worktree && (m.status === 'review' || m.status === 'done'),
      );
      if (projectHasRunning) {
        startPortProbe(project.projectId);
      } else if (hasFinishedWebWork && !finishedWebProbedRef.current.has(project.projectId)) {
        startPortProbe(project.projectId);
        finishedWebProbedRef.current.add(project.projectId);
      } else {
        stopPortProbe(project.projectId);
      }

      // P46+P48 â€” idle-stop bookkeeping runs INDEPENDENTLY of the port-probe
      // lifecycle above (which stops for good once a preview surface exists
      // or gets dismissed): a dev server devPreview.ts spawned must keep
      // having its idle countdown reset for as long as this project has
      // running work, and start counting down the moment it doesn't â€”
      // regardless of whether the preview surface is still open. A no-op
      // for a project devPreview.ts isn't managing a server for.
      noteProjectMissionActivity(project.projectId, projectHasRunning);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reactFlowInstanceRef/containerRef are stable refs (see their own hook-return doc comments in useCanvasFlowGraph.ts/CanvasView.tsx); including them would be a no-op dependency that only adds noise.
  }, [projects, replayActive, startPortProbe, stopPortProbe, updateSurface]);

  return { justCompletedIds };
}

/**
 * (b) â€” pans (translate only, keeps the CURRENT zoom â€” never a rezoom/
 * fitView, so this never feels like a camera "yank") so `nodeRef`'s center
 * lands at the container's center, but ONLY if the node's current screen
 * rect does not intersect the container's client rect AT ALL (i.e. it is
 * genuinely, fully off-viewport â€” a node that's even partially visible is
 * left completely alone).
 */
function panIntoViewIfOffscreen(
  nodeRef: string,
  reactFlowInstanceRef: React.RefObject<ReactFlowInstance<CanvasReactFlowNode, CanvasReactFlowEdge> | null>,
  containerRef: React.RefObject<HTMLElement | null>,
): void {
  const instance = reactFlowInstanceRef.current;
  const container = containerRef.current;
  if (!instance || !container) return;
  const node = instance.getNode(nodeRef);
  if (!node) return;

  const { x: vx, y: vy, zoom } = instance.getViewport();
  const width = node.measured?.width ?? node.width ?? 220;
  const height = node.measured?.height ?? node.height ?? 140;
  const nodeScreenX0 = node.position.x * zoom + vx;
  const nodeScreenY0 = node.position.y * zoom + vy;
  const nodeScreenX1 = nodeScreenX0 + width * zoom;
  const nodeScreenY1 = nodeScreenY0 + height * zoom;

  const rect = container.getBoundingClientRect();
  const fullyOffscreen =
    nodeScreenX1 <= 0 || nodeScreenY1 <= 0 || nodeScreenX0 >= rect.width || nodeScreenY0 >= rect.height;
  if (!fullyOffscreen) return;

  const nodeCenterFlowX = node.position.x + width / 2;
  const nodeCenterFlowY = node.position.y + height / 2;
  const nextX = rect.width / 2 - nodeCenterFlowX * zoom;
  const nextY = rect.height / 2 - nodeCenterFlowY * zoom;
  instance.setViewport({ x: nextX, y: nextY, zoom }, { duration: AUTO_FOCUS_PAN_DURATION_MS });
}


