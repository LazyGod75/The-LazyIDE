/* graph/runGraph.ts — Single Graph Runtime (SGR) wave executor.

   Executes a GraphIR by launching all ready nodes in parallel waves,
   waiting for their missions to settle, then computing the next wave.
   Brain recall is injected before each launch; Brain notes are written
   after each node settles.

   This replaces the sequential for-loop in orchestratorExecutor.ts.
   The legacy executor remains as a thin wrapper that compiles
   OrchestratorState → GraphIR → runGraph.
*/

import type { GraphIR, GraphNode, GraphRun, NodeRun, BrainRecallBundle, ContestNode, ContestRankingEntry, LoopNodeIR, TaskNode, RouterNodeIR } from './types.js';
import type { Mission } from '../types.js';
import { validateGraph, getReadyNodes, initGraphRun, getControlPredecessors, getNodeById, evaluateCondition } from './graphIr.js';
import { recallForStep, noteAfterStep, noteContestRanking } from './brainBus.js';
import { replan as replanEngine, type ReplanContext } from './replanEngine.js';
import { isPauseRequested, isCancelRequested, clearRunControl } from './runControl.js';
import {
  buildNodeInput,
  formatInputBlock,
  formatOutputSchemaHint,
  parseStructuredOutput,
  contractOf,
} from './dataPlane.js';
import { extractFinalOutput } from '../missionOutput.js';
import { formatVerdictScoreLine } from '../evaluator.js';
import { expandSubgraphs, type SubgraphRegistry } from './nestedSubgraphs.js';
import { appendTraceEntry, buildTraceEntry } from './traceJournal.js';

// ── Dependency injection ──────────────────────────────────────────

export interface GraphExecutorDeps {
  /** Launch a mission for a task node, returning the mission id. */
  launchMission(args: {
    node: GraphNode;
    task: string;
    brainContext: BrainRecallBundle;
    projectId: string;
  }): Promise<string>;

  /** Wait for all given mission ids to reach a terminal status. */
  waitForMissions(missionIds: string[], signal?: AbortSignal): Promise<Mission[]>;

  /** Persist the GraphRun state. */
  persistRun?(run: GraphRun): Promise<void>;

  /** Emit a journal/UI event. */
  emit?(type: string, payload: Record<string, unknown>): void;

  /** Diagnose a failed mission (P2.5). Returns category, rootCause, suggestedFix. */
  diagnose?(args: { missionId: string; errorMessage?: string; projectId: string }): Promise<{
    category: string;
    rootCause: string;
    suggestedFix: string;
    confidence: number;
    brainContext?: string;
  }>;

  /** Project root for Brain operations. */
  projectRoot: string;
}

// ── Immutable run helpers ────────────────────────────────────────
// runGraph used to mutate the SAME GraphRun/NodeRun object in place across
// `await` boundaries, then hand that live, still-mutating object to
// `persistRun`/`onRunUpdate` — which agentsStore.tsx stores verbatim as
// `activeGraphRun`. Any downstream reference-equality check (a memoized
// selector, a `useEffect` keyed on the run) would see the SAME object
// mutate underneath itself instead of receiving a fresh snapshot per
// update. Every run/nodeRun update below goes through `withRun`/
// `withNodeRun`, which always return a NEW top-level object — same
// values, same call sequence, only object identity changes.
//
// `RunRef` is a plain mutable box (not the GraphRun itself) so the many
// wave-launch closures below — which run concurrently via
// `Promise.all(waveIds.map(...))` — can each read the LATEST run state and
// publish their own update back into the SAME box, instead of racing on a
// captured-at-closure-start copy. Because JS is single-threaded, a
// `runRef.current = withNodeRun(runRef.current, id, patch)` statement is
// atomic with respect to other closures: no update is ever lost, even
// when two nodes in the same wave (e.g. two contest nodes) both touch
// `run.budget`.

interface RunRef {
  current: GraphRun;
}

function withRun(run: GraphRun, patch: Partial<GraphRun>): GraphRun {
  return { ...run, ...patch };
}

function withNodeRun(run: GraphRun, nodeId: string, patch: Partial<NodeRun>): GraphRun {
  return {
    ...run,
    nodeRuns: { ...run.nodeRuns, [nodeId]: { ...run.nodeRuns[nodeId], ...patch } },
  };
}

// ── Loop node runaway-impossible guards (trust-critical defect #2) ──
// See the 'loop' node kind's own handling below for the full rationale.

/** System-enforced ceiling on a SINGLE loop node's iterations, independent
 *  of whatever loop.exit.n a graph declares (LoopNodeIR carries no upper
 *  bound of its own). */
const LOOP_NODE_HARD_ITERATION_CAP = 100;

/** Minimum real-time delay between two iterations of the SAME loop node —
 *  insurance against a degenerate fast-fail body burning through many
 *  iterations with no real work done. */
const LOOP_NODE_MIN_ITERATION_DELAY_MS = 250;

// ── Dependency-branch inheritance ────────────────────────────────────
// Real incident this fixes (lazy-backoffice, 12-step plan mid-execution):
// step 1 declared an explicit baseBranch and started from the real
// scaffold; steps 2-3 declared none, so their worktrees were silently
// created from the repo's default branch (an empty seed commit) — a
// "harden the auth from the M40 merge" step ran against a repo with no
// auth code at all. A chain where every step restarts from empty can never
// build anything cumulative.
//
// Design decisions (see the task brief this addresses):
//  - `dependsOn` implies inheritance: a node with no explicit
//    `contract.baseBranch` starts its worktree FROM its dependency's
//    settled branch, not the repo default.
//  - Explicit `contract.baseBranch` on the step ALWAYS wins over the
//    inherited default — it is the user's/manager's stated intent
//    (e.g. "continue from agent/M40-…" is deliberate, not accidental).
//  - Single dependency → start straight from that dependency's branch.
//  - Multiple dependencies (fan-in, no explicit baseBranch) → start from
//    the FIRST resolved branch and real-`git merge` every OTHER dependency
//    branch into the new worktree before the agent starts (Mission.mergeBranches,
//    agent_create_worktree_inner). Never silently pick one dependency and
//    drop the rest — each dependency represents real committed work the
//    downstream step is supposed to build on. A merge conflict fails the
//    mission explicitly, naming the conflicting branch, instead of starting
//    the agent on a half-merged tree.
//  - A dependency that settled without producing a branch (join predecessor
//    resolved with nothing underneath, or — defensively — any node kind
//    that never launches a mission) fails EXPLICITLY, naming the missing
//    upstream node, rather than silently degrading to the repo default.
//    That silent fallback is exactly what produced empty worktrees tonight.

/** Resolution of a node's launch start point from its `dependsOn` graph
 *  position. `ok: false` means "do not launch this node" — the caller
 *  reports `reason` as the node's launch failure instead of calling
 *  `deps.launchMission`. */
type BranchResolution =
  | { ok: true; baseBranch?: string; mergeBranches?: string[] }
  | { ok: false; reason: string };

/**
 * Walks a node's control-edge predecessors to resolve the branch(es) its
 * worktree should start from. Only meaningful for 'task'/'contest' nodes —
 * the only kinds that carry a StepContract/launch a mission with a real
 * git branch. See this module's header comment above for the inheritance
 * rules this implements.
 */
function resolveInheritedBranches(ir: GraphIR, run: GraphRun, node: TaskNode | ContestNode): BranchResolution {
  // Explicit step-level intent always wins — never overridden by inference.
  if (node.contract.baseBranch) {
    return { ok: true, baseBranch: node.contract.baseBranch };
  }

  const directPreds = getControlPredecessors(ir, node.id);
  if (directPreds.length === 0) {
    // Entry node — nothing to inherit from; unchanged default (branch off HEAD).
    return { ok: true };
  }

  const branches = new Set<string>();
  const missing: string[] = [];
  const visited = new Set<string>();

  const collect = (predId: string): void => {
    if (visited.has(predId)) return;
    visited.add(predId);
    const predNode = getNodeById(ir, predId);
    // Join AND router nodes are pure control-flow points, never branch
    // producers — resolve THROUGH to their own upstream predecessor(s)
    // instead of treating them as "no branch produced". Router support
    // added alongside join's (item 5, 2026-08-15 audit, D1 fix): a router
    // never launches a mission (see this module's dedicated `node.kind ===
    // 'router'` handler above), so it never sets its own `resultBranch`
    // either — without this, ANY task node downstream of a router failed
    // outright with "no branch to inherit from" the moment the router
    // itself stopped silently degrading into a fake mission launch.
    if (predNode?.kind === 'join' || predNode?.kind === 'router') {
      for (const grandPredId of getControlPredecessors(ir, predId)) collect(grandPredId);
      return;
    }
    const predRun = run.nodeRuns[predId];
    if (predRun?.resultBranch) {
      branches.add(predRun.resultBranch);
    } else {
      missing.push(predNode?.label ?? predId);
    }
  };

  for (const predId of directPreds) collect(predId);

  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Dependency produced no branch to inherit from: ${missing.join(', ')} — refusing to silently fall back to the repo default`,
    };
  }

  const list = Array.from(branches);
  if (list.length <= 1) {
    return { ok: true, baseBranch: list[0] };
  }
  // Fan-in: multiple distinct upstream branches. Deterministic order
  // (Set insertion order == dependsOn traversal order) — start from the
  // first, merge the rest.
  return { ok: true, baseBranch: list[0], mergeBranches: list.slice(1) };
}

/** Applies a resolved branch/merge-branches onto a task/contest node's
 *  contract, returning a NEW node object (never mutates the IR node). */
function withResolvedBranches<T extends TaskNode | ContestNode>(
  node: T,
  resolved: { baseBranch?: string; mergeBranches?: string[] },
): T {
  return {
    ...node,
    contract: {
      ...node.contract,
      ...(resolved.baseBranch !== undefined ? { baseBranch: resolved.baseBranch } : {}),
      ...(resolved.mergeBranches !== undefined ? { mergeBranches: resolved.mergeBranches } : {}),
    },
  };
}

// ── runGraph ──────────────────────────────────────────────────────

export async function runGraph(
  ir: GraphIR,
  deps: GraphExecutorDeps,
  opts?: { signal?: AbortSignal; existingRun?: GraphRun; subgraphRegistry?: SubgraphRegistry },
): Promise<GraphRun> {
  // P8.2 — Expand nested subgraphs before execution
  // `let` — a P2.5 replan can add/remove nodes and edges (replanEngine.ts's
  // applyPatch), returning a NEW GraphIR that replaces this binding so the
  // rest of the loop sees the patched graph on its next iteration.
  let effectiveIr = opts?.subgraphRegistry ? expandSubgraphs(ir, opts.subgraphRegistry) : ir;

  // Validate
  const validation = validateGraph(effectiveIr);
  if (!validation.ok) {
    throw new Error(`Invalid graph: ${validation.errors.join('; ')}`);
  }

  // Initialize or resume run
  const initialRun = opts?.existingRun ?? initGraphRun(effectiveIr.id, effectiveIr);
  const runRef: RunRef = {
    current: withRun(initialRun, {
      nodeOutputs: initialRun.nodeOutputs ?? {},
      status: 'running',
      updatedAt: Date.now(),
    }),
  };
  await deps.persistRun?.(runRef.current);

  deps.emit?.('graph.run_started', { runId: runRef.current.runId, graphId: effectiveIr.id, sourcePlanId: runRef.current.sourcePlanId });

  const maxParallel = effectiveIr.defaults.maxParallelNodes ?? 0; // 0 = unlimited

  while (true) {
    // Check abort
    if (opts?.signal?.aborted) {
      runRef.current = withRun(runRef.current, { status: 'cancelled', updatedAt: Date.now() });
      await deps.persistRun?.(runRef.current);
      deps.emit?.('graph.run_cancelled', { runId: runRef.current.runId });
      clearRunControl(runRef.current.runId);
      return runRef.current;
    }

    // Check cancel request (cancelGraphRun fix, follow-up to D4, 2026-08-15
    // audit) — `cancelGraphRun` has no `AbortSignal` to trigger (that
    // channel belongs to whoever originally called `runGraph(ir, deps,
    // {signal})`, not to a later caller holding only the `GraphRun`), so it
    // registers a request on this runId-keyed channel instead — the SAME
    // mechanism `isPauseRequested` below uses, see runControl.ts's header
    // comment. Checked BEFORE the pause check: cancel is the stronger,
    // terminal action, and every node still 'pending'/'ready' here is
    // explicitly marked 'skipped' (never left dangling) so a downstream
    // join/critical-check never waits on a run that will never resume.
    if (isCancelRequested(runRef.current.runId)) {
      let nodeRuns = runRef.current.nodeRuns;
      for (const nodeId of Object.keys(nodeRuns)) {
        const nr = nodeRuns[nodeId];
        // Same set cancelGraphRun's own pure transform skips — 'running' is
        // included defensively even though this boundary sits BETWEEN
        // waves (every node launched so far has already settled by the
        // time control returns here), so it should never actually be hit.
        if (nr.status === 'pending' || nr.status === 'running' || nr.status === 'ready') {
          nodeRuns = { ...nodeRuns, [nodeId]: { ...nr, status: 'skipped', completedAt: Date.now() } };
        }
      }
      runRef.current = withRun(runRef.current, { status: 'cancelled', nodeRuns, updatedAt: Date.now() });
      await deps.persistRun?.(runRef.current);
      deps.emit?.('graph.run_cancelled', { runId: runRef.current.runId });
      clearRunControl(runRef.current.runId);
      return runRef.current;
    }

    // Check pause request (D4 fix, item 2, 2026-08-15 audit) — the actual
    // channel a live `pauseGraphRun(...)` call now uses (see runControl.ts's
    // own header comment for the full defect writeup). Checked at the SAME
    // safe boundary as the abort check above: between waves, never mid-wave
    // — a wave already launched still runs to completion via the
    // `waitForMissions` call further down, only the NEXT wave is withheld.
    if (isPauseRequested(runRef.current.runId)) {
      runRef.current = withRun(runRef.current, { status: 'paused', updatedAt: Date.now() });
      await deps.persistRun?.(runRef.current);
      deps.emit?.('graph.run_paused', { runId: runRef.current.runId });
      return runRef.current;
    }

    // Check budget
    if (runRef.current.budget.limitUsd !== undefined && runRef.current.budget.spentUsd >= runRef.current.budget.limitUsd) {
      runRef.current = withRun(runRef.current, { status: 'failed', updatedAt: Date.now() });
      await deps.persistRun?.(runRef.current);
      deps.emit?.('graph.run_budget_exceeded', { runId: runRef.current.runId, spent: runRef.current.budget.spentUsd, limit: runRef.current.budget.limitUsd });
      clearRunControl(runRef.current.runId);
      return runRef.current;
    }

    // Get ready nodes
    const readyIds = getReadyNodes(effectiveIr, runRef.current);

    if (readyIds.length === 0) {
      // No ready nodes — check if we're done or stuck
      const anyRunning = Object.values(runRef.current.nodeRuns).some((nr) => nr.status === 'running' || nr.status === 'ready');
      if (anyRunning) {
        // Wait a tick for running missions to settle
        await sleep(100);
        continue;
      }

      // Check for failed critical nodes
      const failedCritical = Object.entries(runRef.current.nodeRuns).find(([nodeId, nr]) => {
        if (nr.status !== 'failed') return false;
        const node = effectiveIr.nodes.find((n) => n.id === nodeId);
        return node?.critical !== false;
      });

      if (failedCritical) {
        runRef.current = withRun(runRef.current, { status: 'failed', updatedAt: Date.now() });
        await deps.persistRun?.(runRef.current);
        deps.emit?.('graph.run_failed', { runId: runRef.current.runId, failedNode: failedCritical[0] });
        clearRunControl(runRef.current.runId);
        return runRef.current;
      }

      // Check for interrupted/blocked nodes (P3.5 — interrupt nodes)
      const hasBlocked = Object.values(runRef.current.nodeRuns).some((nr) => nr.status === 'blocked');
      if (hasBlocked) {
        // Run is paused — return without marking as done
        runRef.current = withRun(runRef.current, { status: 'interrupted', updatedAt: Date.now() });
        await deps.persistRun?.(runRef.current);
        return runRef.current;
      }

      // All done
      runRef.current = withRun(runRef.current, { status: 'done', updatedAt: Date.now() });
      await deps.persistRun?.(runRef.current);
      deps.emit?.('graph.run_finished', { runId: runRef.current.runId });
      clearRunControl(runRef.current.runId);
      return runRef.current;
    }

    // Clamp parallelism
    const waveIds = maxParallel > 0 ? readyIds.slice(0, maxParallel) : readyIds;

    // Mark wave as ready
    for (const nodeId of waveIds) {
      runRef.current = withNodeRun(runRef.current, nodeId, { status: 'ready' });
    }
    await deps.persistRun?.(runRef.current);

    // Launch all nodes in the wave concurrently
    const launchResults = await Promise.all(
      waveIds.map(async (nodeId) => {
        let node = effectiveIr.nodes.find((n) => n.id === nodeId)!;

        // Dependency-branch inheritance — only 'task'/'contest' nodes carry
        // a StepContract/launch a mission with a real branch. See this
        // module's "Dependency-branch inheritance" header comment above for
        // the full rule set (explicit baseBranch wins, single dep inherits
        // directly, fan-in merges, missing upstream branch fails loud).
        if (node.kind === 'task' || node.kind === 'contest') {
          const resolved = resolveInheritedBranches(effectiveIr, runRef.current, node);
          if (!resolved.ok) {
            return { nodeId, missionId: null, error: resolved.reason };
          }
          node = withResolvedBranches(node, resolved);
        }

        // Brain recall
        const brainContext = await recallForStep({
          projectRoot: deps.projectRoot,
          graphId: effectiveIr.id,
          runId: runRef.current.runId,
          node,
        });

        // Contest node: launch N parallel missions and pick the best
        if (node.kind === 'contest') {
          return launchContestNode(node, nodeId, brainContext, effectiveIr, runRef, deps, opts?.signal);
        }

        // Interrupt node: pause the run and emit a resume token
        if (node.kind === 'interrupt') {
          runRef.current = withNodeRun(runRef.current, nodeId, {
            status: 'blocked',
            startedAt: Date.now(),
            errorMessage: node.reason,
          });
          await deps.persistRun?.(runRef.current);

          const resumeToken = `${runRef.current.runId}:${node.id}:${Date.now()}`;
          runRef.current = withRun(runRef.current, { status: 'interrupted', updatedAt: Date.now() });
          await deps.persistRun?.(runRef.current);

          deps.emit?.('graph.interrupt', {
            runId: runRef.current.runId,
            nodeId,
            reason: node.reason,
            payload: node.payload,
            resumeToken,
          });

          return { nodeId, missionId: null, error: null };
        }

        // Join node: fan-in sync point — no mission launched, just mark done
        if (node.kind === 'join') {
          runRef.current = withNodeRun(runRef.current, nodeId, {
            status: 'done',
            startedAt: Date.now(),
            completedAt: Date.now(),
          });
          await deps.persistRun?.(runRef.current);
          deps.emit?.('graph.node_done', { runId: runRef.current.runId, nodeId, status: 'done' });
          return { nodeId, missionId: null, error: null };
        }

        // Loop node: basic iteration — launch body entry N times.
        //
        // Trust-critical defect #2 hardening (runaway-impossible guard,
        // defense-in-depth alongside loopEngine.ts's recurring-scheduler
        // fix — see that module's own header for the real QA capture this
        // whole class of fix addresses): a graph-authored loop.exit.n
        // carries no upper bound in the type itself (LoopNodeIR, types.ts),
        // so an LLM-authored or malformed plan could set it arbitrarily
        // high. Clamped to LOOP_NODE_HARD_ITERATION_CAP regardless of what
        // the graph declares, a minimum delay is enforced between
        // iterations (insurance against a degenerate fast-fail body
        // resolving in milliseconds and burning through many iterations
        // with no real work done), and an undefined `mission` from
        // waitForMissions is treated as a failure — never silently kept
        // looping on the assumption an untracked iteration must have
        // succeeded.
        //
        // DEFERRED, DOCUMENTED (item 4, 2026-08-15 audit): the loop body
        // still carries NO feedback between iterations — `bodyTask` below
        // is the SAME "<label> — iteration i/N" description every time,
        // regardless of what a PREVIOUS iteration's mission produced or
        // why it needed another pass. That makes this a bounded repetition
        // primitive, not yet a correction loop (an agent re-reading its
        // own prior mistake). Wiring real feedback (the settled mission's
        // output/diagnosis threaded into the NEXT iteration's task text,
        // data-plane style) is explicitly left to the design's staged plan
        // (docs/scratch/_agent-graph-design.md §3.11, Étape 1's own
        // "RejectionReason" work) — it is a materially bigger change (a
        // typed reason needs somewhere to come FROM, e.g. a verify/judge
        // step inside the loop body, which this node has no notion of
        // today) than fits this pass. What IS fixed here: the exit
        // predicate is honoured and iteration count stays bounded either
        // way (see below).
        if (node.kind === 'loop') {
          const loop = node as LoopNodeIR;
          // D3 fix (item 4, 2026-08-15 audit) — root cause: `exit.kind ===
          // 'predicate'` was never implemented; `requestedIters` fell back
          // to a hardcoded `1`, so a predicate-exit loop always ran exactly
          // one iteration regardless of whether its own predicate had been
          // satisfied — silently indistinguishable from a loop that isn't
          // a loop at all. A predicate loop has no `n` of its own to bound
          // it by (unlike `max_iterations`), so it now runs up to the SAME
          // hard ceiling every loop node is already clamped to
          // (`LOOP_NODE_HARD_ITERATION_CAP`) — "run until the predicate
          // says stop, or until the hard cap" — and the predicate is
          // evaluated after EVERY iteration that itself completed
          // successfully (see `evaluateLoopExitPredicate` below).
          const requestedIters = loop.exit.kind === 'max_iterations' ? loop.exit.n : LOOP_NODE_HARD_ITERATION_CAP;
          const maxIters = Math.min(Math.max(requestedIters, 0), LOOP_NODE_HARD_ITERATION_CAP);
          const startAttempt = runRef.current.nodeRuns[nodeId].attempt + 1;
          runRef.current = withNodeRun(runRef.current, nodeId, {
            status: 'running',
            attempt: startAttempt,
            startedAt: Date.now(),
          });
          await deps.persistRun?.(runRef.current);
          deps.emit?.('graph.node_started', { runId: runRef.current.runId, nodeId, attempt: startAttempt });

          // Honesty fix: the loop node used to unconditionally report
          // 'done' even when it broke out early because an iteration
          // FAILED — a loop node that never completed its body
          // successfully must never claim success. `stopReason` carries
          // WHY it stopped early (visible via nr.errorMessage /
          // noteAfterStep's journal, same "say WHY" convention as
          // loopEngine.ts's LoopStopReason).
          let stopReason: string | null = null;
          let lastBranch: string | undefined;
          // Only meaningful for `exit.kind === 'predicate'` — true once an
          // iteration's own settled mission satisfies `loop.exit.expression`
          // (see evaluateLoopExitPredicate below). A `max_iterations` loop
          // has no predicate to satisfy, so it is vacuously "satisfied" the
          // moment it completes its requested iterations without failing —
          // unchanged behaviour from before this fix.
          let predicateSatisfied = loop.exit.kind !== 'predicate';
          try {
            for (let i = 0; i < maxIters; i++) {
              if (i > 0) await sleep(LOOP_NODE_MIN_ITERATION_DELAY_MS);

              const bodyTask = `${loop.label ?? node.id} — iteration ${i + 1}/${maxIters}`;
              const missionId = await deps.launchMission({
                node,
                task: bodyTask,
                brainContext,
                projectId: effectiveIr.projectId,
              });
              runRef.current = withNodeRun(runRef.current, nodeId, {
                missionIds: [...runRef.current.nodeRuns[nodeId].missionIds, missionId],
              });

              const missions = await deps.waitForMissions([missionId]);
              const mission = missions[0];
              if (!mission || mission.status !== 'done') {
                stopReason = mission
                  ? `Loop body iteration ${i + 1}/${maxIters} ended '${mission.status}' — refusing to re-run the identical body without a change of input`
                  : `Loop body iteration ${i + 1}/${maxIters} produced no result — refusing to continue`;
                break;
              }
              lastBranch = mission.worktree || lastBranch;

              if (loop.exit.kind === 'predicate') {
                predicateSatisfied = evaluateLoopExitPredicate(loop.exit.expression, mission);
                if (predicateSatisfied) break;
              }
            }
            if (!stopReason && loop.exit.kind === 'predicate' && !predicateSatisfied) {
              // Every iteration ran (none crashed/failed), but the exit
              // predicate never matched, even at the hard cap — the SAME
              // "never claim success it didn't verify" honesty rule this
              // node already applies to a failed iteration (see this
              // block's own header comment) applies here too: a
              // predicate-exit loop that never saw its predicate satisfied
              // did NOT reach its declared exit condition, so it must not
              // report 'done'.
              stopReason = `Loop exit predicate "${loop.exit.expression}" never matched after ${maxIters} iteration(s) (hard cap ${LOOP_NODE_HARD_ITERATION_CAP}) — refusing to claim the loop's exit condition was met`;
            }
            if (stopReason) {
              runRef.current = withNodeRun(runRef.current, nodeId, {
                status: 'failed',
                errorMessage: stopReason,
                completedAt: Date.now(),
              });
            } else {
              // Dependency-branch inheritance: a downstream node depending
              // on this loop starts from the LAST successful iteration's
              // branch — see resolveInheritedBranches's doc comment above.
              runRef.current = withNodeRun(runRef.current, nodeId, {
                status: 'done',
                resultBranch: lastBranch,
                completedAt: Date.now(),
              });
            }
          } catch (err: unknown) {
            runRef.current = withNodeRun(runRef.current, nodeId, {
              status: 'failed',
              errorMessage: err instanceof Error ? err.message : String(err),
              completedAt: Date.now(),
            });
          }
          await deps.persistRun?.(runRef.current);
          const loopNr = runRef.current.nodeRuns[nodeId];
          deps.emit?.('graph.node_done', { runId: runRef.current.runId, nodeId, status: loopNr.status });
          return { nodeId, missionId: null, error: loopNr.errorMessage ?? null };
        }

        // Router node: pure branch resolution, no mission ever launched
        // (D1 fix, item 5, 2026-08-15 audit). This used to fall through to
        // the "standard task node" path below, launching a REAL mission
        // whose task text was the router's own label — silently replacing
        // "route based on what already happened" with "ask an agent to do
        // it (again)". A router branches on exactly ONE upstream node's
        // settled NodeRun (evaluateCondition, graphIr.ts — same semantics
        // as canvasChainOps.ts's resolveRouterBranch: outcome/contains/
        // default, first match wins); anything this handler cannot
        // honestly resolve fails the node instead of guessing.
        if (node.kind === 'router') {
          const router = node as RouterNodeIR;
          const predIds = getControlPredecessors(effectiveIr, nodeId);
          if (predIds.length !== 1) {
            const message =
              `Router node '${nodeId}' has ${predIds.length} control predecessor(s) — the SGR router handler ` +
              `only branches on exactly one upstream node's outcome; refusing to guess instead of silently launching a mission.`;
            runRef.current = withNodeRun(runRef.current, nodeId, {
              status: 'failed',
              startedAt: Date.now(),
              completedAt: Date.now(),
              errorMessage: message,
            });
            await deps.persistRun?.(runRef.current);
            deps.emit?.('graph.node_done', { runId: runRef.current.runId, nodeId, status: 'failed' });
            return { nodeId, missionId: null, error: message };
          }

          const predNr = runRef.current.nodeRuns[predIds[0]];
          const selected = predNr ? router.branches.find((b) => evaluateCondition(b.condition, predNr)) : undefined;
          const targetNr = selected?.targetNodeId ? runRef.current.nodeRuns[selected.targetNodeId] : undefined;
          if (!selected || !targetNr) {
            const message = selected
              ? `Router node '${nodeId}' branch '${selected.id}' has no resolvable target node in this run — refusing to silently succeed with nowhere to route.`
              : `Router node '${nodeId}' — no branch condition matched its predecessor and no default branch is present.`;
            runRef.current = withNodeRun(runRef.current, nodeId, {
              status: 'failed',
              startedAt: Date.now(),
              completedAt: Date.now(),
              errorMessage: message,
            });
            await deps.persistRun?.(runRef.current);
            deps.emit?.('graph.node_done', { runId: runRef.current.runId, nodeId, status: 'failed' });
            return { nodeId, missionId: null, error: message };
          }

          // Every OTHER branch's target must never sit 'pending' forever
          // once this router has decided against it — mark it 'skipped' so
          // a downstream join/critical-check never waits on an untaken path.
          for (const branch of router.branches) {
            if (branch.id === selected.id || !branch.targetNodeId) continue;
            if (runRef.current.nodeRuns[branch.targetNodeId]?.status === 'pending') {
              runRef.current = withNodeRun(runRef.current, branch.targetNodeId, { status: 'skipped', completedAt: Date.now() });
            }
          }

          runRef.current = withNodeRun(runRef.current, nodeId, {
            status: 'done',
            startedAt: Date.now(),
            completedAt: Date.now(),
            output: { selectedBranchId: selected.id, selectedBranchLabel: selected.label },
          });
          await deps.persistRun?.(runRef.current);
          deps.emit?.('graph.node_done', { runId: runRef.current.runId, nodeId, status: 'done', selectedBranch: selected.id });
          return { nodeId, missionId: null, error: null };
        }

        // Form node (HITL): the SGR wave executor has no human-in-the-loop
        // collection mechanism (no pending-form UI state, no timeout
        // handling) — launching a mission whose task text is the form's
        // own prompt (the old fallthrough behaviour) silently replaces
        // "ask a human" with "ask an agent", which can fabricate an answer
        // no human ever gave. Fail loudly instead of pretending this is
        // implemented; real HITL form collection is future work (design
        // doc §3, Étape 3), not something to fake here.
        if (node.kind === 'form') {
          const message =
            `Form node '${nodeId}' has no handler in the Single Graph Runtime — human-in-the-loop form ` +
            `collection is not implemented; refusing to silently launch a mission on its prompt text instead.`;
          runRef.current = withNodeRun(runRef.current, nodeId, {
            status: 'failed',
            startedAt: Date.now(),
            completedAt: Date.now(),
            errorMessage: message,
          });
          await deps.persistRun?.(runRef.current);
          deps.emit?.('graph.node_done', { runId: runRef.current.runId, nodeId, status: 'failed' });
          return { nodeId, missionId: null, error: message };
        }

        // Defensive floor: ANY other node kind reaching this point (a raw
        // 'subgraph' node expandSubgraphs didn't resolve — e.g. a
        // `{graphId}` reference missing from its registry — or a future
        // node kind added to the GraphNode union without a handler here)
        // must fail loudly too. The one option that must never survive is
        // silently falling into the standard-task-node path below and
        // launching a mission on whatever buildTaskForNode's generic
        // `node.label ?? node.id` fallback produces.
        if (node.kind !== 'task') {
          const message = `No SGR handler for node kind '${node.kind}' (node '${nodeId}') — refusing to silently launch a mission on its label text instead.`;
          runRef.current = withNodeRun(runRef.current, nodeId, {
            status: 'failed',
            startedAt: Date.now(),
            completedAt: Date.now(),
            errorMessage: message,
          });
          await deps.persistRun?.(runRef.current);
          deps.emit?.('graph.node_done', { runId: runRef.current.runId, nodeId, status: 'failed' });
          return { nodeId, missionId: null, error: message };
        }

        // Standard task node: single mission
        const upstreamInput = buildNodeInput(effectiveIr, runRef.current, nodeId);
        const task = buildTaskForNode(node, brainContext, upstreamInput);

        // Mark running
        const attempt = runRef.current.nodeRuns[nodeId].attempt + 1;
        runRef.current = withNodeRun(runRef.current, nodeId, {
          status: 'running',
          attempt,
          startedAt: Date.now(),
          brainNoteIds: brainContext.hitIds,
        });
        await deps.persistRun?.(runRef.current);

        deps.emit?.('graph.node_started', {
          runId: runRef.current.runId,
          nodeId,
          attempt,
          hasUpstreamInput: Object.keys(upstreamInput).length > 0,
        });

        try {
          const missionId = await deps.launchMission({
            node,
            task,
            brainContext,
            projectId: effectiveIr.projectId,
          });
          runRef.current = withNodeRun(runRef.current, nodeId, {
            missionIds: [...runRef.current.nodeRuns[nodeId].missionIds, missionId],
          });
          await deps.persistRun?.(runRef.current);
          return { nodeId, missionId, error: null as string | null };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { nodeId, missionId: null, error: msg };
        }
      }),
    );

    // Handle launch failures
    for (const result of launchResults) {
      if (result.error && result.missionId === null) {
        runRef.current = withNodeRun(runRef.current, result.nodeId, {
          status: 'failed',
          errorMessage: result.error,
          completedAt: Date.now(),
        });
        noteAfterStep({
          projectRoot: deps.projectRoot,
          graphId: effectiveIr.id,
          runId: runRef.current.runId,
          node: effectiveIr.nodes.find((n) => n.id === result.nodeId)!,
          nodeRun: runRef.current.nodeRuns[result.nodeId],
          outcome: 'failure',
          errorMessage: result.error,
          missionIds: [],
        });
      }
    }

    // Collect all mission ids from the wave
    const allMissionIds = launchResults
      .filter((r) => r.missionId !== null)
      .map((r) => r.missionId!);

    // Wait for all missions in the wave to settle
    if (allMissionIds.length > 0) {
      const missions = await deps.waitForMissions(allMissionIds, opts?.signal);

      // Process results
      for (const result of launchResults) {
        if (result.missionId === null) continue;

        const node = effectiveIr.nodes.find((n) => n.id === result.nodeId)!;
        const mission = missions.find((m) => m.id === result.missionId);

        if (!mission) {
          runRef.current = withNodeRun(runRef.current, result.nodeId, {
            status: 'failed',
            errorMessage: 'Mission not found after wait',
            completedAt: Date.now(),
          });
          noteAfterStep({
            projectRoot: deps.projectRoot,
            graphId: effectiveIr.id,
            runId: runRef.current.runId,
            node,
            nodeRun: runRef.current.nodeRuns[result.nodeId],
            outcome: 'failure',
            errorMessage: runRef.current.nodeRuns[result.nodeId].errorMessage,
            missionIds: [result.missionId],
          });
          continue;
        }

        // D6 fix (item 1, 2026-08-15 audit) — root cause: a judge REJECTION
        // never transitions a mission's status to 'failed' (see
        // managerAdvice.ts's/approveGate.ts's own doc comments: a rejected
        // verdict leaves status 'review', awaiting a human decision — that
        // is the correct UI-facing behaviour). This line used to treat
        // EVERY 'review' mission as `succeeded`, with no distinction
        // between "awaiting human approval on a passing/undecided verdict"
        // and "the judge conclusively said no" — so inside a graph RUN, a
        // node whose judge rejected it still unblocked its successors,
        // which then built on top of rejected work as though nothing had
        // happened. `judgeGenuinelyRejected` mirrors the SAME rule
        // `managerAdvice.ts`'s `judgeGenuinelyRejected` already applies
        // elsewhere: a real, conclusive rejection (`passed === false`),
        // NOT an evaluator-rail failure (`scoreUnavailable === true`,
        // which stays on the permissive "let it through, there's real
        // work here" path this codebase already established in
        // approveGate.ts's `checkApproveGate`/`evaluateAutoMerge`). A
        // genuinely rejected node is not "done" — it is routed through
        // the SAME failure path a crashed mission takes (diagnose/replan/
        // critical-abort), which is what actually stops
        // `getReadyNodes` from ever considering its successors ready
        // (readiness requires `status === 'done'`, never `'review'`).
        const judgeGenuinelyRejected =
          mission.status === 'review' &&
          mission.judgeVerdict?.passed === false &&
          mission.judgeVerdict?.scoreUnavailable !== true;
        const succeeded = (mission.status === 'done' || mission.status === 'review') && !judgeGenuinelyRejected;
        const failed = mission.status === 'failed' || mission.status === 'cancelled' || judgeGenuinelyRejected;

        if (succeeded) {
          // Data plane: parse + optional outputSchema validation
          const rawText = extractFinalOutput(mission) ?? '';
          const structured = parseStructuredOutput(rawText, contractOf(node));
          if (!structured.ok) {
            runRef.current = withNodeRun(runRef.current, result.nodeId, {
              status: 'failed',
              errorMessage: structured.error ?? 'outputSchema validation failed',
              completedAt: Date.now(),
              ...(mission.agentMetrics?.costUsd ? { costUsd: mission.agentMetrics.costUsd } : {}),
            });
            if (mission.agentMetrics?.costUsd) {
              runRef.current = withRun(runRef.current, {
                budget: { ...runRef.current.budget, spentUsd: runRef.current.budget.spentUsd + mission.agentMetrics.costUsd },
              });
            }
            const nrFailed = runRef.current.nodeRuns[result.nodeId];
            noteAfterStep({
              projectRoot: deps.projectRoot,
              graphId: effectiveIr.id,
              runId: runRef.current.runId,
              node,
              nodeRun: nrFailed,
              outcome: 'failure',
              errorMessage: nrFailed.errorMessage,
              missionIds: [result.missionId],
            });
            deps.emit?.('graph.node_finished', {
              runId: runRef.current.runId,
              nodeId: result.nodeId,
              status: 'failed',
              reason: 'output_schema',
            });
            appendTraceEntry(deps.projectRoot, buildTraceEntry(runRef.current, node, nrFailed));
          } else {
            const output = structured.value ?? { text: rawText };
            runRef.current = withNodeRun(runRef.current, result.nodeId, {
              status: 'done',
              completedAt: Date.now(),
              output,
              // Dependency-branch inheritance — see resolveInheritedBranches's
              // doc comment above. `mission.worktree` is always the branch
              // name (runtime.ts's `branch` local), never a path.
              resultBranch: mission.worktree || undefined,
              ...(mission.agentMetrics?.costUsd ? { costUsd: mission.agentMetrics.costUsd } : {}),
            });
            runRef.current = withRun(runRef.current, {
              nodeOutputs: { ...(runRef.current.nodeOutputs ?? {}), [result.nodeId]: output },
              ...(mission.agentMetrics?.costUsd
                ? { budget: { ...runRef.current.budget, spentUsd: runRef.current.budget.spentUsd + mission.agentMetrics.costUsd } }
                : {}),
            });
            const nrDone = runRef.current.nodeRuns[result.nodeId];
            noteAfterStep({
              projectRoot: deps.projectRoot,
              graphId: effectiveIr.id,
              runId: runRef.current.runId,
              node,
              nodeRun: nrDone,
              outcome: 'success',
              missionIds: [result.missionId],
            });
            deps.emit?.('graph.node_finished', {
              runId: runRef.current.runId,
              nodeId: result.nodeId,
              status: 'done',
              hasOutput: nrDone.output !== undefined,
            });
            appendTraceEntry(deps.projectRoot, buildTraceEntry(runRef.current, node, nrDone));
          }
        } else if (failed) {
          runRef.current = withNodeRun(runRef.current, result.nodeId, {
            status: 'failed',
            errorMessage: judgeGenuinelyRejected
              ? `Judge rejected (${formatVerdictScoreLine(mission.judgeVerdict!)}) — a rejection never lets successors start`
              : (mission.statusReason ?? `Mission ${mission.status}`),
            completedAt: Date.now(),
            ...(mission.agentMetrics?.costUsd ? { costUsd: mission.agentMetrics.costUsd } : {}),
          });
          if (mission.agentMetrics?.costUsd) {
            runRef.current = withRun(runRef.current, {
              budget: { ...runRef.current.budget, spentUsd: runRef.current.budget.spentUsd + mission.agentMetrics.costUsd },
            });
          }
          const nrMissionFailed = runRef.current.nodeRuns[result.nodeId];
          noteAfterStep({
            projectRoot: deps.projectRoot,
            graphId: ir.id,
            runId: runRef.current.runId,
            node,
            nodeRun: nrMissionFailed,
            outcome: 'failure',
            errorMessage: nrMissionFailed.errorMessage,
            missionIds: [result.missionId],
          });
          deps.emit?.('graph.node_finished', { runId: runRef.current.runId, nodeId: result.nodeId, status: 'failed' });
          appendTraceEntry(deps.projectRoot, buildTraceEntry(runRef.current, node, nrMissionFailed));

          // P2.5: Attempt replan on failure
          if (deps.diagnose) {
            try {
              const diagnosis = await deps.diagnose({
                missionId: result.missionId,
                errorMessage: nrMissionFailed.errorMessage,
                projectId: effectiveIr.projectId,
              });

              const replanCtx: ReplanContext = {
                graphId: effectiveIr.id,
                runId: runRef.current.runId,
                projectRoot: deps.projectRoot,
                failedNodeId: result.nodeId,
                failedNodeRun: nrMissionFailed,
                diagnosis,
                attempt: nrMissionFailed.attempt,
              };

              const replanResult = replanEngine(effectiveIr, runRef.current, replanCtx);
              effectiveIr = replanResult.ir;
              runRef.current = replanResult.run;
              deps.emit?.('graph.replan', {
                runId: runRef.current.runId,
                nodeId: result.nodeId,
                reason: replanResult.reason,
                shouldRetry: replanResult.shouldRetry,
                shouldAbort: replanResult.shouldAbort,
              });

              if (replanResult.shouldAbort) {
                runRef.current = withRun(runRef.current, { status: 'failed', updatedAt: Date.now() });
                await deps.persistRun?.(runRef.current);
                deps.emit?.('graph.run_failed', { runId: runRef.current.runId, reason: replanResult.reason });
                clearRunControl(runRef.current.runId);
                return runRef.current;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              deps.emit?.('graph.replan_error', { runId: runRef.current.runId, nodeId: result.nodeId, error: msg });
            }
          }
        } else {
          // Still pending/queued — shouldn't happen after waitForMissions
          runRef.current = withNodeRun(runRef.current, result.nodeId, { status: 'blocked' });
        }
      }

      runRef.current = withRun(runRef.current, { updatedAt: Date.now() });
      await deps.persistRun?.(runRef.current);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────

interface LaunchResult {
  nodeId: string;
  missionId: string | null;
  error: string | null;
  contestRanking?: ContestRankingEntry[];
}

async function launchContestNode(
  node: ContestNode,
  nodeId: string,
  brainContext: BrainRecallBundle,
  ir: GraphIR,
  runRef: RunRef,
  deps: GraphExecutorDeps,
  signal?: AbortSignal,
): Promise<LaunchResult> {
  const n = node.n;
  const task = buildTaskForNode(node, brainContext);

  const attempt = runRef.current.nodeRuns[nodeId].attempt + 1;
  runRef.current = withNodeRun(runRef.current, nodeId, {
    status: 'running',
    attempt,
    startedAt: Date.now(),
    brainNoteIds: brainContext.hitIds,
  });
  await deps.persistRun?.(runRef.current);

  deps.emit?.('graph.node_started', { runId: runRef.current.runId, nodeId: node.id, attempt, contest: true, n });

  // Launch N parallel missions
  const missionIds: string[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const missionId = await deps.launchMission({
        node,
        task: `${task}\n\n[Contest variant ${i + 1}/${n}]`,
        brainContext,
        projectId: ir.projectId,
      });
      missionIds.push(missionId);
      runRef.current = withNodeRun(runRef.current, nodeId, {
        missionIds: [...runRef.current.nodeRuns[nodeId].missionIds, missionId],
      });
    }
    await deps.persistRun?.(runRef.current);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { nodeId: node.id, missionId: null, error: msg };
  }

  // Wait for all contestants
  const missions = await deps.waitForMissions(missionIds, signal);

  // Rank contestants
  const ranking = rankContestants(missions, node.ranking);
  noteContestRanking({
    projectRoot: deps.projectRoot,
    graphId: ir.id,
    runId: runRef.current.runId,
    nodeId: node.id,
    ranking,
  });

  const winner = ranking.find((r) => r.rank === 1);
  const winnerMission = missions.find((m) => m.id === winner?.missionId);

  if (winnerMission && (winnerMission.status === 'done' || winnerMission.status === 'review')) {
    const totalCost = winnerMission.agentMetrics?.costUsd
      ? missions.reduce((sum, m) => sum + (m.agentMetrics?.costUsd ?? 0), 0)
      : undefined;
    runRef.current = withNodeRun(runRef.current, nodeId, {
      status: 'done',
      completedAt: Date.now(),
      // Dependency-branch inheritance: a contest node's downstream dependent
      // inherits the WINNING contestant's branch — see
      // resolveInheritedBranches's doc comment above.
      resultBranch: winnerMission.worktree || undefined,
      ...(totalCost !== undefined ? { costUsd: totalCost } : {}),
    });
    if (totalCost !== undefined) {
      runRef.current = withRun(runRef.current, {
        budget: { ...runRef.current.budget, spentUsd: runRef.current.budget.spentUsd + totalCost },
      });
    }
    const nrDone = runRef.current.nodeRuns[nodeId];
    noteAfterStep({
      projectRoot: deps.projectRoot,
      graphId: ir.id,
      runId: runRef.current.runId,
      node,
      nodeRun: nrDone,
      outcome: 'success',
      missionIds,
    });
    deps.emit?.('graph.node_finished', { runId: runRef.current.runId, nodeId: node.id, status: 'done', contestWinner: winner?.missionId });
    appendTraceEntry(deps.projectRoot, buildTraceEntry(runRef.current, node, nrDone));
  } else {
    const totalCost = missions.reduce((sum, m) => sum + (m.agentMetrics?.costUsd ?? 0), 0);
    runRef.current = withNodeRun(runRef.current, nodeId, {
      status: 'failed',
      errorMessage: `All ${n} contestants failed`,
      completedAt: Date.now(),
      ...(totalCost > 0 ? { costUsd: totalCost } : {}),
    });
    if (totalCost > 0) {
      runRef.current = withRun(runRef.current, {
        budget: { ...runRef.current.budget, spentUsd: runRef.current.budget.spentUsd + totalCost },
      });
    }
    const nrFailed = runRef.current.nodeRuns[nodeId];
    noteAfterStep({
      projectRoot: deps.projectRoot,
      graphId: ir.id,
      runId: runRef.current.runId,
      node,
      nodeRun: nrFailed,
      outcome: 'failure',
      errorMessage: nrFailed.errorMessage,
      missionIds,
    });
    deps.emit?.('graph.node_finished', { runId: runRef.current.runId, nodeId: node.id, status: 'failed' });
    appendTraceEntry(deps.projectRoot, buildTraceEntry(runRef.current, node, nrFailed));
  }

  return { nodeId: node.id, missionId: winner?.missionId ?? null, error: null, contestRanking: ranking };
}

function rankContestants(missions: Mission[], mode: ContestNode['ranking']): ContestRankingEntry[] {
  const succeeded = missions.filter((m) => m.status === 'done' || m.status === 'review');

  if (mode === 'first_success' && succeeded.length > 0) {
    return missions.map((m, idx) => ({
      missionId: m.id,
      rank: m.status === 'done' || m.status === 'review' ? idx + 1 : 999,
      score: undefined,
      notes: m.status,
    }));
  }

  // judge mode: rank by cost efficiency (lower cost = better) as a simple heuristic
  // A real judge would use an LLM to evaluate quality
  const ranked = [...missions].sort((a, b) => {
    const aScore = a.status === 'done' ? 1 : 0;
    const bScore = b.status === 'done' ? 1 : 0;
    if (aScore !== bScore) return bScore - aScore;
    // Among succeeded, prefer lower cost
    const aCost = a.agentMetrics?.costUsd ?? 0;
    const bCost = b.agentMetrics?.costUsd ?? 0;
    return aCost - bCost;
  });

  return ranked.map((m, idx) => ({
    missionId: m.id,
    rank: idx + 1,
    score: m.status === 'done' ? 1 - (m.agentMetrics?.costUsd ?? 0) / 10 : 0,
    notes: m.status,
  }));
}

function buildTaskForNode(
  node: GraphNode,
  brainContext: BrainRecallBundle,
  upstreamInput?: Record<string, unknown>,
): string {
  let task: string;
  if (node.kind === 'task') {
    task = node.description;
  } else if (node.kind === 'contest') {
    task = node.description;
  } else if (node.kind === 'form') {
    task = node.prompt;
  } else if (node.kind === 'interrupt') {
    task = node.reason;
  } else {
    task = node.label ?? node.id;
  }

  const contract = contractOf(node);
  const schemaHint = formatOutputSchemaHint(contract);
  if (schemaHint) {
    task = `${task}\n\n${schemaHint}`;
  }

  if (upstreamInput) {
    const inputBlock = formatInputBlock(upstreamInput);
    if (inputBlock) {
      task = `${task}\n\n${inputBlock}`;
    }
  }

  // Inject brain context
  if (brainContext.contextBlock) {
    task = `${task}\n\n${brainContext.contextBlock}`;
  }

  return task;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Evaluates a `LoopNodeIR`'s `exit: { kind: 'predicate' }` expression
 * against an iteration's own settled (status 'done') mission — item 4,
 * 2026-08-15 audit (D3). DELIBERATE SCOPE: this codebase has no expression
 * grammar/evaluator for this field anywhere (checked: no other module reads
 * `LoopNodeIR.exit.expression`), and evaluating arbitrary code from an
 * LLM-authored graph would be its own real security/robustness liability.
 * The safe, minimal, HONEST choice is to reuse the SAME "substring,
 * case-insensitive" convention this codebase already establishes for every
 * other free-text condition (`RouterBranch`'s `contains` — see
 * canvasChainOps.ts's `resolveRouterBranch`/graphIr.ts's
 * `evaluateCondition`): the expression is treated as literal text to search
 * for in the iteration's own final output (and, so a predicate can also key
 * off a failure's own wording, its status reason). This is a deliberately
 * narrow interpretation — a richer expression language is future work, not
 * silently pretended to exist here.
 */
function evaluateLoopExitPredicate(expression: string, mission: Mission): boolean {
  const text = [extractFinalOutput(mission) ?? '', mission.statusReason ?? ''].join('\n').toLowerCase();
  return text.includes(expression.toLowerCase());
}
