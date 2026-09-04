/**
 * reconcilerConvergence.test.ts — P0 crash, round 2 ("Maximum update depth
 * exceeded" reproduced live at Agents-space boot, AFTER da0ced9's
 * value-equality fix was hot-reloaded and confirmed loaded).
 *
 * da0ced9 fixed the case where `setPositions` re-allocated a NEW `positions`
 * object even for a VALUE-IDENTICAL patch (whose changed IDENTITY alone
 * re-triggered the memo that derives the patch). That fix is correct and is
 * kept. The remaining open question this file answers: does the
 * reconcile()/declutter pipeline itself ever produce a GENUINELY different
 * (non-empty) `declutteredPositions` patch on every single pass — i.e. does
 * the layout ever fail to reach a fixed point at all, rather than merely
 * recomputing an identical one?
 *
 * This file runs the EXACT loop useCanvasFlowGraph.ts's R10 effect runs in
 * the real app — `positions = { ...positions, ...declutteredPositions }`,
 * repeated — against the scenario e1b2e60 ("Keep proposed canvas items on
 * hydration") introduced: several PROPOSED drafts/joins (`proposedPlanId`
 * set) whose PINNED/PERSISTED positions survive a hydrate() restore and
 * collide with each other.
 *
 * Result (proven below, see each test): the pipeline converges to an EMPTY
 * declutter patch within at most 2 non-trivial reconcile() calls for every
 * scenario tried here — direct collisions, position-less mixes, zone-vs-zone
 * overlaps, the legacy-row-migration/declutter interaction, and 150
 * randomized fuzz fixtures. The mechanism is structurally monotonic and
 * data-order deterministic:
 *   - `declutterOrder` (placementCollision.ts) ranks candidates by
 *     `immovable` -> `recencyMs` -> original array index — NONE of which
 *     depend on the candidates' CURRENT positions, so the winner/loser
 *     assignment for any given pair is fixed for the life of the session,
 *     never flips between reconcile() calls, and can never produce the
 *     "A pushes B, B pushes C, C pushes A back" cycle a position-dependent
 *     ranking could.
 *   - within one `declutterPinnedOverlaps` call, `occupied` only ever GROWS
 *     (each resolved item — winner or freshly-placed loser — is added
 *     before the next candidate is checked), so a single pass already
 *     resolves every pairwise/chained collision consistently; the very next
 *     pass sees only already-mutually-clear positions and emits `{}`.
 *
 * So the "still crashes after the hot-reloaded fix" symptom is NOT explained
 * by non-convergent geometry — these tests pin that down as a hard
 * regression guard. See canvasStore.ts's `coordEqual` (this same round) for
 * the one real gap closed alongside this: a NaN coordinate would have
 * defeated `isPositionsPatchNoop`'s equality check forever (`NaN !== NaN`),
 * regardless of how convergent the geometry is.
 */

import { describe, it, expect } from 'vitest';
import { reconcile, type ReconcileInputs } from '../components/agents/canvas/reconciler';
import { DEFAULT_CANVAS_PREFS, makeRef, type DraftSpec, type JoinSpec } from '../components/agents/canvas/canvasTypes';
import { ZONE_PADDING, ZONE_HEADER_HEIGHT, ZONE_TITLE_BAND_HEIGHT, GRID_CELL_WIDTH, GRID_CELL_HEIGHT } from '../components/agents/canvas/geometry';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';

// ── Fixtures (local — same shape as reconciler.test.ts's own, not shared:
//    every test file in this repo defines its own, see that file's header)

function mission(overrides: Partial<FleetMission> & { id: string; title: string }): FleetMission {
  return { status: 'running', stage: 'code', model: 'sonnet', updatedMs: 1000, urgent: false, ...overrides };
}

function project(overrides: Partial<FleetProject> & { projectId: string }): FleetProject {
  return { root: `/repo/${overrides.projectId}`, name: overrides.projectId, missions: [], ...overrides };
}

function baseInputs(overrides: Partial<ReconcileInputs> = {}): ReconcileInputs {
  return {
    projects: [],
    drafts: [],
    chains: [],
    notes: [],
    scheduled: [],
    positions: {},
    collapsed: {},
    prefs: DEFAULT_CANVAS_PREFS,
    ...overrides,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ConvergenceRun {
  converged: boolean;
  iterations: number;
  history: Array<Record<string, { x: number; y: number }>>;
}

/**
 * Runs the EXACT loop useCanvasFlowGraph.ts's R10 effect runs against the
 * live store: `positions = { ...positions, ...declutteredPositions }`,
 * repeated until `reconcile()` returns an empty `declutteredPositions` (the
 * real app's own convergence signal — `Object.keys(...).length === 0` is
 * literally that effect's own early-out check) or `maxIterations` is
 * exhausted. Returns the per-iteration correction history so a genuinely
 * non-convergent run can be inspected/printed by the caller.
 */
function runConvergenceLoop(
  buildInputs: (positions: Record<string, { x: number; y: number }>) => ReconcileInputs,
  initialPositions: Record<string, { x: number; y: number }>,
  maxIterations = 10,
): ConvergenceRun {
  let positions = { ...initialPositions };
  const history: Array<Record<string, { x: number; y: number }>> = [];
  for (let i = 0; i < maxIterations; i += 1) {
    const result = reconcile(buildInputs(positions));
    if (Object.keys(result.declutteredPositions).length === 0) {
      return { converged: true, iterations: i, history };
    }
    history.push(result.declutteredPositions);
    positions = { ...positions, ...result.declutteredPositions };
  }
  return { converged: false, iterations: maxIterations, history };
}

/** Asserts convergence, printing the FULL oscillation history on failure —
 *  the task's own "print the oscillating values" ask, kept live as a
 *  regression diagnostic rather than a one-shot debug print. */
function expectConverges(run: ConvergenceRun, label: string, maxIterations = 2): void {
  if (!run.converged) {
    // eslint-disable-next-line no-console
    console.log(`${label} — DID NOT CONVERGE. Correction history:`, JSON.stringify(run.history, null, 2));
  }
  expect(run.converged, `${label} must reach an empty declutter patch`).toBe(true);
  expect(run.iterations, `${label} took more corrective passes than expected`).toBeLessThanOrEqual(maxIterations);
}

describe('reconcile() convergence — R10 declutter fixed point (P0 crash, round 2)', () => {
  it('several PROPOSED drafts+join restored via hydrate, all pinned to the IDENTICAL collided position', () => {
    const planId = 'plan-1';
    const collidePos = { x: 100, y: 100 };
    const draftIds = ['d1', 'd2', 'd3'];
    const drafts: DraftSpec[] = draftIds.map((id) => ({
      id,
      title: id,
      task: 'x',
      createdBy: 'manager',
      projectId: 'p1',
      proposedPlanId: planId,
    }));
    const joins: JoinSpec[] = [
      {
        id: 'j1',
        projectId: 'p1',
        name: 'join',
        sourceRefs: draftIds.map((id) => makeRef('draft', id)),
        mode: 'all_success',
        proposedPlanId: planId,
      },
    ];
    const initialPositions: Record<string, { x: number; y: number }> = {
      [makeRef('draft', 'd1')]: collidePos,
      [makeRef('draft', 'd2')]: collidePos,
      [makeRef('draft', 'd3')]: collidePos,
      [makeRef('join', 'j1')]: collidePos,
    };

    const run = runConvergenceLoop(
      (positions) => baseInputs({ projects: [project({ projectId: 'p1' })], drafts, joins, positions }),
      initialPositions,
    );

    expectConverges(run, 'restored-proposed-drafts-and-join');
  });

  it('proposed drafts/joins left POSITION-LESS after hydrate (the arrange pass never completed before reload)', () => {
    const planId = 'plan-1';
    const draftIds = ['d1', 'd2', 'd3'];
    const drafts: DraftSpec[] = draftIds.map((id) => ({
      id,
      title: id,
      task: 'x',
      createdBy: 'manager',
      projectId: 'p1',
      proposedPlanId: planId,
    }));
    const joins: JoinSpec[] = [
      {
        id: 'j1',
        projectId: 'p1',
        name: 'join',
        sourceRefs: draftIds.map((id) => makeRef('draft', id)),
        mode: 'all_success',
        proposedPlanId: planId,
      },
    ];

    const run = runConvergenceLoop(
      (positions) => baseInputs({ projects: [project({ projectId: 'p1' })], drafts, joins, positions }),
      {},
    );

    expectConverges(run, 'position-less-proposed-drafts-and-join');
  });

  it('mixed: pinned colliding drafts + a position-less draft + a pinned colliding join', () => {
    const planId = 'plan-1';
    const collidePos = { x: 32, y: 36 };
    const drafts: DraftSpec[] = [
      { id: 'd1', title: 'd1', task: 'x', createdBy: 'manager', projectId: 'p1', proposedPlanId: planId },
      { id: 'd2', title: 'd2', task: 'x', createdBy: 'manager', projectId: 'p1', proposedPlanId: planId },
      { id: 'd3', title: 'd3', task: 'x', createdBy: 'manager', projectId: 'p1', proposedPlanId: planId },
    ];
    const joins: JoinSpec[] = [
      {
        id: 'j1',
        projectId: 'p1',
        name: 'join',
        sourceRefs: ['d1', 'd2'].map((id) => makeRef('draft', id)),
        mode: 'all_success',
        proposedPlanId: planId,
      },
    ];
    const initialPositions: Record<string, { x: number; y: number }> = {
      [makeRef('draft', 'd1')]: collidePos,
      [makeRef('join', 'j1')]: collidePos,
      // d3 intentionally position-less.
    };

    const run = runConvergenceLoop(
      (positions) => baseInputs({ projects: [project({ projectId: 'p1' })], drafts, joins, positions }),
      initialPositions,
    );

    expectConverges(run, 'mixed-pinned-and-positionless');
  });

  it('zone-vs-zone: a SHORT-named zone with a HUGE outlier-inflated bbox overlapping a same-row neighbor', () => {
    // zoneSameRowPackGap (geometry.ts) sizes the "practical" same-row gap
    // off a zone's NAME LENGTH only — never its real computed bbox. A zone
    // with a short name but a huge outlier-driven bbox is exactly the case
    // that could make declutterPinnedZones' correction read as "bloated"
    // to migrateBloatedZoneRowPositions on the NEXT pass, which shrinks it
    // back — the one place a genuinely different `preferred` point feeding
    // findFreePosition on each pass could in principle cause a 2-cycle.
    // Proven below: it still converges in one correction.
    const p1Ref = makeRef('project', 'p1');
    const p2Ref = makeRef('project', 'p2');
    const outlierRef = makeRef('mission', 'p1-outlier');
    const missionsP1: FleetMission[] = [
      mission({ id: 'p1-outlier', title: 'outlier', updatedMs: 1000 }),
      mission({ id: 'p1-m1', title: 'm1', updatedMs: 1000 }),
    ];
    const missionsP2: FleetMission[] = [mission({ id: 'p2-m0', title: 'm0', updatedMs: 1000 })];

    const initialPositions: Record<string, { x: number; y: number }> = {
      [p1Ref]: { x: 0, y: 0 },
      [p2Ref]: { x: 300, y: 0 }, // overlaps p1's real (outlier-inflated) bbox
      [outlierRef]: { x: 3000, y: 0 }, // blows p1's bbox far past 3000px wide
    };

    const run = runConvergenceLoop(
      (positions) =>
        baseInputs({
          projects: [
            project({ projectId: 'p1', missions: missionsP1 }),
            project({ projectId: 'p2', missions: missionsP2 }),
          ],
          positions,
        }),
      initialPositions,
    );

    expectConverges(run, 'zone-vs-zone-outlier-bbox');
  });

  /** Randomized fixture: several PROJECTS, each with a mix of REAL missions
   *  and PROPOSED drafts/joins (proposedPlanId set — mirrors what hydrate()
   *  restores per e1b2e60), pinned positions occasionally colliding on the
   *  exact same grid slot (within a zone, and across zone positions), some
   *  children left entirely position-less. */
  function randomFixture(seed: number): { inputs: (positions: Record<string, { x: number; y: number }>) => ReconcileInputs; initialPositions: Record<string, { x: number; y: number }> } {
    const rand = mulberry32(seed);
    const positions: Record<string, { x: number; y: number }> = {};
    const planId = 'plan-1';

    const pinSlot = (ref: string): void => {
      const slot = Math.floor(rand() * 6);
      const col = slot % 4;
      const row = Math.floor(slot / 4);
      positions[ref] = { x: ZONE_PADDING + col * GRID_CELL_WIDTH, y: ZONE_HEADER_HEIGHT + ZONE_TITLE_BAND_HEIGHT + row * GRID_CELL_HEIGHT };
    };

    const projectCount = 1 + Math.floor(rand() * 3);
    const projects: FleetProject[] = [];
    const allDrafts: DraftSpec[] = [];
    const allJoins: JoinSpec[] = [];

    for (let p = 0; p < projectCount; p += 1) {
      const projectId = `zp${p}`;
      if (rand() < 0.6) pinSlot(makeRef('project', projectId));

      const missionCount = Math.floor(rand() * 4);
      const missions: FleetMission[] = [];
      for (let m = 0; m < missionCount; m += 1) {
        const id = `${projectId}-m${m}`;
        missions.push(mission({ id, title: `m${m}`, updatedMs: Math.floor(rand() * 1_000_000) }));
        if (rand() < 0.5) pinSlot(makeRef('mission', id));
      }
      projects.push(project({ projectId, missions }));

      const draftCount = Math.floor(rand() * 4);
      const draftIds: string[] = [];
      for (let d = 0; d < draftCount; d += 1) {
        const id = `${projectId}-d${d}`;
        draftIds.push(id);
        allDrafts.push({ id, title: id, task: 'x', createdBy: 'manager', projectId, proposedPlanId: planId });
        if (rand() < 0.6) pinSlot(makeRef('draft', id));
      }
      if (draftIds.length >= 2 && rand() < 0.7) {
        const joinId = `${projectId}-j0`;
        allJoins.push({
          id: joinId,
          projectId,
          name: 'join',
          sourceRefs: draftIds.map((id) => makeRef('draft', id)),
          mode: 'all_success',
          proposedPlanId: planId,
        });
        if (rand() < 0.6) pinSlot(makeRef('join', joinId));
      }
    }

    return {
      inputs: (livePositions) => baseInputs({ projects, drafts: allDrafts, joins: allJoins, positions: livePositions }),
      initialPositions: positions,
    };
  }

  it('property: 150 randomized seeded fixtures of restored proposed drafts/joins + missions all converge within 3 passes', () => {
    const nonConvergentSeeds: number[] = [];
    for (let seed = 0; seed < 150; seed += 1) {
      const { inputs, initialPositions } = randomFixture(seed);
      const run = runConvergenceLoop(inputs, initialPositions, 3);
      if (!run.converged) {
        // eslint-disable-next-line no-console
        console.log(`seed ${seed} — DID NOT CONVERGE:`, JSON.stringify(run.history, null, 2));
        nonConvergentSeeds.push(seed);
      }
    }
    expect(nonConvergentSeeds).toEqual([]);
  });
});

// ── P0 crash, round 3 — the ACTUAL live-repro mechanism ────────────────
//
// Round 2 (above) proved the geometry itself is order-independent and
// monotonic GIVEN a proper 1-child-per-ref input. Round 3's live repro
// (spy attached to the running app, 2026-08-01) showed the premise itself
// can be false: TWO DIFFERENT plans, generated in different manager turns
// (e1b2e60 keeps a plan's proposed drafts alive across a hydrate(), so
// they can still be pending sessions apart), each independently produced
// a step called "audit" — two DraftSpec objects, but `makeRef('draft',
// 'audit')` collapses them onto the ONE SAME NodeRef. `positions` is
// `Record<NodeRef, {x,y}>` — one slot per ref — so both "different"
// children are, structurally, the exact same position-map KEY: no
// position-correction pass, however order-independent, can ever separate
// two entries that read and write the identical map slot. Every pass
// rediscovers the "same" collision and nudges by exactly
// `findFreePosition`'s step (draft width 260 + SCAN_MARGIN 16 = 276px —
// see placementCollision.ts), matching the live spy's recorded
// `337196,36 -> 337472,36 -> 337748,36 -> ...` drift exactly.
//
// This is NOT a reconciler.ts defect (da0ced9/6268003 stay correct — see
// this file's own header) — it is a data-integrity precondition reconciler
// was never responsible for enforcing. The real fix
// (canvasRefIntegrity.ts's `ensureUniqueCanvasRefs`) lives upstream, at
// canvasStore's materialization boundaries (`addProposalPreview`/
// `hydrate`), so a colliding ref never reaches `reconcile()` in the first
// place. The test below locks in WHY that upstream fix is required: fed a
// duplicate-ref input directly (bypassing canvasStore, exactly like every
// other test in this file), `reconcile()` genuinely never converges.
describe('reconcile() convergence — round 3 (duplicate draft ids collapse onto one NodeRef)', () => {
  it('two DIFFERENT DraftSpec objects sharing one id (two plans both naming a step "audit") never converge — proves the fix must live upstream of reconcile(), not inside it', () => {
    const collidePos = { x: 337196, y: 36 }; // real drift coordinates from the live crash spy
    const drafts: DraftSpec[] = [
      { id: 'audit', title: 'Audit (plan A)', task: 'x', createdBy: 'manager', projectId: 'p1', proposedPlanId: 'planA' },
      { id: 'audit', title: 'Audit (plan B)', task: 'x', createdBy: 'manager', projectId: 'p1', proposedPlanId: 'planB' },
    ];
    const initialPositions: Record<string, { x: number; y: number }> = {
      [makeRef('draft', 'audit')]: collidePos,
    };

    const run = runConvergenceLoop(
      (positions) => baseInputs({ projects: [project({ projectId: 'p1' })], drafts, positions }),
      initialPositions,
      10,
    );

    expect(run.converged, 'a shared ref can never converge — both entries always read/write the same position-map key').toBe(false);
    // Same +276px-per-pass drift the live spy recorded (draft width 260 +
    // SCAN_MARGIN 16), proving this is the SAME mechanism, not a
    // coincidentally-also-broken one.
    const firstCorrection = run.history[0]![makeRef('draft', 'audit')]!;
    expect(firstCorrection.x - collidePos.x).toBe(276);
  });
});
