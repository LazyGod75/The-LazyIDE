/* previewSurface.ts — shared "ensure a preview surface exists for a
   project" helper (additive). Two independent callers need the SAME
   "reuse the project's existing preview surface, never add a second one"
   invariant:
     - useCanvasAutoComposition.ts's dev-server auto-detect (a background
       probe that auto-adds a preview once a project's dev server answers).
     - the LazyManager's start_preview action (agentsStore.tsx) — an
       explicit, user-requested "show me the site" action.
   Extracted here once so neither reimplements the reuse-vs-create check.

   Preview lifecycle fix ("linked to the agents/missions working on it"):
   also owns `findRunningMissionRef`, the "which mission does this preview
   belong to" resolution BOTH callers need to populate `SurfaceSpec.ownerRef`
   (reconcilerEdges.ts's `buildSurfaceEdges` only draws the dotted
   surface-edge when it is set) — extracted for the exact same
   don't-reimplement-it-twice reason as the reuse-vs-create check above.
*/

import { makeRef, type NodeRef, type SurfaceSpec } from './canvasTypes';

/**
 * Minimal shape {@link findRunningMissionRef} needs — matches both
 * `Mission` (agentsStore.tsx's live `state.missions`) and `FleetMission`
 * (a `FleetProject.missions` entry) structurally, so neither heavier
 * read-model type needs importing into this canvas-owned module.
 */
interface RunnableMissionLike {
  id: string;
  status: string;
  loopConfig?: unknown;
}

/**
 * The {@link NodeRef} of a currently-running mission from `missions`, or
 * undefined when none is running — the "which mission is this project's
 * current owner" resolution shared by every place a preview surface's
 * `ownerRef` gets computed. Resolves to `loop:<id>` for a loop's parent
 * mission (`loopConfig` present) rather than `mission:<id>` — the SAME kind
 * reconcilerEdges.ts's own `missionNodeRef` resolves to for a loop, so the
 * result always matches a REAL rendered node id (`buildSurfaceEdges` only
 * draws the edge when it does; otherwise it degrades gracefully — the
 * surface itself still renders, just without the tether). Picks the FIRST
 * running mission found when several are: `SurfaceSpec.ownerRef` holds only
 * one ref (see its own doc comment), so this is "a" running mission, not an
 * attempt to rank relevance among several.
 */
export function findRunningMissionRef(missions: readonly RunnableMissionLike[]): NodeRef | undefined {
  const running = missions.find((m) => m.status === 'running');
  if (!running) return undefined;
  return makeRef(running.loopConfig ? 'loop' : 'mission', running.id);
}

/**
 * Minimal shape {@link findDeliverableMissionRef} needs, layered onto
 * {@link RunnableMissionLike} — `worktree` (the git branch backing a
 * mission's deliverable, same field devPreview.ts's own worktree
 * resolution reads) and `updatedMs` (recency) are both optional so any
 * existing `Mission`/`FleetMission` array already satisfies this with no
 * cast, exactly like `RunnableMissionLike` itself.
 */
interface DeliverableMissionLike extends RunnableMissionLike {
  worktree?: string;
  updatedMs?: number;
}

/**
 * Preview lifecycle fix — fallback ownerRef for a preview auto-added for
 * FINISHED web work: `findRunningMissionRef` alone resolves to undefined
 * the instant nothing is running anymore, which is exactly the "mission(s)
 * in review/done with a worktree" case (see devPreview.ts's
 * `resolveWebDeliverableRoot`) — a preview auto-added for that work then
 * had no edge to the mission that actually produced it. Spec: "linked to
 * the agents/missions working on it" applies to finished work too, not
 * only a currently-running one.
 *
 * Returns the {@link NodeRef} of the MOST RECENTLY updated mission that is
 * `'review'` or `'done'` AND has a non-empty `worktree`, or undefined when
 * none qualifies. Ties (equal/missing `updatedMs`) keep the LAST candidate
 * in array order — same "good enough, not a ranking algorithm" posture as
 * `findRunningMissionRef`'s own "first running mission" pick.
 */
export function findDeliverableMissionRef(missions: readonly DeliverableMissionLike[]): NodeRef | undefined {
  const candidates = missions.filter(
    (m) => Boolean(m.worktree && m.worktree.trim()) && (m.status === 'review' || m.status === 'done'),
  );
  if (candidates.length === 0) return undefined;
  const mostRecent = candidates.reduce((latest, current) =>
    (current.updatedMs ?? 0) >= (latest.updatedMs ?? 0) ? current : latest,
  );
  return makeRef(mostRecent.loopConfig ? 'loop' : 'mission', mostRecent.id);
}

/**
 * The project's existing REAL preview surface, or undefined when none
 * exists yet. Excludes a search-results surface (P-SEARCH also carries
 * `kind: 'preview'` — see SurfaceSpec.searchSurface's own doc comment) — a
 * project whose agent merely searched the web must not read as "already
 * has a preview".
 */
export function findProjectPreviewSurface(
  surfaces: readonly SurfaceSpec[],
  projectId: string,
): SurfaceSpec | undefined {
  return surfaces.find((s) => s.projectId === projectId && s.kind === 'preview' && !s.searchSurface);
}

export interface EnsurePreviewSurfaceDeps {
  surfaces: readonly SurfaceSpec[];
  addSurface: (surface: SurfaceSpec) => void;
  /** Re-syncs an EXISTING surface's `ownerRef` when `opts.ownerRef` names a
   *  different mission than the one it already carries (see `opts.ownerRef`'s
   *  own doc comment) — never called for any other field/path. Optional: a
   *  caller with no mutator at hand simply never gets that re-sync half of
   *  the behavior (creation-time `ownerRef` still applies either way). */
  updateSurface?: (id: string, patch: Partial<SurfaceSpec>) => void;
  /** Mints a fresh surface id — only invoked when no existing surface is
   *  reused. Injected so each caller keeps its own id convention
   *  (canvasIds.ts's `generateCanvasId('preview')` for an explicit action,
   *  the auto-detect hook's own `auto-preview-<projectId>-<ts>` for a
   *  passive one). */
  generateId: () => string;
}

/**
 * Reuses the project's existing preview surface when one is already on the
 * canvas, otherwise creates one pointed at `url`. Returns the resulting
 * node ref (`preview:<id>`) either way — never a second preview surface for
 * the same project.
 *
 * `autoAdded` mirrors SurfaceSpec's own field (see its doc comment): true
 * only for the passive auto-detect path, never for an explicit user/manager
 * action — omit it (defaults to undefined/false) for a caller like
 * start_preview.
 *
 * `ownerRef` (preview lifecycle fix — "linked to the agents/missions
 * working on it", typically `findRunningMissionRef`'s result) is set on a
 * NEWLY created surface verbatim. For an EXISTING (reused) surface whose
 * `ownerRef` differs, it is re-synced via `deps.updateSurface` when the
 * caller provided one — an explicit `start_preview` re-attaches the
 * preview to whoever is working on the project RIGHT NOW even if it
 * already existed from an earlier mission. Omitted/undefined never
 * clears an existing `ownerRef` (there is nothing fresher to replace it
 * with) and never blocks surface creation.
 */
/**
 * Preview-surface-correctness fix (real incident, 2026-08: a project's
 * auto-detected preview was labelled `auto-preview-lazy-backoffice` but
 * pointed at `http://localhost:5173` — the Lazy IDE's OWN dev server
 * (`src-tauri/tauri.conf.json`'s `devUrl`), wrongly attributed to a project
 * that never served anything there). Root cause: `useCanvasAutoComposition
 * .ts`'s candidate-port fallback probe (CANDIDATE_DEV_PORTS, which includes
 * 5173, Vite's default) only ever asked "does ANYTHING answer on this port"
 * — a `no-cors` fetch can't read the response body/headers to check WHOSE
 * server it is, so it never verified the answering server actually belongs
 * to the project being probed. While the IDE itself runs in dev mode (this
 * app's own WebView is loaded FROM that exact devUrl), every open project's
 * background probe was racing against — and losing to — the app's own
 * dev server the instant nothing else answered on that port first.
 *
 * This is the one honest, verifiable guard available without reading the
 * (opaque, no-cors) response: never adopt a candidate url that is literally
 * this running app's OWN origin. `currentOrigin` is the caller's
 * `window.location.origin` (injected so this stays a pure, unit-testable
 * function with no DOM dependency of its own) — in a real Tauri dev session
 * this is exactly the devUrl the WebView loaded from; in a packaged build it
 * is a custom scheme (`tauri://localhost`/`asset://...`) that can never
 * collide with a `http://localhost:*` preview candidate, so this is a pure
 * no-op there. A malformed/incomparable url never throws — degrades to "not
 * self", the safe direction (never silently blocks a legitimate preview).
 */
export function isSelfOriginUrl(candidateUrl: string, currentOrigin: string): boolean {
  try {
    return new URL(candidateUrl).origin === currentOrigin;
  } catch {
    return false;
  }
}

/**
 * Self-origin hardening (defense in depth, covers the OTHER caller
 * isSelfOriginUrl's own doc comment names but never itself guards):
 * `useCanvasAutoComposition.ts`'s passive port probe already calls
 * `isSelfOriginUrl` and refuses to invoke `ensureProjectPreviewSurface` at
 * all with a self-origin candidate — but the LazyManager's explicit
 * `start_preview` action (agentsStore.tsx) has NO such upstream check: its
 * url comes straight from `devPreview.ts`'s `ensureDevServerForProject`,
 * whose own REUSE-IF-RUNNING probe is a raw "is anything listening on this
 * port" check with the exact same blind spot — a project's resolved
 * framework-default port (Vite's 5173) colliding with THIS app's own devUrl
 * in a real `tauri dev` session would be silently "reused" and handed to
 * this function as if it were a legitimate project preview.
 *
 * `ensureProjectPreviewSurface` is the ONE choke point both callers already
 * share (this file's own module header) — checking here protects the
 * unguarded caller too, without needing to edit it. Reads
 * `window.location.origin` directly (never injected, unlike
 * `isSelfOriginUrl` itself) specifically so it activates for a caller that
 * passes no origin of its own; `typeof window === 'undefined'` (a
 * non-browser test/SSR context) degrades to "never self", the same safe
 * direction `isSelfOriginUrl` already commits to for a malformed url.
 */
function isBlockedSelfOriginUrl(url: string): boolean {
  if (typeof window === 'undefined') return false;
  return isSelfOriginUrl(url, window.location.origin);
}

export function ensureProjectPreviewSurface(
  projectId: string,
  url: string,
  deps: EnsurePreviewSurfaceDeps,
  opts?: { autoAdded?: boolean; ownerRef?: NodeRef },
): NodeRef {
  const existing = findProjectPreviewSurface(deps.surfaces, projectId);
  if (existing) {
    if (opts?.ownerRef && opts.ownerRef !== existing.ownerRef) {
      deps.updateSurface?.(existing.id, { ownerRef: opts.ownerRef });
    }
    return makeRef('preview', existing.id);
  }
  const id = deps.generateId();
  // Self-origin hardening — a NEW surface never gets attributed this app's
  // own origin as its url (see isBlockedSelfOriginUrl's own doc comment):
  // the surface still gets created (so the canvas honestly shows "no server
  // detected yet" via PreviewNode.tsx's existing no-url state, and the user
  // can still type a real url into its url bar) rather than silently
  // rendering this app's OWN dev server inside a different project's zone.
  const safeUrl = isBlockedSelfOriginUrl(url) ? undefined : url;
  deps.addSurface({ id, kind: 'preview', projectId, url: safeUrl, autoAdded: opts?.autoAdded, ownerRef: opts?.ownerRef });
  return makeRef('preview', id);
}
