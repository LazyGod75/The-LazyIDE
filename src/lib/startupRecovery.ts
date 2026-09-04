/* startupRecovery.ts — single shared fetch of the backend's boot-time crash
   recovery state (`get_startup_recovery_state`). Both the startup UI
   (StartupRecoveryCheck.tsx — toast on 'recovered', SafeModeBanner on
   'safe_mode') and agentsStore.tsx's boot pass (gates the durable-queue
   auto-resume bookkeeping while in safe mode) need the SAME answer for this
   session — a cached promise means only the FIRST caller ever actually
   invokes the command; every later caller (regardless of ordering) shares
   that same in-flight/resolved result.

   GRACEFUL DEGRADATION (same contract as systemPressure.ts / missionQueue.ts's
   boot passes): the command may not exist yet on an older/partial Rust
   build. A rejected invoke(), a malformed payload, or a non-Tauri context
   (Vitest/browser) all resolve to 'clean' — i.e. exactly today's behavior,
   nothing gated, no banner, no toast. Never throws, never retried.
*/

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './platform/index.js';

export type StartupRecoveryStateKind = 'clean' | 'recovered' | 'safe_mode';

export interface StartupRecoveryState {
  state: StartupRecoveryStateKind;
  consecutive: number;
}

const CLEAN_STATE: StartupRecoveryState = { state: 'clean', consecutive: 0 };

const VALID_STATES: ReadonlySet<string> = new Set<StartupRecoveryStateKind>(['clean', 'recovered', 'safe_mode']);

/** Validates an untrusted raw payload (Tauri command JSON — never trusted
 *  as-is, same "validate at system boundaries" rule every other boundary in
 *  this codebase follows). An unrecognized/missing `state` degrades to
 *  'clean' rather than throwing or propagating garbage. */
function parseState(raw: unknown): StartupRecoveryState {
  if (!raw || typeof raw !== 'object') return CLEAN_STATE;
  const r = raw as Record<string, unknown>;
  const state = typeof r.state === 'string' && VALID_STATES.has(r.state)
    ? (r.state as StartupRecoveryStateKind)
    : 'clean';
  const consecutive = typeof r.consecutive === 'number' ? r.consecutive : 0;
  return { state, consecutive };
}

let cached: Promise<StartupRecoveryState> | null = null;

/**
 * Fetches (once — cached for the session) the backend's startup recovery
 * state. Safe to call from multiple independent consumers: every call after
 * the first shares the exact same in-flight/resolved promise, so the
 * command is invoked at most once per app session.
 */
export function getStartupRecoveryState(): Promise<StartupRecoveryState> {
  if (!cached) {
    cached = isTauri()
      ? invoke('get_startup_recovery_state').then(parseState).catch(() => CLEAN_STATE)
      : Promise.resolve(CLEAN_STATE);
  }
  return cached;
}

/** Test-only reset — mirrors systemPressure.ts's resetSystemPressureForTests. */
export function resetStartupRecoveryForTests(): void {
  cached = null;
}
