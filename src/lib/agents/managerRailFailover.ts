/* managerRailFailover — bounded cross-rail failover for streamManagerCompletion.

   Before this module the manager dispatched each turn to exactly ONE rail:
   if it died (CLI spawn failure, Devin auth breaker, provider 5xx, network
   drop) the whole turn stranded on `LazyManager error`. Now the resolved
   rail is tried first, then the next AVAILABLE rails in auto-detect order
   (managed → claude-code → codex → devin → live-key) — each exactly once,
   never on abort, never onto 'mock' (a canned demo reply would fabricate a
   manager answer). Every switch emits an honest notice into the stream so
   the transcript says which rail actually produced the reply — same
   contract as withFallback's yieldFallbackNotice in providerFallback.ts. */

import type { ProviderMode } from '../models/index.js';
import {
  getDefaultModelIdForMode,
  isManagedActive,
  loadAccessSettings,
} from '../models/index.js';
import { isCliBackendAvailable } from '../models/cliBackendProvider.js';
import { devinAuthBlocked } from '../models/devinAuthGuard.js';
import { resolveByokDef, hasByokKey } from '../models/byokProviders.js';
import type { ByokProviderDef } from '../models/byokProviders.js';

/** Same '__TAURI_INTERNALS__' sentinel as platform/index.ts's isTauri(),
 *  inlined deliberately: ~100 test files mock ../lib/platform without an
 *  isTauri export, and a missing-mock-export crash inside the failover path
 *  would turn a healthy rail into a fake "provider down". */
function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** One dispatchable manager rail. The primary attempt mirrors the exact
 *  resolution streamManagerCompletion already did (keyed-BYOK pick →
 *  devin-model pick → ambient mode); fallbacks are always ambient mode
 *  rails carrying that mode's OWN default model — a dead rail's model id
 *  is never forwarded to a rail that can't serve it. */
export type ManagerRailAttempt =
  | { kind: 'keyed-byok'; def: ByokProviderDef; model: string }
  | { kind: 'devin-model'; model: string }
  | { kind: 'mode'; mode: ProviderMode; model: string };

export function railAttemptLabel(attempt: ManagerRailAttempt): string {
  if (attempt.kind === 'keyed-byok') return `${attempt.def.label} (${attempt.model})`;
  if (attempt.kind === 'devin-model') return `Devin ${attempt.model}`;
  return modeRailLabel(attempt.mode);
}

function modeRailLabel(mode: ProviderMode): string {
  switch (mode) {
    case 'managed': return 'Lazy Pro (ai-proxy)';
    case 'claude-code': return 'Claude Code';
    case 'codex': return 'Codex';
    case 'devin': return 'Devin';
    case 'live-key': return 'BYOK';
    case 'local': return 'LLM local';
    default: return mode;
  }
}

/** Is this ambient mode currently able to serve a turn? Mirrors the
 *  availability gates getProviderMode's auto-detect applies. `null` from
 *  isCliBackendAvailable means "not probed yet" — include the rail: if it
 *  can't spawn, the failover loop simply moves to the next candidate. */
function modeRailAvailable(mode: ProviderMode): boolean {
  switch (mode) {
    case 'managed':
      return isManagedActive();
    case 'claude-code':
      // CLI rails can only spawn on desktop — on web, _cliAvailability stays
      // null ("not probed") which !== false would wrongly count as available.
      return isDesktopRuntime() && isCliBackendAvailable('claude') !== false;
    case 'codex':
      return isDesktopRuntime() && isCliBackendAvailable('codex') !== false;
    case 'devin':
      // The auth breaker is a hard gate: while engaged, spawning `devin acp`
      // is a guaranteed failure — skip straight to the next rail.
      return isDesktopRuntime() && isCliBackendAvailable('devin') !== false && !devinAuthBlocked();
    case 'live-key': {
      // streamLiveKeyRail serves only the SELECTED BYOK provider's key.
      const def = resolveByokDef(loadAccessSettings().byokProvider);
      return !!def && hasByokKey(def.id);
    }
    default:
      return false; // mock/pro/local are never failover targets
  }
}

/** Ordered fallback candidates after `primary`: the auto-detect priority
 *  order, minus the rail that just failed and minus every unavailable one.
 *  A model-driven primary also excludes its OWN backend family — an
 *  explicit 'swe-2-medium' pick that died must not be retried through the
 *  identical 'devin' mode rail (same CLI, same failure), and a keyed-BYOK
 *  pick must not retry through 'live-key' when the selected BYOK provider
 *  IS that same def. Empty when nothing else can serve — the original
 *  error then propagates unchanged. */
export function fallbackModeRails(primary: ManagerRailAttempt): ManagerRailAttempt[] {
  const excludedModes = new Set<ProviderMode>();
  if (primary.kind === 'mode') excludedModes.add(primary.mode);
  if (primary.kind === 'devin-model') excludedModes.add('devin');
  if (primary.kind === 'keyed-byok') {
    const selected = resolveByokDef(loadAccessSettings().byokProvider);
    if (selected?.id === primary.def.id) excludedModes.add('live-key');
  }
  const order: ProviderMode[] = ['managed', 'claude-code', 'codex', 'devin', 'live-key'];
  return order
    .filter((mode) => !excludedModes.has(mode) && modeRailAvailable(mode))
    .map((mode) => ({ kind: 'mode', mode, model: getDefaultModelIdForMode(mode) }));
}

/** Abort is never recoverable — the user cancelled, falling back would
 *  spawn another backend after they asked us to stop. Everything else is:
 *  the loop is bounded (each rail once), so a request-caused error just
 *  wastes at most one attempt per remaining rail before rethrowing. */
export function isRailRecoverableError(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return false;
  if (err instanceof Error && err.name === 'AbortError') return false;
  return true;
}

function shortReason(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return reason.length > 120 ? `${reason.slice(0, 117)}…` : reason;
}

/** Honest in-stream notice, same shape as providerFallback's
 *  yieldFallbackNotice — lands in rawResponse (inert to the action parser)
 *  and in the displayed bubble. `prior` carries every earlier dead rail so
 *  the FINAL bubble still names them after the accumulator reset (a reset
 *  drops earlier notices — without the trail the user would never learn
 *  which rail originally died). */
export function railFailoverNotice(
  next: ManagerRailAttempt,
  prior: ReadonlyArray<{ label: string; reason: string }>,
): string {
  const chain = prior
    .map((t) => `${t.label} (${shortReason(t.reason)})`)
    .join(' → ');
  return `\n\n_(rails indisponibles : ${chain} — bascule vers ${railAttemptLabel(next)})_\n\n`.slice(0, 420);
}

/**
 * Try each attempt in order until one streams successfully. On a
 * recoverable failure the next attempt runs the SAME request (caller's
 * prompt/messages are rail-agnostic); onFallback fires BEFORE the next
 * dispatch so the caller can reset its accumulator and emit the notice.
 * Non-recoverable errors (abort) rethrow immediately. When every attempt
 * fails, the LAST error rethrows so the user sees the freshest cause.
 */
export async function runWithRailFailover(
  attempts: readonly ManagerRailAttempt[],
  dispatch: (attempt: ManagerRailAttempt) => Promise<void>,
  opts: {
    signal?: AbortSignal;
    onFallback?: (failed: ManagerRailAttempt, next: ManagerRailAttempt, err: unknown) => void;
  } = {},
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    try {
      await dispatch(attempts[i]);
      return;
    } catch (err) {
      if (!isRailRecoverableError(err, opts.signal)) throw err;
      lastErr = err;
      const next = attempts[i + 1];
      if (!next) break;
      opts.onFallback?.(attempts[i], next, err);
    }
  }
  throw lastErr;
}
