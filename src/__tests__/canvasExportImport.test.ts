/**
 * Tests for canvasExportImport.ts (W-CLOSE row 4 — "flow-as-code" v1:
 * export/import a versioned, declarative canvas envelope). Pure-function
 * tests: no store, no React, no DOM.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCanvasExportEnvelope,
  canvasExportFileName,
  parseCanvasExportEnvelope,
  remapImportedCanvas,
  CANVAS_EXPORT_KIND,
  CANVAS_EXPORT_VERSION,
  type CanvasExportEnvelopeV1,
} from '../components/agents/canvas/canvasExportImport';
import { makeRef, type Chain, type DraftSpec, type FrameSpec, type MacroSpec, type NoteData, type RouterSpec } from '../components/agents/canvas/canvasTypes';

function idFactorySeq(prefix: string, seq: { n: number }): string {
  seq.n += 1;
  return `${prefix}-${seq.n}`;
}

describe('buildCanvasExportEnvelope', () => {
  const draft1: DraftSpec = { id: 'd1', title: 'Draft 1', task: 'do X', createdBy: 'user', projectId: 'proj-1' };
  const router1: RouterSpec = { id: 'r1', projectId: 'proj-1', branches: [{ id: 'b1', label: 'ok', condition: { kind: 'default' } }] };
  const note1: NoteData = { id: 'n1', text: 'hello', projectId: 'proj-2' };
  const chain1: Chain = { id: 'c1', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('router', 'r1'), condition: 'success', createdBy: 'user' };
  const macro1: MacroSpec = { id: 'm1', name: 'Starter', drafts: [], routers: [], notes: [], chains: [], positions: {}, createdAtMs: 1 };
  const frame1: FrameSpec = { id: 'f1', projectId: 'proj-1', title: 'Group A', width: 300, height: 200 };

  const source = {
    drafts: [draft1],
    chains: [chain1],
    routers: [router1],
    joins: [],
    macros: [macro1],
    notes: [note1],
    frames: [frame1],
    contests: [],
    positions: {
      [makeRef('draft', 'd1')]: { x: 10, y: 20 },
      [makeRef('router', 'r1')]: { x: 30, y: 40 },
      [makeRef('note', 'n1')]: { x: 50, y: 60 },
      [makeRef('frame', 'f1')]: { x: 70, y: 80 },
      // a mission position should never leak into the export.
      [makeRef('mission', 'mm1')]: { x: 999, y: 999 },
    },
  };

  it('carries drafts/chains/routers/macros/notes/frames verbatim plus a version envelope', () => {
    const envelope = buildCanvasExportEnvelope(source, 123456);
    expect(envelope.version).toBe(CANVAS_EXPORT_VERSION);
    expect(envelope.kind).toBe(CANVAS_EXPORT_KIND);
    expect(envelope.exportedAtMs).toBe(123456);
    expect(envelope.drafts).toEqual([draft1]);
    expect(envelope.chains).toEqual([chain1]);
    expect(envelope.routers).toEqual([router1]);
    expect(envelope.macros).toEqual([macro1]);
    expect(envelope.notes).toEqual([note1]);
    expect(envelope.frames).toEqual([frame1]);
  });

  it('only keeps positions for entities actually being exported (a mission position never leaks in)', () => {
    const envelope = buildCanvasExportEnvelope(source, 1);
    expect(Object.keys(envelope.positions).sort()).toEqual(
      [makeRef('draft', 'd1'), makeRef('note', 'n1'), makeRef('router', 'r1'), makeRef('frame', 'f1')].sort(),
    );
    expect(envelope.positions[makeRef('mission', 'mm1')]).toBeUndefined();
  });
});

describe('parseCanvasExportEnvelope', () => {
  const validEnvelope: CanvasExportEnvelopeV1 = {
    version: 1,
    kind: CANVAS_EXPORT_KIND,
    exportedAtMs: 1,
    positions: { [makeRef('draft', 'd1')]: { x: 0, y: 0 } },
    drafts: [{ id: 'd1', title: 'T', task: 't', createdBy: 'user' }],
    chains: [],
    routers: [],
    joins: [],
    macros: [],
    notes: [],
    frames: [],
    contests: [],
  };

  it('accepts a well-formed envelope', () => {
    expect(parseCanvasExportEnvelope(validEnvelope)).toEqual(validEnvelope);
  });

  it('rejects a wrong version', () => {
    expect(parseCanvasExportEnvelope({ ...validEnvelope, version: 2 })).toBeNull();
  });

  it('rejects a wrong/missing kind (e.g. an unrelated JSON file)', () => {
    expect(parseCanvasExportEnvelope({ ...validEnvelope, kind: 'something-else' })).toBeNull();
    expect(parseCanvasExportEnvelope({ foo: 'bar' })).toBeNull();
  });

  it('rejects malformed drafts/chains/routers/macros/notes/frames rather than partially importing', () => {
    expect(parseCanvasExportEnvelope({ ...validEnvelope, drafts: [{ id: 123 }] })).toBeNull();
    expect(parseCanvasExportEnvelope({ ...validEnvelope, chains: [{ id: 'c1' }] })).toBeNull();
    expect(parseCanvasExportEnvelope({ ...validEnvelope, routers: ['not-an-object'] })).toBeNull();
    expect(parseCanvasExportEnvelope({ ...validEnvelope, frames: [{ id: 'f1' }] })).toBeNull(); // missing title/width/height
  });

  it('rejects non-object input (null, arrays, primitives) without throwing', () => {
    expect(parseCanvasExportEnvelope(null)).toBeNull();
    expect(parseCanvasExportEnvelope([1, 2, 3])).toBeNull();
    expect(parseCanvasExportEnvelope('a json string, not parsed')).toBeNull();
  });
});

describe('remapImportedCanvas', () => {
  const envelope: CanvasExportEnvelopeV1 = {
    version: 1,
    kind: CANVAS_EXPORT_KIND,
    exportedAtMs: 1,
    positions: {
      [makeRef('draft', 'd1')]: { x: 0, y: 0 },
      [makeRef('draft', 'd2')]: { x: 100, y: 0 },
      [makeRef('router', 'r1')]: { x: 200, y: 0 },
      [makeRef('note', 'n1')]: { x: 0, y: 100 },
      [makeRef('frame', 'g1')]: { x: 0, y: 200 },
    },
    drafts: [
      { id: 'd1', title: 'Draft 1', task: 'do X', createdBy: 'user', projectId: 'proj-A' },
      { id: 'd2', title: 'Draft 2', task: 'do Y', createdBy: 'user', projectId: 'proj-B' },
    ],
    routers: [{ id: 'r1', projectId: 'proj-A', branches: [{ id: 'b1', label: 'ok', condition: { kind: 'default' } }] }],
    joins: [],
    notes: [{ id: 'n1', text: 'hello', projectId: 'proj-A' }],
    frames: [{ id: 'g1', projectId: 'proj-B', title: 'Group', width: 300, height: 200 }],
    chains: [
      { id: 'c1', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('draft', 'd2'), condition: 'success', createdBy: 'user' },
      { id: 'c2', sourceRef: makeRef('draft', 'd2'), targetRef: makeRef('router', 'r1'), condition: 'always', createdBy: 'user' },
      { id: 'c3', sourceRef: makeRef('router', 'r1:b1'), targetRef: makeRef('note', 'n1'), condition: 'success', createdBy: 'user' },
    ],
    macros: [{ id: 'm1', name: 'Starter', drafts: [], routers: [], notes: [], chains: [], positions: {}, createdAtMs: 1 }],
    contests: [],
  };

  it('mints brand-new ids for drafts/routers/notes, never reusing the exported ones', () => {
    const seq = { n: 0 };
    const result = remapImportedCanvas(envelope, (p) => idFactorySeq(p, seq));
    const allNewIds = [...result.drafts.map((d) => d.id), ...result.routers.map((r) => r.id), ...result.notes.map((n) => n.id)];
    expect(new Set(allNewIds).size).toBe(allNewIds.length);
    expect(allNewIds).not.toContain('d1');
    expect(allNewIds).not.toContain('d2');
    expect(allNewIds).not.toContain('r1');
    expect(allNewIds).not.toContain('n1');
  });

  it('PRESERVES each entity\'s own projectId (unlike instantiateMacro, which retargets everything to one project)', () => {
    const result = remapImportedCanvas(envelope);
    expect(result.drafts.find((d) => d.title === 'Draft 1')!.projectId).toBe('proj-A');
    expect(result.drafts.find((d) => d.title === 'Draft 2')!.projectId).toBe('proj-B');
    expect(result.routers[0]!.projectId).toBe('proj-A');
    expect(result.notes[0]!.projectId).toBe('proj-A');
  });

  it('remaps every chain endpoint onto the fresh ids, including a router-branch source ref', () => {
    const result = remapImportedCanvas(envelope);
    expect(result.chains).toHaveLength(3);
    const newD1Ref = makeRef('draft', result.drafts.find((d) => d.title === 'Draft 1')!.id);
    const newD2Ref = makeRef('draft', result.drafts.find((d) => d.title === 'Draft 2')!.id);
    const newRouterRef = makeRef('router', result.routers[0]!.id);
    const newNoteRef = makeRef('note', result.notes[0]!.id);
    expect(result.chains[0]).toMatchObject({ sourceRef: newD1Ref, targetRef: newD2Ref });
    expect(result.chains[1]).toMatchObject({ sourceRef: newD2Ref, targetRef: newRouterRef });
    expect(result.chains[2]).toMatchObject({ sourceRef: `${newRouterRef}:b1`, targetRef: newNoteRef });
  });

  it('carries positions over under the new refs, and macros verbatim (own ids kept)', () => {
    const result = remapImportedCanvas(envelope);
    const newD1Ref = makeRef('draft', result.drafts.find((d) => d.title === 'Draft 1')!.id);
    expect(result.positions[newD1Ref]).toEqual({ x: 0, y: 0 });
    expect(result.macros).toEqual(envelope.macros);
  });

  it('mints a fresh id for the frame, preserves its projectId, and carries its position over (W-CLOSE row 2)', () => {
    const result = remapImportedCanvas(envelope);
    expect(result.frames).toHaveLength(1);
    const newFrame = result.frames[0]!;
    expect(newFrame.id).not.toBe('g1');
    expect(newFrame.projectId).toBe('proj-B');
    expect(newFrame.title).toBe('Group');
    expect(result.positions[makeRef('frame', newFrame.id)]).toEqual({ x: 0, y: 200 });
  });

  it('drops (never dangles) a chain whose endpoint fails to remap', () => {
    const withDangling: CanvasExportEnvelopeV1 = {
      ...envelope,
      chains: [...envelope.chains, { id: 'c-bad', sourceRef: makeRef('mission', 'ghost'), targetRef: makeRef('draft', 'd1'), condition: 'success', createdBy: 'user' }],
    };
    const result = remapImportedCanvas(withDangling);
    expect(result.chains).toHaveLength(3); // the dangling one dropped, not carried as broken
  });
});

describe('canvasExportFileName', () => {
  it('is deterministic, sortable, and .json-suffixed', () => {
    const name = canvasExportFileName(0);
    expect(name).toMatch(/^lazy-canvas-export-.*\.json$/);
    expect(canvasExportFileName(0)).toBe(canvasExportFileName(0));
  });
});

describe('export -> import round trip', () => {
  it('an exported envelope, once remapped, reproduces the same STRUCTURE (chain topology, project assignment) under fresh ids', () => {
    const source = {
      drafts: [
        { id: 'd1', title: 'Draft 1', task: 'do X', createdBy: 'user' as const, projectId: 'proj-A' },
        { id: 'd2', title: 'Draft 2', task: 'do Y', createdBy: 'user' as const, projectId: 'proj-B' },
      ],
      chains: [{ id: 'c1', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('draft', 'd2'), condition: 'success' as const, createdBy: 'user' as const }],
      routers: [],
      joins: [],
      macros: [],
      notes: [],
      frames: [],
      contests: [],
      positions: {
        [makeRef('draft', 'd1')]: { x: 5, y: 5 },
        [makeRef('draft', 'd2')]: { x: 105, y: 5 },
      },
    };

    const envelope = buildCanvasExportEnvelope(source, 999);
    const raw = JSON.parse(JSON.stringify(envelope)); // simulate a real file round-trip
    const parsed = parseCanvasExportEnvelope(raw);
    expect(parsed).not.toBeNull();

    const result = remapImportedCanvas(parsed!);
    expect(result.drafts).toHaveLength(2);
    expect(result.chains).toHaveLength(1);
    const d1 = result.drafts.find((d) => d.projectId === 'proj-A')!;
    const d2 = result.drafts.find((d) => d.projectId === 'proj-B')!;
    expect(result.chains[0]).toMatchObject({ sourceRef: makeRef('draft', d1.id), targetRef: makeRef('draft', d2.id) });
    expect(result.positions[makeRef('draft', d1.id)]).toEqual({ x: 5, y: 5 });
    expect(result.positions[makeRef('draft', d2.id)]).toEqual({ x: 105, y: 5 });
  });
});

describe('W-JOIN — export/import round trip', () => {
  it('carries joins through buildCanvasExportEnvelope/parseCanvasExportEnvelope, and remaps their id + resolvable sourceRefs on import', () => {
    const join1 = { id: 'j1', projectId: 'proj-A', mode: 'all_success' as const, sourceRefs: [makeRef('draft', 'd1'), makeRef('mission', 'live-only')] };
    const draft1: DraftSpec = { id: 'd1', title: 'Draft 1', task: 'do X', createdBy: 'user', projectId: 'proj-A' };
    const source = {
      drafts: [draft1],
      chains: [],
      routers: [],
      joins: [join1],
      macros: [],
      notes: [],
      frames: [],
      contests: [],
      positions: {
        [makeRef('draft', 'd1')]: { x: 1, y: 2 },
        [makeRef('join', 'j1')]: { x: 3, y: 4 },
      },
    };

    const envelope = buildCanvasExportEnvelope(source, 1);
    expect(envelope.joins).toEqual([join1]);

    const raw = JSON.parse(JSON.stringify(envelope));
    const parsed = parseCanvasExportEnvelope(raw);
    expect(parsed).not.toBeNull();

    const result = remapImportedCanvas(parsed!);
    expect(result.joins).toHaveLength(1);
    const newJoin = result.joins[0]!;
    expect(newJoin.id).not.toBe('j1'); // fresh id minted, never reused
    expect(newJoin.projectId).toBe('proj-A'); // preserved verbatim, per this module's own rule
    expect(newJoin.mode).toBe('all_success');

    // The draft-shaped sourceRef remaps onto the draft's OWN fresh id; the
    // live mission-shaped sourceRef is dropped (never exported/remappable —
    // this module's "pending-only" header rule), never left dangling.
    const newDraftRef = makeRef('draft', result.drafts[0]!.id);
    expect(newJoin.sourceRefs).toEqual([newDraftRef]);

    expect(result.positions[makeRef('join', newJoin.id)]).toEqual({ x: 3, y: 4 });
  });

  it('rejects an envelope with a malformed joins array rather than partially importing', () => {
    const base = {
      version: CANVAS_EXPORT_VERSION,
      kind: CANVAS_EXPORT_KIND,
      exportedAtMs: 1,
      positions: {},
      drafts: [],
      chains: [],
      routers: [],
      macros: [],
      notes: [],
      frames: [],
      contests: [],
    };
    expect(parseCanvasExportEnvelope({ ...base, joins: ['not-an-object'] })).toBeNull();
    expect(parseCanvasExportEnvelope({ ...base, joins: [{ id: 'j1', mode: 'bogus-mode', sourceRefs: [] }] })).toBeNull();
  });
});

describe('W-CONTEST — export/import round trip', () => {
  it('carries contests through buildCanvasExportEnvelope/parseCanvasExportEnvelope, and remaps id + draftTemplateId on import', () => {
    const contest1 = { id: 'k1', draftTemplateId: 'd1', missionIds: ['live-m1', 'live-m2'], status: 'completed' as const, createdAtMs: 1, winnerId: 'live-m1' };
    const draft1: DraftSpec = { id: 'd1', title: 'Draft 1', task: 'do X', createdBy: 'user', projectId: 'proj-A' };
    const source = {
      drafts: [draft1],
      chains: [],
      routers: [],
      joins: [],
      macros: [],
      notes: [],
      frames: [],
      contests: [contest1],
      positions: {},
    };

    const envelope = buildCanvasExportEnvelope(source, 1);
    expect(envelope.contests).toEqual([contest1]);

    const raw = JSON.parse(JSON.stringify(envelope));
    const parsed = parseCanvasExportEnvelope(raw);
    expect(parsed).not.toBeNull();

    const result = remapImportedCanvas(parsed!);
    expect(result.contests).toHaveLength(1);
    const newContest = result.contests[0]!;
    expect(newContest.id).not.toBe('k1'); // fresh id minted, never reused
    expect(newContest.status).toBe('completed');
    // draftTemplateId remaps onto the template draft's own fresh id.
    expect(newContest.draftTemplateId).toBe(result.drafts[0]!.id);
    // missionIds/winnerId reference LIVE missions — carried over verbatim
    // (documented limitation, this module's own header + ContestSpec's own
    // doc comment), never crashing, never fabricated.
    expect(newContest.missionIds).toEqual(['live-m1', 'live-m2']);
    expect(newContest.winnerId).toBe('live-m1');
  });

  it('rejects an envelope with a malformed contests array rather than partially importing', () => {
    const base = {
      version: CANVAS_EXPORT_VERSION,
      kind: CANVAS_EXPORT_KIND,
      exportedAtMs: 1,
      positions: {},
      drafts: [],
      chains: [],
      routers: [],
      joins: [],
      macros: [],
      notes: [],
      frames: [],
    };
    expect(parseCanvasExportEnvelope({ ...base, contests: ['not-an-object'] })).toBeNull();
    expect(parseCanvasExportEnvelope({ ...base, contests: [{ id: 'k1', status: 'bogus-status' }] })).toBeNull();
  });
});
