import { describe, expect, it } from 'vitest';
import { type LayoutEdge, type LayoutNode, computeLayout, seededPrng } from '../layout.js';

// ---------------------------------------------------------------------------
// PRNG tests
// ---------------------------------------------------------------------------

describe('seededPrng', () => {
  it('produces values in [0, 1)', () => {
    const rand = seededPrng(42);
    for (let i = 0; i < 1000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is deterministic: same seed → same sequence', () => {
    const seqA = Array.from({ length: 20 }, seededPrng(12345));
    const seqB = Array.from({ length: 20 }, seededPrng(12345));
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different sequences', () => {
    const seqA = Array.from({ length: 10 }, seededPrng(1));
    const seqB = Array.from({ length: 10 }, seededPrng(2));
    expect(seqA).not.toEqual(seqB);
  });

  it('seed=0 is handled gracefully (falls back to 1)', () => {
    const rand = seededPrng(0);
    const first = rand();
    expect(Number.isFinite(first)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeLayout: determinism
// ---------------------------------------------------------------------------

function makeLinearGraph(n: number): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const nodes: LayoutNode[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    cluster: `c${i % 3}`,
    degree: 2,
  }));
  const edges: LayoutEdge[] = Array.from({ length: n - 1 }, (_, i) => ({
    source: `n${i}`,
    target: `n${i + 1}`,
  }));
  return { nodes, edges };
}

describe('computeLayout — determinism', () => {
  it('two runs on identical input produce identical positions', () => {
    const { nodes, edges } = makeLinearGraph(50);
    const r1 = computeLayout(nodes, edges, { iterations: 20 });
    const r2 = computeLayout(nodes, edges, { iterations: 20 });

    for (const node of nodes) {
      expect(r1.positions.get(node.id)).toEqual(r2.positions.get(node.id));
    }
  });

  it('different seeds produce different layouts', () => {
    const { nodes, edges } = makeLinearGraph(30);
    const rA = computeLayout(nodes, edges, { iterations: 20, seed: 1 });
    const rB = computeLayout(nodes, edges, { iterations: 20, seed: 9999 });

    let diffCount = 0;
    for (const node of nodes) {
      const pA = rA.positions.get(node.id)!;
      const pB = rB.positions.get(node.id)!;
      if (pA.x !== pB.x || pA.y !== pB.y) diffCount++;
    }
    expect(diffCount).toBeGreaterThan(nodes.length / 2);
  });
});

// ---------------------------------------------------------------------------
// computeLayout: sane spread (no NaN, no all-at-origin)
// ---------------------------------------------------------------------------

describe('computeLayout — sane spread', () => {
  it('no position is NaN', () => {
    const { nodes, edges } = makeLinearGraph(60);
    const { positions } = computeLayout(nodes, edges, { iterations: 30 });
    for (const node of nodes) {
      const p = positions.get(node.id)!;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('not all nodes at origin', () => {
    const { nodes, edges } = makeLinearGraph(40);
    const { positions } = computeLayout(nodes, edges, { iterations: 30 });
    const atOrigin = Array.from(positions.values()).filter((p) => p.x === 0 && p.y === 0);
    expect(atOrigin.length).toBeLessThan(nodes.length);
  });

  it('positions are spread across the canvas', () => {
    const { nodes, edges } = makeLinearGraph(80);
    const { positions } = computeLayout(nodes, edges, { iterations: 50 });
    const xs = Array.from(positions.values()).map((p) => p.x);
    const ys = Array.from(positions.values()).map((p) => p.y);
    const rangeX = Math.max(...xs) - Math.min(...xs);
    const rangeY = Math.max(...ys) - Math.min(...ys);
    expect(rangeX).toBeGreaterThan(100);
    expect(rangeY).toBeGreaterThan(100);
  });

  it('empty graph returns empty positions', () => {
    const { positions, elapsedMs } = computeLayout([], [], {});
    expect(positions.size).toBe(0);
    expect(elapsedMs).toBe(0);
  });

  it('single node layout returns one position', () => {
    const nodes: LayoutNode[] = [{ id: 'solo', cluster: 'a', degree: 0 }];
    const { positions } = computeLayout(nodes, [], {});
    expect(positions.size).toBe(1);
    const p = positions.get('solo')!;
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeLayout: runtime budget
// ---------------------------------------------------------------------------

describe('computeLayout — runtime budget', () => {
  it('completes 2000 nodes in < 10 s', { timeout: 15_000 }, () => {
    // Build a star topology with 2000 nodes (1 hub + 1999 leaves)
    const n = 2000;
    const nodes: LayoutNode[] = [{ id: 'hub', cluster: 'core', degree: n - 1 }];
    for (let i = 1; i < n; i++) {
      nodes.push({ id: `leaf${i}`, cluster: `c${i % 8}`, degree: 1 });
    }
    const edges: LayoutEdge[] = nodes.slice(1).map((node) => ({
      source: 'hub',
      target: node.id,
    }));

    const { elapsedMs } = computeLayout(nodes, edges, { iterations: 130 });
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
