/* previewAttendedState.ts — P59 pure "live-when-attended" reducer.

   FOUNDER DIRECTIVE (verbatim): "hygiène naturelle et auto, fais en sorte
   que l'app soit opti et sature pas, ça peut pas freeze c'est pas normal."
   Real QA repro: a preview node's heavy animated (three.js) local dev site
   rendered CONTINUOUSLY inside its iframe regardless of whether anyone was
   even looking at it; under software rendering that alone froze the whole
   app (30s+ screenshot timeouts, 120s+ stalled wheel events).

   This is deliberately NOT the zoom-adaptive hiding W-CARDS already bans
   (the node keeps its full chrome — header, URL bar, status badge — at
   EVERY zoom level, see PreviewNode.tsx's own render). Only the IFRAME's
   own liveness is gated, on real attention signals:
     - `selected`  — the user has this node selected on the canvas.
     - `hovered`   — the mouse is over this node right now.
     - `pinnedLive`— the user explicitly asked to keep this ONE preview
                     live regardless of hover/selection (the "expand to a
                     live panel" affordance — PreviewNode.tsx's pin toggle).
   ANY of the three is "attended". Attended alone isn't sufficient for the
   iframe to actually render live, though — two more real-world gates apply:
     - `isLiveWinner` — previewLiveCoordinator.ts's hard cap of ONE live
                        iframe across the whole canvas, since attention can
                        cover >1 node at once (e.g. one selected AND a
                        different one hovered).
     - `gesturePaused`— true for a short tail after ANY canvas pan/zoom
                        (PreviewNode.tsx's viewport-based debounce) — a
                        live-rendering iframe mid-gesture is the exact
                        freeze this fix targets, so a gesture always wins
                        over mere attention.
   `reachable` gates on the SAME truth the LIVE/OFFLINE badge already
   reports (previewProbe.ts's `state === 'reachable'`) — pausing the
   iframe's DISPLAY must never contradict that badge (a paused-but-live
   server still honestly reads "LIVE", just not currently rendering).

   Pure function, no React/timers — same "state machine as data" rationale
   previewProbe.ts/previewBackoff.ts already established in this directory,
   unit-tested the same way (previewAttendedState.test.ts).
*/

export interface PreviewAttendedSignals {
  selected: boolean;
  hovered: boolean;
  pinnedLive: boolean;
  isLiveWinner: boolean;
  gesturePaused: boolean;
  reachable: boolean;
}

export interface PreviewAttendedState {
  /** True while the user is meaningfully attending this node at all — the
   *  signal previewLiveCoordinator.ts's `attendPreview`/`unattendPreview`
   *  should be driven from, independent of whether the iframe ultimately
   *  ends up live (it might lose the single-live-slot race). */
  attended: boolean;
  /** True only when EVERY gate lines up — this is what actually decides
   *  the iframe's `display: none` vs `display: block` in PreviewNode.tsx. */
  iframeLive: boolean;
}

/** Pure reducer: given a snapshot of every attention/eligibility signal,
 *  decides whether this preview is "attended" and whether its iframe
 *  should actually render live right now. */
export function derivePreviewAttendedState(signals: PreviewAttendedSignals): PreviewAttendedState {
  const attended = signals.selected || signals.hovered || signals.pinnedLive;
  const iframeLive = attended && signals.reachable && signals.isLiveWinner && !signals.gesturePaused;
  return { attended, iframeLive };
}
