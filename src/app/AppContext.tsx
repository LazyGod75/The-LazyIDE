/* AppContext — global React context for active space, platform, project root,
   and the multi-project registry (T0.9, spec section 5.1). */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getPlatform } from '../lib/platform';
import type { Platform } from '../lib/platform';
import type { ProjectEntryOut } from '../lib/platform/tauri';
import { initProviderMode } from '../lib/models';
import { on } from '../lib/bus';
import type { NavigateSpacePayload } from '../lib/bus';
import { useTeamsSync } from '../lib/teams/useTeamsSync';
import { stripVerbatimPrefix } from '../lib/paths';
import { invalidateProjectRootCache } from '../lib/agents/projectRootCache';

// ── Types ─────────────────────────────────────────────────────────

export type SpaceId = 'home' | 'code' | 'agents' | 'brain' | 'review' | 'terminals' | 'models' | 'settings' | 'account' | 'team' | 'bots';

/** One open project, as tracked by the Rust `ProjectRegistry` (T0.7). Same
 *  wire shape `project_register` / `project_list` return — re-exported
 *  under this name since every AppContext consumer thinks in terms of
 *  "project entries", not the platform wrapper's wire type. */
export type ProjectEntry = ProjectEntryOut;

const LAST_PROJECT_KEY = 'lazy.lastProject';
const RECENT_PROJECTS_KEY = 'lazy.projects.recent';
const MAX_RECENT_PROJECTS = 8;

/** One entry in the `lazy.projects.recent` MRU list — newest first, max
 *  `MAX_RECENT_PROJECTS`. Separate from `openProjects`: recents survive a
 *  project being closed and are never auto-reopened on boot (only the
 *  legacy-upgrade path or an already non-empty registry restore anything
 *  automatically) — this is purely a convenience list for a future
 *  "recent projects" picker. */
export interface RecentProjectEntry {
  root: string;
  lastOpenedMs: number;
}

/** Exported read-only accessor for `lazy.projects.recent` — used by
 *  agentsStore.tsx's `launch_mission` executor (BUG 1 fix, 2026-08-07) to
 *  resolve a project NAME the user named but that isn't currently open
 *  (`resolveDraftProjectId`'s `unresolvedName`) against a real root path
 *  this session has seen before, so the mission can auto-open it instead of
 *  hard-failing with "is not open — cannot launch a mission at it". Read-
 *  only: never mutates the list, safe to call from anywhere. */
export function readRecentProjects(): RecentProjectEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RecentProjectEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RecentProjectEntry).root === 'string' &&
        typeof (entry as RecentProjectEntry).lastOpenedMs === 'number',
    );
  } catch {
    return [];
  }
}

/** Moves `root` to the front of the recents list (deduped), truncated to
 *  `MAX_RECENT_PROJECTS`. Best-effort: a localStorage write failure (quota,
 *  private-mode restrictions) must never break project switching. */
function touchRecentProject(root: string): void {
  try {
    const withoutRoot = readRecentProjects().filter((entry) => entry.root !== root);
    const next = [{ root, lastOpenedMs: Date.now() }, ...withoutRoot].slice(0, MAX_RECENT_PROJECTS);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
  } catch {
    // best-effort — never break project switching over a recents-list write
  }
}

/** Normalizes a project root before it reaches React state or either
 *  localStorage key (`lazy.lastProject` / `lazy.projectRoot`): strips a
 *  Windows extended-length ("verbatim") `\\?\` / `\\?\UNC\` prefix (see
 *  `stripVerbatimPrefix`, src/lib/paths.ts) and trims a trailing separator
 *  (mirrors src-tauri/src/commands/util.rs's `project_id_for_root`).
 *
 *  EVERY project root sourced from Rust becomes verbatim-prefixed on
 *  Windows: `project_register_inner` and `project_set_active_inner`
 *  (src-tauri/src/commands/brain/config.rs) both derive `root` from
 *  `std::fs::canonicalize()`, and that value round-trips to the frontend via
 *  `project_register`'s/`project_list`'s return value AND the
 *  `project://changed` event payload — not from the folder-open dialog
 *  (`openFolder` returns whatever the OS picker hands back, unprefixed).
 *  A `\\?\`-prefixed root reaching the assistant tool loop's Rust-side
 *  containment check (`ensure_repo_in_project_root`) can false-negative
 *  ("outside project root") depending on how a caller joined a suffix onto
 *  it — normalizing at every write site here self-heals both storage keys
 *  regardless of which of the 4 call sites (boot restore, registerProject,
 *  switchProject, project://changed) produced the value. */
function normalizeProjectRoot(path: string): string {
  return stripVerbatimPrefix(path).replace(/[\\/]+$/, '');
}

/** Shallow-compares two `listProjects()` results for the `project://changed`
 *  listener's refresh below: same length and, at each index, the same
 *  id/root/brainId/active. Lets that refresh no-op (skip setOpenProjects,
 *  and the re-render it would otherwise trigger) when the registry didn't
 *  actually change since the last listing. */
function sameProjectEntries(a: ProjectEntry[], b: ProjectEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, i) => {
    const other = b[i];
    return (
      entry.id === other.id &&
      entry.root === other.root &&
      entry.brainId === other.brainId &&
      entry.active === other.active
    );
  });
}

/** REAL-APP FIX (2026-08-04, UC3 dogfood — canvas rendered the SAME project
 *  node 3-4 times: `project:...cerveau\Lazy` at three positions + a
 *  `project:...cerveau\lazy` twin, 214 edges for 26 nodes, completely
 *  unreadable): the Rust ProjectRegistry can end up holding several entries
 *  for the SAME real directory under different spellings — a `\\?\`-prefixed
 *  form vs a plain form, a trailing separator, or a different casing of the
 *  path (`...\cerveau\Lazy` vs `...\cerveau\lazy`; `projectIdFromRoot` only
 *  folds the drive letter, so those mint two different project ids). Every
 *  such twin renders as a separate, overlapping project zone on the canvas.
 *
 *  Single frontend choke point: every `setOpenProjects` in this file funnels
 *  through this dedupe, keyed by the fully normalized root (verbatim prefix
 *  stripped, trailing separators trimmed, case-folded for Windows), keeping
 *  the FIRST entry of each real directory. `active` is re-derived by the
 *  callers exactly as before, so losing a twin never loses the active flag. */
function dedupeProjectEntries(entries: ProjectEntry[]): ProjectEntry[] {
  const seen = new Set<string>();
  const out: ProjectEntry[] = [];
  for (const entry of entries) {
    const key = normalizeProjectRoot(entry.root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

interface AppState {
  activeSpace: SpaceId;
  platform: Platform;
  agentCount: number;
  projectRoot: string;
  /** Every currently open project (T0.7 registry), each flagged `active`. */
  openProjects: ProjectEntry[];
  /** The active project's registry id, or `null` before any project has
   *  ever been registered. Distinct from `projectRoot`: this is the stable
   *  registry id, `projectRoot` is the (display/consumer-facing) path. */
  activeProjectId: string | null;
  /** QA fix (B5): the Settings sub-tab requested by the last navigation
   *  (via setActiveSpace's `tab` param or a `nav:navigateSpace` bus event
   *  carrying one) — `null` when the last navigation didn't request one, in
   *  which case AppShell.tsx's SpaceContent falls back to each settings-ish
   *  SpaceId's own default tab. Read by AppShell so a deep-link (e.g.
   *  AccountPopover's "Créer une équipe" or the palette's "Aller à :
   *  Réglages") lands on the intended sub-tab instead of always General. */
  settingsInitialTab: string | null;
  /** Boot-race fix: `false` for the entire window between mount and the
   *  registry-hydration effect below settling (either branch — a non-empty
   *  registry, the legacy-upgrade path, or genuinely nothing to restore).
   *  `openProjects.length === 0` is AMBIGUOUS on its own during that window
   *  — it means either "hydration finished, no project was ever opened" OR
   *  "hydration hasn't resolved yet" — and a consumer (CanvasView's empty
   *  hero, a future loading skeleton) must be able to tell them apart: the
   *  dead "Ouvre un projet" hero is only honest once hydration completed
   *  WITH zero projects, never while it's still in flight. Always `true` in
   *  web mode (`platform.name !== 'tauri'`) — there is no registry to
   *  hydrate there, so there is nothing to wait for. */
  projectsHydrated: boolean;
}

interface AppContextValue extends AppState {
  /** Switch the active space, optionally deep-linking to a Settings
   *  sub-tab (only meaningful for the 'settings'/'account'/'models' space
   *  ids — see `settingsInitialTab`). */
  setActiveSpace: (space: SpaceId, tab?: string) => void;
  /** Open a folder picker and register+activate the chosen folder as a
   *  project. No-op in web mode. Fully backward compatible: same signature
   *  and behavior as before T0.9 (register-then-activate is exactly what
   *  the old path-based switchProject did under the hood via set_project). */
  openProject: () => Promise<void>;
  /** Switch the active project to an ALREADY-REGISTERED project's id (not
   *  a path — see `registerProject` for opening a not-yet-registered
   *  path). The existing `project://changed` listener updates `projectRoot`
   *  same as always. */
  switchProject: (id: string) => Promise<void>;
  /** Register `path` as an open project and make it the active one
   *  (idempotent — re-registering an already-open root just re-activates
   *  it). No-op in web mode. */
  registerProject: (path: string) => Promise<void>;
  /** Close an open project. Rejects (see the Rust command's semantics) if
   *  `id` is the active project while other projects remain open — the
   *  caller must switch away first. No-op in web mode. */
  closeProject: (id: string) => Promise<void>;
}

// ── Context ───────────────────────────────────────────────────────

const AppContext = createContext<AppContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppContext must be used inside AppProvider');
  return ctx;
}

/**
 * Safe variant of {@link useAppContext} — returns `null` instead of
 * throwing when rendered outside an `AppProvider` ancestor, same "safe
 * no-op default" convention `useToastSafe` (components/ui/Toast.tsx)
 * already establishes for this exact situation. Needed by
 * agentsStore.tsx's fleet-hygiene sweep (P58 test-scratch project
 * closure, 2026-07-22 memory-pressure incident fix): most of that file's
 * OWN unit tests render `AgentsStoreProvider` standalone, with no
 * `AppProvider` ancestor — a consumer degrading to "nothing to sweep here"
 * (an absent `openProjects`/`activeProjectId`) is the honest behavior, not
 * a crash.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useAppContextOptional(): AppContextValue | null {
  return useContext(AppContext);
}

// ── Provider ──────────────────────────────────────────────────────

interface AppProviderProps {
  children: React.ReactNode;
}

export function AppProvider({ children }: AppProviderProps) {
  // D2: Cockpit (agents) is the redesign's home/first-paint space.
  const [activeSpace, setActiveSpaceState] = useState<SpaceId>('agents');
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | null>(null);
  const platform = getPlatform();
  const [projectRoot, setProjectRoot] = useState<string>('');
  const [agentCount, setAgentCount] = useState<number>(0);
  const [openProjects, setOpenProjects] = useState<ProjectEntry[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  // 2026-08-12 fix — "opportunistic canvas refresh" defect: FOUR independent
  // call sites (the boot hydration effect, registerProject, closeProject,
  // and the project://changed listener below) each fire their OWN
  // `listProjects()` IPC round-trip and then call `setOpenProjects` with
  // whatever they get back. Real Tauri IPC latency is NOT guaranteed to
  // preserve call order — a listProjects() issued EARLIER (e.g. by the
  // project://changed listener reacting to the just-superseded activation)
  // can resolve LATER than one issued AFTER it (e.g. registerProject's own,
  // for the SAME user action), and the one that resolves last always won,
  // regardless of which one actually reflects the current registry. Live
  // repro (2026-08-12): opening a new project updated localStorage/the FLUX
  // journal immediately (registerProject's own listProjects()+setOpenProjects
  // DID fire, synchronously, right there), but the canvas kept showing the
  // stale, smaller project set for ~20s — a slower, EARLIER-issued
  // listProjects() response landed after it and silently clobbered the
  // correct state — until a later, unrelated action's own listProjects()
  // call happened to be the new "last one in" and finally caught up (this
  // time to a DIFFERENT, also possibly-stale snapshot — explaining why a
  // previously-open project could vanish just as easily as a new one could
  // fail to appear: neither symptom is about the DATA being wrong, only
  // about which response is allowed to win the race).
  //
  // Fix: every listProjects()-driven `setOpenProjects` funnels through
  // `refreshOpenProjects` below, which tickets each fetch with a
  // monotonically increasing sequence number and only ever applies the
  // highest-ticketed response that has resolved so far — a response from an
  // older ticket arriving after a newer one already applied is dropped,
  // never allowed to move state backwards.
  const openProjectsFetchSeqRef = useRef(0);
  const openProjectsAppliedSeqRef = useRef(0);
  // Web mode never hydrates a registry — start "already hydrated" so a
  // web consumer never sees a permanent loading state (see the field's own
  // doc comment on AppContextValue for the full contract).
  const [projectsHydrated, setProjectsHydrated] = useState<boolean>(platform.name !== 'tauri');

  // Single funnel for every space navigation — both the context's own
  // setActiveSpace(space, tab?) and the nav:navigateSpace bus handler below
  // resolve through here, so the two mechanisms can never drift (QA fix B5).
  const setActiveSpace = useCallback((space: SpaceId, tab?: string) => {
    setActiveSpaceState(space);
    setSettingsInitialTab(tab ?? null);
  }, []);

  // Subscribe to bus 'agent:runningCount' to keep agentCount live
  useEffect(() => {
    return on('agent:runningCount', setAgentCount);
  }, []);

  // Subscribe to navigation bus events
  useEffect(() => {
    const unsubNav = on('nav:navigateSpace', (payload: NavigateSpacePayload) => {
      if (typeof payload === 'string') {
        setActiveSpace(payload as SpaceId);
      } else {
        setActiveSpace(payload.space as SpaceId, payload.tab);
      }
    });
    const unsubBrain = on('nav:focusBrainNode', () => {
      setActiveSpace('brain');
    });
    return () => {
      unsubNav();
      unsubBrain();
    };
  }, [setActiveSpace]);

  // Teams auth reconciliation: sync org-context + store JWT on login / token refresh.
  // No-op in solo mode (scope !== 'team'), on the web build, and when not connected.
  // projectRoot drives scope resolution — re-registers when the project switches.
  useTeamsSync({ projectRoot });

  // On mount: init provider mode (claude CLI availability check) + project root
  useEffect(() => {
    if (platform.name !== 'tauri') return;

    // Kick off provider mode detection in parallel with project init
    initProviderMode().catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Tickets and applies a fresh `listProjects()` read into `openProjects` —
  // see the seq refs' own doc comment above for the exact race this closes.
  // Every call site below that used to do its own `listProjects().then(...
  // setOpenProjects(...))` now funnels through here instead. Deliberately
  // does NOT catch a `listProjects()` rejection itself (matches every
  // pre-existing call site's own error handling — registerProject/
  // closeProject let it propagate, the boot effect and the project://changed
  // listener already wrap their own call in a try/catch) — only adds the
  // sequencing guard on top of the exact same fetch-then-apply shape.
  // Returns the raw entries too (for a caller that also needs to derive e.g.
  // the active entry) plus whether THIS call's response is the one that
  // actually got applied — a caller MUST skip any further state derived
  // from `entries` when `applied` is false, since a newer response already
  // won and this one's data is stale by definition (dropping it, rather
  // than applying it anyway, is the whole point of the guard).
  const refreshOpenProjects = useCallback(async (): Promise<{ applied: boolean; entries: ProjectEntry[] }> => {
    const ticket = ++openProjectsFetchSeqRef.current;
    const { listProjects } = await import('../lib/platform/tauri');
    const entries = await listProjects();
    if (ticket < openProjectsAppliedSeqRef.current) {
      return { applied: false, entries };
    }
    openProjectsAppliedSeqRef.current = ticket;
    setOpenProjects((prev) => {
      const deduped = dedupeProjectEntries(entries);
      return sameProjectEntries(prev, deduped) ? prev : deduped;
    });
    return { applied: true, entries };
  }, []);

  // Register `path` as an open project and make it the active one. The
  // SOLE upgrade path from a not-yet-registered path to an active project —
  // openProject() and the boot effect's legacy-upgrade both funnel through
  // here so there is exactly one place that does register + activate +
  // refresh + recents.
  const registerProject = useCallback(async (path: string): Promise<void> => {
    if (platform.name !== 'tauri') return;
    const { registerProject: registerProjectCmd, setActiveProject: activateCmd } =
      await import('../lib/platform/tauri');
    const entry = await registerProjectCmd(path);
    await activateCmd(entry.id);
    await refreshOpenProjects();
    // entry.id is ground truth the instant activateCmd resolves — set it
    // unconditionally (never gated on refreshOpenProjects' own `applied`):
    // this fact doesn't come from the listProjects() read at all, so a
    // slower/superseded listing racing it is irrelevant to it being correct.
    setActiveProjectId(entry.id);
    // Set projectRoot directly rather than relying solely on the
    // project://changed round-trip below — it still fires too (redundant,
    // harmless: same value) but this keeps every existing projectRoot
    // consumer in sync the instant this call resolves, not one IPC
    // round-trip later. entry.root is Rust's canonicalize() output — always
    // normalize before it reaches state/storage (see normalizeProjectRoot).
    const normalizedRoot = normalizeProjectRoot(entry.root);
    setProjectRoot(normalizedRoot);
    localStorage.setItem(LAST_PROJECT_KEY, normalizedRoot);
    // Defensive backstop: 'lazy.projectRoot' is a DIFFERENT key from
    // LAST_PROJECT_KEY ('lazy.lastProject') that assistantToolLoop.ts's
    // getProjectRoot() falls back to reading when a caller doesn't thread
    // the live projectRoot through StreamChatRequest — self-heals any such
    // stale reader instead of leaving it permanently stuck on '.'.
    localStorage.setItem('lazy.projectRoot', normalizedRoot);
    touchRecentProject(normalizedRoot);
  }, [platform.name, refreshOpenProjects]);

  // Switch the active project to an ALREADY-registered id.
  const switchProject = useCallback(async (id: string): Promise<void> => {
    if (platform.name !== 'tauri') return;
    const { setActiveProject: activateCmd } = await import('../lib/platform/tauri');
    await activateCmd(id);
    setActiveProjectId(id);
    setOpenProjects((prev) => dedupeProjectEntries(prev.map((entry) => ({ ...entry, active: entry.id === id }))));
    const target = openProjects.find((entry) => entry.id === id);
    if (target) {
      // Same reasoning as registerProject above: set directly, don't wait
      // for the project://changed event to make the round-trip. target.root
      // came from listProjects() — same verbatim-prefixed Rust origin as
      // registerProject's entry.root, so normalize the same way.
      const normalizedRoot = normalizeProjectRoot(target.root);
      setProjectRoot(normalizedRoot);
      localStorage.setItem(LAST_PROJECT_KEY, normalizedRoot);
      // Defensive backstop — see the same write in registerProject above.
      localStorage.setItem('lazy.projectRoot', normalizedRoot);
      touchRecentProject(normalizedRoot);
    }
  }, [platform.name, openProjects]);

  const closeProject = useCallback(async (id: string): Promise<void> => {
    if (platform.name !== 'tauri') return;
    const { closeProject: closeProjectCmd } = await import('../lib/platform/tauri');
    await closeProjectCmd(id);
    const { applied, entries } = await refreshOpenProjects();
    // `active` is DERIVED from `entries` (unlike registerProject's entry.id
    // above) — a stale/superseded response must never set activeProjectId
    // off of it, so this skips entirely when a newer refresh already won.
    if (!applied) return;
    const active = entries.find((entry) => entry.active) ?? null;
    setActiveProjectId(active?.id ?? null);
  }, [platform.name, refreshOpenProjects]);

  // On mount: hydrate the registry (source of truth) and, only when it is
  // still empty (fresh Rust process — the registry does not persist across
  // restarts), seamlessly upgrade the legacy single-project key exactly
  // once via registerProject.
  useEffect(() => {
    if (platform.name !== 'tauri') return;

    async function init() {
      let applied = false;
      let entries: ProjectEntry[] = [];
      try {
        const result = await refreshOpenProjects();
        applied = result.applied;
        entries = result.entries;
      } catch {
        // Command unavailable / IPC hiccup — treat exactly like "no
        // projects registered yet" (entries already defaults to []).
      }

      if (entries.length > 0) {
        // `applied` is virtually always true here (this is the first
        // refreshOpenProjects ticket issued this session, nothing else can
        // have raced ahead of it yet) — guarded anyway for the same reason
        // closeProject/the project://changed listener guard it: deriving
        // `active`/writing localStorage from a response that lost the race
        // must never happen, boot included.
        if (!applied) return;
        const active = entries.find((entry) => entry.active) ?? null;
        setActiveProjectId(active?.id ?? null);
        if (active) {
          // active.root is Rust's canonicalize() output (verbatim-prefixed
          // on Windows) — normalize before it reaches state/storage (see
          // normalizeProjectRoot's doc comment). This restore path is the
          // one the boot-race bug traced to: it wrote LAST_PROJECT_KEY but
          // never the 'lazy.projectRoot' backstop, so a fresh boot left that
          // key permanently null even after registerProject/switchProject
          // were patched to write it.
          const normalizedRoot = normalizeProjectRoot(active.root);
          setProjectRoot(normalizedRoot);
          localStorage.setItem(LAST_PROJECT_KEY, normalizedRoot);
          localStorage.setItem('lazy.projectRoot', normalizedRoot);
          touchRecentProject(normalizedRoot);
        }
        return;
      }

      // Registry empty: seamless upgrade from the legacy single-project key.
      const saved = localStorage.getItem(LAST_PROJECT_KEY);
      if (saved) {
        try {
          await registerProject(saved);
        } catch {
          // Saved path may no longer exist — clear it
          localStorage.removeItem(LAST_PROJECT_KEY);
        }
      }

      // No saved project and an empty registry: leave everything empty —
      // the user must explicitly open a folder via the welcome screen.
    }

    // Boot-race fix: `projectsHydrated` flips to `true` once `init()`
    // settles, REGARDLESS of which branch it took (non-empty registry,
    // legacy-upgrade success, legacy-upgrade failure, or nothing to
    // restore) and regardless of whether it threw — a consumer gating on
    // this flag must stop waiting exactly once, not hang forever if a
    // future edit to `init()` above throws past its own internal
    // try/catches.
    init().finally(() => setProjectsHydrated(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for project://changed events emitted by set_project /
  // project_set_active (T0.7 kept the SAME event, same payload shape).
  //
  // Also re-lists openProjects (and syncs activeProjectId off the same
  // listing) on every event: projectRoot used to be the only thing this
  // listener kept live, so a project registered/activated by anything OTHER
  // than this context's own registerProject/switchProject — a raw invoke, a
  // deep link, a future LazyManager tool — updated projectRoot but left
  // openProjects stale, desyncing the PROJECTS rail from the header/
  // explorer (P2 finding). The refresh no-ops via sameProjectEntries when
  // the registry didn't actually change (skips the setOpenProjects
  // re-render), and is resilient: a failure is caught and logged, never
  // thrown back into the event listener or allowed to take projectRoot's
  // own update down with it.
  useEffect(() => {
    if (platform.name !== 'tauri') return;

    let unlisten: (() => void) | null = null;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('project://changed', (event) => {
        // event.payload is project_set_active_inner's active_root() — the
        // same canonicalize() (verbatim-prefixed on Windows) origin as
        // registerProject/switchProject's entry.root/target.root above.
        // Normalize here too and also write the 'lazy.projectRoot' backstop
        // (previously only LAST_PROJECT_KEY was written on this path) so a
        // project activated behind AppContext's back (raw invoke, deep
        // link, future LazyManager tool) self-heals both keys the same way.
        const normalizedRoot = normalizeProjectRoot(event.payload);
        setProjectRoot(normalizedRoot);
        localStorage.setItem(LAST_PROJECT_KEY, normalizedRoot);
        localStorage.setItem('lazy.projectRoot', normalizedRoot);

        // Invalidate the resolveProjectRoot IPC cache so the next manager
        // turn / mission launch sees the new root instead of the stale one.
        invalidateProjectRootCache();

        refreshOpenProjects()
          .then(({ applied, entries }) => {
            // Same guard as closeProject/the boot effect above: `active` is
            // derived from `entries`, so a response that lost the sequencing
            // race must never be allowed to set activeProjectId either.
            if (!applied) return;
            const active = entries.find((entry) => entry.active) ?? null;
            setActiveProjectId(active?.id ?? null);
          })
          .catch((error: unknown) => {
            console.error('AppContext: failed to refresh openProjects after project://changed', error);
          });
      }).then((fn) => {
        unlisten = fn;
      }).catch(() => {});
    }).catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openProject = useCallback(async (): Promise<void> => {
    if (platform.name !== 'tauri') return;
    const { openFolder } = await import('../lib/platform/tauri');
    const path = await openFolder();
    if (!path) return;
    await registerProject(path);
  }, [platform.name, registerProject]);

  const value: AppContextValue = {
    activeSpace,
    platform,
    agentCount,
    projectRoot,
    openProjects,
    activeProjectId,
    projectsHydrated,
    settingsInitialTab,
    setActiveSpace,
    openProject,
    switchProject,
    registerProject,
    closeProject,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}
