/**
 * previewSurface.test.ts — shared preview-surface helpers (previewSurface.ts):
 * the reuse-vs-create invariant, and the preview lifecycle fix that links a
 * preview to whichever mission is actually working on its project
 * (`findRunningMissionRef` + `ensureProjectPreviewSurface`'s `ownerRef`).
 */

import { describe, it, expect, vi } from 'vitest';
import { ensureProjectPreviewSurface, findProjectPreviewSurface, findRunningMissionRef, isSelfOriginUrl } from '../components/agents/canvas/previewSurface';
import { buildSurfaceEdges } from '../components/agents/canvas/reconcilerEdges';
import { makeRef, type SurfaceSpec } from '../components/agents/canvas/canvasTypes';

describe('findRunningMissionRef', () => {
  it('resolves the running mission to a mission:<id> ref', () => {
    const ref = findRunningMissionRef([
      { id: 'm1', status: 'queued' },
      { id: 'm2', status: 'running' },
    ]);
    expect(ref).toBe(makeRef('mission', 'm2'));
  });

  it('resolves a running LOOP mission (loopConfig present) to a loop:<id> ref — matches reconcilerEdges.ts missionNodeRef', () => {
    const ref = findRunningMissionRef([{ id: 'loop1', status: 'running', loopConfig: { cadenceSec: 60 } }]);
    expect(ref).toBe(makeRef('loop', 'loop1'));
  });

  it('returns undefined when nothing is running', () => {
    expect(findRunningMissionRef([{ id: 'm1', status: 'queued' }, { id: 'm2', status: 'done' }])).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(findRunningMissionRef([])).toBeUndefined();
  });

  it('picks the FIRST running mission when several are (SurfaceSpec.ownerRef holds only one ref)', () => {
    const ref = findRunningMissionRef([
      { id: 'm1', status: 'running' },
      { id: 'm2', status: 'running' },
    ]);
    expect(ref).toBe(makeRef('mission', 'm1'));
  });
});

describe('ensureProjectPreviewSurface — ownerRef (preview lifecycle fix)', () => {
  it('sets ownerRef on a newly created surface', () => {
    const addSurface = vi.fn();
    const ref = ensureProjectPreviewSurface(
      'p1',
      'http://localhost:3000',
      { surfaces: [], addSurface, generateId: () => 'gen-1' },
      { ownerRef: makeRef('mission', 'm1') },
    );
    expect(ref).toBe(makeRef('preview', 'gen-1'));
    expect(addSurface).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gen-1', kind: 'preview', projectId: 'p1', ownerRef: makeRef('mission', 'm1') }),
    );
  });

  it('omitting ownerRef creates a surface with no ownerRef (never a fabricated link)', () => {
    const addSurface = vi.fn();
    ensureProjectPreviewSurface('p1', 'http://localhost:3000', { surfaces: [], addSurface, generateId: () => 'gen-1' });
    expect((addSurface.mock.calls[0]![0] as SurfaceSpec).ownerRef).toBeUndefined();
  });

  it('re-syncs an EXISTING surface whose ownerRef is stale, via updateSurface', () => {
    const existing: SurfaceSpec = { id: 's1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000', ownerRef: makeRef('mission', 'old') };
    const updateSurface = vi.fn();
    const ref = ensureProjectPreviewSurface(
      'p1',
      'http://localhost:3000',
      { surfaces: [existing], addSurface: vi.fn(), updateSurface, generateId: () => 'unused' },
      { ownerRef: makeRef('mission', 'new') },
    );
    expect(ref).toBe(makeRef('preview', 's1'));
    expect(updateSurface).toHaveBeenCalledWith('s1', { ownerRef: makeRef('mission', 'new') });
  });

  it('never calls updateSurface when the existing ownerRef already matches', () => {
    const existing: SurfaceSpec = { id: 's1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000', ownerRef: makeRef('mission', 'm1') };
    const updateSurface = vi.fn();
    ensureProjectPreviewSurface(
      'p1',
      'http://localhost:3000',
      { surfaces: [existing], addSurface: vi.fn(), updateSurface, generateId: () => 'unused' },
      { ownerRef: makeRef('mission', 'm1') },
    );
    expect(updateSurface).not.toHaveBeenCalled();
  });

  it('never clears an existing ownerRef when the caller passes none (nothing fresher to replace it with)', () => {
    const existing: SurfaceSpec = { id: 's1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000', ownerRef: makeRef('mission', 'm1') };
    const updateSurface = vi.fn();
    ensureProjectPreviewSurface('p1', 'http://localhost:3000', { surfaces: [existing], addSurface: vi.fn(), updateSurface, generateId: () => 'unused' });
    expect(updateSurface).not.toHaveBeenCalled();
  });

  it('tolerates a missing updateSurface dep (optional) — reuse still works, just no re-sync', () => {
    const existing: SurfaceSpec = { id: 's1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000', ownerRef: makeRef('mission', 'old') };
    expect(() =>
      ensureProjectPreviewSurface(
        'p1',
        'http://localhost:3000',
        { surfaces: [existing], addSurface: vi.fn(), generateId: () => 'unused' },
        { ownerRef: makeRef('mission', 'new') },
      ),
    ).not.toThrow();
  });
});

// The explicit deliverable: a preview surface for a project with a running
// mission gets an ownerRef, and buildSurfaceEdges (reconcilerEdges.ts) then
// draws a real edge from it — end to end, chaining the two real functions
// rather than asserting on a mocked intermediate.
describe('preview surface ownerRef -> buildSurfaceEdges (end to end)', () => {
  it('a project with a running mission produces a preview surface with an edge to that mission', () => {
    const missions = [{ id: 'm1', status: 'running' }];
    const ownerRef = findRunningMissionRef(missions);
    let surfaces: SurfaceSpec[] = [];
    const addSurface = (s: SurfaceSpec) => { surfaces = [...surfaces, s]; };

    ensureProjectPreviewSurface('p1', 'http://localhost:3000', { surfaces, addSurface, generateId: () => 'prev-1' }, { ownerRef });

    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]!.ownerRef).toBe(makeRef('mission', 'm1'));

    const renderedIds = new Set([makeRef('mission', 'm1'), makeRef('preview', 'prev-1')]);
    const edges = buildSurfaceEdges(surfaces, renderedIds);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      id: `surface:${makeRef('mission', 'm1')}:prev-1`,
      type: 'hierarchy',
      source: makeRef('mission', 'm1'),
      target: makeRef('preview', 'prev-1'),
    });
  });

  it('a project with NO running mission produces a preview surface with no edge (degrades gracefully, never a broken/fabricated link)', () => {
    const missions = [{ id: 'm1', status: 'done' }];
    const ownerRef = findRunningMissionRef(missions);
    let surfaces: SurfaceSpec[] = [];
    const addSurface = (s: SurfaceSpec) => { surfaces = [...surfaces, s]; };

    ensureProjectPreviewSurface('p1', 'http://localhost:3000', { surfaces, addSurface, generateId: () => 'prev-1' }, { ownerRef });

    expect(surfaces[0]!.ownerRef).toBeUndefined();
    const renderedIds = new Set([makeRef('preview', 'prev-1')]);
    expect(buildSurfaceEdges(surfaces, renderedIds)).toEqual([]);
  });
});

// Mission B (proof window) — the multi-owner generalization of ownerRef:
// SurfaceSpec.ownerRefs lets several missions/loops be tethered to the SAME
// surface (e.g. a browser-recipe proof surface fed by more than one
// mission over time) — buildSurfaceEdges must draw one edge PER entry.
describe('buildSurfaceEdges — multi-owner (SurfaceSpec.ownerRefs, Mission B)', () => {
  it('draws one edge per owner when ownerRefs carries several refs', () => {
    const surfaces: SurfaceSpec[] = [
      { id: 'proof-1', kind: 'preview', ownerRefs: [makeRef('mission', 'm1'), makeRef('mission', 'm2')] },
    ];
    const renderedIds = new Set([makeRef('mission', 'm1'), makeRef('mission', 'm2'), makeRef('preview', 'proof-1')]);

    const edges = buildSurfaceEdges(surfaces, renderedIds);

    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.source)).toEqual(
      expect.arrayContaining([makeRef('mission', 'm1'), makeRef('mission', 'm2')]),
    );
    expect(edges.every((e) => e.target === makeRef('preview', 'proof-1'))).toBe(true);
  });

  it('degrades gracefully when only SOME owners are currently rendered — the others just lose their tether', () => {
    const surfaces: SurfaceSpec[] = [
      { id: 'proof-1', kind: 'preview', ownerRefs: [makeRef('mission', 'm1'), makeRef('mission', 'm2')] },
    ];
    // m2 folded/removed — only m1 and the surface itself are rendered.
    const renderedIds = new Set([makeRef('mission', 'm1'), makeRef('preview', 'proof-1')]);

    const edges = buildSurfaceEdges(surfaces, renderedIds);

    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(makeRef('mission', 'm1'));
  });

  it('never double-draws an edge for a duplicated ref in ownerRefs', () => {
    const surfaces: SurfaceSpec[] = [
      { id: 'proof-1', kind: 'preview', ownerRefs: [makeRef('mission', 'm1'), makeRef('mission', 'm1')] },
    ];
    const renderedIds = new Set([makeRef('mission', 'm1'), makeRef('preview', 'proof-1')]);

    expect(buildSurfaceEdges(surfaces, renderedIds)).toHaveLength(1);
  });

  it('ownerRefs takes precedence over a simultaneously-set ownerRef (defensive — real callers set only one)', () => {
    const surfaces: SurfaceSpec[] = [
      {
        id: 'proof-1',
        kind: 'preview',
        ownerRef: makeRef('mission', 'stale'),
        ownerRefs: [makeRef('mission', 'm1')],
      },
    ];
    const renderedIds = new Set([makeRef('mission', 'm1'), makeRef('mission', 'stale'), makeRef('preview', 'proof-1')]);

    const edges = buildSurfaceEdges(surfaces, renderedIds);
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe(makeRef('mission', 'm1'));
  });
});

// Preview-surface-correctness fix — real incident: a candidate-port probe
// found the Lazy IDE's OWN dev server (this app's own devUrl) answering and
// wrongly attributed it as a DIFFERENT project's preview (see
// isSelfOriginUrl's own doc comment for the full root cause).
describe('isSelfOriginUrl', () => {
  it('flags a candidate url that is literally the app\'s own origin', () => {
    expect(isSelfOriginUrl('http://localhost:5173', 'http://localhost:5173')).toBe(true);
  });

  it('flags it regardless of a trailing path/query on the candidate', () => {
    expect(isSelfOriginUrl('http://localhost:5173/some/route?x=1', 'http://localhost:5173')).toBe(true);
  });

  it('does not flag a DIFFERENT port on the same host — a real, distinct project preview', () => {
    expect(isSelfOriginUrl('http://localhost:3000', 'http://localhost:5173')).toBe(false);
  });

  it('does not flag a malformed url — degrades to "not self", never throws', () => {
    expect(isSelfOriginUrl('not-a-url', 'http://localhost:5173')).toBe(false);
  });
});

describe('findProjectPreviewSurface', () => {
  it('excludes a search-results surface (P-SEARCH also carries kind: preview)', () => {
    const surfaces: SurfaceSpec[] = [{ id: 's1', kind: 'preview', projectId: 'p1', searchSurface: { history: [] } }];
    expect(findProjectPreviewSurface(surfaces, 'p1')).toBeUndefined();
  });
});

// Self-origin hardening — real incident (isSelfOriginUrl's own doc comment):
// useCanvasAutoComposition.ts's passive dev-port probe already refuses to
// call this function at all with a self-origin candidate (it checks
// isSelfOriginUrl itself, BEFORE ever reaching ensureProjectPreviewSurface).
// agentsStore.tsx's `start_preview` action has NO such upstream check — its
// url comes straight from devPreview.ts's `ensureDevServerForProject`, whose
// own REUSE-IF-RUNNING probe (`probeReachable(port)`) is a raw "is anything
// listening" check with the EXACT SAME blind spot isSelfOriginUrl's module
// header describes: a Vite project's resolved default port (5173) colliding
// with THIS app's own devUrl (also 5173 in a real `tauri dev` session) would
// be silently "reused" and handed to this function as a legitimate url.
// ensureProjectPreviewSurface is the one choke point BOTH callers share
// (this file's own module header) — hardening it here protects the
// unguarded caller too, without needing to touch agentsStore.tsx.
describe('ensureProjectPreviewSurface — self-origin hardening (defense in depth)', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // jsdom's default origin (http://localhost:3000) would otherwise collide
    // with several PRE-EXISTING tests above that legitimately use
    // 'http://localhost:3000' as a normal, distinct-project preview url —
    // pin a stable, deliberately-chosen origin for every test in this file so
    // only the dedicated collision test below opts into a match.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, origin: 'http://localhost:19999' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('never attributes THIS app\'s own origin to a newly-created surface — creates it with no url instead of the dangerous one', () => {
    const addSurface = vi.fn();
    const ref = ensureProjectPreviewSurface(
      'lazy-backoffice',
      'http://localhost:19999', // matches the stubbed window.location.origin above
      { surfaces: [], addSurface, generateId: () => 'auto-preview-1' },
      { autoAdded: true },
    );
    expect(ref).toBe(makeRef('preview', 'auto-preview-1'));
    expect(addSurface).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'auto-preview-1', kind: 'preview', projectId: 'lazy-backoffice', url: undefined }),
    );
  });

  it('a DIFFERENT localhost port (a real, distinct project preview) is never blocked', () => {
    const addSurface = vi.fn();
    ensureProjectPreviewSurface(
      'p1',
      'http://localhost:3000',
      { surfaces: [], addSurface, generateId: () => 'gen-1' },
    );
    expect(addSurface).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://localhost:3000' }));
  });

  it('never overwrites an EXISTING surface\'s url on reuse — the self-origin guard only ever applies to a NEW surface', () => {
    const existing: SurfaceSpec = { id: 's1', kind: 'preview', projectId: 'p1', url: 'http://localhost:3000' };
    const updateSurface = vi.fn();
    const ref = ensureProjectPreviewSurface(
      'p1',
      'http://localhost:19999',
      { surfaces: [existing], addSurface: vi.fn(), updateSurface, generateId: () => 'unused' },
    );
    expect(ref).toBe(makeRef('preview', 's1'));
    expect(updateSurface).not.toHaveBeenCalled();
  });
});
