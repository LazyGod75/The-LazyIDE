/* canvasChainOps.ts — Canvas chain operations that survive the SGR consolidation
   (Phase 5). Extracted from chainEngine.ts before its deletion: these are
   canvas-level operations (pin output, refire downstream, context block
   formatting) that are NOT part of the reactive chain firing logic replaced
   by the SGR runtime.

   - pinChainWithAudit: captures a frozen snapshot of a source mission's output
   - refireChainDownstream: replays a pinned chain's target without re-running source
   - buildContextBlock / capturePinnedOutput: shared formatting helpers
   - computeCascadeDepth: pure validation helper (cycle-safe)
*/

import type { Mission } from './types.js';
import type { NewMissionInput } from '../../components/agents/agentsStore.js';
import { canvasStoreVanilla } from '../../components/agents/canvas/canvasStore.js';
import { saveCanvasChainsGlobal } from '../../components/agents/canvas/canvasPersistence.js';
import {
  makeRef,
  parseRef,
  parseRouterBranchRef,
  type Chain,
  type NodeRef,
  type RouterBranch,
} from '../../components/agents/canvas/canvasTypes.js';
import { formatMissionDetail } from './managerEngine.js';
import { emitEvent } from '../journal/journal.js';
import { projectIdFromRoot } from '../journal/projectId.js';

// ── Constants ──────────────────────────────────────────────────────

export const MAX_CASCADE_DEPTH = 5;
const CONTEXT_OUTPUT_CAP_CHARS = 2000;
const TRUNCATION_SUFFIX = ' …(tronqué)…';
const CONTEXT_TIMELINE_ENTRIES = 8;

// ── Deps for refireChainDownstream ─────────────────────────────────

export interface CanvasChainOpsDeps {
  addMission: (input: NewMissionInput) => Promise<string>;
  getActiveProjectId: () => Promise<string | null>;
  defaultModelId: () => string;
}

let currentOpsDeps: CanvasChainOpsDeps | null = null;

/** Wire the deps needed by refireChainDownstream. Called once from
 *  agentsStore's provider mount (same shape as the old initChainEngine). */
export function initCanvasChainOps(deps: CanvasChainOpsDeps): () => void {
  currentOpsDeps = deps;
  return () => { currentOpsDeps = null; };
}

/** Test-only: clears the module singleton between tests. */
export function _resetCanvasChainOpsForTests(): void {
  currentOpsDeps = null;
}

// ── Context block ──────────────────────────────────────────────────

export function buildContextBlock(sourceMission: Mission): string {
  const summary = formatMissionDetail(sourceMission, { maxTimelineEntries: CONTEXT_TIMELINE_ENTRIES });
  const capped =
    summary.length > CONTEXT_OUTPUT_CAP_CHARS
      ? `${summary.slice(0, CONTEXT_OUTPUT_CAP_CHARS - TRUNCATION_SUFFIX.length).trimEnd()}${TRUNCATION_SUFFIX}`
      : summary;
  return `\n\n## CONTEXTE AMONT\nMission « ${sourceMission.title} » terminée (${sourceMission.status}).\n${capped}`;
}

export function capturePinnedOutput(sourceMission: Mission): { text: string; pinnedAtMs: number; sourceTitle: string } {
  return { text: buildContextBlock(sourceMission), pinnedAtMs: Date.now(), sourceTitle: sourceMission.title };
}

// ── Pin output ─────────────────────────────────────────────────────

export async function pinChainWithAudit(chainId: string, sourceMission: Mission): Promise<boolean> {
  const chain = canvasStoreVanilla.getState().chains.find((c) => c.id === chainId);
  if (!chain) return false;

  const pinned = capturePinnedOutput(sourceMission);
  canvasStoreVanilla.getState().pinChainOutput(chainId, pinned);

  const projectId = currentOpsDeps ? ((await currentOpsDeps.getActiveProjectId().catch(() => null)) ?? '') : '';
  void emitEvent({
    type: 'chain.pinned',
    tsMs: Date.now(),
    projectId,
    missionId: sourceMission.id,
    actor: 'user',
    payload: {
      chainId,
      sourceMissionId: sourceMission.id,
      targetRef: chain.targetRef,
      projectId,
      sourceTitle: pinned.sourceTitle,
    },
  });
  return true;
}

// ── Refire downstream ──────────────────────────────────────────────

export type RefireOutcome =
  | 'refired'
  | 'skipped-chain-missing'
  | 'skipped-not-pinned'
  | 'skipped-target-not-draft'
  | 'skipped-target-missing'
  | 'skipped-inactive-project';

export async function refireChainDownstream(chainId: string): Promise<RefireOutcome> {
  const deps = currentOpsDeps;
  if (!deps) return 'skipped-chain-missing';

  const chain = canvasStoreVanilla.getState().chains.find((c) => c.id === chainId);
  if (!chain) return 'skipped-chain-missing';
  if (!chain.pinnedContext) return 'skipped-not-pinned';

  const target = parseRef(chain.targetRef);
  if (!target || target.kind !== 'draft') return 'skipped-target-not-draft';

  const draft = canvasStoreVanilla.getState().drafts.find((d) => d.id === target.id);
  if (!draft) return 'skipped-target-missing';

  const activeProjectId = await deps.getActiveProjectId();
  if (draft.projectId !== undefined && draft.projectId !== activeProjectId) {
    return 'skipped-inactive-project';
  }

  const missionId = await deps.addMission({
    title: draft.title,
    agentTask: `${draft.task}${chain.pinnedContext.text}`,
    agentName: draft.agentName,
    repo: '.',
    worktree: '',
    modelLabel: draft.model ?? deps.defaultModelId(),
    mode: 'agent',
    orchestrator: false,
    permissionMode: draft.permissionMode ?? 'acceptEdits',
  });

  const projectId = activeProjectId ?? draft.projectId ?? '';
  void emitEvent({
    type: 'chain.fired',
    tsMs: Date.now(),
    projectId,
    missionId,
    actor: 'system',
    payload: { chainId, targetRef: chain.targetRef, projectId, replayedFromPin: true },
  });

  return 'refired';
}

// ── Cascade depth (pure, used by validation) ───────────────────────

function predecessorMatchRef(sourceRef: NodeRef): NodeRef {
  const branch = parseRouterBranchRef(sourceRef);
  return branch ? makeRef('router', branch.routerId) : sourceRef;
}

export function computeCascadeDepth(
  chains: readonly Chain[],
  chainId: string,
  visited: ReadonlySet<string> = new Set(),
): number {
  if (visited.has(chainId)) return MAX_CASCADE_DEPTH + 1;
  const chain = chains.find((c) => c.id === chainId);
  if (!chain) return 1;
  const predecessor = chains.find((c) => c.targetRef === predecessorMatchRef(chain.sourceRef));
  if (!predecessor) return 1;
  const nextVisited = new Set(visited);
  nextVisited.add(chainId);
  return 1 + computeCascadeDepth(chains, predecessor.id, nextVisited);
}

export { projectIdFromRoot, saveCanvasChainsGlobal };

// ── Router branch resolution (pure) ────────────────────────────────

/** Evaluate router branches IN ORDER against a completed mission — first
 *  match wins. Returns null if no branch matches and there is no default.
 *
 *  - `outcome` matches based on mission status (success=done, fail=failed)
 *  - `contains` matches case-insensitively against the mission's output text
 *  - `default` always matches
 */
export function resolveRouterBranch(
  branches: readonly RouterBranch[],
  mission: Mission,
  outputText: string,
): RouterBranch | null {
  for (const b of branches) {
    if (b.condition.kind === 'default') return b;
    if (b.condition.kind === 'outcome') {
      if (b.condition.value === 'success' && mission.status === 'done') return b;
      if (b.condition.value === 'fail' && mission.status === 'failed') return b;
    }
    if (b.condition.kind === 'contains') {
      if (outputText.toLowerCase().includes(b.condition.value.toLowerCase())) return b;
    }
  }
  return null;
}
