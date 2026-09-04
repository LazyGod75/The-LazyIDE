/* seedProgressStore — global, app-lifetime tracker for the brain "seed from
   history" background build (onboarding's BrainSetupStep + Settings'
   HistoryReimportSection both trigger a seed via platform.brain.seedBrain();
   this store is the SINGLE place that listens for the resulting
   brain://seed-progress events, independent of which component — if any —
   is currently mounted).

   Why this exists: BrainSetupStep used to own its own local
   platform.brain.onSeedProgress() subscription, tied to its own component
   lifetime — so a seed kicked off during onboarding stopped being observable
   the moment the wizard closed, and "Continuer" had to stay disabled for the
   whole import (sometimes 40+ minutes) to avoid abandoning that
   subscription. Now the seed is tracked here, at module scope: it survives
   navigation, survives the onboarding modal closing, and both BrainSetupStep
   and the Brain page (BrainSpace.tsx) render from the same live state
   instead of each keeping their own parallel Tauri event subscription.

   Plain module-level store (zustand-style: getState + subscribe, no
   Context/Provider) — mirrors src/lib/models/costStore.ts exactly. Consumers
   read it the same way costStore is already read elsewhere (Omnibar.tsx,
   BrainBanner.tsx):
     const [s, setS] = useState(getSeedProgressState);
     useEffect(() => subscribeSeedProgress(setS), []);

   percent/imported/skipped/notesTotal/served are additive fields carried on
   the brain://seed-progress event payload (see history_import.rs's
   emit_seed_progress / the inline "done" emit) that are not part of the
   shared SeedProgressEvent type (src/lib/platform/types.ts) — read here via
   a locally-widened type, the same convention already used elsewhere in
   this codebase for extending a shared platform type without editing its
   file (e.g. BrainSpace.tsx/MemoryPanel.tsx's BrainInfoW/BrainWithSetup
   casts). */

import { getPlatform } from '../platform/index.js';
import type { SeedProgressEvent } from '../platform/types.js';

// ── Public state shape ──────────────────────────────────────────────

/** Mirrors SeedProgress.tsx's own SeedProgressResult shape (imported/skipped
    counts). Kept as a structurally-identical local type rather than an
    import from a components/ file, so this lib/ module has no dependency on
    the component tree — TypeScript's structural typing makes a value of
    this type directly assignable into <SeedProgress result={...}>. */
export interface SeedProgressResult {
  imported: number;
  skipped: number;
}

export interface SeedProgressState {
  /** True from the moment a seed starts until its terminal 'done' event (or
      an outright seedBrain() rejection) — see applyRawEvent/startSeed. */
  active: boolean;
  /** Last known phase string (see SeedProgressEvent's doc comment in
      platform/types.ts for the full list) — '' before any seed has ever run
      this session. */
  phase: string;
  done: number;
  total: number;
  /** Whole-pipeline, source-weighted percent (0-100) computed server-side —
      see history_import.rs's import_phase_percent. 0 before any event with
      a percent field has arrived. */
  percent: number;
  message: string;
  /** Populated once the terminal 'done' event arrives (or, as a defensive
      fallback, once seedBrain()'s own resolved value is reconciled — see
      startSeed). */
  result: SeedProgressResult | null;
  /** Set only by an outright seedBrain() rejection (e.g. the lazybrain
      binary could not be resolved) — NOT by a non-fatal per-source/per-step
      'error' progress event, which the backend explicitly continues past
      (see history_import.rs's module doc comment). A mid-run 'error' event
      just updates phase/message as usual; SeedProgress.tsx already renders
      that as an inline warning within the running view, not a terminal
      state. */
  error: string | null;
}

const IDLE_STATE: SeedProgressState = {
  active: false,
  phase: '',
  done: 0,
  total: 0,
  percent: 0,
  message: '',
  result: null,
  error: null,
};

type Listener = (state: SeedProgressState) => void;

let _state: SeedProgressState = IDLE_STATE;
const _listeners = new Set<Listener>();

function notify(): void {
  const snapshot = { ..._state };
  _listeners.forEach((fn) => fn(snapshot));
}

export function getSeedProgressState(): SeedProgressState {
  return { ..._state };
}

export function subscribeSeedProgress(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Test-only reset — mirrors costStore's resetCost(). */
export function resetSeedProgressForTests(): void {
  _state = IDLE_STATE;
  notify();
}

// ── Raw event widening (percent/imported/skipped/notesTotal/served) ────

interface RawSeedProgressExtra {
  percent?: number;
  imported?: number;
  skipped?: number;
  notesTotal?: number;
  served?: boolean;
}

type RawSeedProgressEvent = SeedProgressEvent & RawSeedProgressExtra;

function applyRawEvent(raw: RawSeedProgressEvent): void {
  const isDone = raw.phase === 'done';
  _state = {
    ..._state,
    active: !isDone,
    phase: raw.phase,
    done: raw.done,
    total: raw.total,
    percent: typeof raw.percent === 'number' ? raw.percent : _state.percent,
    message: raw.message ?? '',
    result: isDone
      ? { imported: raw.imported ?? 0, skipped: raw.skipped ?? 0 }
      : _state.result,
  };
  notify();
}

// ── App-lifetime listener (call ONCE, e.g. from AppShell) ─────────────

/** Subscribe to platform.brain.onSeedProgress() for the whole app session.
    Safe to call more than once (e.g. React StrictMode's dev-only
    double-invoke of effects) — each call registers its own Tauri listener
    and returns its own matching unsubscribe function; callers should still
    only invoke this from ONE persistent mount point (see AppShell.tsx) so
    exactly one listener stays active in normal operation. */
export function initSeedProgressListener(): () => void {
  return getPlatform().brain.onSeedProgress((p) => {
    applyRawEvent(p as RawSeedProgressEvent);
  });
}

// ── Start a seed (owns the platform.brain.seedBrain() call) ───────────

export interface StartSeedOptions {
  sources: string[];
  useLlm: boolean;
  since?: string;
  projectRoot?: string;
}

/**
 * Kick off a history-import seed and reset this store to a fresh, active
 * state. Deliberately NOT required to be awaited by callers that must stay
 * responsive — BrainSetupStep's "Lancer l'import" handler calls this
 * without awaiting so "Continuer" can be clicked immediately. This
 * function's own internal await keeps running at module scope regardless of
 * what unmounts, updating the shared store as real progress events arrive
 * (via initSeedProgressListener's subscription, started separately at app
 * level) and reconciling the final state once platform.brain.seedBrain()
 * itself settles.
 *
 * seedBrain() still only resolves once the WHOLE pipeline (import ->
 * index -> synthesize -> serve) truly finishes — that contract is
 * unchanged (Settings' HistoryReimportSection still awaits it directly and
 * is not touched by this store) — so the resolve branch below is a
 * defensive reconciliation, not the primary way this store learns the
 * result: the 'done' progress event (handled by applyRawEvent above) is the
 * primary source of truth and normally lands first/simultaneously.
 */
export async function startSeed(opts: StartSeedOptions): Promise<void> {
  _state = {
    ...IDLE_STATE,
    active: true,
    phase: 'starting',
    total: opts.sources.length,
  };
  notify();

  try {
    const res = await getPlatform().brain.seedBrain(opts);
    if (_state.active) {
      _state = {
        ..._state,
        active: false,
        phase: 'done',
        result: { imported: res.imported, skipped: res.skipped },
      };
      notify();
    }
  } catch (err: unknown) {
    _state = {
      ..._state,
      active: false,
      error: err instanceof Error ? err.message : String(err),
    };
    notify();
  }
}

// ── Presentational helper: SeedProgressState -> SeedProgressEvent ──────

/** Adapts this store's flattened state back into the SeedProgressEvent
    shape SeedProgress.tsx's `progress` prop expects (plus the additive
    `percent` field it also reads) — null before any seed has ever run this
    session, so callers can render their own idle/empty state instead. */
export function seedProgressStateToEvent(
  s: SeedProgressState,
): (SeedProgressEvent & { percent: number }) | null {
  if (!s.active && !s.result && !s.error) return null;
  return {
    done: s.done,
    total: s.total,
    phase: s.phase || 'starting',
    message: s.message || undefined,
    percent: s.percent,
  };
}
