/* frictionAnalysis.ts — Store-level API for the self-improvement loop
   (Pillar D5, v1). Runs the friction miner (frictionMiner.ts) for a project
   and materializes its ranked candidates as canvas DRAFTS inside one
   dedicated frame — never auto-launches anything, the normal approval/launch
   flow still governs execution of any resulting draft. Also writes one
   brain pathology note per analysis run (brainNotation.ts's
   noteFrictionAnalysis) so the top pathology is recallable later.

   Positions are set explicitly (simple offset stacking, zone-relative to
   `projectId` — see placementCollision.ts's module header for the
   coordinate-space convention) because — unlike a single ad-hoc
   create_draft — these nodes need to render visually grouped inside the
   frame this module just created; there is no live reconciled node list to
   consult for collision-safe placement outside a component (same
   constraint documented at agentsStore.tsx's `instantiate_macro` case).
*/

import { mineFrictions, type ImprovementCandidate } from './frictionMiner.js';
import { noteFrictionAnalysis } from './brainNotation.js';
import { seedLearnedRules } from './harnessLearning.js';
import { canvasStoreVanilla } from '../../components/agents/canvas/canvasStore.js';
import { generateCanvasId } from '../../components/agents/canvas/canvasIds.js';
import { makeRef } from '../../components/agents/canvas/canvasTypes.js';
import type { AutonomyConfig } from './types.js';

export interface FrictionAnalysisResult {
  candidates: ImprovementCandidate[];
  frameId?: string;
  draftIds: string[];
}

const FRAME_WIDTH = 460;
const FRAME_HEIGHT_PER_CANDIDATE = 140;
const FRAME_HEIGHT_MIN = 220;
const BASE_X = 40;
const BASE_Y = 40;
const DRAFT_X_OFFSET = 20;
const DRAFT_Y_STEP = 130;

/**
 * Runs the friction miner for `projectId` and materializes its output as
 * canvas drafts inside one dedicated frame. Returns an empty result with NO
 * canvas/brain side effects when the miner finds nothing — never fabricates
 * a candidate to fill the frame.
 */
export async function runFrictionAnalysis(
  projectId: string,
  projectRoot?: string,
  frameTitle = 'Self-improvement',
  autonomy?: AutonomyConfig,
): Promise<FrictionAnalysisResult> {
  const candidates = await mineFrictions(projectId, projectRoot, autonomy);
  if (candidates.length === 0) {
    return { candidates: [], draftIds: [] };
  }

  const frameId = generateCanvasId('frame');
  canvasStoreVanilla.getState().addFrame({
    id: frameId,
    projectId,
    title: frameTitle,
    width: FRAME_WIDTH,
    height: Math.max(FRAME_HEIGHT_MIN, candidates.length * FRAME_HEIGHT_PER_CANDIDATE),
  });
  canvasStoreVanilla.getState().setPosition(makeRef('frame', frameId), { x: BASE_X, y: BASE_Y });

  const draftIds = candidates.map((candidate, index) => {
    const draftId = generateCanvasId('draft');
    canvasStoreVanilla.getState().addDraft({
      id: draftId,
      title: candidate.title.slice(0, 60),
      task: `${candidate.suggestedTask}\n\nEvidence: ${candidate.evidence.join(', ')}`,
      projectId,
      createdBy: 'manager',
    });
    canvasStoreVanilla.getState().setPosition(makeRef('draft', draftId), {
      x: BASE_X + DRAFT_X_OFFSET,
      y: BASE_Y + 50 + index * DRAFT_Y_STEP,
    });
    return draftId;
  });

  noteFrictionAnalysis(candidates, projectId, projectRoot);

  // Harness-compiles loop: seed seed-worthy candidates as TRIAL harness
  // rules in the brain. Fire-and-forget — a brain failure must never break
  // the analysis flow. The rules are injected at the next mission and the
  // evalGate decides promotion/eviction from real journal evidence.
  seedLearnedRules(candidates, projectId).catch(() => {
    // best-effort — rules are optional
  });

  return { candidates, frameId, draftIds };
}
