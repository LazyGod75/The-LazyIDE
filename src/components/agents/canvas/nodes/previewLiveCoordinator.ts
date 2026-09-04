/* previewLiveCoordinator.ts — P59 (founder directive: "ça peut pas freeze,
   c'est pas normal"): hard cap "at most ONE live iframe at a time across
   the canvas". A tiny module-scope pub/sub, deliberately NOT built on
   `@xyflow/react`'s own `useOnViewportChange` (that hook writes a SINGLE
   shared store slot per callback — `store.setState({ onViewportChangeStart:
   onStart })` — so N mounted instances would silently clobber each other's
   registration, only the most-recently-rendered one would ever fire) and
   NOT on lib/bus.ts (a cross-cutting app event bus outside this fix's
   owned-files boundary — see PreviewNode.tsx's own module header). Every
   mounted PreviewNodeCard that currently WANTS to be live (attended AND its
   server is reachable, see previewAttendedState.ts) registers itself here;
   the most recently attended id always wins the single live slot, and
   losing it — or the winner stepping back down — is reported back
   synchronously via the subscribed listener, same "pure state, no timers"
   testability previewProbe.ts/previewBackoff.ts already established in
   this directory.

   Ordering, not a simple "last write wins" flag: an id that stops wanting
   live (mouse leaves an unpinned, unselected card) is REMOVED from the
   order rather than merely overwritten, so the next-most-recent still-
   attended id (e.g. a `selected` card the user tabbed away from
   momentarily) reclaims the slot automatically — "others pause" never
   means "paused forever until an unrelated re-render happens".

   MEMORY-PRESSURE LOCKOUT (2026-08-05 incident): the reclaim rule above is
   exactly what turned a memory scare into a second spike — closing one
   heavy Next.js dev preview handed the live slot straight to ANOTHER
   preview, which reloaded ITS iframe while the renderer was already under
   pressure. src/lib/agents/memoryGuardian.ts (see its own header for the
   full contract) watches the renderer's JS heap and dispatches
   `lazy:memory-pressure` on `window` with `{level: 'soft'|'hard', usedMB}`
   when usage crosses either threshold. This module subscribes at MODULE
   INIT rather than behind an explicit init function: unlike
   memoryGuardian.ts itself — which needs one explicit `startMemoryGuardian()`
   call site because it owns a polling `setInterval` someone must be
   responsible for stopping — this module has never had an init/start
   function; `attendedOrder`/`listeners` are already eager module-scope
   singleton state the instant PreviewNode.tsx imports this file. A bare
   `window.addEventListener` alongside them fits that same shape and needs
   no new call site in PreviewNode.tsx or main.tsx (both outside this fix's
   file boundary — see PreviewNode.tsx's own module header).

   Policy:
     - 'hard' — release the live slot ENTIRELY (every preview pauses,
       PreviewNode.tsx's GoLiveCard affordance takes over) and refuse every
       non-manual claim until the lockout clears.
     - 'soft' — keep whichever preview was already live (the "incumbent",
       snapshotted the instant soft pressure begins) but refuse every OTHER
       preview's non-manual claim — including a later auto-reclaim after
       the incumbent itself steps down, which would just be the same
       incident at a smaller scale.
     - Either level: an explicit, user-initiated claim (PreviewNode.tsx's
       "Voir en direct" pin, threaded through as `attendPreview(id, {
       manual: true })`) always bypasses the lockout — a human asking for a
       specific preview is a deliberate, singular action, not the kind of
       unattended pile-up this guards against.
   The lockout clears once `lazy:memory-pressure` has gone quiet for
   PREVIEW_PRESSURE_SILENCE_MS: the guardian only ever emits ABOVE a
   threshold (see its header's RATE LIMITING/hysteresis), it never tells us
   "you're fine now" directly — so sustained silence is the only signal we
   get that pressure has receded, and we infer recovery from the absence of
   further events rather than waiting for a positive all-clear.
*/

import {
  MEMORY_PRESSURE_EVENT,
  type MemoryPressureEventDetail,
  type MemoryPressureLevel,
} from '../../../../lib/agents/memoryGuardian';

type LiveWinnerListener = (isLive: boolean) => void;

// Most-recently-attended last. A plain array is fine — the canvas realistically
// holds a handful of preview nodes at once, never enough for O(n) splice/indexOf
// to matter.
const attendedOrder: string[] = [];
const listeners = new Map<string, LiveWinnerListener>();

/** Lockout level — see module header's MEMORY-PRESSURE LOCKOUT section. */
export type PreviewPressureLockoutLevel = 'none' | 'soft' | 'hard';

let pressureLevel: PreviewPressureLockoutLevel = 'none';
let silenceTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

/** How long `lazy:memory-pressure` must stay silent before the lockout
 *  clears — see module header's inference rationale. */
export const PREVIEW_PRESSURE_SILENCE_MS = 5 * 60_000;

function currentWinner(): string | null {
  return attendedOrder.length > 0 ? attendedOrder[attendedOrder.length - 1] : null;
}

function notifyIfChanged(previousWinner: string | null): void {
  const winner = currentWinner();
  if (winner === previousWinner) return;
  if (previousWinner) listeners.get(previousWinner)?.(false);
  if (winner) listeners.get(winner)?.(true);
}

/** Marks `id` as the most-recently-attended preview — it becomes (or stays)
 *  the live winner, demoting whichever id previously held the slot. Safe to
 *  call repeatedly (e.g. re-attending an already-winning id is a no-op).
 *
 *  `opts.manual` marks a deliberate, user-initiated claim (e.g. an explicit
 *  "Voir en direct" pin) — see module header: it always bypasses the
 *  memory-pressure lockout. Every other caller (PreviewNode.tsx's own
 *  eligibility/attention effects) omits it and is subject to the lockout
 *  like any other automatic claim. */
export function attendPreview(id: string, opts?: { manual?: boolean }): void {
  const manual = opts?.manual === true;
  if (!manual && pressureLevel !== 'none' && id !== currentWinner()) {
    // Locked out and this isn't the sole id still allowed through: while
    // locked out, attendedOrder is kept trimmed to at most that one id (see
    // handleMemoryPressureLevel/releaseLiveSlot below), so currentWinner()
    // IS the incumbent (or null under 'hard' — nobody qualifies).
    return;
  }
  const previousWinner = currentWinner();
  if (pressureLevel !== 'none') {
    // Locked out and this claim IS allowed through (manual, or the sole
    // incumbent re-affirming itself): collapse to JUST this id rather than
    // the usual splice-then-push. A manual claim stacking on top of an
    // already-trimmed incumbent would otherwise leave that incumbent
    // sitting underneath it — the same stale-runner-up bug the lockout
    // exists to prevent, just re-introduced one claim later (see
    // unattendPreview's header comment).
    attendedOrder.length = 0;
    attendedOrder.push(id);
  } else {
    const existingIndex = attendedOrder.indexOf(id);
    if (existingIndex !== -1) attendedOrder.splice(existingIndex, 1);
    attendedOrder.push(id);
  }
  notifyIfChanged(previousWinner);
}

/** Removes `id` from contention entirely — the next-most-recently-attended
 *  id (if any) reclaims the live slot. A no-op if `id` was never attended.
 *
 *  Needs no memory-pressure special-case: while locked out, attendedOrder
 *  is already trimmed to at most the one entitled incumbent (see
 *  handleMemoryPressureLevel/releaseLiveSlot), so there is never a stale
 *  runner-up sitting underneath it to be wrongly auto-promoted here — the
 *  exact 2026-08-05 incident (closing one preview handing the slot straight
 *  to another one under the same pressure) this module now prevents. */
export function unattendPreview(id: string): void {
  const previousWinner = currentWinner();
  const existingIndex = attendedOrder.indexOf(id);
  if (existingIndex === -1) return;
  attendedOrder.splice(existingIndex, 1);
  notifyIfChanged(previousWinner);
}

/** Registers `id`'s callback for live-slot changes. Returns an unsubscribe
 *  function that ALSO removes `id` from contention (an unmounting
 *  PreviewNodeCard must never keep occupying — or blocking — the single
 *  live slot after it's gone). */
export function subscribePreviewLiveWinner(id: string, listener: LiveWinnerListener): () => void {
  listeners.set(id, listener);
  return () => {
    listeners.delete(id);
    unattendPreview(id);
  };
}

/** True when `id` currently holds the single live slot. Exposed for tests
 *  and for a caller that only needs a one-off read rather than a
 *  subscription. */
export function isPreviewLiveWinner(id: string): boolean {
  return currentWinner() === id;
}

// ── Memory-pressure lockout ──────────────────────────────────────────────
// See module header's MEMORY-PRESSURE LOCKOUT section for the full policy.

/** Releases the live slot outright (entering 'hard') without promoting a
 *  replacement — the departing winner is told honestly, nobody else is. */
function releaseLiveSlot(): void {
  const previousWinner = currentWinner();
  attendedOrder.length = 0;
  if (previousWinner) listeners.get(previousWinner)?.(false);
}

/** Trims attendedOrder down to at most its current winner (entering
 *  'soft'). Deliberately does NOT go through notifyIfChanged — the winner
 *  itself is unchanged, only the OTHER, lower-priority entries underneath
 *  it are dropped, so a later departure of the winner can never expose one
 *  of them as a stale, wrongly-auto-promoted runner-up (see
 *  unattendPreview's header comment). */
function trimToIncumbentOnly(): void {
  const incumbent = currentWinner();
  attendedOrder.length = 0;
  if (incumbent) attendedOrder.push(incumbent);
}

function clearPressureLockout(): void {
  silenceTimeoutHandle = null;
  pressureLevel = 'none';
  // Deliberately does NOT re-attend anyone: we don't know which id (if
  // any) should reclaim the slot. Auto-claiming simply becomes possible
  // again the next time PreviewNode.tsx's own effects call attendPreview.
}

function resetSilenceTimer(): void {
  if (silenceTimeoutHandle !== null) clearTimeout(silenceTimeoutHandle);
  silenceTimeoutHandle = setTimeout(clearPressureLockout, PREVIEW_PRESSURE_SILENCE_MS);
}

function handleMemoryPressureLevel(level: MemoryPressureLevel): void {
  resetSilenceTimer();
  if (level === 'hard') {
    pressureLevel = 'hard';
    releaseLiveSlot();
    return;
  }
  // 'soft'
  if (pressureLevel === 'none') {
    pressureLevel = 'soft';
    trimToIncumbentOnly();
  }
  // Already 'soft' or 'hard': leave the existing lockout untouched — only
  // the silence timer above refreshes. A later 'soft' event never
  // downgrades an active 'hard' lockout; only silence (clearPressureLockout)
  // clears it.
}

function handleMemoryPressureDomEvent(event: Event): void {
  const detail = (event as CustomEvent<MemoryPressureEventDetail>).detail;
  if (!detail || (detail.level !== 'soft' && detail.level !== 'hard')) return;
  handleMemoryPressureLevel(detail.level);
}

// Module-init subscription — see module header for why this module (unlike
// memoryGuardian.ts) has no explicit init function to hang this off instead.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(MEMORY_PRESSURE_EVENT, handleMemoryPressureDomEvent as EventListener);
}

/** True while ANY memory-pressure lockout (soft or hard) is active — for UI
 *  to later render a hint (e.g. "auto-live paused: low memory"). See
 *  {@link getPreviewPressureLockoutLevel} for which level specifically. */
export function isPreviewPressureLockout(): boolean {
  return pressureLevel !== 'none';
}

/** The current lockout level — 'none' outside any pressure event. */
export function getPreviewPressureLockoutLevel(): PreviewPressureLockoutLevel {
  return pressureLevel;
}

/** Test-only reset — mirrors canvasStore.ts's own `_resetCanvasStoreForTests`
 *  convention: this module's state is otherwise process-lifetime, module-
 *  scope singleton state, which would leak between unrelated test cases. */
export function _resetPreviewLiveCoordinatorForTests(): void {
  attendedOrder.length = 0;
  listeners.clear();
  pressureLevel = 'none';
  if (silenceTimeoutHandle !== null) {
    clearTimeout(silenceTimeoutHandle);
    silenceTimeoutHandle = null;
  }
}
