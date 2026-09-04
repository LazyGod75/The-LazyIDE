/* useCanvasHydration.ts — mount-time data feeds for the Agent Canvas (W2b
   refactor of CanvasView.tsx — deliverable #0). Bundles two orthogonal but
   both mount-time concerns that used to live inline in CanvasView.tsx's
   body:
     - the persistence boot (load `canvas/layout.json` + `canvas/chains.json`
       ONCE, hydrate canvasStore, decide fitView vs a persisted viewport,
       wire the autosave subscription) — see canvasPersistence.ts's own
       header for the full seam description; behavior copied verbatim from
       CanvasView.tsx's original mount effect;
     - the scheduled-agents poll (agent-template cron triggers, refreshed
       every 30s while the canvas is visible) — reconciler.ts's own
       "SEAM for W1c" comment.
   Grouped together only because both are "gather a real-time INPUT the
   reconciler needs, from an effect, at mount" — not because they depend on
   each other.
*/

import { useEffect, useRef, useState } from 'react';
import { canvasStoreVanilla, type CanvasViewport } from '../canvasStore';
import { isTauriPlatform, loadCanvasPersisted, subscribeCanvasAutosave } from '../canvasPersistence';
import { listAgents } from '../../../../lib/agents/agentsStorage';
import { scheduledAgentsToNodeData } from '../reconciler';
import type { ScheduleNodeData } from '../canvasTypes';
import { isViewportSane } from './viewportSanity';
import {
  cleanupStaleProposedPreviews,
  relocateOrchestratorRecord,
  type CleanupStaleProposalsDeps,
  type OpenProjectRef,
} from '../canvasProposalCleanup';
import {
  repairMaterializedPlanProjects,
  type MaterializedPlanRepairDeps,
} from '../../../../lib/agents/graph/materializedPlanRepair';
import { getOrchestrator, listOrchestrators } from '../../../../lib/agents/orchestratorState';
import { listProjects } from '../../../../lib/platform/tauri';
import { projectIdFromRoot } from '../../../../lib/journal/projectId';
import { basename } from '../../../../lib/paths';
import { getJournalMissionsSnapshot } from '../../../../lib/agents/journalMissionsFeed';
import { emit } from '../../../../lib/bus';

const SCHEDULE_POLL_MS = 30_000;

/**
 * Real dependency wiring for `cleanupStaleProposedPreviews` (see that
 * module's own header) — `listOpenProjects` reads the SAME real, Tauri-
 * backed open-project directory `canvasDigest.ts`'s `fetchProjectDirectory`
 * does (never the in-session-only globalRuntime registry), so a project
 * this session has not yet touched still resolves correctly once it opens.
 * A fresh object every call — cheap, and keeps this free of any stale
 * closure over `canvasStoreVanilla.getState()`.
 */
function makeProposalCleanupDeps(): CleanupStaleProposalsDeps {
  return {
    getCanvasState: () => canvasStoreVanilla.getState(),
    rejectProposedPlan: (planId) => canvasStoreVanilla.getState().rejectProposedPlan(planId),
    retagProposedPlanProject: (planId, projectId) =>
      canvasStoreVanilla.getState().retagProposedPlanProject(planId, projectId),
    listOpenProjects: async (): Promise<OpenProjectRef[]> => {
      const projects = await listProjects();
      return (Array.isArray(projects) ? projects : []).map((p) => ({
        projectId: projectIdFromRoot(p.root),
        root: p.root,
        name: basename(p.root),
      }));
    },
    getOrchestrator,
    relocateOrchestrator: relocateOrchestratorRecord,
    // enableReHome deliberately OMITTED (defaults to false) — see
    // canvasProposalCleanup.ts's own INCIDENT note (module header): the
    // FIRST version of the re-home matcher fired on the product name
    // "Lazy" (present in nearly every real objective) and relocated an
    // already-correctly-homed plan into the wrong zone. Re-home stays
    // OFF in production until there is a real, considered decision to
    // re-enable it — the missing/advanced staleness cleanup below is
    // unaffected and stays fully active.
  };
}

/**
 * Real dependency wiring for `repairMaterializedPlanProjects` (see that
 * module's own header) — `listOpenProjects`/`listOrchestrators` mirror
 * `makeProposalCleanupDeps` above exactly (same real directory, same
 * per-project orchestrator read); `fetchMissionProjectIds` reads the SAME
 * `journal_missions_current` data canvasDigest.ts's `fetchAllMissions`
 * does — via the shared journalMissionsFeed.ts cache (perf audit finding:
 * this used to be its own ad-hoc invoke on every 30s safety-net tick;
 * routing it through the shared feed piggybacks on the fleetMissions/
 * SpacesRail pollers' already-fresh data instead of firing a fourth
 * redundant IPC call — see that module's header) — narrowed to just the
 * `mission_id -> project_id` mapping this repair actually needs — the REAL
 * ground truth (see that module's own header for why this is never derived
 * from any orchestrator's own `projectId` field).
 */
function makeMaterializedPlanRepairDeps(): MaterializedPlanRepairDeps {
  return {
    listOpenProjects: async () => {
      const projects = await listProjects();
      return (Array.isArray(projects) ? projects : []).map((p) => ({
        projectId: projectIdFromRoot(p.root),
        root: p.root,
      }));
    },
    listOrchestrators,
    fetchMissionProjectIds: async () => {
      const rows = await getJournalMissionsSnapshot();
      const map = new Map<string, string>();
      for (const row of rows) {
        if (row?.mission_id && row.project_id) map.set(row.mission_id, row.project_id);
      }
      return map;
    },
    getCanvasState: () => canvasStoreVanilla.getState(),
    updateDraft: (id, patch) => canvasStoreVanilla.getState().updateDraft(id, patch),
    updateJoin: (id, patch) => canvasStoreVanilla.getState().updateJoin(id, patch),
  };
}

export type CanvasViewportInit = { fit: true } | { fit: false; viewport: CanvasViewport };

export interface UseCanvasHydrationResult {
  /** `null` until the persistence boot resolves — CanvasView.tsx renders a
   *  blank placeholder until this settles, so `defaultViewport` (read once
   *  by React Flow) reflects the real persisted viewport instead of racing
   *  it (original module doc comment, still true here). */
  viewportInit: CanvasViewportInit | null;
  scheduled: ScheduleNodeData[];
}

/**
 * Runs the persistence boot (once, on mount) and the scheduled-agents poll
 * (every {@link SCHEDULE_POLL_MS} while mounted, restarted whenever
 * `activeFleetProjectId` changes). `activeRoot` is read through a ref
 * internally so the boot effect stays a TRUE one-shot mount effect (matches
 * the original CanvasView.tsx behavior byte-for-byte) — passing a fresh
 * `activeRoot` value on every render never re-triggers the boot.
 *
 * ── BUG 1 fix (W6f, real-app P0 data-loss repro) ──────────────────────
 * The original version of this effect SKIPPED hydration entirely when
 * `activeRoot` was still null at mount (a common cold-boot race — the
 * project registry hydrates async) but armed the debounced autosave
 * subscription (canvasPersistence.ts's `subscribeCanvasAutosave`)
 * unconditionally regardless. The very next store change then wrote the
 * pre-hydrate EMPTY store over the real global canvas/{layout,chains}.json
 * files — observed live going from 2 drafts + 1 chain to nothing.
 *
 * Three changes close this:
 *   (a) hydrate unconditionally with respect to `activeRoot` — never
 *       skipped for lack of an active root, ON TAURI. `repoPath` is only
 *       ever consulted by canvasPersistence.ts for the one-time LEGACY
 *       per-project migration (its own module header: storage itself has
 *       been GLOBAL, via canvas_state_load/save, since W3) — so a null root
 *       at mount is no longer a reason to skip loading the real global
 *       state, only a reason to skip the migration lookup (passing ''
 *       already means exactly that to loadCanvasPersisted).
 *   (b) ...but NOT unconditionally with respect to PLATFORM: outside Tauri
 *       there is no real global file to protect (every canvasPersistence.ts
 *       load/save already short-circuits to defaults/no-op there), and
 *       canvas-harness.tsx's screenshot fixture pre-seeds canvasStoreVanilla
 *       directly, relying — by its own doc comment — on hydrate() never
 *       running outside a real Tauri boot to clobber that seed with empty
 *       defaults. Gating on `isTauriPlatform()` rather than `activeRoot`
 *       keeps that contract intact while still fixing the ACTUAL bug, which
 *       only ever happens on a real (Tauri) boot.
 *   (c) the autosave subscription is only ever CREATED after boot() has
 *       actually run hydrate() on the store — never armed early "just in
 *       case", so there is no window where a store change could be
 *       persisted before the real data has replaced the store's defaults.
 * `isHydrated` is still threaded into subscribeCanvasAutosave as a second,
 * independent signal (canvasPersistence.ts's own empty-overwrite guard) —
 * belt-and-suspenders, not load-bearing given (a)-(c) above, but cheap
 * insurance against a future change re-introducing an early-arm path.
 */
export function useCanvasHydration(activeRoot: string | null, activeFleetProjectId: string | undefined): UseCanvasHydrationResult {
  const activeRootRef = useRef(activeRoot);
  useEffect(() => {
    activeRootRef.current = activeRoot;
  }, [activeRoot]);

  const [viewportInit, setViewportInit] = useState<CanvasViewportInit | null>(null);

  useEffect(() => {
    let cancelled = false;
    let disposeAutosave: (() => void) | null = null;
    const hydratedRef = { current: false };

    async function boot(): Promise<void> {
      if (!isTauriPlatform()) {
        // No real persistence to load or protect outside Tauri — never
        // touch the store, never arm autosave (see the BUG 1 doc comment's
        // point (b): canvas-harness.tsx and any other pre-seeded/web-mode
        // store depend on this).
        setViewportInit({ fit: true });
        return;
      }
      // '' when no root is active yet — loadCanvasPersisted/loadGlobalOrMigrate
      // already treat an empty repoPath as "skip the legacy migration lookup,
      // load global-or-defaults" (canvasPersistence.ts), so this still hydrates
      // the real global state instead of skipping the load altogether.
      const repoPath = activeRootRef.current ?? '';
      const { layout, chainsFile } = await loadCanvasPersisted(repoPath);
      if (cancelled) return;
      canvasStoreVanilla.getState().hydrate(layout, chainsFile);
      hydratedRef.current = true;
      // Stale/mis-homed proposal-preview migration (canvasProposalCleanup.ts's
      // own module header — real founder state: 49 stale preview nodes from
      // 5 un-launched proposals, never cleared across restarts). Best-effort,
      // fire-and-forget: a failure here must never block the boot sequence
      // (viewportInit below still resolves) — the periodic safety-net effect
      // further down retries for any project that was not open yet at this
      // exact moment.
      void cleanupStaleProposedPreviews(makeProposalCleanupDeps()).catch(() => {});
      // Mis-materialized plan-project repair (materializedPlanRepair.ts's
      // own module header — real founder state: a plan already mid-
      // execution with its remaining steps' drafts/joins stuck in the
      // wrong project's zone, the manager "losing the chain" past the
      // steps that already ran). Best-effort, fire-and-forget, same
      // convention as the proposal-preview migration above; re-lays out
      // the canvas only when something actually moved.
      void repairMaterializedPlanProjects(makeMaterializedPlanRepairDeps())
        .then((result) => {
          if (result.repaired.length > 0) emit('canvas:arrange', { mode: 'auto' });
        })
        .catch(() => {});
      // W-UX3 finding B — boot sanity guard (viewportSanity.ts's own
      // header): a persisted viewport that's out of a sane zoom range, or
      // that would leave most of the real content off-screen, is never
      // trusted verbatim — falls back to the existing `{ fit: true }`
      // path (React Flow's own `fitView`) exactly as if nothing had been
      // persisted at all. `window.innerWidth/innerHeight` is a reasonable
      // proxy for the canvas pane's own size at this point (this effect
      // only ever runs on a real Tauri boot — see this hook's own BUG 1
      // doc comment — where the canvas occupies essentially the whole
      // window); erring conservative (fitView) costs nothing worse than
      // one extra fit-to-content on an already-rare corrupted-viewport
      // boot.
      const persistedViewport = layout.viewport;
      const viewportIsSane =
        persistedViewport !== undefined &&
        isViewportSane(persistedViewport, layout.positions, { width: window.innerWidth, height: window.innerHeight });
      setViewportInit(viewportIsSane ? { fit: false, viewport: persistedViewport! } : { fit: true });
      // Arm autosave ONLY now — see the BUG 1 doc comment above.
      disposeAutosave = subscribeCanvasAutosave(canvasStoreVanilla, () => activeRootRef.current, 500, () => hydratedRef.current);
    }

    void boot();
    return () => {
      cancelled = true;
      disposeAutosave?.();
    };
    // Intentional one-shot mount effect (see module doc comment) — reads
    // activeRootRef.current (a ref, exempt from exhaustive-deps) rather
    // than reacting to activeRoot changing later.
  }, []);

  // Safety-net retry for the stale/mis-homed proposal-preview migration
  // above — a proposal whose target project was not open YET at the exact
  // moment `boot()` ran (a workspace still restoring several project tabs)
  // is simply skipped that first pass (canvasProposalCleanup.ts's own
  // "unknown -> never guessed away" rule) and would otherwise stay
  // unresolved for the rest of the session. Reuses the SAME cadence the
  // scheduled-agents poll below already uses — each run is a cheap no-op
  // once every currently-tagged proposal has been resolved one way or
  // another (cleanupStaleProposedPreviews's own early-out on an empty
  // group list).
  useEffect(() => {
    if (!isTauriPlatform()) return;
    const intervalId = setInterval(() => {
      void cleanupStaleProposedPreviews(makeProposalCleanupDeps()).catch(() => {});
      // Same safety-net rationale as above, for the materialized-plan
      // project repair — a plan's target project not open yet at boot, or
      // a mission's journal row not flushed yet, resolves on a later pass.
      void repairMaterializedPlanProjects(makeMaterializedPlanRepairDeps())
        .then((result) => {
          if (result.repaired.length > 0) emit('canvas:arrange', { mode: 'auto' });
        })
        .catch(() => {});
    }, SCHEDULE_POLL_MS);
    return () => clearInterval(intervalId);
  }, []);

  const [scheduled, setScheduled] = useState<ScheduleNodeData[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const agents = await listAgents();
        if (!cancelled) setScheduled(scheduledAgentsToNodeData(agents, activeFleetProjectId));
      } catch {
        // best-effort — schedules are an overlay, not the source of truth
      }
    }
    void refresh();
    const intervalId = setInterval(refresh, SCHEDULE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [activeFleetProjectId]);

  return { viewportInit, scheduled };
}
