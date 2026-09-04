/**
 * Tests for canvasRefIntegrity.ts (P0 crash, round 3) — the pure
 * dedupe/sanitize functions canvasStore.ts's `addProposalPreview`/`hydrate`
 * call at their materialization boundaries. See that module's own header
 * for the full mechanism this closes.
 */

import { describe, it, expect } from 'vitest';
import { ensureUniqueCanvasRefs, sanitizeCanvasPositions, MAX_SANE_CANVAS_COORD } from '../components/agents/canvas/canvasRefIntegrity';
import { makeRef, type Chain, type DraftSpec, type JoinSpec } from '../components/agents/canvas/canvasTypes';

function idFactory(): (prefix: string) => string {
  let counter = 0;
  return (prefix: string) => {
    counter += 1;
    return `${prefix}-fresh${counter}`;
  };
}

describe('ensureUniqueCanvasRefs', () => {
  it('is a no-op when every draft/join id is already unique', () => {
    const drafts: DraftSpec[] = [
      { id: 'a', title: 'A', task: 'x', createdBy: 'manager' },
      { id: 'b', title: 'B', task: 'x', createdBy: 'manager' },
    ];
    const result = ensureUniqueCanvasRefs({ drafts, joins: [], chains: [] }, idFactory());
    expect(result.renamed.size).toBe(0);
    expect(result.drafts).toEqual(drafts);
  });

  it('renames the SECOND draft when two drafts share an id, leaving the first untouched', () => {
    const drafts: DraftSpec[] = [
      { id: 'audit', title: 'First', task: 'x', createdBy: 'manager', proposedPlanId: 'planA' },
      { id: 'audit', title: 'Second', task: 'x', createdBy: 'manager', proposedPlanId: 'planB' },
    ];
    const result = ensureUniqueCanvasRefs({ drafts, joins: [], chains: [] }, idFactory());

    expect(result.drafts[0]).toEqual(drafts[0]); // first occupant, byte-for-byte untouched
    expect(result.drafts[1].id).toBe('draft-fresh1');
    expect(result.drafts[1].title).toBe('Second'); // every OTHER field preserved — repair, not replace
    expect(result.renamed.get(makeRef('draft', 'audit'))).toBe(makeRef('draft', 'draft-fresh1'));
  });

  it('rewrites chain sourceRef/targetRef and join sourceRefs that share the RENAMED draft\'s own scope (no proposedPlanId — the legacy/materialized case)', () => {
    const drafts: DraftSpec[] = [
      { id: 'audit', title: 'First', task: 'x', createdBy: 'manager' },
      { id: 'audit', title: 'Second', task: 'x', createdBy: 'manager' },
    ];
    const chains: Chain[] = [
      { id: 'c1', sourceRef: makeRef('draft', 'audit'), targetRef: makeRef('draft', 'other'), condition: 'success', createdBy: 'manager' },
    ];
    const joins: JoinSpec[] = [
      { id: 'j1', sourceRefs: [makeRef('draft', 'audit'), makeRef('draft', 'other')], mode: 'all_success' },
    ];

    const result = ensureUniqueCanvasRefs({ drafts, joins, chains }, idFactory());
    const newRef = makeRef('draft', result.drafts[1].id);

    // Both drafts (and the chain/join) share the SAME scope — undefined
    // proposedPlanId, i.e. "no plan" — so the rewrite applies here.
    expect(result.chains[0].sourceRef).toBe(newRef);
    expect(result.joins[0].sourceRefs).toContain(newRef);
    expect(result.joins[0].sourceRefs).toContain(makeRef('draft', 'other')); // untouched sibling ref
  });

  it('NEVER lets a rename in one plan leak into an unrelated chain from a DIFFERENT plan that happens to reuse the same old ref string', () => {
    const drafts: DraftSpec[] = [
      { id: 'audit', title: 'Plan A\'s audit', task: 'x', createdBy: 'manager', proposedPlanId: 'planA' },
      { id: 'audit', title: 'Plan B\'s audit', task: 'x', createdBy: 'manager', proposedPlanId: 'planB' }, // collides, renamed
    ];
    const chains: Chain[] = [
      // Plan A's OWN chain into ITS OWN "audit" draft — must stay exactly
      // as it was: plan A's draft never moved, only plan B's did.
      { id: 'ca', sourceRef: makeRef('draft', 'audit'), targetRef: makeRef('draft', 'a-sink'), condition: 'success', createdBy: 'manager', proposedPlanId: 'planA' },
      // Plan B's OWN chain into ITS OWN "audit" draft — must follow the
      // rename (irToProposedCanvas always stamps a plan's chains with the
      // SAME proposedPlanId as that plan's own drafts).
      { id: 'cb', sourceRef: makeRef('draft', 'audit'), targetRef: makeRef('draft', 'b-sink'), condition: 'success', createdBy: 'manager', proposedPlanId: 'planB' },
    ];

    const result = ensureUniqueCanvasRefs({ drafts, joins: [], chains }, idFactory());
    const planBNewRef = makeRef('draft', result.drafts[1].id);

    expect(result.chains.find((c) => c.id === 'ca')!.sourceRef).toBe(makeRef('draft', 'audit')); // plan A untouched
    expect(result.chains.find((c) => c.id === 'cb')!.sourceRef).toBe(planBNewRef); // plan B follows its own draft's rename
  });

  it('dedupes colliding JOIN ids the same way', () => {
    const joins: JoinSpec[] = [
      { id: 'j1', sourceRefs: [], mode: 'all_success', proposedPlanId: 'planA' },
      { id: 'j1', sourceRefs: [], mode: 'all_success', proposedPlanId: 'planB' },
    ];
    const result = ensureUniqueCanvasRefs({ drafts: [], joins, chains: [] }, idFactory());
    expect(result.joins[0].id).toBe('j1');
    expect(result.joins[1].id).toBe('join-fresh1');
    expect(result.renamed.get(makeRef('join', 'j1'))).toBe(makeRef('join', 'join-fresh1'));
  });

  it('a third collision on the same id gets its own fresh id, never reused', () => {
    const drafts: DraftSpec[] = [
      { id: 'audit', title: 'First', task: 'x', createdBy: 'manager' },
      { id: 'audit', title: 'Second', task: 'x', createdBy: 'manager' },
      { id: 'audit', title: 'Third', task: 'x', createdBy: 'manager' },
    ];
    const result = ensureUniqueCanvasRefs({ drafts, joins: [], chains: [] }, idFactory());
    const ids = result.drafts.map((d) => d.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('sanitizeCanvasPositions', () => {
  it('is a no-op when every position is within bounds', () => {
    const positions = { [makeRef('draft', 'a')]: { x: 100, y: 200 } };
    const result = sanitizeCanvasPositions(positions);
    expect(result.droppedRefs).toEqual([]);
    expect(result.positions).toEqual(positions);
  });

  it('drops a position beyond MAX_SANE_CANVAS_COORD without inventing a replacement', () => {
    const drifted = makeRef('draft', 'drifted');
    const normal = makeRef('draft', 'normal');
    const positions = {
      [drifted]: { x: 337196, y: 36 },
      [normal]: { x: 120, y: 80 },
    };
    const result = sanitizeCanvasPositions(positions);
    expect(result.droppedRefs).toEqual([drifted]);
    expect(result.positions[drifted]).toBeUndefined();
    expect(result.positions[normal]).toEqual({ x: 120, y: 80 });
  });

  it('drops a non-finite coordinate', () => {
    const bad = makeRef('draft', 'bad');
    const result = sanitizeCanvasPositions({ [bad]: { x: NaN, y: 0 } });
    expect(result.droppedRefs).toEqual([bad]);
  });

  it('keeps a position exactly at the bound (inclusive)', () => {
    const ref = makeRef('draft', 'edge');
    const result = sanitizeCanvasPositions({ [ref]: { x: MAX_SANE_CANVAS_COORD, y: 0 } });
    expect(result.droppedRefs).toEqual([]);
  });
});
