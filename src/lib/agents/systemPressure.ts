/* systemPressure.ts — FOUNDER NORTH STAR: normal users' machines must never
   be saturated by the app; everything adapts BY the app, automatically,
   with no manual unblocking ever. This module is the single shared "is this
   machine under load right now" signal for the whole app.

   Module-level singleton (zustand-style: getState + subscribe, no Context)
   — mirrors src/lib/brain/seedProgressStore.ts exactly. Subscribed to
   EXACTLY ONCE for the whole app session: scheduler.ts (throttles new
   mission launches), devPreview.ts (skips spawning a NEW dev server), and
   the cockpit's SystemPressureBadge (tells the user WHY — "adaptation must
   be TOLD, not silent") all read the SAME live state via getSystemPressure/
   subscribeSystemPressure instead of each registering its own Tauri
   listener.

   WIRE CONTRACT (Rust side — src-tauri/src/commands/system_pressure.rs): a
   `system://pressure` event, and a `get_system_pressure` command for the
   snapshot that exists BEFORE the first live event, both carrying the
   `SystemPressure` struct's `#[serde(rename_all = "camelCase")]` shape:
     { level: 'Normal' | 'Elevated' | 'High', availableRamMb: number, totalRamMb: number, cpuPct: number, ramLevel: 'Normal' | 'Elevated' | 'High' }
   Note the level's own PascalCase (the `PressureLevel` Rust enum has its
   OWN separate `#[serde(rename_all = "PascalCase")]`, independent of the
   struct's camelCase) — parseSnapshot below normalizes this to this
   module's own lowercase `PressureLevel` (never leaked past this file), and
   `available_ram_mb`/`cpu_pct`/`ram_level` are read under their real wire
   names, not this module's own JS-side field names.

   `ramLevel` is RAM's OWN classification, independent of the combined
   `level` — the Rust side classifies RAM and CPU separately and ORs them
   into `level` (either alone is reason enough to throttle), so `level ===
   'high'` can mean a genuine low-memory condition OR a pure CPU spike on an
   unrelated process. `ramLevel` is what lets a consumer (
   MemoryPressureIndicator.tsx) tell those apart and never claim "low
   memory" when the actual cause was CPU — see that component's own doc
   comment.

   GRACEFUL DEGRADATION (deliberate, not a gap): an older Rust build with
   neither the event nor the command simply never calls back — this module
   then stays at the 'normal' default forever, i.e. EXACTLY today's
   behavior (no throttling, no indicator, no dev-server gating). Never
   assumes the command exists; never throws; never retries a rejected
   get_system_pressure call (nothing would change without a live event
   anyway).
*/

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from '../platform/index.js';

export type PressureLevel = 'normal' | 'elevated' | 'high';

export interface SystemPressureSnapshot {
  level: PressureLevel;
  /** Available system RAM in MB, when the backend reported one — undefined
   *  (never a fabricated number) until a real snapshot supplies it. */
  availableMemoryMb?: number;
  /** System-wide CPU load, 0-100, when the backend reported one. */
  cpuPercent?: number;
  /** RAM's OWN classification, independent of `level` (see this module's
   *  header) — lets a consumer distinguish a genuine low-memory condition
   *  from `level` being 'high' purely because of CPU. Undefined (never a
   *  guessed value) until a real snapshot supplies it, same convention as
   *  `availableMemoryMb`/`cpuPercent` — an older/malformed backend that
   *  never sends this field degrades to "unconfirmed", which a consumer
   *  must treat as "do not claim memory is low", never as "memory is
   *  confirmed fine" (that would silently misreport the opposite way). */
  ramLevel?: PressureLevel;
}

const NORMAL_SNAPSHOT: SystemPressureSnapshot = { level: 'normal' };

/** Maps the Rust `PressureLevel` enum's own PascalCase serialization
 *  ('Normal'/'Elevated'/'High' — see this module's header) to this
 *  module's lowercase PressureLevel. An unrecognized/missing value maps to
 *  undefined, never a guess — parseSnapshot treats that the same as a
 *  wholly malformed payload (degrades to 'normal'). */
const WIRE_LEVEL_MAP: Record<string, PressureLevel> = { Normal: 'normal', Elevated: 'elevated', High: 'high' };

/** Validates an untrusted raw payload (Tauri event/command JSON — never
 *  trusted as-is, same "validate at system boundaries" rule every other
 *  boundary in this codebase follows) into a snapshot. A missing/invalid
 *  `level` degrades to 'normal' rather than throwing or propagating
 *  garbage — the same "never worse than today" contract this whole module
 *  commits to for an older/malformed backend. */
function parseSnapshot(raw: unknown): SystemPressureSnapshot {
  if (!raw || typeof raw !== 'object') return NORMAL_SNAPSHOT;
  const r = raw as Record<string, unknown>;
  const level = (typeof r.level === 'string' && WIRE_LEVEL_MAP[r.level]) || 'normal';
  const availableMemoryMb = typeof r.availableRamMb === 'number' ? r.availableRamMb : undefined;
  const cpuPercent = typeof r.cpuPct === 'number' ? r.cpuPct : undefined;
  const ramLevel = (typeof r.ramLevel === 'string' && WIRE_LEVEL_MAP[r.ramLevel]) || undefined;
  return { level, availableMemoryMb, cpuPercent, ramLevel };
}

type Listener = (snapshot: SystemPressureSnapshot) => void;

let _snapshot: SystemPressureSnapshot = NORMAL_SNAPSHOT;
const _listeners = new Set<Listener>();
let _initialized = false;
let _unlisten: UnlistenFn | null = null;

function notify(): void {
  for (const fn of _listeners) fn(_snapshot);
}

function applyRaw(raw: unknown): void {
  _snapshot = parseSnapshot(raw);
  notify();
}

/**
 * Idempotent, lazy init — safe to call from every consumer's own first-use
 * moment (scheduler.ts's dispatch(), devPreview.ts's ensure call, the
 * cockpit badge's mount effect): only the FIRST call actually registers the
 * Tauri listener / fetches the initial snapshot; every later call is a
 * no-op. Never runs outside a real Tauri app — a browser/harness session
 * has no OS-level pressure signal to read, and calling invoke/listen there
 * would be pure console noise (same posture as this codebase's other
 * isTauri() gates, e.g. useCanvasAutoComposition.ts's startPortProbe).
 */
function ensureInit(): void {
  if (_initialized) return;
  _initialized = true;
  if (!isTauri()) return;

  listen('system://pressure', (event) => applyRaw(event.payload))
    .then((un) => {
      _unlisten = un;
    })
    .catch(() => {
      // Event system itself unavailable — extremely unlikely inside a real
      // Tauri app, but never worse than staying at 'normal'.
    });

  // Lazy fetch for the snapshot that exists BEFORE the first live event. An
  // older Rust build without this command simply rejects once here and
  // this module stays at 'normal' forever — exactly today's behavior.
  invoke('get_system_pressure').then(applyRaw).catch(() => {});
}

export function getSystemPressure(): SystemPressureSnapshot {
  ensureInit();
  return _snapshot;
}

export function subscribeSystemPressure(fn: Listener): () => void {
  ensureInit();
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Test-only reset — mirrors seedProgressStore.ts's resetSeedProgressForTests.
 *  Also tears down a real listener if one was ever registered, so one
 *  test's module-level state never leaks into the next. */
export function resetSystemPressureForTests(): void {
  _snapshot = NORMAL_SNAPSHOT;
  _listeners.clear();
  _initialized = false;
  if (_unlisten) {
    _unlisten();
    _unlisten = null;
  }
}

/**
 * Test-only direct setter — lets scheduler.test.ts / devPreview.test.ts /
 * the indicator's own tests simulate a pressure level without a real Tauri
 * event round-trip. Marks the module already-initialized so a subsequent
 * getSystemPressure()/subscribeSystemPressure() call in the same test never
 * tries a real listen()/invoke() underneath.
 */
export function setSystemPressureForTests(snapshot: SystemPressureSnapshot): void {
  _initialized = true;
  _snapshot = snapshot;
  notify();
}
