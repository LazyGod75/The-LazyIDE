/**
 * Auto-updater — thin IPC wrapper around the Rust-driven updater service
 * (src-tauri/src/updater_service.rs + the updater_* Tauri commands it
 * registers). See AUTOUPDATE-SPEC.md for the full rationale; the short
 * version:
 *
 * `@tauri-apps/plugin-updater`'s `downloadAndInstall()` / `install()` are
 * dead on Windows — `install_inner` calls `std::process::exit(0)`
 * unconditionally, which short-circuits `run_exit_cleanup()` and gets every
 * update miscounted as a crash by the crash guard. The whole update cycle
 * is now staged to disk by Rust and applied at the NEXT boot, before
 * anything else starts. This module therefore never imports
 * `@tauri-apps/plugin-updater` or `@tauri-apps/plugin-process` — it only
 * calls `invoke()` on the `updater_*` commands below and `listen()` for the
 * two `updater://` events.
 *
 * Guards every call with isTauri() so the module is a safe no-op in
 * browser/web builds and Vitest (no Tauri IPC available there): every
 * exported function resolves to `null` (commands) or a harmless no-op
 * unlisten (events) instead of invoking anything.
 *
 * Stateless by design — src/lib/updateStore.ts is the single source of
 * truth for UI state built from these calls; this module never remembers
 * anything between invocations.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from './platform/index.js';

// ── IPC contract types (AUTOUPDATE-SPEC.md section A.4 — shared with the
// Rust side; keep field names/optionality in lockstep with the commands
// table there) ───────────────────────────────────────────────────────

export type UpdaterCheckStatus = 'up-to-date' | 'available' | 'error';

export interface UpdaterCheckResult {
  status: UpdaterCheckStatus;
  version?: string;
  notes?: string;
  pubDate?: string;
  message?: string;
}

export interface UpdaterDownloadResult {
  version: string;
}

export interface StagedUpdateInfo {
  version: string;
  /** Nullable on the wire (Rust's `StagedOut.notes: Option<String>` has no
   *  `skip_serializing_if`, so a missing release body serializes as `null`,
   *  not an omitted key — unlike UpdaterCheckResult's own `notes?`, which IS
   *  omitted when absent). */
  notes: string | null;
}

export interface UpdateAppliedInfo {
  fromVersion: string;
}

export interface UpdaterStateInfo {
  currentVersion: string;
  autoUpdate: boolean;
  staged: StagedUpdateInfo | null;
  lastCheckAt: string | null;
  ignoredVersion: string | null;
  lastError: string | null;
  updateApplied: UpdateAppliedInfo | null;
}

export interface DownloadProgressEvent {
  downloaded: number;
  total: number | null;
}

export interface StagedEvent {
  version: string;
}

const EVENT_DOWNLOAD_PROGRESS = 'updater://download-progress';
const EVENT_STAGED = 'updater://staged';

/** Resolved by the event-subscription functions below when running outside
 *  Tauri, so callers never need to null-check their unlisten handle. */
const NOOP_UNLISTEN: UnlistenFn = () => {};

// ── Commands ─────────────────────────────────────────────────────────

/** Checks the remote manifest. Does not download anything. */
export async function checkForUpdate(): Promise<UpdaterCheckResult | null> {
  if (!isTauri()) return null;
  return invoke<UpdaterCheckResult>('updater_check');
}

/** Checks, downloads and stages an update on disk. Rejects if there is
 *  nothing to download (see the commands table in AUTOUPDATE-SPEC.md). */
export async function downloadUpdate(): Promise<UpdaterDownloadResult | null> {
  if (!isTauri()) return null;
  return invoke<UpdaterDownloadResult>('updater_download');
}

/** Snapshot of the persisted updater state (autoUpdate policy, any staged
 *  update, last check/error, ignored version). */
export async function getUpdaterState(): Promise<UpdaterStateInfo | null> {
  if (!isTauri()) return null;
  return invoke<UpdaterStateInfo>('updater_state');
}

export async function setAutoUpdate(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>('updater_set_auto', { enabled });
}

export async function ignoreUpdateVersion(version: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>('updater_ignore_version', { version });
}

export async function clearStagedUpdate(): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>('updater_clear_staged');
}

/** Restarts the app to apply a staged update — goes through
 *  `RunEvent::Exit` -> `run_exit_cleanup()` -> a clean-exit marker, unlike
 *  the dead plugin `relaunch()` path this replaces. */
export async function restartAndApplyUpdate(): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>('updater_restart_and_apply');
}

// ── Events ───────────────────────────────────────────────────────────

/**
 * Subscribe to `updater://download-progress`. No-op outside Tauri: resolves
 * to a harmless unlisten function so callers never need to null-check.
 */
export async function onDownloadProgress(
  handler: (event: DownloadProgressEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return NOOP_UNLISTEN;
  return listen<DownloadProgressEvent>(EVENT_DOWNLOAD_PROGRESS, (e) => handler(e.payload));
}

/**
 * Subscribe to `updater://staged`, fired once Rust finishes writing and
 * verifying a staged installer (whether triggered by a manual download() or
 * a background auto-download). Same no-op contract as onDownloadProgress.
 */
export async function onStaged(handler: (event: StagedEvent) => void): Promise<UnlistenFn> {
  if (!isTauri()) return NOOP_UNLISTEN;
  return listen<StagedEvent>(EVENT_STAGED, (e) => handler(e.payload));
}
