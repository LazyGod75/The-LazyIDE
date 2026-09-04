/**
 * Tests for chainValidation.ts — pure "can source chain to target" checks
 * (spec §7 loop-target rejection, §5 cycle rejection). No React, no store.
 */

import { describe, it, expect } from 'vitest';
import { validateChain, validateJoinSources, type JoinSourcesCandidate } from '../components/agents/canvas/chainValidation';
import { makeRef, type Chain } from '../components/agents/canvas/canvasTypes';

function chain(overrides: Partial<Chain> & { id: string; sourceRef: string; targetRef: string }): Chain {
  return { condition: 'success', createdBy: 'user', ...overrides };
}

describe('validateChain', () => {
  it('rejects a self-chain', () => {
    const ref = makeRef('draft', 'd1');
    const result = validateChain([], ref, ref, { kind: 'draft' });
    expect(result.ok).toBe(false);
  });

  it('rejects a chain into a loop node', () => {
    const source = makeRef('mission', 'm1');
    const target = makeRef('loop', 'loop1');
    const result = validateChain([], source, target, { kind: 'loop' });
    expect(result.ok).toBe(false);
  });

  it('accepts a chain into a draft', () => {
    const source = makeRef('mission', 'm1');
    const target = makeRef('draft', 'd1');
    expect(validateChain([], source, target, { kind: 'draft' })).toEqual({ ok: true });
  });

  it('accepts a chain into a QUEUED mission', () => {
    const source = makeRef('mission', 'm1');
    const target = makeRef('mission', 'm2');
    const result = validateChain([], source, target, { kind: 'mission', missionStatus: 'queued' });
    expect(result).toEqual({ ok: true });
  });

  it('rejects a chain into a RUNNING mission', () => {
    const source = makeRef('mission', 'm1');
    const target = makeRef('mission', 'm2');
    const result = validateChain([], source, target, { kind: 'mission', missionStatus: 'running' });
    expect(result.ok).toBe(false);
  });

  it('rejects a chain into a DONE mission', () => {
    const source = makeRef('mission', 'm1');
    const target = makeRef('mission', 'm2');
    const result = validateChain([], source, target, { kind: 'mission', missionStatus: 'done' });
    expect(result.ok).toBe(false);
  });

  it('rejects a chain into a project/schedule/note ref kind', () => {
    const source = makeRef('mission', 'm1');
    const target = makeRef('note', 'n1');
    const result = validateChain([], source, target, { kind: 'note' });
    expect(result.ok).toBe(false);
  });

  it('accepts a direct A -> B chain when no existing edges', () => {
    const a = makeRef('mission', 'a');
    const b = makeRef('draft', 'b');
    expect(validateChain([], a, b, { kind: 'draft' })).toEqual({ ok: true });
  });

  it('rejects a chain that would close a direct 2-cycle (B already chains to A)', () => {
    const a = makeRef('mission', 'a');
    const b = makeRef('mission', 'b');
    const existing: Chain[] = [chain({ id: 'c1', sourceRef: b, targetRef: a })];
    // A -> B would close A -> B -> A
    const result = validateChain(existing, a, b, { kind: 'mission', missionStatus: 'queued' });
    expect(result.ok).toBe(false);
  });

  it('rejects a chain that would close a longer transitive cycle (A -> B -> C -> A)', () => {
    const a = makeRef('mission', 'a');
    const b = makeRef('mission', 'b');
    const c = makeRef('mission', 'c');
    const existing: Chain[] = [
      chain({ id: 'c1', sourceRef: a, targetRef: b }),
      chain({ id: 'c2', sourceRef: b, targetRef: c }),
    ];
    // C -> A would close the cycle A -> B -> C -> A
    const result = validateChain(existing, c, a, { kind: 'mission', missionStatus: 'queued' });
    expect(result.ok).toBe(false);
  });

  it('a disabled existing chain still counts for cycle detection', () => {
    const a = makeRef('mission', 'a');
    const b = makeRef('mission', 'b');
    const existing: Chain[] = [chain({ id: 'c1', sourceRef: b, targetRef: a, disabled: true })];
    const result = validateChain(existing, a, b, { kind: 'mission', missionStatus: 'queued' });
    expect(result.ok).toBe(false);
  });

  it('does not reject an unrelated fan-out (A -> B and A -> C both allowed)', () => {
    const a = makeRef('mission', 'a');
    const b = makeRef('draft', 'b');
    const c = makeRef('draft', 'c');
    const existing: Chain[] = [chain({ id: 'c1', sourceRef: a, targetRef: b })];
    const result = validateChain(existing, a, c, { kind: 'draft' });
    expect(result).toEqual({ ok: true });
  });

  // ── W-JOIN — a join is a legal chain target AND source ───────────────

  it('accepts a chain into a join (fan-in target)', () => {
    const source = makeRef('mission', 'm1');
    const target = makeRef('join', 'j1');
    expect(validateChain([], source, target, { kind: 'join' })).toEqual({ ok: true });
  });

  it('accepts a chain FROM a join (its one outgoing edge)', () => {
    const source = makeRef('join', 'j1');
    const target = makeRef('draft', 'd1');
    expect(validateChain([], source, target, { kind: 'draft' })).toEqual({ ok: true });
  });
});

describe('validateJoinSources', () => {
  it('rejects fewer than MIN_JOIN_SOURCES (2) sources', () => {
    const result = validateJoinSources([], [], 'j1', [makeRef('mission', 'm1')]);
    expect(result.ok).toBe(false);
  });

  it('accepts exactly 2 sources with no existing graph', () => {
    const sources = [makeRef('mission', 'm1'), makeRef('mission', 'm2')];
    expect(validateJoinSources([], [], 'j1', sources)).toEqual({ ok: true });
  });

  it('rejects a source that is the join itself', () => {
    const sources = [makeRef('mission', 'm1'), makeRef('join', 'j1')];
    const result = validateJoinSources([], [], 'j1', sources);
    expect(result.ok).toBe(false);
  });

  it('rejects a source that can already reach the join through the chain graph (would close a cycle)', () => {
    // join j1's outgoing chain already feeds mission-target m2 (a queued
    // mission-shaped ref is enough here — canReachJoin only walks strings).
    const chains: Chain[] = [chain({ id: 'c1', sourceRef: makeRef('join', 'j1'), targetRef: makeRef('draft', 'd1') })];
    const chainsToD1Feed: Chain[] = [...chains, chain({ id: 'c2', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('mission', 'm-bad') })];
    // Wiring join j1 FROM m-bad would close j1 -> d1 -> m-bad -> j1.
    const result = validateJoinSources(chainsToD1Feed, [], 'j1', [makeRef('mission', 'm1'), makeRef('mission', 'm-bad')]);
    expect(result.ok).toBe(false);
  });

  it('rejects a source that can reach the join through ANOTHER join\'s own sourceRefs (fan-in-only cycle, invisible to the chains array alone)', () => {
    // join j2 already has j1 as one of its own fan-in sources (j1 -> j2 via
    // JoinSpec.sourceRefs, not a Chain object) and j2's outgoing chain feeds
    // mission-shaped ref m-bad. Wiring j1 FROM m-bad would close
    // j1 -> j2 -> m-bad -> j1 even though no single Chain embodies the
    // j1 -> j2 leg.
    const otherJoins: JoinSourcesCandidate[] = [{ id: 'j2', sourceRefs: [makeRef('join', 'j1'), makeRef('mission', 'other')] }];
    const chains: Chain[] = [chain({ id: 'c1', sourceRef: makeRef('join', 'j2'), targetRef: makeRef('mission', 'm-bad') })];
    const result = validateJoinSources(chains, otherJoins, 'j1', [makeRef('mission', 'm1'), makeRef('mission', 'm-bad')]);
    expect(result.ok).toBe(false);
  });

  it('does not reject an unrelated join co-existing in the graph', () => {
    const otherJoins: JoinSourcesCandidate[] = [{ id: 'j2', sourceRefs: [makeRef('mission', 'x'), makeRef('mission', 'y')] }];
    const sources = [makeRef('mission', 'm1'), makeRef('mission', 'm2')];
    expect(validateJoinSources([], otherJoins, 'j1', sources)).toEqual({ ok: true });
  });
});
