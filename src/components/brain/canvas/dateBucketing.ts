/* dateBucketing.ts — derives the 0..7 "dateIdx" time-travel bucket used by
   the Brain Canvas time-travel slider (see the handoff's `visible(nn)`:
   `dateIdx <= timeIdx`).

   The bulk graph endpoint the app fetches from today (BrainGraphNode /
   LbGraphNode, see src/lib/platform/tauri.ts) does not expose a per-node
   timestamp — only a single note's metadata (note()/BrainNoteMeta.created)
   does, fetched on demand for the currently selected node, not for the
   whole graph. Rewriting that contract is explicitly out of scope for this
   change ("ne pas réécrire la couche données").

   So bucketing here is deliberately hybrid and pure:
   - Items that DO carry a parseable `createdAt` are ordered chronologically
     and split into even quantiles across the 8 buckets — genuinely "derived
     from real note timestamps" the day the graph endpoint starts sending
     them, with zero call-site changes required.
   - Items without one fall back to a stable hash of their id, so the
     timeline still spreads deterministically across all 8 buckets instead
     of collapsing everything into a single "unknown" slot — the "sensible
     bucketing" the design calls out explicitly for the mock/web-demo path,
     and in practice also for real desktop data today.
*/

export const TIME_BUCKET_COUNT = 8;

export interface DateBucketInput {
  id: string;
  /** ISO-ish timestamp string, when known. Absent/unparseable → hash fallback. */
  createdAt?: string | null;
}

/**
 * Stable 32-bit FNV-1a style hash of a string. Deterministic and
 * allocation-free; used to seed both date bucketing and node layout so the
 * same node id always maps to the same value across re-renders/filters.
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic bucket for an id with no timestamp context available. */
export function hashDateBucket(id: string): number {
  return hashString(id) % TIME_BUCKET_COUNT;
}

interface DatedEntry {
  id: string;
  t: number;
}

/**
 * Splits raw items into { dated (sorted oldest -> newest), undated }.
 * Shared by assignDateBuckets and buildDateAxis so both derive buckets and
 * boundary dates from the exact same chronological ordering.
 */
function splitDated(items: readonly DateBucketInput[]): {
  dated: DatedEntry[];
  undated: DateBucketInput[];
} {
  const dated: DatedEntry[] = [];
  const undated: DateBucketInput[] = [];

  for (const item of items) {
    const t = item.createdAt ? Date.parse(item.createdAt) : Number.NaN;
    if (Number.isFinite(t)) {
      dated.push({ id: item.id, t });
    } else {
      undated.push(item);
    }
  }

  dated.sort((a, b) => a.t - b.t);
  return { dated, undated };
}

/**
 * Assigns a 0..TIME_BUCKET_COUNT-1 bucket to every input item.
 *
 * Items with a parseable `createdAt` are sorted oldest → newest and split
 * across the full 0..TIME_BUCKET_COUNT-1 range by chronological rank
 * (oldest -> bucket 0, newest -> bucket TIME_BUCKET_COUNT-1, regardless of
 * how many dated items there are) so dragging the time-travel slider to
 * either end always reveals the true chronological extremes. Items
 * without a timestamp fall back to `hashDateBucket`. Pure function — same
 * input always produces the same Map, safe to call on every adapt (no
 * hidden state).
 */
export function assignDateBuckets(items: readonly DateBucketInput[]): Map<string, number> {
  const buckets = new Map<string, number>();
  const { dated, undated } = splitDated(items);

  if (dated.length > 0) {
    const lastIndex = dated.length - 1;
    dated.forEach((entry, index) => {
      const bucket = lastIndex === 0 ? 0 : Math.round((index / lastIndex) * (TIME_BUCKET_COUNT - 1));
      buckets.set(entry.id, bucket);
    });
  }

  for (const item of undated) {
    buckets.set(item.id, hashDateBucket(item.id));
  }

  return buckets;
}

// ── Time-travel scrubber support ───────────────────────────────────────

export interface DateAxis {
  /** True when at least one item carries a parseable createdAt — i.e. the
   *  scrubber can show real calendar dates instead of generic "slice"
   *  labels. False for the mock/demo dataset and any legacy cached graph
   *  payload predating engine/src/server/routes/graph.ts's `created` field. */
  hasRealDates: boolean;
  /** Oldest parseable createdAt across all items (ISO string), or null. */
  minCreatedAt: string | null;
  /** Newest parseable createdAt across all items (ISO string), or null. */
  maxCreatedAt: string | null;
  /**
   * For each bucket k (0..TIME_BUCKET_COUNT-1): the newest createdAt among
   * dated items assigned to a bucket <= k (cumulative "as of" date), or
   * null if no dated item falls at or before that bucket. Powers the
   * scrubber's "<= <date>" label without re-deriving it on every drag.
   */
  bucketDates: (string | null)[];
  /**
   * True when the real date range collapses to a single calendar day (a
   * fresh brain, or one imported without history) — scrubbing would have
   * nothing meaningful to reveal. Only meaningful when `hasRealDates` is
   * true; callers should disable the scrubber (with an explanatory
   * tooltip) exactly when `hasRealDates && isSingleDay`, and leave it
   * enabled — using the hash-fallback spread — when `!hasRealDates`.
   */
  isSingleDay: boolean;
}

const EMPTY_DATE_AXIS: DateAxis = {
  hasRealDates: false,
  minCreatedAt: null,
  maxCreatedAt: null,
  bucketDates: new Array(TIME_BUCKET_COUNT).fill(null) as (string | null)[],
  isSingleDay: false,
};

/**
 * Derives the real-date context the TimelineScrubber needs: whether real
 * dates exist at all, the min/max range, a per-bucket "as of" label date,
 * and whether the range is too narrow (same calendar day) to be worth
 * scrubbing. Pure function of `items` alone — safe to recompute once per
 * graph load and reuse for the lifetime of that data (see AdaptedBrainData.
 * dateAxis in lib/brain/brainAdapter.ts).
 */
export function buildDateAxis(items: readonly DateBucketInput[]): DateAxis {
  const { dated } = splitDated(items);
  if (dated.length === 0) return EMPTY_DATE_AXIS;

  const minCreatedAt = new Date(dated[0].t).toISOString();
  const maxCreatedAt = new Date(dated[dated.length - 1].t).toISOString();

  const bucketDates: (string | null)[] = new Array(TIME_BUCKET_COUNT).fill(null) as (string | null)[];
  const lastIndex = dated.length - 1;
  dated.forEach((entry, index) => {
    const bucket = lastIndex === 0 ? 0 : Math.round((index / lastIndex) * (TIME_BUCKET_COUNT - 1));
    // Later entries in chronological order only ever push the bucket's
    // "as of" date forward — dated is sorted oldest -> newest already.
    bucketDates[bucket] = new Date(entry.t).toISOString();
  });
  // Cumulative max so a bucket with no dated item of its own still reports
  // the newest date known "as of" that point (carried forward from the
  // last bucket that had one).
  for (let i = 1; i < bucketDates.length; i++) {
    if (bucketDates[i] === null) bucketDates[i] = bucketDates[i - 1];
  }

  return {
    hasRealDates: true,
    minCreatedAt,
    maxCreatedAt,
    bucketDates,
    isSingleDay: minCreatedAt.slice(0, 10) === maxCreatedAt.slice(0, 10),
  };
}

/**
 * Pure threshold filter mirroring the Brain Canvas render loop's per-frame
 * `node.visible = node.dateIdx <= timeIdx` gate (see BrainGraph3D.tsx) —
 * kept as a standalone, testable unit documenting that exact semantic. The
 * render loop itself does NOT call this (allocating a Set every animation
 * frame for up to ~3000 nodes would be wasteful); it inlines the same
 * comparison instead. Use this for anything off the hot path.
 */
export function visibleAtTimeIdx(
  items: readonly { id: string; dateIdx: number }[],
  timeIdx: number,
): Set<string> {
  const visible = new Set<string>();
  for (const item of items) {
    if (item.dateIdx <= timeIdx) visible.add(item.id);
  }
  return visible;
}
