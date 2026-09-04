/* canvasPersistence.ts — load/save of CanvasLayoutFileV1 and ChainsFileV1
   (W1a, plan §W1a; spec §6/§7; migrated to global storage by W3).

   GLOBAL PERSISTENCE (W3 fix for the W1a deviation documented below): both
   files now live at `<app_local_data_dir>/canvas/<key>.json` via two new
   Tauri commands (`canvas_state_load`/`canvas_state_save`,
   src-tauri/src/commands/canvas.rs), project-INDEPENDENT — exactly what
   spec §7 always asked for ("canvas/chains.json — global file keyed by no
   single project, chains may cross projects"). Every exported function
   below keeps its EXISTING `repoPath` parameter for source compatibility
   with CanvasView.tsx (W1c, not this wave's file) and every existing
   test/call site — but `repoPath` is no longer where the data is STORED;
   it is only consulted for the one-time legacy migration below.

   ── W1a's original deviation (kept here as history — no longer live) ──
   The spec's wording ("appData JSON") implied an OS-level, project-
   independent directory that did not exist on the TS side at W1a time —
   the only generic file-IO commands reachable from the frontend were
   sandboxed to the currently OPEN project root(s)
   (`ensure_write_path_in_any_open_project`, Rust fs.rs). W1a's workaround
   was to follow loopEngine.ts's exact per-project `.lazy/loops.json`
   pattern instead: `getPlatform().fs.readFile/writeFile/createDir` under
   the ACTIVE project's `.lazy/canvas/{layout,chains}.json`. This wave adds
   the missing Rust command pair (out of W1a's declared scope, flagged for
   orchestrator sign-off) and migrates onto it — see the "One-time
   migration" section below for how an existing per-project file is
   adopted rather than silently orphaned.

   Every export here degrades honestly instead of crashing:
     - non-Tauri platform (web/Playwright) -> pure no-op, defaults returned.
     - missing global file (first run, or first run after this wave ships)
       -> attempt the one-time legacy migration, else defaults.
     - corrupt global JSON (invalid JSON, or JSON that fails schema
       validation) -> logged, defaults returned, AND the corrupt file is
       immediately overwritten with a fresh defaults file (read+rewrite
       self-heal) so the SAME corruption is not re-hit on every future
       load. True quarantine-to-`.bak` (W1a's original per-project
       behavior) is not reproduced here: canvas_state_save/load's tiny,
       deliberately-narrow command surface (spec'd as a load/save pair
       keyed by an allowlist, nothing else) has no generic rename-in-
       appData-dir primitive to quarantine WITH — adding a THIRD command
       for that alone was judged out of scope for this wave; documented
       here rather than silently reproducing weaker behavior than W1a had.
     - corrupt LEGACY per-project file (met during migration) -> still
       quarantined to `.bak` exactly as W1a did (that path still goes
       through `getPlatform().fs`, unchanged).
     - any other read/write failure -> best-effort, swallowed (matches
       loopEngine.ts / objectivesStore.ts convention: a persistence failure
       must never crash the UI).
*/

import { invoke } from '@tauri-apps/api/core';
import type { StoreApi } from 'zustand';
import { getPlatform } from '../../../lib/platform';
import { joinPath } from '../../../lib/paths';
import {
  DEFAULT_CANVAS_PREFS,
  type CanvasLayoutFileV1,
  type CanvasPrefs,
  type Chain,
  type ChainsFileV1,
  type ContestSpec,
  type DraftSpec,
  type DraftVersion,
  type FrameSpec,
  type JoinSpec,
  type MacroSpec,
  type NodeRef,
  type NoteData,
  type RouterSpec,
  type SurfaceSpec,
} from './canvasTypes';
import type { CanvasState } from './canvasStore';

// ── Legacy per-project file layout (migration source only) ───────────

const CANVAS_DIR = '.lazy/canvas';
const LEGACY_LAYOUT_FILE_NAME = 'layout.json';
const LEGACY_CHAINS_FILE_NAME = 'chains.json';

function legacyLayoutFilePath(repoPath: string): string {
  return joinPath(repoPath, CANVAS_DIR, LEGACY_LAYOUT_FILE_NAME);
}

function legacyChainsFilePath(repoPath: string): string {
  return joinPath(repoPath, CANVAS_DIR, LEGACY_CHAINS_FILE_NAME);
}

// ── Defaults ───────────────────────────────────────────────────────

export function defaultCanvasLayout(): CanvasLayoutFileV1 {
  return {
    version: 1,
    positions: {},
    viewport: undefined,
    collapsed: {},
    prefs: DEFAULT_CANVAS_PREFS,
    notes: [],
  };
}

export function defaultCanvasChains(): ChainsFileV1 {
  return { version: 1, chains: [], drafts: [] };
}

// ── Empty-state predicates (BUG 1 defense-in-depth, W6f) ──────────────
//
// "Fully empty" mirrors canvasStore.ts's INITIAL_FACTS exactly (positions/
// collapsed/notes / chains/drafts) — the pre-hydrate default shape. Used
// ONLY by shouldSkipEmptyOverwrite below to recognize "this looks like a
// store that was never hydrated", never to reject a legitimate user
// clear-all (that path is allowed through via the `hydrated` opt — see
// saveCanvasLayout/saveCanvasChains).

function isEmptyCanvasLayout(layout: CanvasLayoutFileV1): boolean {
  return (
    Object.keys(layout.positions).length === 0 &&
    Object.keys(layout.collapsed).length === 0 &&
    layout.notes.length === 0 &&
    (layout.surfaces?.length ?? 0) === 0 &&
    Object.keys(layout.expandedPanels ?? {}).length === 0 &&
    (layout.frames?.length ?? 0) === 0 &&
    (layout.dismissedRefs?.length ?? 0) === 0
  );
}

function isEmptyChainsFile(chainsFile: ChainsFileV1): boolean {
  return (
    chainsFile.chains.length === 0 &&
    chainsFile.drafts.length === 0 &&
    (chainsFile.routers?.length ?? 0) === 0 &&
    (chainsFile.macros?.length ?? 0) === 0 &&
    (chainsFile.joins?.length ?? 0) === 0 &&
    (chainsFile.contests?.length ?? 0) === 0 &&
    Object.keys(chainsFile.draftVersions ?? {}).length === 0
  );
}

// ── Validation (never trust a file on disk) ──────────────────────────

/** Exported — see isNoteData's doc comment above. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isXYPosition(value: unknown): value is { x: number; y: number } {
  return isPlainObject(value) && typeof value.x === 'number' && typeof value.y === 'number';
}

/** Exported — see isNoteData's doc comment above. */
export function isPositionsRecord(value: unknown): value is Record<NodeRef, { x: number; y: number }> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isXYPosition);
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((v) => typeof v === 'boolean');
}

function isCanvasPrefs(value: unknown): value is CanvasPrefs {
  return (
    isPlainObject(value) &&
    typeof value.laneMode === 'boolean' &&
    typeof value.snap === 'boolean' &&
    typeof value.hideMerged === 'boolean' &&
    typeof value.minimap === 'boolean'
  );
}

/** Exported (W-CLOSE row 4, canvasExportImport.ts) — the export/import
 *  envelope reuses these SAME field-level validators rather than duplicating
 *  a second "never trust a file on disk" pass; zero behavior change here,
 *  only visibility. */
export function isNoteData(value: unknown): value is NoteData {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    (value.projectId === undefined || typeof value.projectId === 'string')
  );
}

/** W-DISMISS — dismissed-mission {@link NodeRef}s (canvasStore's
 *  `dismissedRefs` slice). A bare string array — never trust a persisted
 *  field un-narrowed (rules/common/coding-style.md's "validate at system
 *  boundaries"): only checks each entry is a string, same minimal-shape
 *  precedent `isJoinSpec`'s `sourceRefs` check already established (no
 *  dedicated per-ref kind/id parse here either). */
export function isNodeRefArray(value: unknown): value is NodeRef[] {
  return Array.isArray(value) && value.every((ref) => typeof ref === 'string');
}

/** W-CLOSE row 2/4 — frames (canvasStore's `frames` slice, canvasExportImport.ts's
 *  import validation). Exported for the same reasons as isNoteData above. */
export function isFrameSpec(value: unknown): value is FrameSpec {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    (value.projectId === undefined || typeof value.projectId === 'string')
  );
}

/** Exported — see isNoteData's doc comment above. */
export function isDraftSpec(value: unknown): value is DraftSpec {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.task === 'string' &&
    (value.agentName === undefined || typeof value.agentName === 'string') &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    (value.createdBy === 'user' || value.createdBy === 'manager' || value.createdBy === 'assistant')
  );
}

/** P-SEARCH — one search-history entry inside a surface's `searchSurface`
 *  (canvasTypes.ts's SearchHistoryEntry). Same minimal-shape discipline as
 *  isSurfaceSpec itself. */
function isSearchHistoryEntry(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.query === 'string' &&
    typeof value.atMs === 'number' &&
    Array.isArray(value.results) &&
    value.results.every(
      (r) =>
        isPlainObject(r) &&
        typeof r.title === 'string' &&
        typeof r.url === 'string' &&
        typeof r.snippet === 'string',
    )
  );
}

/** R7 — surface (terminal/preview) nodes (canvasStore's `surfaces` slice).
 *  Same minimal-shape discipline as isFrameSpec above. */
function isSurfaceSpec(value: unknown): value is SurfaceSpec {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'terminal' || value.kind === 'preview') &&
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    (value.cwd === undefined || typeof value.cwd === 'string') &&
    (value.url === undefined || typeof value.url === 'string') &&
    (value.ownerRef === undefined || typeof value.ownerRef === 'string') &&
    (value.width === undefined || typeof value.width === 'number') &&
    (value.height === undefined || typeof value.height === 'number') &&
    (value.autoAdded === undefined || typeof value.autoAdded === 'boolean') &&
    (value.refreshRequestedAtMs === undefined || typeof value.refreshRequestedAtMs === 'number') &&
    // P-SEARCH (additive) — see SurfaceSpec.searchSurface's own doc comment.
    (value.searchSurface === undefined ||
      (isPlainObject(value.searchSurface) &&
        (value.searchSurface.agentName === undefined || typeof value.searchSurface.agentName === 'string') &&
        (value.searchSurface.pendingQuery === undefined || typeof value.searchSurface.pendingQuery === 'string') &&
        Array.isArray(value.searchSurface.history) &&
        value.searchSurface.history.every(isSearchHistoryEntry)))
  );
}

/** R7 — expanded panels record (canvasStore's `expandedPanels` slice). */
function isExpandedPanelsRecord(value: unknown): value is Record<string, { width: number; height: number }> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(
    (v) => isPlainObject(v) && typeof v.width === 'number' && typeof v.height === 'number',
  );
}

/** W8c — router nodes (canvasStore's `routers` slice in ChainsFileV1).
 *  Same minimal-shape discipline as isJoinSpec above. */
function isRouterSpec(value: unknown): value is RouterSpec {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    Array.isArray(value.branches) &&
    value.branches.every(
      (b) =>
        isPlainObject(b) &&
        typeof b.id === 'string' &&
        typeof b.label === 'string' &&
        isPlainObject(b.condition) &&
        typeof b.condition.kind === 'string',
    )
  );
}

/** W-JOIN — join (fan-in) nodes (canvasStore's `joins` slice,
 *  canvasExportImport.ts's import validation). Exported for the same
 *  reasons as isNoteData above. Deliberately as minimal as isRouterSpecLike
 *  (canvasExportImport.ts) — no dedicated per-item sourceRefs validator
 *  beyond "is a string array" exists yet, same established precedent. */
export function isJoinSpec(value: unknown): value is JoinSpec {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    (value.mode === 'all_success' || value.mode === 'all_settled') &&
    Array.isArray(value.sourceRefs) &&
    value.sourceRefs.every((ref) => typeof ref === 'string')
  );
}

/** W-CONTEST — best-of-N contests (canvasStore's `contests` slice,
 *  canvasExportImport.ts's import validation). Exported for the same
 *  reasons as isNoteData above. */
export function isContestSpec(value: unknown): value is ContestSpec {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.draftTemplateId === 'string' &&
    Array.isArray(value.missionIds) &&
    value.missionIds.every((id) => typeof id === 'string') &&
    (value.status === 'running' || value.status === 'completed') &&
    typeof value.createdAtMs === 'number' &&
    (value.winnerId === undefined || typeof value.winnerId === 'string')
  );
}

/** Exported — see isNoteData's doc comment above. */
export function isChain(value: unknown): value is Chain {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.sourceRef === 'string' &&
    typeof value.targetRef === 'string' &&
    (value.condition === 'success' || value.condition === 'fail' || value.condition === 'always') &&
    (value.createdBy === 'user' || value.createdBy === 'manager') &&
    (value.disabled === undefined || typeof value.disabled === 'boolean') &&
    // chainEngine.ts's exactly-once high-water mark (canvasTypes.ts's
    // Chain.lastFiredAtMs doc comment) — optional so a chains.json written
    // before this wave still validates.
    (value.lastFiredAtMs === undefined || typeof value.lastFiredAtMs === 'number')
  );
}

/** Validates a parsed JSON value against {@link CanvasLayoutFileV1}'s v1
 *  schema. Forward-compat note: an unknown `version` is treated as invalid
 *  (defaults returned) rather than guessed at — no v2 schema exists yet to
 *  migrate from. Deliberately permissive of UNKNOWN extra top-level keys
 *  (e.g. this file's own `migratedFrom` marker, see below) — only the
 *  fields this schema actually declares are checked. */
export function isCanvasLayoutFileV1(value: unknown): value is CanvasLayoutFileV1 {
  if (!isPlainObject(value)) return false;
  if (value.version !== 1) return false;
  if (!isPositionsRecord(value.positions)) return false;
  if (value.viewport !== undefined && !isXYPosition(value.viewport)) return false;
  if (value.viewport !== undefined && typeof (value.viewport as Record<string, unknown>).zoom !== 'number') return false;
  if (!isBooleanRecord(value.collapsed)) return false;
  if (!isCanvasPrefs(value.prefs)) return false;
  if (!Array.isArray(value.notes) || !value.notes.every(isNoteData)) return false;
  // dismissedRefs (W-DISMISS, additive) — same "absent is valid, only
  // checked when present" rule as every other additive field this schema
  // never widened a hard requirement for.
  if (value.dismissedRefs !== undefined && !isNodeRefArray(value.dismissedRefs)) return false;
  // R7 (additive) — surfaces: optional, validated when present.
  if (value.surfaces !== undefined && (!Array.isArray(value.surfaces) || !value.surfaces.every(isSurfaceSpec))) return false;
  // R7 (additive) — expandedPanels: optional, validated when present.
  if (value.expandedPanels !== undefined && !isExpandedPanelsRecord(value.expandedPanels)) return false;
  // W-CLOSE row 2 (additive) — frames: optional, validated when present.
  if (value.frames !== undefined && (!Array.isArray(value.frames) || !value.frames.every(isFrameSpec))) return false;
  return true;
}

/** Group macros — tolerant of extra/future fields on the drafts/routers/
 *  notes/chains it embeds (same discipline as isDraftSpec/isChain above):
 *  only the fields THIS schema version declares are checked. */
/** Exported — see isNoteData's doc comment above. */
export function isMacroSpec(value: unknown): value is MacroSpec {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.description === undefined || typeof value.description === 'string') &&
    Array.isArray(value.drafts) &&
    value.drafts.every(isDraftSpec) &&
    Array.isArray(value.routers) &&
    Array.isArray(value.notes) &&
    value.notes.every(isNoteData) &&
    Array.isArray(value.chains) &&
    value.chains.every(isChain) &&
    isPositionsRecord(value.positions) &&
    typeof value.createdAtMs === 'number'
  );
}

function isDraftVersion(value: unknown): value is DraftVersion {
  return (
    isPlainObject(value) &&
    typeof value.ts === 'number' &&
    typeof value.title === 'string' &&
    typeof value.task === 'string' &&
    (value.model === undefined || typeof value.model === 'string') &&
    (value.agentName === undefined || typeof value.agentName === 'string')
  );
}

function isDraftVersionsRecord(value: unknown): value is Record<string, DraftVersion[]> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((v) => Array.isArray(v) && v.every(isDraftVersion));
}

export function isChainsFileV1(value: unknown): value is ChainsFileV1 {
  if (!isPlainObject(value)) return false;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.chains) || !value.chains.every(isChain)) return false;
  if (!Array.isArray(value.drafts) || !value.drafts.every(isDraftSpec)) return false;
  // macros/draftVersions (additive, optional — same "absent is valid" rule
  // as `routers` above, which this schema also never validates the shape
  // of): only checked when PRESENT, so a chains.json written before either
  // field existed still validates unchanged.
  if (value.macros !== undefined && (!Array.isArray(value.macros) || !value.macros.every(isMacroSpec))) return false;
  if (value.draftVersions !== undefined && !isDraftVersionsRecord(value.draftVersions)) return false;
  // joins (W-JOIN, additive) — same "absent is valid, only checked when
  // present" rule as macros/draftVersions above.
  if (value.joins !== undefined && (!Array.isArray(value.joins) || !value.joins.every(isJoinSpec))) return false;
  // contests (W-CONTEST, additive) — same "absent is valid, only checked
  // when present" rule as joins above.
  if (value.contests !== undefined && (!Array.isArray(value.contests) || !value.contests.every(isContestSpec))) return false;
  // routers (W8c, additive) — same "absent is valid, only checked when
  // present" rule as joins/contests above.
  if (value.routers !== undefined && (!Array.isArray(value.routers) || !value.routers.every(isRouterSpec))) return false;
  return true;
}

// ── Global command wrappers (canvas_state_load/save) ─────────────────

/** Exported for useCanvasHydration.ts (BUG 1 fix, W6f): the persistence
 *  boot must hydrate unconditionally with respect to `activeRoot` (see that
 *  hook's own doc comment) but NOT unconditionally with respect to platform
 *  — outside Tauri there is no real global file to load (every load/save
 *  below already short-circuits to defaults/no-op here), and canvas-harness
 *  .tsx's screenshot fixture relies EXACTLY on hydrate() never touching a
 *  pre-seeded canvasStoreVanilla outside a real Tauri runtime. */
export function isTauriPlatform(): boolean {
  return getPlatform().name === 'tauri';
}

type CanvasStateKey = 'layout' | 'chains';

/** Never throws: an invoke failure is logged and treated as "no state" —
 *  matches every other Tauri-invoke wrapper in this codebase (journal.ts,
 *  missionsProjection.ts) — a persistence hiccup must degrade to defaults,
 *  never crash the canvas. */
async function invokeCanvasStateLoad(key: CanvasStateKey): Promise<string | null> {
  try {
    const raw = await invoke<string | null>('canvas_state_load', { key });
    return raw ?? null;
  } catch (err: unknown) {
    console.warn(`[canvasPersistence] canvas_state_load('${key}') failed:`, err);
    return null;
  }
}

async function invokeCanvasStateSave(key: CanvasStateKey, json: string): Promise<void> {
  try {
    await invoke('canvas_state_save', { key, json });
  } catch (err: unknown) {
    console.warn(`[canvasPersistence] canvas_state_save('${key}') failed:`, err);
  }
}

// ── Legacy per-project read (migration source + its own quarantine) ──
//
// Unchanged from W1a except renamed to make clear these are ONLY consulted
// as a one-time migration source now, never the live storage path.

async function quarantineCorruptLegacyFile(filePath: string): Promise<void> {
  try {
    await getPlatform().fs.rename(filePath, `${filePath}.bak`);
  } catch {
    // best-effort — the caller already has defaults/no-migration to fall back on
  }
}

async function loadLegacyJsonFile<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await getPlatform().fs.readFile(filePath);
  } catch {
    return null; // missing file — nothing to migrate
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorruptLegacyFile(filePath);
    return null;
  }

  if (!validate(parsed)) {
    await quarantineCorruptLegacyFile(filePath);
    return null;
  }

  return parsed;
}

// ── One-time migration (W3) ────────────────────────────────────────
//
// "if global file absent but the ACTIVE project has legacy
// .lazy/canvas/*.json, load it as the initial global state (keep the
// legacy file, add a migratedFrom note in the new file)" — the legacy file
// is intentionally NEVER deleted (a user who somehow ends up back on an
// older build must not lose it), and the migration only ever runs while
// the GLOBAL file is absent — once written (even from an empty default,
// see loadGlobalOrMigrate below), it never re-triggers, so a second open
// project's legacy file is never spuriously merged in later.

/** `migratedFrom` is intentionally NOT part of canvasTypes.ts's frozen
 *  `CanvasLayoutFileV1`/`ChainsFileV1` schemas (this wave's contract change
 *  budget was spent entirely on `Chain.lastFiredAtMs`) — it is a
 *  disk-only marker this module adds/strips locally, invisible to every
 *  other consumer of those types (canvasStore.hydrate, the reconciler,
 *  every node/edge component). `isCanvasLayoutFileV1`/`isChainsFileV1`
 *  accept it unbothered since they only check for the fields they declare,
 *  never reject unknown extras. */
type WithMigrationMarker<T> = T & { migratedFrom?: string };

async function loadGlobalOrMigrate<T extends object>(
  key: CanvasStateKey,
  repoPath: string,
  loadLegacy: (repoPath: string) => Promise<T | null>,
  defaults: () => T,
  validate: (value: unknown) => value is T,
): Promise<T> {
  const globalRaw = await invokeCanvasStateLoad(key);

  if (globalRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(globalRaw);
    } catch (err: unknown) {
      console.warn(`[canvasPersistence] corrupt global '${key}.json' (invalid JSON), resetting to defaults:`, err);
      const fresh = defaults();
      await invokeCanvasStateSave(key, JSON.stringify(fresh)); // self-heal (see module header)
      return fresh;
    }
    if (!validate(parsed)) {
      console.warn(`[canvasPersistence] corrupt global '${key}.json' (schema mismatch), resetting to defaults`);
      const fresh = defaults();
      await invokeCanvasStateSave(key, JSON.stringify(fresh));
      return fresh;
    }
    return parsed;
  }

  // Global file absent: attempt the one-time legacy migration, then WRITE
  // the global file regardless (even a bare defaults()) so this branch
  // never runs again for this key.
  const legacy = repoPath ? await loadLegacy(repoPath) : null;
  const initial: T = legacy ?? defaults();
  const withMarker: WithMigrationMarker<T> = legacy
    ? { ...initial, migratedFrom: repoPath }
    : initial;
  await invokeCanvasStateSave(key, JSON.stringify(withMarker));
  return initial;
}

// ── Empty-overwrite guard (BUG 1 defense-in-depth, W6f) ───────────────
//
// Real-app repro (W6e): useCanvasHydration.ts's boot effect used to SKIP
// hydration entirely when `activeRoot` was null at mount (a common cold-boot
// race — the project registry hydrates async) but still armed the debounced
// autosave subscription unconditionally. The very next store change wrote
// the pre-hydrate EMPTY store over the real global canvas/{layout,chains}
// .json files — observed going from 2 drafts+1 chain to nothing.
//
// useCanvasHydration.ts's fix (never arm the subscription before hydrate()
// has actually run, and hydrate unconditionally regardless of `repoPath`)
// closes the bug structurally. This guard is the belt-and-suspenders layer
// UNDER that fix, living at the actual save boundary so it protects against
// ANY future caller — not just this one — accidentally reintroducing the
// same shape of bug: refuse to overwrite a stored file that currently has
// real content with a fully-EMPTY state, unless the caller explicitly
// proves (via `opts.hydrated`) that the empty state is a genuine, intentional
// result of a real hydrate/user action. Defaults to `true` so every existing
// direct call site (tests, any explicit one-off save) is completely
// unaffected — only subscribeCanvasAutosave's own debounced save threads the
// real flag through.
async function shouldSkipEmptyOverwrite<T extends object>(
  key: CanvasStateKey,
  data: T,
  isEmpty: (value: T) => boolean,
  validate: (value: unknown) => value is T,
  hydrated: boolean | undefined,
): Promise<boolean> {
  if (hydrated !== false) return false; // trusted caller (default) or hydration genuinely happened
  if (!isEmpty(data)) return false; // not the destructive shape this guard exists for
  const currentRaw = await invokeCanvasStateLoad(key);
  if (currentRaw === null) return false; // nothing stored yet — an empty write is harmless
  let current: unknown;
  try {
    current = JSON.parse(currentRaw);
  } catch {
    return false; // stored file is already corrupt — not this guard's concern
  }
  if (!validate(current) || isEmpty(current)) return false; // stored file is itself empty/invalid already
  console.warn(
    `[canvasPersistence] BLOCKED an autosave that would have overwritten a non-empty '${key}.json' with an empty, not-yet-hydrated state — see useCanvasHydration.ts's BUG 1 guard (W6f)`,
  );
  return true;
}

/** Threaded through from callers that can genuinely prove hydration state —
 *  see shouldSkipEmptyOverwrite's doc comment above. */
export interface SaveGuardOpts {
  hydrated?: boolean;
}

// ── Public API (signatures unchanged from W1a for CanvasView.tsx / tests) ──

export async function loadCanvasLayout(repoPath: string): Promise<CanvasLayoutFileV1> {
  if (!isTauriPlatform()) return defaultCanvasLayout();
  return loadGlobalOrMigrate(
    'layout',
    repoPath,
    (root) => loadLegacyJsonFile(legacyLayoutFilePath(root), isCanvasLayoutFileV1),
    defaultCanvasLayout,
    isCanvasLayoutFileV1,
  );
}

export async function saveCanvasLayout(repoPath: string, data: CanvasLayoutFileV1, opts: SaveGuardOpts = {}): Promise<void> {
  if (!isTauriPlatform()) return;
  if (await shouldSkipEmptyOverwrite('layout', data, isEmptyCanvasLayout, isCanvasLayoutFileV1, opts.hydrated)) return;
  await invokeCanvasStateSave('layout', JSON.stringify(data));
  void repoPath; // kept for signature compatibility — storage is global now (see module header)
}

export async function loadCanvasChains(repoPath: string): Promise<ChainsFileV1> {
  if (!isTauriPlatform()) return defaultCanvasChains();
  return loadGlobalOrMigrate(
    'chains',
    repoPath,
    (root) => loadLegacyJsonFile(legacyChainsFilePath(root), isChainsFileV1),
    defaultCanvasChains,
    isChainsFileV1,
  );
}

export async function saveCanvasChains(repoPath: string, data: ChainsFileV1, opts: SaveGuardOpts = {}): Promise<void> {
  if (!isTauriPlatform()) return;
  if (await shouldSkipEmptyOverwrite('chains', data, isEmptyChainsFile, isChainsFileV1, opts.hydrated)) return;
  await invokeCanvasStateSave('chains', JSON.stringify(data));
  void repoPath; // kept for signature compatibility — storage is global now (see module header)
}

/** Convenience — loads both files in parallel, ready to feed straight into
 *  `canvasStore`'s `hydrate(layout, chainsFile)` action. `repoPath` is only
 *  used as the one-time migration source (see module header) — pass the
 *  active project's root exactly as CanvasView.tsx already does; a `null`/
 *  empty root simply skips migration and returns global-or-defaults. */
export async function loadCanvasPersisted(
  repoPath: string,
): Promise<{ layout: CanvasLayoutFileV1; chainsFile: ChainsFileV1 }> {
  const [layout, chainsFile] = await Promise.all([loadCanvasLayout(repoPath), loadCanvasChains(repoPath)]);
  return { layout, chainsFile };
}

/**
 * Global save, bypassing the debounced autosave subscription — chainEngine
 * (W3) calls this directly right after `canvasStore.markChainFired()` so
 * the exactly-once high-water mark (`Chain.lastFiredAtMs`) hits disk
 * immediately instead of riding the 500ms `subscribeCanvasAutosave` window,
 * closing the same "advance bookkeeping before anything can race it" gap
 * loopScheduler.ts's `markIterationFired` fix closes for loops. No-op
 * outside Tauri, best-effort (never throws) — same convention as every
 * other save in this module.
 */
export async function saveCanvasChainsGlobal(data: ChainsFileV1): Promise<void> {
  if (!isTauriPlatform()) return;
  await invokeCanvasStateSave('chains', JSON.stringify(data));
}

// ── Debounce helper (500ms, flush-able) ───────────────────────────

interface Debounced<Args extends unknown[]> {
  call: (...args: Args) => void;
  /** Runs the pending call synchronously now, if one is scheduled. */
  flush: () => void;
  /** Drops any pending call without running it. */
  cancel: () => void;
}

function debounce<Args extends unknown[]>(fn: (...args: Args) => void, waitMs: number): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Args | null = null;

  function runPending(): void {
    if (pendingArgs === null) return;
    const args = pendingArgs;
    pendingArgs = null;
    fn(...args);
  }

  return {
    call(...args: Args) {
      pendingArgs = args;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        runPending();
      }, waitMs);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      runPending();
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingArgs = null;
    },
  };
}

const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * Wires `canvasStore`'s vanilla store to debounced disk autosave. W1c calls
 * this exactly ONCE (see plan's file-ownership map / this wave's report
 * "seams" section) after the store has been hydrated, passing a getter for
 * the current active project's root (kept for signature compatibility —
 * see this file's header: storage itself is global since W3, `getRepoPath`
 * is no longer consulted by the save calls below, only historically used
 * to scope them). Returns a single dispose function that unsubscribes,
 * cancels any pending debounced save, and removes the visibilitychange
 * listener.
 *
 * "Flush on hide" (task requirement): a `visibilitychange` listener flushes
 * any pending debounced save immediately when the document becomes hidden
 * (tab switch, app minimize, close) so a save never gets lost to the
 * 500ms window.
 *
 * `isHydrated` (BUG 1 fix, W6f): the CALLER's proof that a real hydrate()
 * has run before this subscription may be trusted to write real data.
 * useCanvasHydration.ts's own fix is to never even CALL this function until
 * its boot() effect has hydrated the store — so in normal operation this is
 * always `() => true` by the time it's invoked. It defaults to `() => true`
 * here too (every existing call site, including every test, keeps behaving
 * exactly as before) — it exists so the flag can still reach
 * canvasPersistence.ts's own empty-overwrite guard (saveCanvasLayout/
 * saveCanvasChains's `hydrated` opt) as a second, independent layer, in case
 * some future change ever re-arms this subscription earlier again.
 */
export function subscribeCanvasAutosave(
  store: StoreApi<CanvasState>,
  getRepoPath: () => string | null,
  debounceMs: number = AUTOSAVE_DEBOUNCE_MS,
  isHydrated: () => boolean = () => true,
): () => void {
  const debounced = debounce((state: CanvasState) => {
    const repoPath = getRepoPath();
    if (!repoPath) return; // no active project — nothing to persist against
    const hydrated = isHydrated();
    const layout: CanvasLayoutFileV1 = {
      version: 1,
      positions: state.positions,
      viewport: state.viewport,
      collapsed: state.collapsed,
      prefs: state.prefs,
      notes: state.notes,
      // R7 (additive, fix/canvas-ux living-surfaces wave) — same "include it
      // in the debounced save shape" fix `routers` already needed below:
      // canvasStore.ts's `surfaces`/`expandedPanels` are real tracked facts
      // (see that file's own doc comments) that would otherwise never reach
      // disk despite existing in-memory.
      surfaces: state.surfaces,
      expandedPanels: state.expandedPanels,
      // W-CLOSE row 2 (additive) — same "must be in the debounced save shape"
      // fix `surfaces` already needed above: omitting it here would silently
      // drop every frame on the very next autosave tick despite existing
      // in-memory.
      frames: state.frames,
      // W-DISMISS (additive) — same "must be in the debounced save shape"
      // fix `frames` already needed above: omitting it here would silently
      // drop every dismissed mission on the very next autosave tick despite
      // existing in-memory.
      dismissedRefs: state.dismissedRefs,
    };
    // `routers` included (W9 fix — see CanvasFacts.routers's own doc
    // comment in canvasStore.ts, and chainEngine.ts's `consume()`, which
    // already included it in its OWN direct save): a router add/edit made
    // ONLY through the palette/context-menu (never through a chain firing,
    // which is the sole path that used to reach persistence) previously
    // never survived an app restart — this was the flagged gap.
    // `macros`/`draftVersions` included (same "must be in the debounced save
    // shape" fix `routers` already needed — see that field's own comment
    // above): omitting them here would silently drop every saved macro and
    // every draft's edit history on the very next autosave tick despite
    // existing in-memory.
    // `joins` included (W-JOIN — same "must be in the debounced save shape"
    // fix `routers` already needed above): omitting it here would silently
    // drop every join add/edit made ONLY through the palette/context-menu
    // (never through a chain firing) on the very next autosave tick.
    // `contests` included (W-CONTEST — same "must be in the debounced save
    // shape" fix `joins` already needed above): omitting it here would
    // silently drop every contest launched via the context menu on the very
    // next autosave tick despite existing in-memory.
    const chainsFile: ChainsFileV1 = {
      version: 1,
      chains: state.chains,
      drafts: state.drafts,
      routers: state.routers,
      joins: state.joins,
      macros: state.macros,
      draftVersions: state.draftVersions,
      contests: state.contests,
    };
    void saveCanvasLayout(repoPath, layout, { hydrated });
    void saveCanvasChains(repoPath, chainsFile, { hydrated });
  }, debounceMs);

  const unsubscribe = store.subscribe((state) => {
    debounced.call(state);
  });

  function handleVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      debounced.flush();
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  return () => {
    unsubscribe();
    // P1 fix: flush (not cancel) any pending debounced save so the last
    // canvas state change before unmount is persisted rather than dropped.
    debounced.flush();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  };
}
