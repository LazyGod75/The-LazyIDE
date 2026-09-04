/* canvasDigest.ts — compact text serializer of the Agent Canvas's REAL
   state (spec §8.1 `canvas_overview` / §8.2 "the digest reuses
   canvas_overview's serializer"). Used two ways:

     1. Injected into managerEngine's system prompt EVERY turn (like
        formatCreditsSummary's creditsSummary — see agentsStore.tsx's
        sendManagerMessage) so the manager reasons about the REAL board
        instead of guessing.
     2. `canvas_overview`'s own case in agentsStore.tsx's executor is a pure
        marker, same as `list_missions`/`list_agents` — the manager already
        saw this same digest in the system prompt for the turn that emitted
        it, so there is nothing left to do there.

   Cross-project like the canvas itself (spec §3 — this is the ONE place
   the manager sees the whole fleet, not just the active project's
   missions): project names/roots come from `listProjects()`
   (lib/platform/tauri.ts's plain async wrapper around the `project_list`
   Tauri command), deliberately NOT from AppContext — agentsStore.tsx's own
   test suite renders `<AgentsStoreProvider>` directly, without an
   `<AppProvider>` ancestor (see e.g. agentsStore.test.tsx), so a
   `useAppContext()` call inside AgentsStoreProvider would throw across ~19
   existing test files. Missions are fetched fleet-wide via the SAME
   `journal_missions_current` invoke chainEngine.ts's own
   `fetchAllJournalMissions` already established as this repo's
   no-shared-export convention for that row shape (see this file's own
   local `MissionRow` type — mirrors chainEngine.ts's `MissionCurrentRow`,
   itself already a documented duplicate of fleetMissions.ts/
   missionsProjection.ts's identical local type).

   Both fetches are best-effort: a Tauri failure (no runtime, project not
   registered yet, a transient error) degrades to an honest empty
   directory/mission list, never a thrown error into the manager's
   system-prompt build.
*/

import { invoke } from '@tauri-apps/api/core';
import { basename } from '../../../lib/paths';
import { deriveFleetStage } from '../../../lib/agents/fleetStage';
import { listProjects } from '../../../lib/platform/tauri';
import { withTimeout } from '../../../lib/models/brainSearchLoop';
import { projectIdFromRoot } from '../../../lib/journal/projectId';
import type { Mission, MissionStatus } from '../../../lib/agents/types';
import { canvasStoreVanilla } from './canvasStore';
import { makeRef, parseRef, type Chain, type DraftSpec } from './canvasTypes';

/** Nodes listed before the digest switches to a "…+N autres" summary line
 *  (spec §8.1 deliverable #3's cap). */
const MAX_NODES_LISTED = 80;
const MAX_TITLE_CHARS = 40;

/** Hard ceiling on each Tauri round-trip below. The existing try/catch
 *  blocks only cover an invoke() REJECTION — a stalled IPC call that never
 *  settles slipped straight through them and froze every caller awaiting
 *  the digest (sendManagerMessage's pre-turn Promise.all was frozen this
 *  way: the manager turn never reached the model, managerBusy never
 *  resolved — the "je vais lire dans le brain… then nothing" regression).
 *  Same failure class commit 50ae785 ("no-op chain engine init outside
 *  Tauri") fixed for chainEngine. withTimeout converts a hang into a
 *  rejection, which the catches below already degrade to honest empties. */
const DIGEST_FETCH_TIMEOUT_MS = 2_000;

interface MissionRow {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

function isMissionLike(value: unknown): value is Mission {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'string';
}

interface ProjectDirectoryEntry {
  name: string;
  active: boolean;
}

/** Real open-project directory, keyed by the journal/canvas project-id
 *  space (`projectIdFromRoot(root)` — the same id `DraftSpec.projectId`
 *  and `journal_missions_current`'s `project_id` column live in), never
 *  the Tauri registry's own opaque `id`. Empty on any failure (no Tauri
 *  runtime, web/test environment, nothing registered yet). Exported so
 *  agentsStore.tsx's `resolveDraftProjectId` below (and any future caller
 *  needing the same real directory) reads the SAME source buildCanvasDigest
 *  does, rather than a second, possibly-diverging fetch. */
export async function fetchProjectDirectory(): Promise<Map<string, ProjectDirectoryEntry>> {
  const dir = new Map<string, ProjectDirectoryEntry>();
  try {
    const entries = await withTimeout(listProjects(), DIGEST_FETCH_TIMEOUT_MS, 'canvas digest project list');
    for (const entry of Array.isArray(entries) ? entries : []) {
      dir.set(projectIdFromRoot(entry.root), { name: basename(entry.root), active: entry.active });
    }
  } catch {
    // No Tauri runtime / nothing registered yet — an honest empty directory.
  }
  return dir;
}

/** Every mission across every project, straight from the journal — same
 *  invoke + defensive parsing chainEngine.ts's fetchAllJournalMissions
 *  already established (one corrupt row must never break the whole
 *  digest). */
async function fetchAllMissions(): Promise<Array<{ mission: Mission; projectId: string }>> {
  try {
    const rows = await withTimeout(
      invoke<MissionRow[]>('journal_missions_current'),
      DIGEST_FETCH_TIMEOUT_MS,
      'canvas digest missions',
    );
    const out: Array<{ mission: Mission; projectId: string }> = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (!isMissionLike(parsed)) continue;
      out.push({ mission: parsed, projectId: row.project_id });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolves a mission id to the REAL root path of the project it actually
 * belongs to — read from the SAME journal `project_id` column
 * fetchAllMissions/fleetMissions.ts's `missionOwner` map key off of (stamped
 * once, at `mission.created` time, via `projectIdFromRoot(repoPath)` — see
 * agentsStore.tsx's `addMission`), NEVER the currently ACTIVE project.
 *
 * Bug this exists to fix (see agentsStore.tsx's `approve_mission` case and
 * `triggerAutoMergeIfEligible`): both used to resolve the merge target via
 * `resolveProjectRoot()` — the ACTIVE project. A mission's own project and
 * whatever project is active NOW are two independent things — agentsStore's
 * mission list is never reloaded on an active-project switch (see this
 * file's own module doc comment / fleetMissions.ts's identical caveat), and
 * a mission can legitimately keep running against a project that is
 * open-but-not-active (e.g. a background/self-improvement mission) while the
 * user works elsewhere. Using the active root instead of the mission's own
 * either found no matching mission at all (a cross-project manager approve)
 * or, worse, ran a real `git merge` against the WRONG repo — rejected by git
 * as soon as it can't find the mission's branch there, then silently
 * swallowed by every caller's best-effort `.catch()`, leaving the mission
 * stuck in 'review' forever with no visible error anywhere. Rust's own
 * `ensure_repo_in_any_open_project` (commands/util.rs) already validates a
 * repo path against EVERY open project root, not just the active one, so a
 * background project's real root is already a fully-supported merge target
 * end to end — this was purely a TypeScript-side resolution bug.
 *
 * Returns undefined when the mission has no journal row yet (mock/web mode,
 * or a race before the first journal flush) OR its owning project isn't
 * currently open (closed since, or never registered this session) — callers
 * must treat this as "can't resolve, don't guess a possibly-wrong root"
 * (same honesty convention as resolveDraftProjectId above) and fall back to
 * their own pre-existing behavior instead of trusting a fabricated root.
 */
export async function resolveMissionProjectRoot(missionId: string): Promise<string | undefined> {
  try {
    const rows = await withTimeout(
      invoke<MissionRow[]>('journal_missions_current'),
      DIGEST_FETCH_TIMEOUT_MS,
      'resolve mission project root — missions',
    );
    const ownerProjectId = (Array.isArray(rows) ? rows : []).find((r) => r.mission_id === missionId)?.project_id;
    if (!ownerProjectId) return undefined;

    const projects = await withTimeout(
      listProjects(),
      DIGEST_FETCH_TIMEOUT_MS,
      'resolve mission project root — projects',
    );
    const match = (Array.isArray(projects) ? projects : []).find((p) => projectIdFromRoot(p.root) === ownerProjectId);
    return match?.root;
  } catch {
    return undefined;
  }
}

/**
 * Comparison-only superset of {@link projectIdFromRoot}: everything that
 * primitive already normalizes (verbatim `\\?\` prefix, drive-letter case,
 * trailing separator) PLUS slash-direction unification (backslash ->
 * forward-slash — same direction projectDigest.ts's own `normalizeForCompare`
 * already uses for the identical class of problem, never the reverse, which
 * would corrupt a genuine POSIX root that only ever uses `/`).
 *
 * Bug this exists to fix (2026-08-05, real prod repro): `open_project`
 * registers a path via Rust's `project_register` (backed by
 * `std::fs::canonicalize`, which on Windows yields a verbatim,
 * backslash-separated root — see paths.ts's header) while the id a caller
 * supplies back (the model echoing its own `open_project` argument, or a
 * hand-typed path) can carry a different drive-letter case OR forward
 * slashes. `projectIdFromRoot` alone already fixes the case; this wrapper
 * additionally fixes the slash direction. Only ever used to build an
 * ephemeral comparison key — every caller still returns/stores the
 * ORIGINAL `projectIdFromRoot`-shaped id (byte-preserving apart from the
 * drive letter), so no other reader of a directory key or a resolved root
 * ever observes this extra normalization.
 *
 * Exported (2026-08-05) — now also shared with draftLaunch.ts's own
 * launch-time cross-project check (`launchDraft`'s `draft.projectId` vs
 * `deps.activeProjectId` comparison, same bug family: a draft can be
 * stamped with a projectId of a different drive-letter case or slash
 * direction than the canonicalized active project id, e.g. when a manager
 * action echoes a path back). Both call sites reuse this ONE primitive
 * rather than draftLaunch.ts growing a second, possibly-diverging copy.
 */
export function normalizeForMembershipCompare(p: string): string {
  return projectIdFromRoot(p).replace(/\\/g, '/');
}

/**
 * Resolves a KNOWN project id (e.g. the output of {@link resolveDraftProjectId})
 * to its REAL root path — the same `listProjects()` (`project_list` Tauri
 * command) directory `resolveDraftProjectId`/`resolveMissionProjectRoot`
 * already read from, just keyed the other direction (id -> root instead of
 * root -> id). Needed by a caller that must actually touch the project's
 * filesystem (e.g. `start_preview`'s devPreview.ts pipeline reading
 * package.json), not just tag a draft/note with an id. Returns undefined on
 * any failure or when `projectId` names a project that is not (or no
 * longer) open — same honest "don't guess a possibly-wrong root" contract
 * as `resolveMissionProjectRoot`.
 *
 * `projectId` is normalized the SAME way (via {@link normalizeForMembershipCompare},
 * built on the shared `projectIdFromRoot` primitive) before comparison — a
 * raw caller-supplied path (different drive-letter case, or forward slashes)
 * must still match the directory's own normalized keys, not just an
 * already-canonical id (2026-08-05 fix: `scan_project` right after
 * `open_project` was rejecting the very project just opened).
 */
export async function resolveProjectRootById(projectId: string): Promise<string | undefined> {
  try {
    const projects = await withTimeout(listProjects(), DIGEST_FETCH_TIMEOUT_MS, 'resolve project root by id');
    const target = normalizeForMembershipCompare(projectId);
    const match = (Array.isArray(projects) ? projects : []).find((p) => normalizeForMembershipCompare(p.root) === target);
    return match?.root;
  } catch {
    return undefined;
  }
}

function truncateTitle(title: string): string {
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

function emptyStatusCounts(): Record<MissionStatus, number> {
  return { queued: 0, running: 0, review: 0, done: 0, failed: 0, cancelled: 0 };
}

export interface CanvasDigestOptions {
  /** Override for tests — production callers always use the default cap. */
  maxNodes?: number;
}

/**
 * Builds the compact canvas digest: per-project mission counts by status,
 * up to `maxNodes` mission/loop nodes (ref/kind/title≤40/status/stage/
 * project), every chain (source→target/condition/disabled/lastFired),
 * every draft, and pending cross-project chain fires — a best-effort
 * MIRROR of chainEngine.ts's own deferred-cross-project check
 * (`attemptFire`'s `crossProject` branch), read-only: this never advances
 * `lastFiredAtMs` or launches anything, it only reports what chainEngine
 * would currently see as "waiting on a project switch" so the manager can
 * tell the user about it.
 */
export async function buildCanvasDigest(options: CanvasDigestOptions = {}): Promise<string> {
  const maxNodes = options.maxNodes ?? MAX_NODES_LISTED;
  const [directory, allMissionRows] = await Promise.all([fetchProjectDirectory(), fetchAllMissions()]);
  const { drafts, chains, notes, macros, routers, joins, surfaces, frames } = canvasStoreVanilla.getState();

  // Round-3 QA fix (real user test: manager announced "48 nodes" for a
  // canvas that actually held 82): an ARCHIVED mission is already invisible
  // on the real board — the reconciler filters it out of the live node set
  // (Mission.archived's own doc comment, types.ts), same rule
  // buildManagerDynamicContext's own `visibleMissions` filter already
  // applies to the Current Missions list — but this digest counted every
  // journal row regardless, so an archived mission could inflate a count the
  // user's own eyes would never see on the canvas. Filtering here keeps the
  // mission/loop count fidelity-matched to what is actually rendered.
  const missionRows = allMissionRows.filter(({ mission }) => !mission.archived);

  if (directory.size === 0 && missionRows.length === 0 && drafts.length === 0 && chains.length === 0) {
    return 'Canvas: no open project — nothing on the board yet.';
  }

  // ── Per-project counts by status ────────────────────────────────────
  const countsByProject = new Map<string, Record<MissionStatus, number>>();
  for (const { mission, projectId } of missionRows) {
    const counts = countsByProject.get(projectId) ?? emptyStatusCounts();
    counts[mission.status] = (counts[mission.status] ?? 0) + 1;
    countsByProject.set(projectId, counts);
  }

  const allProjectIds = new Set<string>([...directory.keys(), ...countsByProject.keys()]);
  const projectLines = [...allProjectIds].map((projectId) => {
    const info = directory.get(projectId);
    const counts = countsByProject.get(projectId) ?? emptyStatusCounts();
    const summary =
      Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([status, n]) => `${status}:${n}`)
        .join(' ') || 'no missions';
    return `- ${info?.name ?? projectId} (${projectId})${info?.active ? ' [ACTIVE]' : ''}: ${summary}`;
  });

  // ── Nodes (mission/loop) — capped ───────────────────────────────────
  const totalNodes = missionRows.length;
  const nodeLines = missionRows.slice(0, maxNodes).map(({ mission, projectId }) => {
    const kind = mission.loopConfig ? 'loop' : 'mission';
    const ref = makeRef(kind, mission.id);
    const stage = deriveFleetStage(mission);
    return `- ${ref} [${kind}] "${truncateTitle(mission.title)}" status=${mission.status} stage=${stage} project=${projectId}`;
  });
  if (totalNodes > maxNodes) nodeLines.push(`…+${totalNodes - maxNodes} autres`);

  // ── Chains ───────────────────────────────────────────────────────────
  // Manager-context fix (2026-08-02 escalation — real founder repro: "no
  // chain defined after M1/M2 in lazy-backoffice", the manager unable to
  // tell WHICH project a chain belongs to because this digest listed a
  // chain's two bare refs with no project attribution at all — the manager
  // had to cross-reference the separate Nodes/Drafts/Joins sections by hand
  // to guess). `projectOfRef` resolves either endpoint's OWN project the
  // exact same way the rest of this digest already does (mission ->
  // `missionRows`' real journal project_id, draft/join/router -> their own
  // `projectId` field) — never text/name matching. A chain whose two
  // endpoints disagree (the exact shape of a mis-materialized plan: a real
  // mission in project B chaining into a draft stuck in project A) is
  // flagged explicitly with MISMATCH so the manager (or a human reading the
  // digest) can see the wrong-zone chain instead of silently missing it.
  const missionProjectById = new Map(missionRows.map((r) => [r.mission.id, r.projectId] as const));
  const draftProjectById = new Map(drafts.map((d: DraftSpec) => [d.id, d.projectId] as const));
  const joinProjectById = new Map(joins.map((j) => [j.id, j.projectId] as const));
  const routerProjectById = new Map(routers.map((r) => [r.id, r.projectId] as const));
  const projectOfRef = (ref: string): string | undefined => {
    const parsed = parseRef(ref);
    if (!parsed) return undefined;
    if (parsed.kind === 'mission' || parsed.kind === 'loop') return missionProjectById.get(parsed.id);
    if (parsed.kind === 'draft') return draftProjectById.get(parsed.id);
    if (parsed.kind === 'join') return joinProjectById.get(parsed.id);
    if (parsed.kind === 'router') return routerProjectById.get(parsed.id);
    return undefined;
  };
  const chainLines = chains.map((c: Chain) => {
    const lastFired = c.lastFiredAtMs !== undefined ? ` lastFired=${new Date(c.lastFiredAtMs).toISOString()}` : '';
    const sourceProject = projectOfRef(c.sourceRef);
    const targetProject = projectOfRef(c.targetRef);
    const project = sourceProject ?? targetProject;
    const projectLabel = project ? ` project=${project}` : ' (transverse)';
    const mismatchLabel =
      sourceProject !== undefined && targetProject !== undefined && sourceProject !== targetProject
        ? ` MISMATCH(source=${sourceProject} target=${targetProject})`
        : '';
    return `- ${c.id}: ${c.sourceRef} -> ${c.targetRef} [${c.condition}]${projectLabel}${mismatchLabel}${c.disabled ? ' DISABLED' : ''}${lastFired}`;
  });

  // ── Drafts ───────────────────────────────────────────────────────────
  const draftLines = drafts.map(
    (d: DraftSpec) => `- ${makeRef('draft', d.id)}: "${truncateTitle(d.title)}"${d.projectId ? ` project=${d.projectId}` : ' (transverse)'}`,
  );

  // ── Structural nodes (routers/joins/frames) + living surfaces ──────────
  // Round-3 QA fix (real user test: manager announced "48 nodes" for a
  // canvas that actually held 82): these four kinds render as real nodes on
  // the board (canvasTypes.ts's CanvasNodeKind: 'router' | 'join' |
  // 'terminal' | 'preview' | 'frame') but this digest never reported any of
  // them at all — the single largest source of the node-count gap. Listed
  // (like Drafts above) only when non-empty, matching the Notes/Saved-macros
  // convention below, to keep the prompt compact on the common empty case —
  // but the "Canvas total" line further below always states their real
  // count regardless.
  const routerLines = routers.map(
    (r) => `- ${makeRef('router', r.id)}: ${r.branches.length} branch(es)${r.projectId ? ` project=${r.projectId}` : ' (transverse)'}`,
  );
  const joinLines = joins.map(
    (j) => `- ${makeRef('join', j.id)}: "${truncateTitle(j.name ?? j.id)}" ${j.sourceRefs.length} source(s) mode=${j.mode}${j.projectId ? ` project=${j.projectId}` : ' (transverse)'}`,
  );
  const surfaceLines = surfaces.map(
    (s) => `- ${makeRef(s.kind, s.id)}: [${s.kind}]${s.projectId ? ` project=${s.projectId}` : ' (transverse)'}`,
  );
  const frameLines = frames.map(
    (f) => `- ${makeRef('frame', f.id)}: "${truncateTitle(f.title)}"${f.projectId ? ` project=${f.projectId}` : ' (transverse)'}`,
  );

  // ── Pending cross-project fires (best-effort mirror — see doc comment) ─
  const missionById = new Map(missionRows.map((r) => [r.mission.id, r.mission] as const));
  const draftById = new Map(drafts.map((d) => [d.id, d] as const));
  const activeProjectId = [...directory.entries()].find(([, info]) => info.active)?.[0];
  const pendingLines: string[] = [];
  for (const chainEntry of chains) {
    if (chainEntry.disabled) continue;
    const source = parseRef(chainEntry.sourceRef);
    const target = parseRef(chainEntry.targetRef);
    if (!source || source.kind !== 'mission' || !target || target.kind !== 'draft') continue;
    const sourceMission = missionById.get(source.id);
    const draft = draftById.get(target.id);
    if (!sourceMission || !draft || draft.projectId === undefined) continue;
    const terminalMatch =
      (chainEntry.condition === 'success' && sourceMission.status === 'done') ||
      (chainEntry.condition === 'fail' && sourceMission.status === 'failed') ||
      (chainEntry.condition === 'always' && (sourceMission.status === 'done' || sourceMission.status === 'failed'));
    if (!terminalMatch || draft.projectId === activeProjectId) continue;
    pendingLines.push(`- chain ${chainEntry.id}: "${truncateTitle(sourceMission.title)}" completed, waiting on project ${draft.projectId} to become active`);
  }

  const sections = [
    `Projects:\n${projectLines.length > 0 ? projectLines.join('\n') : '(none open)'}`,
    `Nodes (${totalNodes}):\n${nodeLines.length > 0 ? nodeLines.join('\n') : '(none)'}\n(missions/loops only, fleet-wide, archived excluded — see Canvas total below for every node kind)`,
    `Chains (${chains.length}):\n${chainLines.length > 0 ? chainLines.join('\n') : '(none)'}`,
    `Drafts (${drafts.length}):\n${draftLines.length > 0 ? draftLines.join('\n') : '(none)'}`,
  ];
  if (routers.length > 0) sections.push(`Routers (${routers.length}):\n${routerLines.join('\n')}`);
  if (joins.length > 0) sections.push(`Joins (${joins.length}):\n${joinLines.join('\n')}`);
  if (surfaces.length > 0) sections.push(`Surfaces — terminals/previews (${surfaces.length}):\n${surfaceLines.join('\n')}`);
  if (frames.length > 0) sections.push(`Frames (${frames.length}):\n${frameLines.join('\n')}`);
  // Round-3 QA fix — the fidelity fix itself: a single explicit total that
  // sums EVERY kind actually tracked above, so "how many nodes on the
  // canvas" always matches what the user's own eyes count, never just the
  // mission/loop subset. Explicitly names what is NOT in this sum (project
  // zone headers — a UI grouping chrome, not a canvas-owned fact like the
  // others) so the manager never silently over- or under-claims scope.
  const canvasTotalNodes = totalNodes + drafts.length + notes.length + routers.length + joins.length + surfaces.length + frames.length;
  sections.push(
    `Canvas total: ${canvasTotalNodes} node(s) — missions/loops ${totalNodes} + drafts ${drafts.length} + notes ${notes.length} + routers ${routers.length} + joins ${joins.length} + terminals/previews ${surfaces.length} + frames ${frames.length}. This sums every node kind the real board renders EXCEPT project zone headers (grouping chrome, never counted as a node) — archived missions are already excluded from the missions/loops count above.`,
  );
  if (pendingLines.length > 0) sections.push(`Pending cross-project fires:\n${pendingLines.join('\n')}`);
  if (notes.length > 0) sections.push(`Notes: ${notes.length} sticky note(s) on the board.`);
  // Group macros (canvas-parity-close, additive) — the manager references a
  // saved macro by NAME (instantiate_macro), so it needs the real saved
  // names here rather than guessing.
  if (macros.length > 0) {
    const macroLines = macros.map(
      (m) => `- "${truncateTitle(m.name)}": ${m.drafts.length + m.routers.length + m.notes.length} node(s)`,
    );
    sections.push(`Saved macros (${macros.length}):\n${macroLines.join('\n')}`);
  }

  // ── Recently finished (active project) — anti-relaunch guard ──────
  // Real-user incident (2026-08-03): the manager told the user a file was
  // "still pending" while the mission that created it was already done and
  // merged. The Nodes section above carries the raw status, but an explicit
  // "recently finished, do NOT relaunch" line removes all ambiguity — for
  // cheap/fast models in particular, which tend to answer from the last
  // statuses they remember instead of the current digest.
  const finishedLines = missionRows
    .filter(({ mission, projectId }) => projectId === activeProjectId && (mission.status === 'done' || mission.status === 'failed'))
    .sort((a, b) => (b.mission.createdAt ?? 0) - (a.mission.createdAt ?? 0))
    .slice(0, 5)
    .map(({ mission }) => {
      const ref = makeRef(mission.loopConfig ? 'loop' : 'mission', mission.id);
      return mission.status === 'done'
        ? `- ${ref} "${truncateTitle(mission.title)}" DONE — work is committed/merged in the project; do NOT relaunch or re-create its deliverable unless the user explicitly asks`
        : `- ${ref} "${truncateTitle(mission.title)}" FAILED — may be relaunched, but only if the user asks`;
    });
  if (finishedLines.length > 0) {
    sections.push(`Recently finished (active project):\n${finishedLines.join('\n')}`);
  }

  return sections.join('\n\n');
}

// ── Project targeting resolution (W6e) ──────────────────────────────────
//
// Real-app finding: a manager reply that fires create_draft (directly, or
// via chain_agents' inline target spec) with no `projectId` — or one that
// does not match any REAL open project — used to pass that value straight
// through to canvasStore's addDraft, so the draft silently landed in the
// Transverse zone even when the user clearly meant "put it in the project
// I'm looking at". resolveDraftProjectId is the one place both executor
// call sites (agentsStore.tsx's `create_draft` case and `chain_agents`'
// inline-target branch) resolve a requested projectId against the SAME
// real directory buildCanvasDigest itself reads from — so "known project
// id" here means exactly what the digest shows the manager on every turn.

export interface ProjectTargetResolution {
  /** Resolved project id to store on the draft — undefined places it in
   *  the Transverse zone (either deliberately, when nothing is open/active,
   *  or as the honest fallback for an unresolvable `unresolvedName`). */
  projectId: string | undefined;
  /** Set only when the caller passed a non-blank `requested` value that
   *  matched NEITHER a known project id NOR a known project name — the
   *  caller should surface an honest "project not found" note to the user
   *  (the draft still gets created, just in the Transverse zone) instead of
   *  silently guessing which project was meant. */
  unresolvedName?: string;
}

/**
 * Resolves a `create_draft` / `chain_agents` inline-target `projectId`
 * field to a real, known project id:
 *   - absent/blank -> the ACTIVE project's id (the one the digest marks
 *     `[ACTIVE]`), or undefined (Transverse) when no project is open/active.
 *   - an exact match against a known project id -> used as-is.
 *   - else a case-insensitive match against a known project NAME (the same
 *     `basename(root)` the digest displays) -> resolved to that project's
 *     real id.
 *   - else -> undefined (Transverse), with `unresolvedName` set to the raw
 *     requested value.
 */
export async function resolveDraftProjectId(requested: string | undefined): Promise<ProjectTargetResolution> {
  const directory = await fetchProjectDirectory();
  const trimmed = requested?.trim();

  if (!trimmed) {
    const activeId = [...directory.entries()].find(([, info]) => info.active)?.[0];
    return { projectId: activeId };
  }

  if (directory.has(trimmed)) return { projectId: trimmed };

  // Normalized fallback (2026-08-05 fix, same root cause/primitive as
  // resolveProjectRootById above): `trimmed` may be a raw filesystem path
  // (e.g. echoed verbatim from a prior open_project call) rather than an
  // already-canonical directory key — different drive-letter case or
  // forward slashes must still resolve. Returns the directory's OWN key
  // (never `trimmed` itself), so the result stays in the exact id space
  // every other reader (journal-stamped mission ids, draft.projectId, ...)
  // already expects.
  const normalizedTarget = normalizeForMembershipCompare(trimmed);
  const byNormalizedId = [...directory.keys()].find((id) => normalizeForMembershipCompare(id) === normalizedTarget);
  if (byNormalizedId) return { projectId: byNormalizedId };

  const needle = trimmed.toLowerCase();
  const byName = [...directory.entries()].find(([, info]) => info.name.toLowerCase() === needle);
  if (byName) return { projectId: byName[0] };

  return { projectId: undefined, unresolvedName: trimmed };
}
