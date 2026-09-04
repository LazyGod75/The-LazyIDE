/**
 * Tests for canvasMacros.ts — captureMacro/instantiateMacro (group macros,
 * Langflow parity). Pure-function tests: no store, no React.
 */

import { describe, it, expect } from 'vitest';
import { captureMacro, instantiateMacro, pendingOnlyRefs, siblingRectsInZone, storeOccupancyRects } from '../components/agents/canvas/canvasMacros';
import { makeRef, parseRef, type Chain, type DraftSpec, type NoteData, type RouterSpec } from '../components/agents/canvas/canvasTypes';
import { DEFAULT_NODE_SIZE, ROUTER_NODE_SIZE } from '../components/agents/canvas/reconciler';

function idFactorySeq(prefix: string, seq: { n: number }): string {
  seq.n += 1;
  return `${prefix}-${seq.n}`;
}

describe('pendingOnlyRefs', () => {
  it('keeps only draft/router/note refs, drops mission/loop/project refs', () => {
    const refs = [
      makeRef('draft', 'd1'),
      makeRef('mission', 'm1'),
      makeRef('router', 'r1'),
      makeRef('note', 'n1'),
      makeRef('loop', 'l1'),
      makeRef('project', 'p1'),
    ];
    expect(pendingOnlyRefs(refs)).toEqual([makeRef('draft', 'd1'), makeRef('router', 'r1'), makeRef('note', 'n1')]);
  });
});

describe('captureMacro', () => {
  const draft1: DraftSpec = { id: 'd1', title: 'Draft 1', task: 'do X', createdBy: 'user', projectId: 'proj-1' };
  const draft2: DraftSpec = { id: 'd2', title: 'Draft 2', task: 'do Y', createdBy: 'user', projectId: 'proj-1' };
  const note1: NoteData = { id: 'n1', text: 'hello', projectId: 'proj-1' };
  const router1: RouterSpec = {
    id: 'r1',
    projectId: 'proj-1',
    branches: [{ id: 'b1', label: 'ok', condition: { kind: 'default' } }],
  };
  const chainInternal: Chain = { id: 'c1', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('draft', 'd2'), condition: 'success', createdBy: 'user' };
  const chainToRouter: Chain = { id: 'c2', sourceRef: makeRef('draft', 'd2'), targetRef: makeRef('router', 'r1'), condition: 'success', createdBy: 'user' };
  const chainOutside: Chain = { id: 'c3', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'success', createdBy: 'user' };

  const source = {
    drafts: [draft1, draft2],
    routers: [router1],
    notes: [note1],
    chains: [chainInternal, chainToRouter, chainOutside],
    positions: {
      [makeRef('draft', 'd1')]: { x: 100, y: 100 },
      [makeRef('draft', 'd2')]: { x: 300, y: 100 },
      [makeRef('note', 'n1')]: { x: 100, y: 300 },
      [makeRef('router', 'r1')]: { x: 300, y: 300 },
      [makeRef('mission', 'm1')]: { x: 0, y: 0 },
    },
  };

  it('captures only pending refs among the selection', () => {
    const macro = captureMacro(source, [makeRef('draft', 'd1'), makeRef('draft', 'd2'), makeRef('mission', 'm1')], 'My macro', undefined);
    expect(macro.drafts.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(macro.notes).toEqual([]);
    expect(macro.routers).toEqual([]);
  });

  it('captures chains whose BOTH endpoints resolve inside the selection, drops the rest', () => {
    const macro = captureMacro(
      source,
      [makeRef('draft', 'd1'), makeRef('draft', 'd2'), makeRef('router', 'r1'), makeRef('note', 'n1')],
      'Full group',
      'a description',
    );
    expect(macro.chains.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(macro.name).toBe('Full group');
    expect(macro.description).toBe('a description');
  });

  it('normalizes positions relative to the selection bounding box (min corner -> 0,0)', () => {
    const macro = captureMacro(source, [makeRef('draft', 'd1'), makeRef('draft', 'd2'), makeRef('note', 'n1')], 'Group', undefined);
    expect(macro.positions[makeRef('draft', 'd1')]).toEqual({ x: 0, y: 0 });
    expect(macro.positions[makeRef('draft', 'd2')]).toEqual({ x: 200, y: 0 });
    expect(macro.positions[makeRef('note', 'n1')]).toEqual({ x: 0, y: 200 });
  });

  it('mints an id via the given idFactory', () => {
    const seq = { n: 0 };
    const macro = captureMacro(source, [makeRef('draft', 'd1')], 'Solo', undefined, (p) => idFactorySeq(p, seq));
    expect(macro.id).toBe('macro-1');
  });
});

describe('instantiateMacro', () => {
  const macro = captureMacro(
    {
      drafts: [
        { id: 'd1', title: 'Draft 1', task: 'do X', createdBy: 'user', projectId: 'proj-1' },
        { id: 'd2', title: 'Draft 2', task: 'do Y', createdBy: 'user', projectId: 'proj-1' },
      ],
      routers: [{ id: 'r1', projectId: 'proj-1', branches: [{ id: 'b1', label: 'ok', condition: { kind: 'default' } }] }],
      notes: [{ id: 'n1', text: 'hello', projectId: 'proj-1' }],
      chains: [
        { id: 'c1', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('draft', 'd2'), condition: 'success', createdBy: 'user' },
        { id: 'c2', sourceRef: makeRef('draft', 'd2'), targetRef: makeRef('router', 'r1'), condition: 'always', createdBy: 'user' },
        // branch-source chain: from router branch b1 to d1 (a cycle in
        // reality, but fine for exercising branch-ref remapping).
        { id: 'c3', sourceRef: makeRef('router', 'r1:b1'), targetRef: makeRef('note', 'n1'), condition: 'success', createdBy: 'user' },
      ],
      positions: {
        [makeRef('draft', 'd1')]: { x: 0, y: 0 },
        [makeRef('draft', 'd2')]: { x: 200, y: 0 },
        [makeRef('router', 'r1')]: { x: 400, y: 0 },
        [makeRef('note', 'n1')]: { x: 0, y: 200 },
      },
    },
    [makeRef('draft', 'd1'), makeRef('draft', 'd2'), makeRef('router', 'r1'), makeRef('note', 'n1')],
    'Template',
    undefined,
  );

  it('mints brand-new ids for every draft/router/note (never reuses template ids)', () => {
    const seq = { n: 0 };
    const result = instantiateMacro(macro, { x: 1000, y: 1000 }, 'proj-2', [], (p) => idFactorySeq(p, seq));
    expect(result.drafts).toHaveLength(2);
    expect(result.routers).toHaveLength(1);
    expect(result.notes).toHaveLength(1);
    const allNewIds = [...result.drafts.map((d) => d.id), ...result.routers.map((r) => r.id), ...result.notes.map((n) => n.id)];
    expect(new Set(allNewIds).size).toBe(allNewIds.length);
    expect(allNewIds).not.toContain('d1');
    expect(allNewIds).not.toContain('d2');
    expect(allNewIds).not.toContain('r1');
    expect(allNewIds).not.toContain('n1');
  });

  it('retargets every instantiated node to the requested projectId', () => {
    const result = instantiateMacro(macro, { x: 0, y: 0 }, 'proj-2', []);
    for (const d of result.drafts) expect(d.projectId).toBe('proj-2');
    for (const r of result.routers) expect(r.projectId).toBe('proj-2');
    for (const n of result.notes) expect(n.projectId).toBe('proj-2');
  });

  it('remaps every internal chain endpoint onto the fresh ids, including a router-branch source ref', () => {
    const result = instantiateMacro(macro, { x: 0, y: 0 }, 'proj-2', []);
    expect(result.chains).toHaveLength(3);
    const newDraft1Ref = makeRef('draft', result.drafts.find((d) => d.title === 'Draft 1')!.id);
    const newDraft2Ref = makeRef('draft', result.drafts.find((d) => d.title === 'Draft 2')!.id);
    const newRouterRef = makeRef('router', result.routers[0]!.id);
    const newNoteRef = makeRef('note', result.notes[0]!.id);

    const c1 = result.chains.find((c) => c.condition === 'success' && c.targetRef === newDraft2Ref);
    expect(c1?.sourceRef).toBe(newDraft1Ref);

    const c2 = result.chains.find((c) => c.condition === 'always');
    expect(c2?.sourceRef).toBe(newDraft2Ref);
    expect(c2?.targetRef).toBe(newRouterRef);

    // Branch-source ref: "router:<newRouterId>:b1" — branch id kept verbatim.
    const c3 = result.chains.find((c) => c.targetRef === newNoteRef);
    expect(c3?.sourceRef).toBe(`router:${result.routers[0]!.id}:b1`);
  });

  it('never copies chain engine bookkeeping (lastFiredAtMs/pinnedContext) onto the fresh copy', () => {
    const macroWithFiredChain = captureMacro(
      {
        drafts: [{ id: 'd1', title: 'A', task: 't', createdBy: 'user' }],
        routers: [],
        notes: [{ id: 'n1', text: 'x' }],
        chains: [{ id: 'c1', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('note', 'n1'), condition: 'success', createdBy: 'user', lastFiredAtMs: 12345 }],
        positions: {},
      },
      [makeRef('draft', 'd1'), makeRef('note', 'n1')],
      'M',
      undefined,
    );
    const result = instantiateMacro(macroWithFiredChain, { x: 0, y: 0 }, undefined, []);
    expect(result.chains[0]?.lastFiredAtMs).toBeUndefined();
  });

  it('places instantiated siblings collision-safe (no overlap with each other or pre-existing occupied rects)', () => {
    const occupied = [{ x: 1000, y: 1000, width: 200, height: 100 }];
    const result = instantiateMacro(macro, { x: 1000, y: 1000 }, 'proj-2', occupied);
    const placedRects = Object.entries(result.positions).map(([ref, pos]) => {
      const kind = parseRef(ref)!.kind;
      const size = kind === 'router' ? ROUTER_NODE_SIZE : kind === 'note' ? DEFAULT_NODE_SIZE.note : DEFAULT_NODE_SIZE.draft;
      return { x: pos.x, y: pos.y, width: size.width, height: size.height };
    });
    function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
      return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    }
    for (let i = 0; i < placedRects.length; i += 1) {
      expect(overlaps(placedRects[i]!, occupied[0]!)).toBe(false);
      for (let j = i + 1; j < placedRects.length; j += 1) {
        expect(overlaps(placedRects[i]!, placedRects[j]!)).toBe(false);
      }
    }
  });

  it('drops a chain whose endpoint fails to remap rather than leaving it dangling', () => {
    const macroWithDanglingChain = captureMacro(
      {
        drafts: [{ id: 'd1', title: 'A', task: 't', createdBy: 'user' }],
        routers: [],
        notes: [],
        chains: [{ id: 'c1', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('draft', 'd1'), condition: 'success', createdBy: 'user' }],
        positions: {},
      },
      [makeRef('draft', 'd1')],
      'M',
      undefined,
    );
    // Manually corrupt the template chain's targetRef to point OUTSIDE the
    // captured set (captureMacro itself would never produce this — this
    // simulates a hand-edited/legacy macro file).
    const corrupted = { ...macroWithDanglingChain, chains: [{ ...macroWithDanglingChain.chains[0]!, targetRef: makeRef('draft', 'unknown') }] };
    const result = instantiateMacro(corrupted, { x: 0, y: 0 }, undefined, []);
    expect(result.chains).toEqual([]);
  });
});

describe('siblingRectsInZone / storeOccupancyRects', () => {
  it('siblingRectsInZone reads sizes from live React Flow nodes', () => {
    const nodes = [
      { id: makeRef('draft', 'd1'), type: 'draft', parentId: makeRef('project', 'proj-1'), position: { x: 10, y: 20 }, width: 240, height: 200, data: {} },
      { id: makeRef('draft', 'd2'), type: 'draft', parentId: undefined, position: { x: 0, y: 0 }, width: 240, height: 200, data: {} },
    ] as never;
    expect(siblingRectsInZone(nodes, 'proj-1')).toEqual([{ x: 10, y: 20, width: 240, height: 200 }]);
    expect(siblingRectsInZone(nodes, undefined)).toEqual([{ x: 0, y: 0, width: 240, height: 200 }]);
  });

  it('storeOccupancyRects approximates from raw store facts (used where no live RF node list exists)', () => {
    const source = {
      drafts: [{ id: 'd1', title: 'A', task: 't', createdBy: 'user' as const, projectId: 'proj-1' }],
      routers: [],
      notes: [],
      positions: { [makeRef('draft', 'd1')]: { x: 5, y: 5 } },
    };
    const rects = storeOccupancyRects(source, 'proj-1');
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ x: 5, y: 5 });
  });

  it('storeOccupancyRects skips a draft with no stored position, and one from a different project', () => {
    const source = {
      drafts: [
        { id: 'd1', title: 'A', task: 't', createdBy: 'user' as const, projectId: 'proj-1' },
        { id: 'd2', title: 'B', task: 't', createdBy: 'user' as const, projectId: 'proj-2' },
      ],
      routers: [],
      notes: [],
      positions: {},
    };
    expect(storeOccupancyRects(source, 'proj-1')).toEqual([]);
  });
});
