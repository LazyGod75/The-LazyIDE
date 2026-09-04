/* usageHistory — persisted time-bucketed usage store.
   Records token usage, brain savings, and mission completions by hour.
   Persists to localStorage (web) or .lazy/usage-history.json (Tauri).
   Never throws — all storage operations are best-effort.
*/

import { joinPath } from '../paths.js';
import { isTauri as isTauriRuntime } from '../platform/index.js';

// ── Public types ───────────────────────────────────────────────────

export type UsageWindow = 'today' | '7d' | 'all';

export interface WindowMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  brainTokensSaved: number;
  missionsCompleted: number;
  /** Tokens per bucket, oldest → newest, for the selected window. */
  tokenSparkline: number[];
  /** costUsd per bucket, same length/order as tokenSparkline. */
  costSparkline: number[];
  bucketCount: number;
}

// ── Internal types ─────────────────────────────────────────────────

interface HourBucket {
  hour: number;      // unix ms, floor to hour start
  inTok: number;
  outTok: number;
  cost: number;
  saved: number;
  missions: number;
}

// ── Constants ──────────────────────────────────────────────────────

const STORAGE_KEY = 'lazy:usageHistory';
const PRUNE_MS = 90 * 24 * 3_600_000;   // 90 days
const SAVE_DEBOUNCE_MS = 800;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

// ── Module state ───────────────────────────────────────────────────

let _buckets: Map<number, HourBucket> = new Map();
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
const _listeners = new Set<() => void>();

// ── Notification ───────────────────────────────────────────────────

function notifyListeners(): void {
  _listeners.forEach((fn) => {
    try { fn(); } catch { /* guard listener errors */ }
  });
}

// ── Time helpers ───────────────────────────────────────────────────

function currentHourMs(): number {
  return Math.floor(Date.now() / MS_PER_HOUR) * MS_PER_HOUR;
}

function localMidnightMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function floorToDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── Persistence helpers ────────────────────────────────────────────

function bucketsToJson(): string {
  return JSON.stringify(Array.from(_buckets.values()));
}

function parseBucketsJson(raw: unknown): Map<number, HourBucket> {
  if (!Array.isArray(raw)) return new Map();
  const result = new Map<number, HourBucket>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec['hour'] !== 'number') continue;
    const hour = rec['hour'] as number;
    result.set(hour, {
      hour,
      inTok:    typeof rec['inTok']    === 'number' ? (rec['inTok']    as number) : 0,
      outTok:   typeof rec['outTok']   === 'number' ? (rec['outTok']   as number) : 0,
      cost:     typeof rec['cost']     === 'number' ? (rec['cost']     as number) : 0,
      saved:    typeof rec['saved']    === 'number' ? (rec['saved']    as number) : 0,
      missions: typeof rec['missions'] === 'number' ? (rec['missions'] as number) : 0,
    });
  }
  return result;
}

let _cachedProjectRoot: string | null = null;

async function resolveProjectRoot(): Promise<string> {
  if (_cachedProjectRoot !== null) return _cachedProjectRoot;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    _cachedProjectRoot = await invoke<string>('get_project_root');
    return _cachedProjectRoot;
  } catch {
    _cachedProjectRoot = '.';
    return _cachedProjectRoot;
  }
}

async function saveToStorage(): Promise<void> {
  const json = bucketsToJson();
  if (isTauriRuntime()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = await resolveProjectRoot();
      // joinPath (not a hardcoded '/') — root is typically Rust's own
      // canonicalize() output (verbatim '\\?\'-prefixed on Windows); joining
      // with a literal '/' produces a mixed-separator string the Rust fs
      // commands reject as "outside project root" even when '.lazy' exists
      // on disk. See paths.ts's header comment for the full bug-class history.
      const lazyDir = joinPath(root, '.lazy');
      await invoke<void>('fs_create_dir', { path: lazyDir });
      await invoke<void>('write_file', { path: joinPath(lazyDir, 'usage-history.json'), content: json });
    } catch {
      // best-effort: storage failure must not affect functionality
    }
  } else {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, json);
      }
    } catch {
      // best-effort
    }
  }
}

async function loadFromStorage(): Promise<void> {
  try {
    let raw: unknown = null;
    if (isTauriRuntime()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const root = await resolveProjectRoot();
        const text = await invoke<string>('read_file', { path: joinPath(root, '.lazy', 'usage-history.json') });
        raw = JSON.parse(text) as unknown;
      } catch {
        // File does not exist yet — proceed with empty state
      }
    } else {
      if (typeof localStorage !== 'undefined') {
        const text = localStorage.getItem(STORAGE_KEY);
        if (text !== null) {
          try { raw = JSON.parse(text) as unknown; } catch { /* invalid JSON, ignore */ }
        }
      }
    }
    if (raw !== null) {
      _buckets = parseBucketsJson(raw);
    }
  } catch {
    // best-effort: proceed with empty state
  }
}

function scheduleSave(): void {
  if (_saveTimer !== null) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveToStorage().catch(() => { /* best-effort */ });
  }, SAVE_DEBOUNCE_MS);
}

// ── Pruning ────────────────────────────────────────────────────────

function pruneBuckets(buckets: Map<number, HourBucket>): Map<number, HourBucket> {
  const cutoff = Date.now() - PRUNE_MS;
  const next = new Map<number, HourBucket>();
  buckets.forEach((bucket, hour) => {
    if (hour >= cutoff) next.set(hour, bucket);
  });
  return next;
}

// ── Immutable bucket update ────────────────────────────────────────

function updateBucket(patch: Readonly<{
  inTok?: number;
  outTok?: number;
  cost?: number;
  saved?: number;
  missions?: number;
}>): void {
  const hour = currentHourMs();
  const existing = _buckets.get(hour) ?? { hour, inTok: 0, outTok: 0, cost: 0, saved: 0, missions: 0 };
  const updated: HourBucket = {
    hour,
    inTok:    existing.inTok    + (patch.inTok    ?? 0),
    outTok:   existing.outTok   + (patch.outTok   ?? 0),
    cost:     existing.cost     + (patch.cost     ?? 0),
    saved:    existing.saved    + (patch.saved    ?? 0),
    missions: existing.missions + (patch.missions ?? 0),
  };
  const next = new Map(_buckets);
  next.set(hour, updated);
  _buckets = pruneBuckets(next);
  notifyListeners();
  scheduleSave();
}

// ── Initialize on module load ──────────────────────────────────────

loadFromStorage().then(() => {
  notifyListeners();
}).catch(() => {
  // silent: proceed with empty state
});

// ── Public API ─────────────────────────────────────────────────────

export function recordUsage(r: {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}): void {
  updateBucket({ inTok: r.inputTokens, outTok: r.outputTokens, cost: r.costUsd });
}

export function recordBrainSavings(tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  updateBucket({ saved: Math.round(tokens) });
}

export function recordMissionCompleted(): void {
  updateBucket({ missions: 1 });
}

export function subscribeUsageHistory(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Test helper — clears all in-memory state and cancels pending saves. */
export function __resetUsageHistory(): void {
  _buckets = new Map();
  if (_saveTimer !== null) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  notifyListeners();
}

// ── Sparkline builders ─────────────────────────────────────────────

/** Hourly sparkline for 'today': one point per hour from midnight to now. */
function buildHourlySparkline(
  fromMs: number,
  buckets: HourBucket[],
  key: 'tokens' | 'cost',
): number[] {
  if (buckets.length === 0) return [];
  const now = Date.now();
  const startHour = Math.floor(fromMs / MS_PER_HOUR) * MS_PER_HOUR;
  const endHour = Math.floor(now / MS_PER_HOUR) * MS_PER_HOUR;
  const bucketMap = new Map(buckets.map((b) => [b.hour, b]));
  const result: number[] = [];
  for (let h = startHour; h <= endHour; h += MS_PER_HOUR) {
    const b = bucketMap.get(h);
    result.push(b ? (key === 'tokens' ? b.inTok + b.outTok : b.cost) : 0);
  }
  return result;
}

/** Daily sparkline for '7d': exactly 7 points (one per day, oldest to newest). */
function buildSevenDaySparkline(
  buckets: HourBucket[],
  key: 'tokens' | 'cost',
): number[] {
  if (buckets.length === 0) return [];
  const dayMap = new Map<number, number>();
  for (const b of buckets) {
    const day = floorToDayMs(b.hour);
    const val = key === 'tokens' ? b.inTok + b.outTok : b.cost;
    dayMap.set(day, (dayMap.get(day) ?? 0) + val);
  }
  const todayStart = floorToDayMs(Date.now());
  const result: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = todayStart - i * MS_PER_DAY;
    result.push(dayMap.get(day) ?? 0);
  }
  return result;
}

/** Daily sparkline for 'all': up to maxDays most-recent daily totals. */
function buildAllDailySparkline(
  buckets: HourBucket[],
  key: 'tokens' | 'cost',
  maxDays: number,
): number[] {
  if (buckets.length === 0) return [];
  const dayMap = new Map<number, number>();
  for (const b of buckets) {
    const day = floorToDayMs(b.hour);
    const val = key === 'tokens' ? b.inTok + b.outTok : b.cost;
    dayMap.set(day, (dayMap.get(day) ?? 0) + val);
  }
  const sortedDays = Array.from(dayMap.keys()).sort((a, b) => a - b);
  const recentDays = sortedDays.slice(-maxDays);
  return recentDays.map((d) => dayMap.get(d) ?? 0);
}

// ── getWindowMetrics ───────────────────────────────────────────────

export function getWindowMetrics(window: UsageWindow): WindowMetrics {
  const now = Date.now();
  const allBuckets = Array.from(_buckets.values());

  let filtered: HourBucket[];
  let tokenSparkline: number[];
  let costSparkline: number[];

  switch (window) {
    case 'today': {
      const midnight = localMidnightMs();
      filtered = allBuckets.filter((b) => b.hour >= midnight);
      tokenSparkline = buildHourlySparkline(midnight, filtered, 'tokens');
      costSparkline  = buildHourlySparkline(midnight, filtered, 'cost');
      break;
    }
    case '7d': {
      // Align with buildSevenDaySparkline: same 7 calendar days (D-6 … D-0).
      const sevenDayStart = floorToDayMs(now) - 6 * MS_PER_DAY;
      filtered = allBuckets.filter((b) => b.hour >= sevenDayStart);
      tokenSparkline = buildSevenDaySparkline(filtered, 'tokens');
      costSparkline  = buildSevenDaySparkline(filtered, 'cost');
      break;
    }
    default: /* 'all' */ {
      filtered = allBuckets;
      tokenSparkline = buildAllDailySparkline(filtered, 'tokens', 30);
      costSparkline  = buildAllDailySparkline(filtered, 'cost', 30);
      break;
    }
  }

  const inputTokens       = filtered.reduce((s, b) => s + b.inTok,    0);
  const outputTokens      = filtered.reduce((s, b) => s + b.outTok,   0);
  const costUsd           = filtered.reduce((s, b) => s + b.cost,     0);
  const brainTokensSaved  = filtered.reduce((s, b) => s + b.saved,    0);
  const missionsCompleted = filtered.reduce((s, b) => s + b.missions, 0);

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    brainTokensSaved,
    missionsCompleted,
    tokenSparkline,
    costSparkline,
    bucketCount: filtered.length,
  };
}
