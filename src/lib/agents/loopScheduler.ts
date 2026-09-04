/* loopScheduler.ts — Drives loopEngine's tick() on a stable interval and turns
   due loops into child iteration missions.

   Extracted from agentsStore.tsx's loop-scheduler effect to keep that file
   thin and to make the scheduling contract independently testable.

   ── ROOT CAUSE of the runaway defect this file fixes ─────────────────────
   The previous effect declared `[state.missions]` as its dependency array.
   `state.missions` is replaced (new array reference) on almost every mission
   update — including the frequent onUpdate patches emitted while ANY mission
   runs (progress %, live action text, new timeline entries), which happens
   many times per second, including for a loop's own freshly spawned child.
   Each one of those mutations tore the effect down and rebuilt it, which had
   two consequences:
     1. It called loadLoopsOnStartup(root) again — NOT "on startup" at all,
        but on every mission-list mutation.
     2. loadLoopsOnStartup() does its own read-modify-write of loops.json:
        whenever it observes a persisted nextRunAt still in the past (the
        NORMAL state between "a loop just became due" and "markIterationFired
        finished persisting the advance"), it overwrites the entire loop
        record with that stale snapshot, stamping only nextRunAt back to
        "now".
     3. Racing against markIterationFired's own read-modify-write of the same
        file, whichever write landed last won — clobbering iterationCount and
        iterationMissionIds back to their PRE-FIRE values (0 and []) while
        leaving nextRunAt immediately due again, so the very next 30s poll
        fired again.
   This reproduces every symptom observed in the real-app QA run: every child
   labeled "iter #1" (iterationCount kept getting stomped back to 0),
   iterationMissionIds ending with only the LAST id (each racing writer
   started from the same clobbered []), and 5 children in ~6 minutes for a
   cadence that should have produced 1-2.

   ── THE FIX ───────────────────────────────────────────────────────────────
   This module owns exactly ONE interval for the caller's whole lifetime
   (created once — the caller must NOT recreate it on mission-state changes),
   calls loadLoopsOnStartup() exactly once when the scheduler starts, and
   serializes tick execution with an in-flight guard so two ticks (or a tick
   and the startup load) can never race against each other. markIterationFired
   is awaited BEFORE the child mission is handed back to the caller, closing
   the window where a concurrent reader could observe stale due/iteration
   data — one tick fires at most once per cadence, guaranteed.
*/

import type { Mission } from './types.js';
import type { PermissionMode } from './runtime.js';
import {
  tick as loopTick,
  markIterationFired,
  shouldStopLoop,
  disableLoop,
  loadLoopsOnStartup,
  getLoopState,
  artifactOwnerIdForLoop,
  type PersistedLoop,
  type LoopStopReason,
} from './loopEngine.js';
import { getCurrentLoopArtifact } from './loopArtifact.js';
import { getMetricsForLoop, synthesizeMetricTrend, formatMetricSynthesisText } from './loopMetrics.js';
import { emitBuffered } from '../journal/journal.js';
import { projectIdFromRoot } from '../journal/projectId.js';

/**
 * Section 4 gate 1 ("figé une seule fois ... jamais régénéré à chaque
 * tour") + section 6 ("étape de synthèse qui influence les décisions
 * suivantes") — builds the two OPTIONAL, purely-additive context blocks a
 * gated loop's iteration prompt gets, on top of the pre-existing previous-
 * iteration state context below. Both are read-only lookups (never a write,
 * never an LLM call) so calling this on every tick is cheap and side-effect
 * free. Absent artifact/metrics simply contribute no text — never a
 * fabricated placeholder.
 */
async function buildGateContext(root: string, loop: PersistedLoop): Promise<string> {
  const parts: string[] = [];

  const artifact = await getCurrentLoopArtifact(root, artifactOwnerIdForLoop(loop)).catch(() => null);
  if (artifact) {
    const content = typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content);
    parts.push(
      `[VALIDATED ARTIFACT v${artifact.version}${artifact.label ? ` — ${artifact.label}` : ''}] This was frozen once and approved by the user — reuse it AS-IS, do NOT regenerate or reinterpret it:\n${content}`,
    );
  }

  // Section 6: `loopConfig.measure` is the charter's own named learning
  // metric (types.ts's LearningAndKillSwitch.measure, carried onto the
  // running loop) — absent for a loop with no learning axis declared at all
  // (never fabricates a metric name to look up).
  const metricName = loop.loopConfig.measure;
  if (metricName) {
    const entries = await getMetricsForLoop(root, loop.missionId, metricName).catch(() => []);
    if (entries.length > 0) {
      const text = formatMetricSynthesisText(synthesizeMetricTrend(entries, metricName));
      if (text) parts.push(text);
    }
  }

  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : '';
}

const TICK_INTERVAL_MS = 30_000;

export interface LoopFireEvent {
  loop: PersistedLoop;
  childMission: Mission;
  /** The loop's own permission mode, or the 'acceptEdits' default — pass
   *  straight through to runMission's options so children never stall on an
   *  approval prompt that cannot appear in-app. */
  permissionMode: PermissionMode;
}

export interface LoopSchedulerDeps {
  /** Resolves the real project root (never '.'). */
  getRepoPath: () => Promise<string>;
  /** Latest missions snapshot — callers should back this with a ref so it
   *  never goes stale without forcing the scheduler to restart. */
  getMissions: () => Mission[];
  /** Mint the next mission id (shared counter with the rest of the store). */
  nextMissionId: (existing: readonly Mission[]) => string;
  /** Default model id when a persisted loop predates the model field. */
  defaultModelId: () => string;
  /** Called synchronously for every loop that fired this tick, once its
   *  persisted bookkeeping (iterationCount/iterationMissionIds/nextRunAt) has
   *  already been advanced. The caller owns spawning + running the mission. */
  onFire: (event: LoopFireEvent) => void;
  /**
   * Trust-critical defect #2 — called for every loop tick() disabled instead
   * of firing (see LoopStopReason for the distinct reasons), AFTER the
   * disable + journal write already happened. Optional and best-effort: the
   * caller (agentsStore.tsx) uses this to set a human-readable, localized
   * `statusReason` on the loop's own anchor mission so the guard trip is
   * visible on the mission itself, not only in the (deliberately
   * unlocalized, machine-readable) journal payload — "make it visible ...
   * say WHY ... in the user's language". Never required for the scheduler's
   * own correctness — a caller that omits it loses only that extra
   * surfacing, not the guard itself.
   */
  onAutoDisabled?: (loop: PersistedLoop, reason: LoopStopReason) => void;
}

/** Start the loop scheduler. Returns a stop function — clears the interval
 *  and prevents any further loops from firing (an in-flight tick still
 *  finishes the loop it is currently processing, but starts no new one). */
export function startLoopScheduler(deps: LoopSchedulerDeps): () => void {
  let stopped = false;
  let ticking = false; // reentrancy guard — the core of the runaway fix

  const runTick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const root = await deps.getRepoPath();
      const projectId = projectIdFromRoot(root);
      const missions = deps.getMissions();
      const { loopsToFire, loopsAutoDisabled } = await loopTick(root, missions);

      // ZOMBIE LOOP fix (belt-and-suspenders) + trust-critical defect #2's
      // runaway guards (see loopEngine.ts tick()'s own doc comment):
      // loopTick already disabled these before returning them here; journal
      // the fact for each one, with its OWN specific reason, so the loop's
      // history shows a real marker (same convention as a merge/archive/
      // delete-triggered stop) instead of a single generic label that would
      // hide WHY a runaway guard actually tripped.
      for (const loop of loopsAutoDisabled) {
        emitBuffered({
          type: 'loop.stopped',
          tsMs: Date.now(),
          projectId,
          missionId: loop.missionId,
          actor: 'system',
          payload: { reason: loop.stopReason },
        });
        deps.onAutoDisabled?.(loop, loop.stopReason);
      }

      if (loopsToFire.length === 0 || stopped) return;

      for (const loop of loopsToFire) {
        if (stopped) return;

        if (shouldStopLoop(loop, missions)) {
          await disableLoop(root, loop.missionId);
          continue;
        }

        const iterNum = loop.loopConfig.iterationCount + 1;
        const childId = deps.nextMissionId(missions);

        // Journal: this tick is about to launch an iteration for `loop` —
        // emitted BEFORE the bookkeeping advance below so a slow
        // markIterationFired/onFire chain can never delay the tick signal
        // itself. loop.missionId is the loop's own persisted identity (see
        // PersistedLoop.missionId in loopEngine.ts) — reused here as the
        // envelope's missionId since a loop has no separate "loopId" concept
        // in the journal's event vocabulary today.
        emitBuffered({
          type: 'loop.tick',
          tsMs: Date.now(),
          projectId,
          missionId: loop.missionId,
          actor: 'system',
          payload: { iteration: iterNum },
        });

        // Advance persisted bookkeeping BEFORE spawning (the fix): by the
        // time onFire()/runMission() run, loops.json already reflects this
        // iteration, so no concurrent reader can observe a stale "still due"
        // record and reprocess it. `missions` (trust-critical defect #2)
        // drives markIterationFired's own minimum-delay + exponential
        // backoff guard — see its doc comment in loopEngine.ts.
        await markIterationFired(root, loop.missionId, childId, missions);

        const loopState = await getLoopState(root, loop.missionId);
        const stateContext = loopState
          ? `\n\n[PREVIOUS ITERATIONS CONTEXT]\nLast iteration: #${loopState.lastIteration}\nLast result: ${loopState.lastResult}\nLast files created: ${loopState.lastFilesCreated.join(', ') || 'none'}\nTotal history entries: ${loopState.history.length}\nDo NOT recreate files that already exist. Continue from where the previous iteration left off.`
          : '';
        // Section 4 gate 1 (frozen artifact, never regenerated) + section 6
        // (named-metric synthesis) — see buildGateContext's own doc comment.
        // Best-effort: a lookup failure degrades to no extra context, never
        // blocks the iteration from firing.
        const gateContext = await buildGateContext(root, loop).catch(() => '');

        const childMission: Mission = {
          id: childId,
          title: `${loop.title} #${iterNum}`,
          status: 'queued',
          model: loop.model ?? deps.defaultModelId(),
          worktree: `loop/${loop.missionId}/${iterNum}`,
          progress: 0,
          planSteps: [],
          actionTimeline: [],
          agentTask: `${loop.agentTask}\n\n[LOOP ITERATION ${iterNum}] This is iteration ${iterNum} of a recurring loop. Do ONLY ONE step of the task this iteration, then emit FINAL. Do NOT attempt to complete the entire task in one iteration. For sequential file creation, create only file #${iterNum} this iteration.${stateContext}${gateContext}`,
          agentName: loop.agentName,
          loopParentId: loop.missionId,
          loopIteration: iterNum,
        };

        deps.onFire({
          loop,
          childMission,
          permissionMode: loop.permissionMode ?? 'acceptEdits',
        });

        // Journal: the iteration record itself, once the child mission has
        // actually been handed to the caller. LoopIterationPayload only
        // carries an optional free-text `summary` (no dedicated loopId/
        // missionId fields) — the child mission id is folded into that text
        // rather than inventing new payload fields on the shared contract.
        emitBuffered({
          type: 'loop.iteration',
          tsMs: Date.now(),
          projectId,
          missionId: loop.missionId,
          actor: 'system',
          payload: { summary: `iteration ${iterNum} -> mission ${childId}` },
        });
      }
    } catch {
      // Loop tick is best-effort — never throw into the interval callback.
    } finally {
      ticking = false;
    }
  };

  const interval = setInterval(() => {
    void runTick();
  }, TICK_INTERVAL_MS);

  // Runs exactly once, when the scheduler starts — NOT on every mission
  // mutation (that was the bug; see the module header). Recovers loops that
  // were due while the app was closed.
  deps
    .getRepoPath()
    .then((root) => loadLoopsOnStartup(root))
    .catch(() => {
      // Best-effort.
    });

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
