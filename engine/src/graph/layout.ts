/**
 * Deterministic force-directed 2-D layout for the brain graph.
 *
 * Design constraints:
 *  - Zero npm dependencies — pure TypeScript arithmetic only.
 *  - Math.random is forbidden in this repo. All randomness goes through seededPrng().
 *  - Two runs on identical input produce byte-identical positions.
 *  - O(n^2) repulsion is acceptable up to ~2500 nodes; grid-buckets applied above that.
 *  - Cluster-aware initialisation: nodes start on a circle per cluster so the
 *    layout converges faster and clusters stay visually separated.
 *  - Target runtime: < 10 s at 2000 nodes (typically < 2 s).
 */

export interface LayoutNode {
  id: string;
  cluster: string;
  degree: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

export interface LayoutPosition {
  x: number;
  y: number;
}

export interface LayoutResult {
  positions: Map<string, LayoutPosition>;
  /** ms elapsed */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// PRNG — Park-Miller LCG (deterministic, seed-based)
// ---------------------------------------------------------------------------

/**
 * Returns a pseudo-random number generator function seeded with `seed`.
 * Output is in [0, 1). Follows the Park-Miller algorithm (mod 2^31 - 1).
 * @param seed  integer seed; 0 is replaced by 1
 */
export function seededPrng(seed: number): () => number {
  let state = (Math.abs(Math.floor(seed)) || 1) % 2147483647;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAYOUT_SEED = 0xdeadbeef;
const DEFAULT_ITERATIONS = 130;
const REPULSION_K = 40_000;
const ATTRACTION_K = 0.05;
const DAMPING = 0.85;
const CENTER_GRAVITY = 0.003;
const CANVAS_HALF = 5000;
// Switch to grid-bucket repulsion above this node count
const GRID_BUCKET_THRESHOLD = 1200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Cluster-aware circle initialisation
// ---------------------------------------------------------------------------

function initPositions(
  nodes: LayoutNode[],
  rand: () => number,
): Map<string, { x: number; y: number; vx: number; vy: number }> {
  const clusters = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const existing = clusters.get(n.cluster) ?? [];
    clusters.set(n.cluster, [...existing, i]);
  });

  const clusterList = Array.from(clusters.keys());
  const clusterCount = clusterList.length;
  const positions = new Map<string, { x: number; y: number; vx: number; vy: number }>();

  // Place cluster centres on an outer circle
  const outerRadius = CANVAS_HALF * 0.55;
  const clusterCentres = new Map<string, { cx: number; cy: number }>();
  clusterList.forEach((label, ci) => {
    const angle = (2 * Math.PI * ci) / Math.max(clusterCount, 1);
    clusterCentres.set(label, {
      cx: outerRadius * Math.cos(angle),
      cy: outerRadius * Math.sin(angle),
    });
  });

  // Within each cluster, place nodes on a smaller circle with jitter
  for (const [label, indices] of clusters) {
    const centre = clusterCentres.get(label) ?? { cx: 0, cy: 0 };
    const r = Math.min(CANVAS_HALF * 0.35, 300 + indices.length * 12);

    indices.forEach((i, li) => {
      const angle = (2 * Math.PI * li) / Math.max(indices.length, 1);
      const jitter = (rand() - 0.5) * r * 0.25;
      positions.set(nodes[i].id, {
        x: centre.cx + r * Math.cos(angle) + jitter,
        y: centre.cy + r * Math.sin(angle) + jitter,
        vx: 0,
        vy: 0,
      });
    });
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Repulsion — direct O(n^2) for small graphs
// ---------------------------------------------------------------------------

function applyRepulsionDirect(
  nodes: LayoutNode[],
  state: Map<string, { x: number; y: number; vx: number; vy: number }>,
): void {
  for (let i = 0; i < nodes.length; i++) {
    const a = state.get(nodes[i].id)!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = state.get(nodes[j].id)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist2 = dx * dx + dy * dy || 1;
      const f = REPULSION_K / dist2;
      const dist = Math.sqrt(dist2);
      const nx = dx / dist;
      const ny = dy / dist;
      a.vx += nx * f;
      a.vy += ny * f;
      b.vx -= nx * f;
      b.vy -= ny * f;
    }
  }
}

// ---------------------------------------------------------------------------
// Repulsion — grid-bucket O(n * bucket) for larger graphs
// ---------------------------------------------------------------------------

interface GridCell {
  indices: number[];
}

function buildGrid(
  nodes: LayoutNode[],
  state: Map<string, { x: number; y: number; vx: number; vy: number }>,
  cellSize: number,
): { grid: Map<string, GridCell>; cellSize: number } {
  const grid = new Map<string, GridCell>();
  nodes.forEach((n, i) => {
    const pos = state.get(n.id)!;
    const gx = Math.floor(pos.x / cellSize);
    const gy = Math.floor(pos.y / cellSize);
    const key = `${gx},${gy}`;
    const existing = grid.get(key) ?? { indices: [] };
    grid.set(key, { indices: [...existing.indices, i] });
  });
  return { grid, cellSize };
}

function applyRepulsionGrid(
  nodes: LayoutNode[],
  state: Map<string, { x: number; y: number; vx: number; vy: number }>,
): void {
  const cellSize = Math.sqrt(REPULSION_K) * 0.7;
  const { grid } = buildGrid(nodes, state, cellSize);

  nodes.forEach((n, i) => {
    const a = state.get(n.id)!;
    const gx = Math.floor(a.x / cellSize);
    const gy = Math.floor(a.y / cellSize);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${gx + dx},${gy + dy}`);
        if (!cell) continue;
        for (const j of cell.indices) {
          if (j <= i) continue;
          const b = state.get(nodes[j].id)!;
          const ddx = a.x - b.x;
          const ddy = a.y - b.y;
          const dist2 = ddx * ddx + ddy * ddy || 1;
          const f = REPULSION_K / dist2;
          const dist = Math.sqrt(dist2);
          a.vx += (ddx / dist) * f;
          a.vy += (ddy / dist) * f;
          const bState = state.get(nodes[j].id)!;
          bState.vx -= (ddx / dist) * f;
          bState.vy -= (ddy / dist) * f;
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Attraction along edges
// ---------------------------------------------------------------------------

function applyAttraction(
  edges: LayoutEdge[],
  state: Map<string, { x: number; y: number; vx: number; vy: number }>,
): void {
  for (const edge of edges) {
    const a = state.get(edge.source);
    const b = state.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const f = dist * ATTRACTION_K;
    const nx = dx / dist;
    const ny = dy / dist;
    a.vx += nx * f;
    a.vy += ny * f;
    b.vx -= nx * f;
    b.vy -= ny * f;
  }
}

// ---------------------------------------------------------------------------
// Integrate — apply velocities, damping, centre gravity, clamp
// ---------------------------------------------------------------------------

function integrate(
  nodes: LayoutNode[],
  state: Map<string, { x: number; y: number; vx: number; vy: number }>,
): void {
  for (const node of nodes) {
    const s = state.get(node.id)!;
    s.vx = s.vx * DAMPING + (0 - s.x) * CENTER_GRAVITY;
    s.vy = s.vy * DAMPING + (0 - s.y) * CENTER_GRAVITY;
    s.x = clamp(s.x + s.vx, -CANVAS_HALF, CANVAS_HALF);
    s.y = clamp(s.y + s.vy, -CANVAS_HALF, CANVAS_HALF);
  }
}

// ---------------------------------------------------------------------------
// Normalise: fit positions into [-1000, 1000] × [-1000, 1000]
// ---------------------------------------------------------------------------

function normalise(positions: Map<string, LayoutPosition>): Map<string, LayoutPosition> {
  if (positions.size === 0) return positions;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const { x, y } of positions.values()) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  const scale = 2000 / Math.max(rangeX, rangeY);

  const result = new Map<string, LayoutPosition>();
  for (const [id, pos] of positions) {
    result.set(id, {
      x: Math.round(((pos.x - (minX + maxX) / 2) * scale) / 10) * 10,
      y: Math.round(((pos.y - (minY + maxY) / 2) * scale) / 10) * 10,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  iterations?: number;
  seed?: number;
}

/**
 * Compute a deterministic 2-D layout for the given nodes and edges.
 *
 * Positions are normalised to approximately ±1000 units and rounded to the
 * nearest 10 units to keep JSON output stable across floating-point implementations.
 *
 * @param nodes  - nodes with id, cluster label, and precomputed degree
 * @param edges  - directed edges (source, target)
 * @param opts   - optional overrides (iterations, seed)
 */
export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOptions = {},
): LayoutResult {
  const t0 = Date.now();
  const seed = opts.seed ?? LAYOUT_SEED;
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;

  if (nodes.length === 0) {
    return { positions: new Map(), elapsedMs: 0 };
  }

  const rand = seededPrng(seed);
  const state = initPositions(nodes, rand);

  const useGrid = nodes.length > GRID_BUCKET_THRESHOLD;

  for (let iter = 0; iter < iterations; iter++) {
    if (useGrid) {
      applyRepulsionGrid(nodes, state);
    } else {
      applyRepulsionDirect(nodes, state);
    }
    applyAttraction(edges, state);
    integrate(nodes, state);
  }

  // Extract raw positions
  const rawPositions = new Map<string, LayoutPosition>();
  for (const node of nodes) {
    const s = state.get(node.id)!;
    rawPositions.set(node.id, { x: s.x, y: s.y });
  }

  const positions = normalise(rawPositions);
  return { positions, elapsedMs: Date.now() - t0 };
}
