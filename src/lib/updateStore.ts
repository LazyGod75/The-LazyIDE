/* updateStore.ts — single source of truth for auto-update UI state.

   Plain module-level store (zustand-style: getState + subscribe, no
   Context/Provider, no state library added) — mirrors
   src/lib/brain/seedProgressStore.ts and src/lib/agents/canvas/chrome/
   chipVisibilityStore.ts exactly. Every write replaces `_state` with a new
   object (never mutated in place); `useUpdateStore()` reads that same
   reference via useSyncExternalStore, which is why getUpdateState() must
   NOT spread-copy — a fresh object identity on every call would make
   useSyncExternalStore re-render (or warn about an unstable snapshot) even
   when nothing changed.

   Rust (src-tauri/src/updater_service.rs) owns autoUpdate / staged /
   lastCheckAt / ignoredVersion persistence (`<data_dir>/updates/state.json`)
   — this store only caches that state for the UI and layers two purely
   client-side concerns on top:
     1. dedup guards so two surfaces (Settings, the badge, the background
        service) calling check()/download() at the same time never fire two
        concurrent network round-trips (AUTOUPDATE-SPEC.md B.2);
     2. the "toast shown for version X" flag, which is UI presentation state
        that has no reason to live in Rust (AUTOUPDATE-SPEC.md B.2's
        "Persistance côté UI (localStorage) uniquement pour toastShownFor").

   Scheduling (periodic re-check interval + jitter, error backoff, the
   focus-recheck threshold) is exposed as PURE functions
   (nextCheckDelayMs/shouldRecheckOnFocus below) rather than setTimeout
   calls hidden in here — the component that owns the actual timers
   (UpdaterService.tsx, AUTOUPDATE-SPEC.md B.3) calls these to decide when
   to fire, keeping the scheduling math independently unit-testable. */

import { useSyncExternalStore } from 'react';
import { isTauri } from './platform/index.js';
import { errorMessage } from './errorMessage.js';
import {
  checkForUpdate,
  downloadUpdate,
  getUpdaterState,
  setAutoUpdate,
  ignoreUpdateVersion,
  restartAndApplyUpdate,
  onDownloadProgress,
  onStaged,
  type UpdaterCheckResult,
  type DownloadProgressEvent,
  type StagedEvent,
} from './updater.js';

// ── Public state shape ──────────────────────────────────────────────

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'staged' | 'error';

export interface UpdateDownloadProgress {
  downloaded: number;
  total: number | null;
}

export interface UpdateStoreState {
  phase: UpdatePhase;
  version?: string;
  notes?: string;
  progress?: UpdateDownloadProgress;
  autoUpdate: boolean;
  lastCheckAt: string | null;
  lastError: string | null;
  /** Version the user explicitly dismissed via ignoreVersion() — mirrors
   *  Rust's `updater_state.ignoredVersion` (not listed among the spec's
   *  minimal state fields, but required for the background service to
   *  decide "available and NOT ignored" before auto-downloading; see B.3). */
  ignoredVersion: string | null;
  /** Consecutive check()/download() failures since the last success — the
   *  input to the error-backoff schedule (errorBackoffDelayMs below).
   *  Reset to 0 by any successful check or download. */
  errorStreak: number;
}

const INITIAL_STATE: UpdateStoreState = {
  phase: 'idle',
  autoUpdate: true,
  lastCheckAt: null,
  lastError: null,
  ignoredVersion: null,
  errorStreak: 0,
};

type Listener = () => void;

let _state: UpdateStoreState = INITIAL_STATE;
const _listeners = new Set<Listener>();

function notify(): void {
  for (const listener of _listeners) listener();
}

function setState(patch: Partial<UpdateStoreState>): void {
  _state = { ..._state, ...patch };
  notify();
}

/** Current snapshot. Never mutate the returned object — every state change
 *  goes through setState(), which always produces a new reference. */
export function getUpdateState(): Readonly<UpdateStoreState> {
  return _state;
}

export function subscribeUpdateStore(listener: Listener): () => void {
  ensureInit();
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Lazy init: hydrate from Rust + subscribe to the two updater:// events,
// exactly once per app session (mirrors systemPressure.ts's ensureInit) ──

let _initialized = false;
let _unlistenProgress: (() => void) | null = null;
let _unlistenStaged: (() => void) | null = null;

function ensureInit(): void {
  if (_initialized) return;
  _initialized = true;
  if (!isTauri()) return;

  onDownloadProgress(handleDownloadProgress)
    .then((unlisten) => { _unlistenProgress = unlisten; })
    .catch(() => { /* event system unavailable — stays at whatever phase check()/download() set */ });

  onStaged(handleStaged)
    .then((unlisten) => { _unlistenStaged = unlisten; })
    .catch(() => { /* same as above */ });

  void hydrateFromRust();
}

function handleDownloadProgress(event: DownloadProgressEvent): void {
  setState({ phase: 'downloading', progress: event });
}

function handleStaged(event: StagedEvent): void {
  setState({
    phase: 'staged',
    version: event.version,
    progress: undefined,
    lastError: null,
    errorStreak: 0,
  });
}

async function hydrateFromRust(): Promise<void> {
  try {
    const remote = await getUpdaterState();
    if (!remote) return; // outside Tauri — checkForUpdate etc. already no-op
    setState({
      autoUpdate: remote.autoUpdate,
      lastCheckAt: remote.lastCheckAt,
      lastError: remote.lastError,
      ignoredVersion: remote.ignoredVersion,
      phase: remote.staged ? 'staged' : _state.phase,
      version: remote.staged ? remote.staged.version : _state.version,
      // Rust's StagedOut.notes is nullable on the wire (see StagedUpdateInfo
      // in updater.ts) — normalized to undefined here to match this store's
      // own `notes?: string` convention.
      notes: remote.staged ? remote.staged.notes ?? undefined : _state.notes,
    });
  } catch (err: unknown) {
    // Best-effort hydration only — a stale/default store is safe (the next
    // explicit check() still works), but log so a genuine regression is
    // diagnosable instead of silently vanishing.
    console.warn('[updateStore] hydrateFromRust failed:', err instanceof Error ? err.message : String(err));
  }
}

// ── Actions ──────────────────────────────────────────────────────────

let _checkPromise: Promise<void> | null = null;

/** Checks for an update. Never runs two checks concurrently — a second
 *  caller while one is already in flight awaits the SAME promise instead of
 *  firing a second network round-trip (AUTOUPDATE-SPEC.md B.2). */
export function check(): Promise<void> {
  ensureInit();
  if (_checkPromise) return _checkPromise;
  _checkPromise = performCheck().finally(() => {
    _checkPromise = null;
  });
  return _checkPromise;
}

async function performCheck(): Promise<void> {
  setState({ phase: 'checking' });
  let result: UpdaterCheckResult | null;
  try {
    result = await checkForUpdate();
  } catch (err: unknown) {
    applyFailure(err);
    return;
  }
  if (result === null) {
    // Outside Tauri (web/test) — nothing to report; return to idle so a
    // caller that rendered a "checking" spinner does not hang forever.
    setState({ phase: 'idle' });
    return;
  }
  applyCheckResult(result);
}

function applyCheckResult(result: UpdaterCheckResult): void {
  const lastCheckAt = new Date().toISOString();
  if (result.status === 'error') {
    setState({
      phase: 'error',
      lastError: result.message ?? 'unknown error',
      lastCheckAt,
      errorStreak: _state.errorStreak + 1,
    });
    return;
  }
  if (result.status === 'available') {
    setState({
      phase: 'available',
      version: result.version,
      notes: result.notes,
      lastCheckAt,
      lastError: null,
      errorStreak: 0,
    });
    return;
  }
  setState({
    phase: 'idle',
    version: undefined,
    notes: undefined,
    lastCheckAt,
    lastError: null,
    errorStreak: 0,
  });
}

let _downloadPromise: Promise<void> | null = null;

/** Downloads (and stages) the currently available update. Same
 *  never-two-in-flight guard as check(); Rust also guards this on its side
 *  (a Mutex/AtomicBool per A.4), this is the client-side half of that
 *  contract so a caller never even fires the redundant IPC call. */
export function download(): Promise<void> {
  ensureInit();
  if (_downloadPromise) return _downloadPromise;
  _downloadPromise = performDownload().finally(() => {
    _downloadPromise = null;
  });
  return _downloadPromise;
}

async function performDownload(): Promise<void> {
  setState({ phase: 'downloading', progress: undefined });
  try {
    const result = await downloadUpdate();
    if (result === null) {
      setState({ phase: 'idle' }); // outside Tauri
      return;
    }
    // The updater://staged event (handleStaged) normally lands first/at the
    // same time, but reconcile explicitly here too so a build that emits
    // the event without this resolving cleanly (or vice versa) still ends
    // in the right state.
    setState({
      phase: 'staged',
      version: result.version,
      progress: undefined,
      lastError: null,
      errorStreak: 0,
    });
  } catch (err: unknown) {
    applyFailure(err);
  }
}

function applyFailure(err: unknown): void {
  const message = errorMessage(err);
  console.warn('[updateStore] operation failed:', message);
  setState({
    phase: 'error',
    lastError: message,
    lastCheckAt: new Date().toISOString(),
    errorStreak: _state.errorStreak + 1,
  });
}

/** Restarts the app to apply a staged update. On failure the update stays
 *  staged on disk (it will still apply on the user's next manual restart)
 *  — surfaced as an error rather than silently doing nothing. */
export async function restartAndApply(): Promise<void> {
  try {
    await restartAndApplyUpdate();
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn('[updateStore] restartAndApply failed:', message);
    setState({ lastError: message });
  }
}

/** Toggles the autoUpdate policy. Optimistic (flips immediately so the
 *  Settings toggle feels instant) with rollback if the Rust write fails. */
export async function setAuto(enabled: boolean): Promise<void> {
  const previous = _state.autoUpdate;
  setState({ autoUpdate: enabled });
  try {
    await setAutoUpdate(enabled);
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn('[updateStore] setAuto failed:', message);
    setState({ autoUpdate: previous, lastError: message });
  }
}

/** Dismisses a version so the background service stops auto-downloading it
 *  and the badge/toast stop nagging about it. If it is the currently
 *  available/staged version, also clears it from view immediately rather
 *  than waiting for the next check() to notice. */
export async function ignoreVersion(version: string): Promise<void> {
  const isCurrent = _state.version === version;
  const patch: Partial<UpdateStoreState> = isCurrent
    ? { ignoredVersion: version, phase: 'idle', version: undefined, notes: undefined }
    : { ignoredVersion: version };
  setState(patch);
  try {
    await ignoreUpdateVersion(version);
  } catch (err: unknown) {
    const message = errorMessage(err);
    console.warn('[updateStore] ignoreVersion failed:', message);
    setState({ lastError: message });
  }
}

// ── React hook: state + bound actions combined ──────────────────────

export interface UpdateStoreValue extends UpdateStoreState {
  check(): Promise<void>;
  download(): Promise<void>;
  restartAndApply(): Promise<void>;
  setAuto(enabled: boolean): Promise<void>;
  ignoreVersion(version: string): Promise<void>;
}

/** React hook: every surface (Settings, the badge, the background service)
 *  reads from the same single store this way, getting both the live state
 *  AND the bound action methods off one object — so a caller writes
 *  `store.check()` / `store.phase` without a second import for the actions.
 *  The action methods are the SAME module-level singletons every render
 *  (check/download/... above), only the returned wrapper object itself is
 *  rebuilt each render — that's fine, only useSyncExternalStore's own
 *  getSnapshot (getUpdateState) needs a stable reference. */
export function useUpdateStore(): UpdateStoreValue {
  ensureInit();
  const state = useSyncExternalStore(subscribeUpdateStore, getUpdateState);
  return { ...state, check, download, restartAndApply, setAuto, ignoreVersion };
}

// ── Toast-shown-once persistence (UI-only; see this file's header) ─────

const TOAST_SHOWN_STORAGE_KEY = 'lazy.updater.toastShownFor';

/** True once a "update ready" toast has already been shown for this exact
 *  version — only the most recent version is remembered (matches the
 *  spec's singular `toastShownFor: version`), so re-ignoring/re-staging an
 *  older version after a newer one shows its own toast again. */
export function hasShownStagedToast(version: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(TOAST_SHOWN_STORAGE_KEY) === version;
  } catch {
    return false;
  }
}

export function markStagedToastShown(version: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(TOAST_SHOWN_STORAGE_KEY, version);
  } catch {
    // best-effort — a storage failure must not break the UI
  }
}

// ── Pure scheduling functions (AUTOUPDATE-SPEC.md B.3) — the component
// that owns the actual setTimeout calls uses these; nothing in this file
// starts a timer itself. ────────────────────────────────────────────

/** Base periodic re-check interval, before jitter. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h

/** Jitter applied symmetrically around CHECK_INTERVAL_MS (+/-25%), so many
 *  installs don't all hit the update endpoint at the same moment. */
export const CHECK_INTERVAL_JITTER_RATIO = 0.25;

/** First error-backoff delay. */
export const ERROR_BACKOFF_BASE_MS = 15 * 60 * 1000; // 15min

/** Error-backoff multiplier applied per consecutive failure. */
export const ERROR_BACKOFF_MULTIPLIER = 2;

/** Error-backoff ceiling. */
export const ERROR_BACKOFF_MAX_MS = 4 * 60 * 60 * 1000; // 4h

/** Only re-check on window focus if the last check is older than this. */
export const FOCUS_RECHECK_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2h

/**
 * Deterministic pseudo-random fraction in [0, 1), seeded from `seed` — same
 * LCG constants as components/brain/canvas/layout.ts's createRng (Numerical
 * Recipes), reimplemented locally (a few lines) rather than imported, so
 * this lib/ module has no dependency on the components/ tree. Keeps
 * jitteredCheckIntervalMs a pure function of `now` instead of reaching for
 * Math.random() directly, so tests never need to mock global randomness.
 */
function seededFraction(seed: number): number {
  const s = (Math.imul(seed >>> 0, 1664525) + 1013904223) >>> 0;
  return s / 4294967296;
}

/** Periodic re-check delay: CHECK_INTERVAL_MS +/- CHECK_INTERVAL_JITTER_RATIO,
 *  deterministic in `now` (see seededFraction above). */
export function jitteredCheckIntervalMs(now: number): number {
  const jitterSpan = CHECK_INTERVAL_MS * CHECK_INTERVAL_JITTER_RATIO;
  const offset = (seededFraction(now) * 2 - 1) * jitterSpan;
  return Math.round(CHECK_INTERVAL_MS + offset);
}

/** Delay before the Nth error-backoff retry (1-based: 1 = first retry after
 *  a failure). Doubles per consecutive failure, capped at
 *  ERROR_BACKOFF_MAX_MS — never grows unbounded. */
export function errorBackoffDelayMs(errorStreak: number): number {
  const streak = Math.max(1, errorStreak);
  const delay = ERROR_BACKOFF_BASE_MS * Math.pow(ERROR_BACKOFF_MULTIPLIER, streak - 1);
  return Math.min(delay, ERROR_BACKOFF_MAX_MS);
}

/** The single delay the scheduling component should use to arm its next
 *  setTimeout, given the store's current state: error backoff while a
 *  failure streak is active, otherwise the normal jittered interval. */
export function nextCheckDelayMs(state: Pick<UpdateStoreState, 'errorStreak'>, now: number): number {
  if (state.errorStreak > 0) {
    return errorBackoffDelayMs(state.errorStreak);
  }
  return jitteredCheckIntervalMs(now);
}

/** Whether a window-focus event should trigger an immediate re-check —
 *  true if there has never been a check, if `lastCheckAt` fails to parse
 *  (defensive), or if it's older than FOCUS_RECHECK_THRESHOLD_MS. */
export function shouldRecheckOnFocus(lastCheckAt: string | null, now: number): boolean {
  if (!lastCheckAt) return true;
  const last = Date.parse(lastCheckAt);
  if (Number.isNaN(last)) return true;
  return now - last > FOCUS_RECHECK_THRESHOLD_MS;
}

// ── Test-only helpers ────────────────────────────────────────────────

/** Mirrors systemPressure.ts's resetSystemPressureForTests — tears down any
 *  real listener so one test file's module-level state never leaks into
 *  the next. */
export function _resetUpdateStoreForTests(): void {
  _state = INITIAL_STATE;
  _listeners.clear();
  _initialized = false;
  _checkPromise = null;
  _downloadPromise = null;
  if (_unlistenProgress) {
    _unlistenProgress();
    _unlistenProgress = null;
  }
  if (_unlistenStaged) {
    _unlistenStaged();
    _unlistenStaged = null;
  }
}
