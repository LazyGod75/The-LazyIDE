/* projectReport.ts — pure per-project « Rapport » read-model (Agent Canvas
   W8b follow-up): everything a future report page needs about a project's
   COMPLETED missions, derived exclusively from journal events. The page UI
   itself ships in a later wave — this module is only the derivation.

   Same honesty contract as missionHistory.ts (this module's sibling —
   grouping/duration/token/chain helpers are imported from there, never
   re-derived): a field that cannot be derived from real events is absent or
   null, never fabricated.

   Artifacts provenance: Mission.proofs (the ProofArtifact[] an agent
   actually attached at runtime — screenshots/test_run/command_output/
   behavior_diff stored under `<project>/.lazy/artifacts/<missionId>/`, see
   types.ts's ProofArtifact block) is read out of the journal's OWN data:
   the LATEST mission.updated/mission.created event carrying a full Mission
   snapshot in `payload.mission` (eventTypes.ts's T0.5 mechanism — the same
   snapshot `missions_current` is built from, so a mission pruned from the
   live store still reports the proofs its last snapshot carried). Each
   entry is shape-checked against the ProofArtifact union's per-kind
   REQUIRED fields before being trusted — a malformed entry is dropped, not
   patched.
*/

import type { ProofArtifact } from '../agents/types.js';
import type { JournalEventRow, JournalEventType } from './eventTypes.js';
import {
  buildMissionRunHistory,
  groupEventsByMission,
  splitMissionGenerations,
  type ChainFireEntry,
  type TokensSource,
} from './missionHistory.js';

// ── Types ────────────────────────────────────────────────────────────

export interface CompletedMissionReport {
  missionId: string;
  /** Generation index for this id (0 = oldest) — see missionHistory.ts's
   *  splitMissionGenerations. Mission ids get recycled, so completedMissions
   *  is keyed by (missionId, generation), never missionId alone: two
   *  unrelated missions sharing a recycled id can BOTH legitimately appear
   *  here if each independently reached a success terminal event. */
  generation: number;
  /** From the latest full Mission snapshot (or mission.created's own title) — null when never observed. */
  title: string | null;
  /** The success terminal event that qualified this mission ('mission.completed' | 'mission.approved'). */
  terminalType: JournalEventType;
  completedAtMs: number;
  /** True when completedAtMs falls on the same LOCAL calendar day as `nowMs`. */
  mergedToday: boolean;
  /**
   * Real agent processing time — agentMetrics.durationMs from the mission's
   * latest journal snapshot, NEVER the wall-clock span between the mission's
   * first and terminal event (see missionHistory.ts's own durationMs, which
   * IS wall-clock and stays correct for its own callers — Gantt timelines —
   * but is the wrong metric for a "how much agent time did this cost" KPI:
   * a mission queued/paused for hours or days between start and completion
   * would otherwise report that whole span as its "duration". null when the
   * mission never recorded agentMetrics (mock/demo missions, or an older
   * snapshot shape) — an honest absence, never a wall-clock fallback and
   * never estimated.
   */
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  tokensSource: TokensSource;
  /**
   * Prompt-cache READ tokens (M12 dogfood fix, undercount honesty) —
   * agentMetrics.cacheReadInputTokens from the mission's latest snapshot.
   * `tokensIn` alone under-reports a mission's real input volume whenever
   * prompt caching kicked in (see AgentMetrics.cacheReadInputTokens's doc
   * comment in types.ts). null when never recorded — an honest absence, the
   * UI-facing "entrée" label should read as "(hors cache)" in that case
   * rather than silently implying the count already includes cache reads.
   */
  cacheReadInputTokens: number | null;
  /**
   * Cost-honesty wave ("comment est calculé le coût... quand j'utilise
   * l'abonnement ?") — true when costUsd came from the NATIVE claude-code/
   * codex CLI's own self-reported total_cost_usd (agent.rs's
   * parse_result_usage, emitted with payload.source:'real' at runtime.ts's
   * doneHandler): an exact calculation of the tokens' API-list-price
   * EQUIVALENT, never an amount Lazy actually billed. A user on a flat
   * Claude subscription (or a personal API key configured straight into the
   * CLI) pays Lazy nothing extra for this mission — Lazy's own ai-proxy/
   * credits system is never involved for native missions. false when the
   * mission's `mission.started` model carried a '/' (OpenRouter id), which
   * only ever routes through the managed engine (real ai-proxy billing —
   * see runtime.ts's classifyMissionModel/isLiveAgentAvailable). undefined
   * when no mission.started event was observed for this generation — an
   * honest absence, never a guessed default.
   */
  costIsApiEquivalent?: boolean;
  /** Real attached evidence from the mission's last journal snapshot — [] when none was ever attached. */
  artifacts: readonly ProofArtifact[];
  chainFires: readonly ChainFireEntry[];
  /**
   * W-MODES (approval modes) — true when the successful `mission.approved`
   * event's own payload carries `actor: 'auto'` (agentsStore.tsx's
   * `triggerAutoMergeIfEligible` merged this mission, not a human's
   * "Merger" click). Absent — never a fabricated `false` — whenever
   * `terminalType` isn't `mission.approved` at all (a review-only
   * completion never merged), or the approval predates this field, or the
   * payload couldn't be parsed; only ever `true`, matching this codebase's
   * "absent, never a fabricated default" honesty convention.
   */
  autoMerged?: boolean;
}

export interface ProjectReportTotals {
  /** Raw sum across EVERY completed mission regardless of rail — kept for
   *  back-compat with any existing consumer that genuinely wants "total
   *  dollar-equivalent activity" as one number. Mixes real managed/BYOK
   *  spend with native-rail API-equivalent figures — NEVER render this
   *  alone as "cost" in a user-facing $/credits surface (that is exactly
   *  the 2026-08-19 dollar-kill incident's display half); use
   *  `costUsdManaged`/`costUsdApiEquivalent` below instead, which split by
   *  rail so each can be labeled honestly (real vs equivalent). */
  costUsd: number;
  /** Sum of costUsd across missions where `costIsApiEquivalent === false`
   *  (managed/BYOK — real spend, either Lazy's managed credits or the
   *  user's own BYOK key). Excludes missions with `costIsApiEquivalent`
   *  undefined (no mission.started event observed — unknown rail, honestly
   *  left out of both splits rather than guessed into either). */
  costUsdManaged: number;
  /** Sum of costUsd across missions where `costIsApiEquivalent === true`
   *  (native claude-code/codex CLI rail — an API-list-price EQUIVALENT,
   *  never money Lazy actually billed; see CompletedMissionReport.
   *  costIsApiEquivalent's own doc comment). */
  costUsdApiEquivalent: number;
  tokensIn: number;
  tokensOut: number;
  /** Sum of each completed mission's REAL agent processing time
   *  (CompletedMissionReport.durationMs, i.e. agentMetrics.durationMs — see
   *  that field's doc comment). Missions with no recorded agentMetrics
   *  contribute 0, never a wall-clock estimate — an honest partial sum, not
   *  a fabricated total. */
  durationMs: number;
}

export interface ProjectReport {
  completedMissions: readonly CompletedMissionReport[];
  totals: ProjectReportTotals;
  mergedTodayCount: number;
}

// ── Proof-artifact shape validation ──────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): value is string {
  return typeof value === 'string';
}

/** Validates one raw snapshot entry against the ProofArtifact union's
 *  per-kind REQUIRED fields (types.ts, spec §8 — shape normative). */
export function isProofArtifactLike(value: unknown): value is ProofArtifact {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'screenshot':
      return str(value.path) && str(value.label);
    case 'test_run':
      return str(value.command) && typeof value.exitCode === 'number' && str(value.outputPath);
    case 'e2e_recording':
      return str(value.path);
    case 'command_output':
      return str(value.command) && str(value.outputPath);
    case 'behavior_diff':
      return str(value.before) && str(value.after);
    default:
      return false;
  }
}

// ── Snapshot extraction ──────────────────────────────────────────────

const SNAPSHOT_EVENT_TYPES: readonly JournalEventType[] = ['mission.updated', 'mission.created'];

interface SnapshotFacts {
  title: string | null;
  artifacts: ProofArtifact[];
  /** Real agent processing time (agentMetrics.durationMs from the mission's
   *  latest snapshot) — see this file's header on why this, not
   *  missionHistory.ts's wall-clock durationMs, backs the report's DURÉE
   *  total. null when the mission never recorded agentMetrics (mock/demo
   *  missions, or an older snapshot shape) — an honest absence, never
   *  estimated from wall-clock timestamps. */
  agentDurationMs: number | null;
  /** Prompt-cache READ tokens (agentMetrics.cacheReadInputTokens) — see
   *  CompletedMissionReport.cacheReadInputTokens's doc comment. null when
   *  never recorded. */
  cacheReadInputTokens: number | null;
}

/** True for a finite, non-negative number — the only shape agentMetrics.
 *  durationMs (a real Rust/managed-loop measurement) can honestly take. */
function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Latest-snapshot-wins extraction of title + proofs + real agent duration
 * from a mission's events (already ascending — buildMissionRunHistory
 * sorts). mission.updated carries the freshest full Mission under
 * `payload.mission`; mission.created carries either the same snapshot shape
 * or, minimally, a top-level `title`. Walks newest-first and takes the
 * first event that yields each fact.
 */
function extractSnapshotFacts(ascEvents: readonly JournalEventRow[]): SnapshotFacts {
  let title: string | null = null;
  let artifacts: ProofArtifact[] | null = null;
  let agentDurationMs: number | null = null;
  let cacheReadInputTokens: number | null = null;

  for (let i = ascEvents.length - 1; i >= 0; i--) {
    const e = ascEvents[i];
    if (!SNAPSHOT_EVENT_TYPES.includes(e.type)) continue;
    const payload = parsePayload(e.payload);
    if (!payload) continue;

    const snapshot = isRecord(payload.mission) ? payload.mission : null;
    const agentMetrics = snapshot && isRecord(snapshot.agentMetrics) ? snapshot.agentMetrics : null;

    if (artifacts === null && snapshot && Array.isArray(snapshot.proofs)) {
      artifacts = snapshot.proofs.filter(isProofArtifactLike);
    }
    if (title === null) {
      if (snapshot && str(snapshot.title)) title = snapshot.title;
      else if (str(payload.title)) title = payload.title;
    }
    if (agentDurationMs === null && agentMetrics && isFiniteNonNegative(agentMetrics.durationMs)) {
      agentDurationMs = agentMetrics.durationMs;
    }
    if (cacheReadInputTokens === null && agentMetrics && isFiniteNonNegative(agentMetrics.cacheReadInputTokens)) {
      cacheReadInputTokens = agentMetrics.cacheReadInputTokens;
    }
    if (title !== null && artifacts !== null && agentDurationMs !== null && cacheReadInputTokens !== null) break;
  }

  return { title, artifacts: artifacts ?? [], agentDurationMs, cacheReadInputTokens };
}

// ── Engine kind (cost-honesty wave) ───────────────────────────────────

/** The model this generation's `mission.started` event carried, or null when
 *  that event was never observed. See CompletedMissionReport.
 *  costIsApiEquivalent's doc comment. */
function extractStartedModel(ascEvents: readonly JournalEventRow[]): string | null {
  const started = ascEvents.find((e) => e.type === 'mission.started');
  if (!started) return null;
  const payload = parsePayload(started.payload);
  return payload && str(payload.model) ? payload.model : null;
}

/** Mirrors runtime.ts's classifyMissionModel rule exactly (native Anthropic
 *  ids never carry '/', managed/OpenRouter ids always do — see that
 *  function's own doc comment) without importing that large, unrelated
 *  module for one boolean check. */
function isNativeEngineModel(model: string): boolean {
  return !model.includes('/');
}

// ── Report derivation ────────────────────────────────────────────────

function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * W-MODES — best-effort read of a `mission.approved` row's own
 * `actor: 'auto'` payload flag. Mirrors missionHistory.ts's private
 * `parsePayload` (not exported — duplicated here as a single-field read
 * rather than widening that module's surface for one caller) with the same
 * fail-honest contract: a corrupt/truncated payload degrades to `undefined`
 * (unknown), never a fabricated `true`/`false`.
 */
function parseAutoMerged(rawPayload: string): boolean | undefined {
  try {
    const parsed = JSON.parse(rawPayload) as { actor?: unknown };
    return parsed.actor === 'auto' ? true : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the per-project report from a flat list of that project's journal
 * rows (any order). Only missions with an observed SUCCESS terminal event
 * (mission.completed/mission.approved) qualify as "completed" — a failed/
 * cancelled mission never appears here (it belongs to the archive view, not
 * the report). Newest-completed-first. `nowMs` is injectable for
 * deterministic `mergedToday` tests; defaults to Date.now().
 *
 * GENERATION SCOPING: mission ids get recycled (see missionHistory.ts's
 * header) — each id's events are split into generations FIRST, and each
 * generation is evaluated independently via buildMissionRunHistory (which,
 * given a single generation's own slice, correctly treats it as its own
 * "current" run with no earlier boundary inside it). A generation that is
 * NOT itself terminal-success is excluded even when an OLDER generation of
 * the same id was — it can never inherit a sibling generation's "Terminée"
 * status or count toward mergedToday.
 *
 * fix/canvas-ux R9 MAJEUR (« Mergées aujourd'hui » honesty) — `mission.
 * completed` marks the AGENT RUN's own end (runtime.ts's own doc comment:
 * "marks the agent run's own end, not the evaluation's") — it fires the
 * instant a mission reaches 'review', REGARDLESS of whether a human ever
 * approves it afterward. `mission.approved` is the only event this codebase
 * ever emits for a REAL merge (agentsStore.tsx's approveMission is the
 * SOLE call site that ever sets `status: 'done'`, and it always pairs that
 * with a `mission.approved` journal row — see that function's own header).
 * Since `history.events` is chronologically ascending and a normally-
 * reviewed-then-approved mission emits `mission.completed` BEFORE the later
 * `mission.approved`, naively taking the FIRST SUCCESS_TERMINAL_TYPES match
 * (the pre-fix behavior) always picked `mission.completed` — meaning
 * `mergedToday`/`mergedTodayCount` counted "agent run finished today"
 * (still awaiting review, or even later REJECTED) as "mergée", never
 * requiring an actual merge at all. Preferring `mission.approved` when
 * present (regardless of array order) fixes both the terminal type AND the
 * completion timestamp to the REAL merge moment; `completedMissions` itself
 * still includes a review-only (never approved) mission — its cost/token/
 * duration totals are real and worth reporting — but `mergedToday` for it
 * is honestly `false` until an actual `mission.approved` row exists.
 */
export function buildProjectReport(events: readonly JournalEventRow[], nowMs: number = Date.now()): ProjectReport {
  const grouped = groupEventsByMission(events);
  const completedMissions: CompletedMissionReport[] = [];

  for (const [missionId, missionEvents] of grouped) {
    for (const gen of splitMissionGenerations(missionEvents)) {
      const history = buildMissionRunHistory(missionId, gen.events);
      const successEvent =
        history.events.find((e) => e.type === 'mission.approved') ??
        history.events.find((e) => e.type === 'mission.completed');
      if (!successEvent) continue;

      const { title, artifacts, agentDurationMs, cacheReadInputTokens } = extractSnapshotFacts(history.events);
      const startedModel = extractStartedModel(history.events);

      completedMissions.push({
        missionId,
        generation: gen.generation,
        title,
        terminalType: successEvent.type,
        completedAtMs: successEvent.ts_ms,
        mergedToday: successEvent.type === 'mission.approved' && isSameLocalDay(successEvent.ts_ms, nowMs),
        // Real agent time (agentMetrics.durationMs), NEVER
        // history.durationMs's wall-clock span — see CompletedMissionReport.
        // durationMs's own doc comment for why.
        durationMs: agentDurationMs,
        tokensIn: history.tokens.tokensIn,
        tokensOut: history.tokens.tokensOut,
        costUsd: history.tokens.costUsd,
        tokensSource: history.tokens.source,
        cacheReadInputTokens,
        artifacts,
        chainFires: history.chainFires,
        autoMerged: successEvent.type === 'mission.approved' ? parseAutoMerged(successEvent.payload) : undefined,
        costIsApiEquivalent: startedModel !== null ? isNativeEngineModel(startedModel) : undefined,
      });
    }
  }

  completedMissions.sort((a, b) => b.completedAtMs - a.completedAtMs);

  const totals = completedMissions.reduce<ProjectReportTotals>(
    (acc, m) => ({
      costUsd: acc.costUsd + m.costUsd,
      // Split by rail (2026-08-19 dollar-kill incident, display half) — see
      // ProjectReportTotals.costUsdManaged/costUsdApiEquivalent's own doc
      // comments. `costIsApiEquivalent === undefined` (unknown rail) adds to
      // NEITHER split, an honest omission rather than a guess.
      costUsdManaged: acc.costUsdManaged + (m.costIsApiEquivalent === false ? m.costUsd : 0),
      costUsdApiEquivalent: acc.costUsdApiEquivalent + (m.costIsApiEquivalent === true ? m.costUsd : 0),
      tokensIn: acc.tokensIn + m.tokensIn,
      tokensOut: acc.tokensOut + m.tokensOut,
      durationMs: acc.durationMs + (m.durationMs ?? 0),
    }),
    { costUsd: 0, costUsdManaged: 0, costUsdApiEquivalent: 0, tokensIn: 0, tokensOut: 0, durationMs: 0 },
  );

  return {
    completedMissions,
    totals,
    mergedTodayCount: completedMissions.filter((m) => m.mergedToday).length,
  };
}
