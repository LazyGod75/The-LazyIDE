/* chainEngine.ts — Phase 5: GUTTED. The reactive fire-per-chain logic has
   been replaced by sgrChainRunner.ts (SGR-based execution). This file is
   now a thin compatibility shim that:

   1. Re-exports canvas operations from canvasChainOps.ts (pinChainWithAudit,
      refireChainDownstream, buildContextBlock, capturePinnedOutput,
      computeCascadeDepth, MAX_CASCADE_DEPTH)
   2. Re-exports the SGR chain runner functions (initSgrChainRunner,
      onMissionTerminalSGR) under their OLD names for backward compat
   3. Keeps `fetchAllJournalMissions` here (used by contestEngine.ts)
   4. Re-exports `_resetChainEngineForTests` as a combined reset

   Once all consumers and tests are migrated, this file will be deleted.
*/

// Re-export canvas ops
export {
  pinChainWithAudit,
  refireChainDownstream,
  buildContextBlock,
  capturePinnedOutput,
  computeCascadeDepth,
  resolveRouterBranch,
  MAX_CASCADE_DEPTH,
  initCanvasChainOps as initChainEngine,
  _resetCanvasChainOpsForTests,
  projectIdFromRoot,
  saveCanvasChainsGlobal,
} from './canvasChainOps.js';

// Re-export SGR chain runner under old names for backward compat
export {
  initSgrChainRunner,
  onMissionTerminalSGR as onMissionTerminal,
  reconcileChains,
  _resetSgrChainRunnerForTests,
} from './sgrChainRunner.js';

// fetchAllJournalMissions now lives in journalMissions.ts (extracted so
// sgrChainRunner.ts can read the same journal snapshot without importing
// this file back — see journalMissions.ts's header for why). Re-exported
// here unchanged so contestEngine.ts's existing import site needs no
// change.
export { fetchAllJournalMissions, type JournalMissionEntry } from './journalMissions.js';

// Combined test reset — resets both canvasChainOps and sgrChainRunner
import { _resetCanvasChainOpsForTests as _resetOps } from './canvasChainOps.js';
import { _resetSgrChainRunnerForTests as _resetSgr } from './sgrChainRunner.js';

export function _resetChainEngineForTests(): void {
  _resetOps();
  _resetSgr();
}

// Re-export the deps type for backward compat
export type { CanvasChainOpsDeps as ChainEngineDeps } from './canvasChainOps.js';
