/* graph/graphRunStore.ts — Durable on-disk persistence for GraphRun (item 6,
   2026-08-15 audit, D7).

   ROOT CAUSE (verified against the code before this fix): `GraphRun` was
   never persisted as its own object anywhere. `sgrOrchestratorRunner.ts`'s
   `persistRun` dep (the one hook `runGraph.ts` calls on every state
   transition — see that module's `GraphExecutorDeps.persistRun`) only ever
   PROJECTED the run onto `OrchestratorState.steps` via
   `syncOrchestratorFromRun`, then persisted THAT (a lossier shape — no
   `nodeOutputs`, no `checkpoints`, no `replanCount`, no `NodeRun.output`) to
   `.lazy/orchestrators.json`. A process crash/restart mid-run had nothing
   real to resume from at the GraphRun level; only the orchestrator's own
   step statuses survived, which `seedRunFromSteps` (sgrOrchestratorRunner.ts)
   already uses to avoid RE-launching finished steps — but that is a
   reconstruction from a lossy projection, not a resume of the actual run.

   THIS MODULE closes the "not persisted at all" half of D7: `saveGraphRun`
   is wired into `sgrOrchestratorRunner.ts`'s `persistRun` dep ADDITIVELY
   (alongside the existing orchestrator-state projection, which stays —
   nothing here replaces it), so every real graph execution now writes its
   FULL `GraphRun` (including `nodeOutputs`) to
   `<projectRoot>/.lazy/graph-runs/<runId>.json` on every transition, using
   the exact same read/write/BOM-strip/graceful-degradation conventions as
   `orchestratorState.ts` (same file family, same platform.fs abstraction).

   `reconcilePhantomGraphRuns` closes the "phantom running graph after a
   restart" half: any persisted run still reading a status that only makes
   sense while a live process is actively driving its wave loop
   ('pending'/'running'/'paused') is proof that process is gone — rewritten
   to 'interrupted' (an existing, already-honest GraphRun status: "paused,
   awaiting a decision") so nothing that later reads these files can present
   a run that died with the process as though it were still going. It is
   wired into `sgrOrchestratorRunner.ts`'s `startOrchestratorViaSgr` — the
   SGR's own real entry point — so it runs whenever a plan is (re)executed.

   SCOPE — DOCUMENTED, NOT HIDDEN (this item explicitly allows a reduced
   pass; see the task this closes):
     - This does NOT implement full resume-from-disk. `runGraph(ir, deps,
       { existingRun })` already exists and already accepts a resumed run
       (used today for the interrupted/HITL case) — a persisted GraphRun
       here COULD be handed to it, but nothing in this pass builds the "on
       boot, offer to resume every interrupted run found on disk" UI/flow
       (design doc §3.11, Étape 0's own scope) — reconciliation only makes
       the ON-DISK STATE honest, it does not itself resume anything.
     - `OrchestratorState.status` (a SEPARATE persisted projection — see
       `sgrOrchestratorRunner.ts`'s `syncOrchestratorFromRun`) is not
       touched by this module. A caller that also wants the orchestrator's
       own 'executing' label fixed after a restart must reconcile it
       separately — not done here.
     - Large `nodeOutputs` are written inline (no claim-check blob
       indirection the way `checkpointStore.ts` does for ReAct turn state)
       — acceptable for now since GraphRun outputs are typically small
       structured JSON, but a genuinely large output would bloat this file.
*/

import { joinPath } from '../../paths.js';
import { getPlatform } from '../../platform/index.js';
import type { GraphRun } from './types.js';

const GRAPH_RUNS_DIR = '.lazy/graph-runs';

function graphRunsDirPath(projectRoot: string): string {
  return joinPath(projectRoot, GRAPH_RUNS_DIR);
}

function graphRunPath(projectRoot: string, runId: string): string {
  // runId is always `run-${Date.now()}-${random}` (initGraphRun, graphIr.ts)
  // — no path separators are ever produced, safe as a bare filename.
  return joinPath(projectRoot, GRAPH_RUNS_DIR, `${runId}.json`);
}

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * Persists the full `GraphRun` to `<projectRoot>/.lazy/graph-runs/<runId>.json`.
 * Best-effort, same "never break the caller on a disk failure" convention
 * as `orchestratorState.ts`'s own `saveOrchestratorsJson` — a save failure
 * is logged and swallowed, never thrown, since this is called from inside
 * `runGraph.ts`'s hot persistence path and must never abort a real run over
 * a filesystem hiccup.
 */
export async function saveGraphRun(projectRoot: string, run: GraphRun): Promise<void> {
  try {
    const fs = getPlatform().fs;
    try {
      await fs.createDir(graphRunsDirPath(projectRoot));
    } catch {
      // Directory may already exist — createDir throwing here is expected
      // and not itself an error worth logging.
    }
    await fs.writeFile(graphRunPath(projectRoot, run.runId), JSON.stringify(run, null, 2));
  } catch (err) {
    console.warn('[graphRunStore] saveGraphRun failed:', err);
  }
}

/** Loads a single persisted GraphRun by id. Returns `undefined` on any
 *  read/parse failure (missing file, corrupt JSON) — never throws. */
export async function loadGraphRun(projectRoot: string, runId: string): Promise<GraphRun | undefined> {
  try {
    const raw = await getPlatform().fs.readFile(graphRunPath(projectRoot, runId));
    return JSON.parse(stripBom(raw)) as GraphRun;
  } catch {
    return undefined;
  }
}

/** Lists every GraphRun persisted for a project. Returns `[]` if the
 *  directory has never been created (no run has ever been persisted) —
 *  never throws. An individual unreadable/corrupt file is skipped (logged)
 *  rather than failing the whole listing. */
export async function listGraphRuns(projectRoot: string): Promise<GraphRun[]> {
  try {
    const fs = getPlatform().fs;
    const entries = await fs.readDir(graphRunsDirPath(projectRoot));
    const runs: GraphRun[] = [];
    for (const entry of entries) {
      if (entry.isDir || !entry.name.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(entry.path);
        runs.push(JSON.parse(stripBom(raw)) as GraphRun);
      } catch (err) {
        console.warn(`[graphRunStore] skipping unreadable run file ${entry.path}:`, err);
      }
    }
    return runs;
  } catch {
    return [];
  }
}

/** Statuses a persisted GraphRun should NEVER be found in "at rest" (i.e.
 *  when nothing is actively driving its wave loop): the process that would
 *  ever move it OUT of one of these is gone. 'paused' is included even
 *  though it's a deliberate user action (item 2's `pauseGraphRun`) — the
 *  in-memory pause-request registry (`runControl.ts`'s `pauseRequests`) is
 *  itself lost on restart too, so a 'paused' run found on disk after a
 *  restart is exactly as stranded as a 'running' one; both need the SAME
 *  honest "awaiting a decision" status a human can act on. */
const PHANTOM_STATUSES: ReadonlySet<GraphRun['status']> = new Set(['pending', 'running', 'paused']);

/**
 * Rewrites every persisted GraphRun still reading a "was actively
 * executing" status to `'interrupted'` — see this module's header comment
 * for the full rationale and documented scope. Returns the list of runs
 * that were actually reconciled (empty when nothing was stale).
 */
export async function reconcilePhantomGraphRuns(projectRoot: string): Promise<GraphRun[]> {
  const runs = await listGraphRuns(projectRoot);
  const reconciled: GraphRun[] = [];
  for (const run of runs) {
    if (!PHANTOM_STATUSES.has(run.status)) continue;
    const fixed: GraphRun = { ...run, status: 'interrupted', updatedAt: Date.now() };
    await saveGraphRun(projectRoot, fixed);
    reconciled.push(fixed);
  }
  return reconciled;
}
