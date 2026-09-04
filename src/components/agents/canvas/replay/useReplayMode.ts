/* useReplayMode.ts — Agent Canvas W8d: React session state for fleet
   Replay. Owns enter/exit, the query window, the play/pause/speed/scrub
   playhead, and the derived (memoized) fleet snapshot + firing chain ids
   for the current instant. Local component state ONLY (NOT canvasStore) —
   replay is a transient VIEW MODE, never persisted, same rationale
   useCanvasFilter.ts documents for search/status-filter state one
   directory over.

   Live reconcile keeps running underneath the whole time (this hook never
   touches canvasStore/agentsStore/the reconciler) — only the DECORATION
   layer in useCanvasFlowGraph.ts reads this hook's output to override what
   the canvas visually shows for the current playhead instant.
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { journalQuery } from '../../../../lib/journal/journal';
import { emit } from '../../../../lib/bus';
import type { JournalEventRow } from '../../../../lib/journal/eventTypes';
import {
  buildFleetTimeline,
  computeWindowStartMs,
  firesBetween,
  fleetStateAt,
  lastKeyframeAtOrBefore,
  type FleetStateEntry,
  type FleetTimeline,
  type ReplayWindowOption,
  type TimelineKeyframe,
} from './replayModel';

export type ReplaySpeed = 1 | 4 | 16;

/** Playback tick cadence — brief's perf rule "rAF-driven interval <=10Hz"
 *  (200ms = 5Hz, comfortably under the ceiling; matches the sibling
 *  dry-run preview's own TICK_MS precedent, dryrun/useDryRunPreview.ts). */
const TICK_MS = 200;

/** Generous per-invoke cap — a fleet's whole-window history is bounded
 *  activity (not a live poll), same order of magnitude as
 *  useMissionHistory.ts's PROJECT_QUERY_LIMIT. */
const QUERY_LIMIT = 5000;

export interface UseReplayModeParams {
  /** Every currently-open project's journal projectId — journalQuery only
   *  filters by ONE projectId per call (journal.ts's JournalQueryFilter),
   *  so entering replay fans out one query per open project and merges the
   *  rows. Should be referentially stable across renders where possible
   *  (the caller — CanvasView.tsx — derives it from `openProjects` with a
   *  memo) to avoid a needless re-derivation; this hook itself never
   *  re-queries on its own when the array merely changes reference. */
  projectIds: readonly string[];
}

export interface UseReplayModeResult {
  active: boolean;
  loading: boolean;
  windowOption: ReplayWindowOption;
  timeline: FleetTimeline | null;
  currentTMs: number;
  playing: boolean;
  speed: ReplaySpeed;
  /** Fleet snapshot at `currentTMs` — empty map before the first load
   *  resolves or when the window has no events at all. */
  fleetState: ReadonlyMap<string, FleetStateEntry>;
  /** Chain ids that fired between the previous and current playhead
   *  position — cleared back to empty the instant the playhead moves
   *  again without a fire in range. */
  firingChainIds: ReadonlySet<string>;
  tickerKeyframe: TimelineKeyframe | undefined;
  /**
   * Fork-from-replay (v1) — mission node id selected while replay is active,
   * or `null`. Local, transient UI state, same convention as
   * useCanvasChainConnect.ts's own `chainSource` (never persisted, never
   * canvasStore-resident): cleared on `enter()`/`exit()` and whenever the
   * caller reports a non-mission selection (see `selectMission`).
   */
  selectedMissionId: string | null;
  /** Sets (or clears, via `null`) the selected mission — CanvasView.tsx's
   *  `onNodeClick` calls this in place of the normal click-to-connect
   *  handler while `active`. */
  selectMission: (missionId: string | null) => void;
  /**
   * The exact fleet-wide rows the CURRENT `timeline` was built from (see
   * `load()`) — kept so forkFromReplay.ts's `buildForkDraft` can derive
   * context-as-of-`atMs` facts without a second query. Empty before the
   * first load resolves.
   */
  rawEvents: readonly JournalEventRow[];
  enter: () => void;
  exit: () => void;
  toggle: () => void;
  setWindowOption: (option: ReplayWindowOption) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
  scrubTo: (tMs: number) => void;
  stepMs: (deltaMs: number) => void;
}

const EMPTY_FLEET_STATE: ReadonlyMap<string, FleetStateEntry> = new Map();
const EMPTY_FIRING_IDS: ReadonlySet<string> = new Set();

export function useReplayMode({ projectIds }: UseReplayModeParams): UseReplayModeResult {
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [windowOption, setWindowOptionState] = useState<ReplayWindowOption>('today');
  const [timeline, setTimeline] = useState<FleetTimeline | null>(null);
  const [currentTMs, setCurrentTMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [fleetState, setFleetState] = useState<ReadonlyMap<string, FleetStateEntry>>(EMPTY_FLEET_STATE);
  const [firingChainIds, setFiringChainIds] = useState<ReadonlySet<string>>(EMPTY_FIRING_IDS);
  const [tickerKeyframe, setTickerKeyframe] = useState<TimelineKeyframe | undefined>(undefined);
  // Fork-from-replay (v1) — see UseReplayModeResult's own doc comments.
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [rawEvents, setRawEvents] = useState<readonly JournalEventRow[]>([]);

  const currentTMsRef = useRef(0);
  // Synced via effect (react-hooks/refs: never a render-body ref write) —
  // safe because the only reader is load(), which is exclusively invoked
  // from user-gesture callbacks (enter/setWindowOption), always after the
  // sync effect for the current render has run.
  const projectIdsRef = useRef(projectIds);
  useEffect(() => {
    projectIdsRef.current = projectIds;
  }, [projectIds]);
  // Bumped on every load()/exit() so an in-flight query that loses the
  // race (window changed again, or replay was exited, before it resolves)
  // never clobbers newer state — same "answer stamped with its own
  // request key" convention as useMissionHistory.ts's requestKey/isCurrent.
  const generationRef = useRef(0);

  const applyPlayhead = useCallback((tl: FleetTimeline, tMs: number) => {
    currentTMsRef.current = tMs;
    setCurrentTMs(tMs);
    setFleetState(fleetStateAt(tl, tMs));
    setTickerKeyframe(lastKeyframeAtOrBefore(tl, tMs));
  }, []);

  const load = useCallback(
    async (option: ReplayWindowOption) => {
      const myGeneration = (generationRef.current += 1);
      setLoading(true);
      const nowMs = Date.now();
      const windowStartMs = computeWindowStartMs(option, nowMs);
      const results = await Promise.all(
        projectIdsRef.current.map((projectId) => journalQuery({ projectId, sinceMs: windowStartMs, limit: QUERY_LIMIT })),
      );
      if (myGeneration !== generationRef.current) return; // superseded — a newer load/exit already won
      let events = results.flat();
      // R2a fix (thread 3) — root cause proven: this per-project fan-out
      // silently returns ZERO rows whenever `projectIdsRef.current` is empty
      // (the project registry hasn't hydrated yet — see the model script's
      // own doc comment on the seamless-upgrade/localStorage boot path) OR a
      // project's CURRENT id (projectId.ts's projectIdFromRoot) no longer
      // matches what an event was actually stamped with (id-scheme drift
      // across a normalization change) — even on a window with genuine
      // activity. The FLUX footer (queryActivityFeed, projections.ts) never
      // has this problem because it never filters by project_id at all —
      // which is exactly why the SAME day's events show up there but not
      // here. Only when the properly-scoped fan-out found LITERALLY
      // NOTHING does this fall back to one project-agnostic query for the
      // identical [windowStartMs, nowMs] window — this never changes
      // behavior for the expected/common case where per-project scoping
      // already found real events, and it never widens what the user sees
      // beyond "this exact time window", only beyond "this exact set of
      // project ids".
      if (events.length === 0) {
        const fallback = await journalQuery({ sinceMs: windowStartMs, limit: QUERY_LIMIT });
        if (myGeneration !== generationRef.current) return; // superseded mid-fallback
        events = fallback;
      }
      const built = buildFleetTimeline(events, windowStartMs, nowMs);
      setTimeline(built);
      setRawEvents(events);
      setFiringChainIds(EMPTY_FIRING_IDS);
      // A window switch can leave a previously-selected mission outside the
      // new window entirely — same "don't carry stale selection across a
      // fresh load" rule firingChainIds' own reset follows.
      setSelectedMissionId(null);
      applyPlayhead(built, windowStartMs);
      setLoading(false);
    },
    [applyPlayhead],
  );

  const enter = useCallback(() => {
    setActive(true);
    setPlaying(false);
    emit('canvas:replayActive', { active: true });
    void load(windowOption);
    // windowOption intentionally read fresh via closure at call time; this
    // callback is only invoked from user gestures (toolbar/keyboard), never
    // from a dependency-driven effect, so a stale windowOption can't leak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const exit = useCallback(() => {
    generationRef.current += 1; // invalidate any in-flight load
    setActive(false);
    setPlaying(false);
    setTimeline(null);
    setFleetState(EMPTY_FLEET_STATE);
    setFiringChainIds(EMPTY_FIRING_IDS);
    setTickerKeyframe(undefined);
    setSelectedMissionId(null);
    emit('canvas:replayActive', { active: false });
  }, []);

  const selectMission = useCallback((missionId: string | null) => {
    setSelectedMissionId(missionId);
  }, []);

  const toggle = useCallback(() => {
    if (active) exit();
    else enter();
  }, [active, enter, exit]);

  const setWindowOption = useCallback(
    (option: ReplayWindowOption) => {
      setWindowOptionState(option);
      if (active) void load(option);
    },
    [active, load],
  );

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);
  const togglePlay = useCallback(() => setPlaying((p) => !p), []);

  const advanceTo = useCallback(
    (nextTMs: number) => {
      if (!timeline) return;
      const prev = currentTMsRef.current;
      const clamped = Math.min(Math.max(nextTMs, timeline.windowStartMs), timeline.windowEndMs);
      if (clamped === prev) return;
      const lo = Math.min(prev, clamped);
      const hi = Math.max(prev, clamped);
      const fired = clamped >= prev ? firesBetween(timeline, lo, hi) : [];
      setFiringChainIds(fired.length > 0 ? new Set(fired.map((f) => f.chainId)) : EMPTY_FIRING_IDS);
      applyPlayhead(timeline, clamped);
      if (clamped >= timeline.windowEndMs) setPlaying(false);
    },
    [timeline, applyPlayhead],
  );

  const scrubTo = useCallback((tMs: number) => advanceTo(tMs), [advanceTo]);
  const stepMs = useCallback((deltaMs: number) => advanceTo(currentTMsRef.current + deltaMs), [advanceTo]);

  // Playback tick — only while active+playing+a timeline is loaded. Reads
  // the live playhead via currentTMsRef (not the `currentTMs` state) so the
  // interval itself never needs `currentTMs` in its deps — same "install
  // once, read live via a ref" shape useCanvasKeyboard.ts already
  // establishes, avoiding a re-install (and a lost in-flight tick) every
  // 200ms.
  useEffect(() => {
    if (!active || !playing || !timeline) return;
    const id = window.setInterval(() => {
      advanceTo(currentTMsRef.current + TICK_MS * speed);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [active, playing, timeline, speed, advanceTo]);

  return {
    active,
    loading,
    windowOption,
    timeline,
    currentTMs,
    playing,
    speed,
    fleetState,
    firingChainIds,
    tickerKeyframe,
    selectedMissionId,
    selectMission,
    rawEvents,
    enter,
    exit,
    toggle,
    setWindowOption,
    play,
    pause,
    togglePlay,
    setSpeed,
    scrubTo,
    stepMs,
  };
}
