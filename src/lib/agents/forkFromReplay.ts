/* forkFromReplay.ts — fork-from-replay v1 (Agent Canvas market-gap fix: the
   canvas scorecard names "rewind-and-fork" as residual #1 — LangGraph
   Studio can rewind-and-fork from a checkpoint; our Replay
   (components/agents/canvas/replay/) was scrub-only, read-only, never able
   to spawn a new run from a historical instant).

   HONEST SEMANTICS BOUNDARY (read before touching this file, or before
   assuming it does more than it does): this module can NEVER resurrect the
   source mission's actual PROCESS/conversation state at time T.
     - A native (one-shot `claude -p`) run has no serialized mid-run
       interpreter state to rewind to at all (spec's own architecture: one
       prompt in, one transcript out) — there is nothing to restore.
     - A managed (ReAct) run's live conversation buffer is gone the moment
       its process/tab exits, checkpoint or not — this codebase has no
       durable per-turn conversation snapshot store.
   What this DOES do, honestly: reconstructs a FRESH `DraftSpec` — the
   source mission's own task text, prefixed with a context preamble
   summarizing what the REAL journal shows had happened by `atMs` (which
   plan/stage spans had already CLOSED, the latest human intervention note,
   the gate/judge verdicts seen so far) — for the user to review and launch
   as a brand-new, `isolated` mission (never fires outgoing chains — see
   canvasTypes.ts's `DraftSpec.isolated`) carrying that historical context in
   its prompt. This is "fork a NEW run from a described point in time",
   never "resume the exact process" — LangGraph's checkpoint-rewind is a
   materially stronger guarantee this v1 does not claim, and never should
   without a real serialized-state store behind it.

   Pure derivation, no invoke/fetch — same convention as
   components/agents/canvas/replay/replayModel.ts and
   lib/journal/missionHistory.ts (one directory over): `journalEvents` is
   supplied by the caller (useReplayMode.ts already holds the fleet-wide rows
   queried for the active replay window — see its own `rawEvents`). Every
   derivation here reads ONLY events with `ts_ms <= atMs` — strictly, never
   later — mirroring replayModel.ts's own windowing-honesty rule ("a row
   outside the boundary can never leak into any derived state").

   Layering note: this file lives under lib/agents/ but imports the
   `DraftSpec` TYPE from components/agents/canvas/canvasTypes.ts — a
   type-only import (erased at compile time, so it can never form a runtime
   circular dependency), and the same direction lib/agents/chainEngine.ts
   already imports canvasStore/canvasTypes-adjacent modules from, so this is
   not a new layering precedent.
*/

import type { JournalEventRow } from '../journal/eventTypes.js';
import { currentGenerationEvents, deriveStageSpans } from '../journal/missionHistory.js';
import type { FleetStage } from './fleetStage.js';
import type { DraftSpec } from '../../components/agents/canvas/canvasTypes.js';

// ── Source mission facts ────────────────────────────────────────────────

/**
 * Minimal read-only mission facts `buildForkDraft` needs — deliberately NOT
 * the full `Mission` shape (lib/agents/types.ts): a mission scrubbed from a
 * NON-active project's replay window may only ever have `FleetMission`'s
 * thinner projection on hand (no `agentTask`), and this module must degrade
 * the SAME honest way CanvasContextMenu.tsx's `duplicateAsDraft` already
 * does for its own mission->draft clone (`full?.agentTask ?? title`) rather
 * than require a shape the caller cannot always produce. The caller (the
 * canvas UI) resolves this however it has it — the active project's live
 * `Mission` when available, a `FleetMission`'s title/model otherwise.
 */
export interface ForkSourceMission {
  title: string;
  agentTask?: string;
  agentName?: string;
  model?: string;
}

/** What `buildForkDraft` returns: a full `DraftSpec` MINUS `id` — minting a
 *  canvas id is an existing choke point (canvasIds.ts's `generateCanvasId`)
 *  every other draft-creation call site already owns for itself (see
 *  CanvasContextMenu.tsx's `duplicateAsDraft`/`addNoteAt`/etc.), never
 *  duplicated inside a pure lib function. `projectId` is likewise left for
 *  the caller to set (the source mission's own zone) — this module has no
 *  opinion on WHERE the fork lands, only on what it CONTAINS. */
export type ForkDraftSeed = Omit<DraftSpec, 'id'>;

// ── Context-as-of-T facts (strictly events with ts_ms <= atMs) ──────────

/** Canonical stage order (fleetStage.ts's own vocabulary) — used only to
 *  report completed stages in a stable, human-reading order. */
const STAGE_ORDER: readonly FleetStage[] = ['plan', 'code', 'test', 'review', 'merged'];

export interface ForkContextFacts {
  /** Stage keys whose span was fully CLOSED (both boundaries observed) at or
   *  before `atMs` — an open/in-progress stage at the fork point is
   *  deliberately excluded: it had not actually finished yet. */
  completedStages: readonly FleetStage[];
  /** The latest `mission.intervened` note at or before `atMs`, if any. */
  lastIntervention?: string;
  /** The latest `gate.passed`/`gate.failed` verdict per reviewer role
   *  observed at or before `atMs` (a later re-run of the same role, still
   *  before `atMs`, overwrites the earlier one — "latest known as of T"). */
  gateVerdicts: readonly { role: string; passed: boolean }[];
}

function sortedAsc(events: readonly JournalEventRow[]): JournalEventRow[] {
  return [...events].sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.ts_ms - b.ts_ms));
}

/** Same best-effort parse convention as missionHistory.ts/replayModel.ts —
 *  the journal stores payload as opaque JSON (Rust never inspects it), so a
 *  parse failure must degrade to "no fact" rather than throw. */
function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Derives `missionId`'s context-as-of-`atMs` facts, STRICTLY from events with
 * `ts_ms <= atMs` (never later — see this module's header). `events` may
 * carry any mix of missions/projects; only `missionId`'s CURRENT generation
 * is considered (missionHistory.ts's `currentGenerationEvents` — the same
 * recycled-id scoping every other read-model in this codebase relies on, so
 * a fork can never blend in an unrelated earlier run that happened to reuse
 * the same id).
 */
export function buildForkContextFacts(
  missionId: string,
  atMs: number,
  events: readonly JournalEventRow[],
): ForkContextFacts {
  const generation = currentGenerationEvents(events, missionId);
  const upToT = sortedAsc(generation).filter((e) => e.ts_ms <= atMs);

  const spans = deriveStageSpans(upToT);
  const completedStages = STAGE_ORDER.filter((stage) => spans.some((s) => s.stage === stage && s.endMs !== null));

  let lastIntervention: string | undefined;
  const gateByRole = new Map<string, boolean>();

  for (const e of upToT) {
    if (e.type === 'mission.intervened') {
      const payload = parsePayload(e.payload);
      const note = payload && typeof payload.note === 'string' ? payload.note : undefined;
      if (note) lastIntervention = note; // last one wins — upToT is ascending
      continue;
    }
    if (e.type === 'gate.passed' || e.type === 'gate.failed') {
      const payload = parsePayload(e.payload);
      const role = payload && typeof payload.role === 'string' ? payload.role : undefined;
      if (role) gateByRole.set(role, e.type === 'gate.passed'); // last one wins
    }
  }

  return {
    completedStages,
    lastIntervention,
    gateVerdicts: [...gateByRole.entries()].map(([role, passed]) => ({ role, passed })),
  };
}

// ── Title / preamble composition ─────────────────────────────────────────

/** Locale-agnostic HH:MM (same `toLocaleTimeString` idiom as
 *  replay/replayTicker.ts's `formatClock`, duplicated rather than imported:
 *  that module lives under components/agents/canvas/replay/ and is React
 *  UI-copy-composition code (takes a `t()` callback) — this lib module stays
 *  a leaf with no UI dependency, same rationale draftLaunch.ts/
 *  chainValidation.ts already follow by returning i18n KEYS instead of
 *  calling `t()` themselves.
 *
 *  `hour12: false` is required, not cosmetic: without it, `toLocaleTimeString`
 *  falls back to the RUNTIME's resolved ICU locale, which is `en-US` (12h,
 *  "12:00 AM") on GitHub Actions' ubuntu-latest runners but `fr-FR` (24h,
 *  "01:00") on a French-locale dev machine — the same code producing a
 *  different, non-24h string per environment. Forcing `hour12: false` pins
 *  the output to always-24h, deterministic regardless of the host locale. */
function formatHHMM(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Composes the fork's context preamble — prepended to the source mission's
 * own task so the new mission's agent starts with an honest, event-derived
 * brief of what had already happened by the fork point. Deliberately plain,
 * structural English text, NOT run through `t()`: this becomes part of the
 * AGENT PROMPT (like runtime.ts's own `buildProofContractBlock` scaffolding),
 * never rendered as UI copy — UI-facing strings for this feature (the
 * ReplayBar entry, the DraftNode provenance chip) are the ones translated
 * across all 6 locales, not this internal prompt text.
 */
export function buildForkPreamble(facts: ForkContextFacts, atMs: number): string {
  const lines: string[] = [`[Forked from a Replay checkpoint at ${formatHHMM(atMs)}]`];
  lines.push(
    facts.completedStages.length > 0
      ? `Completed by this point: ${facts.completedStages.join(', ')}.`
      : 'No stage had completed yet by this point.',
  );
  if (facts.gateVerdicts.length > 0) {
    const verdictText = facts.gateVerdicts.map((v) => `${v.role}=${v.passed ? 'passed' : 'failed'}`).join(', ');
    lines.push(`Gate verdicts so far: ${verdictText}.`);
  }
  if (facts.lastIntervention) {
    lines.push(`Last human note: "${facts.lastIntervention}".`);
  }
  return lines.join('\n');
}

// ── The public entry point ───────────────────────────────────────────────

/**
 * Builds a seeded, `isolated` draft forking `missionId` at `atMs` — see this
 * module's header for the honest boundary (task + context brief, never a
 * resurrected process). `journalEvents` is the SAME fleet-wide rows Replay's
 * own window query already holds (useReplayMode.ts's `rawEvents`); this
 * function filters them to `ts_ms <= atMs` itself (via
 * `buildForkContextFacts`) — strictly nothing after the fork point ever
 * leaks into the seeded task or its provenance.
 *
 * Pure: does not mint an id (`ForkDraftSeed` omits it — see its own doc
 * comment) and has no opinion on placement; the caller adds `id` +
 * `projectId` and positions/selects the resulting node.
 */
export function buildForkDraft(
  missionId: string,
  atMs: number,
  journalEvents: readonly JournalEventRow[],
  mission: ForkSourceMission,
): ForkDraftSeed {
  const facts = buildForkContextFacts(missionId, atMs, journalEvents);
  const preamble = buildForkPreamble(facts, atMs);
  const originalTask = mission.agentTask ?? mission.title;

  return {
    title: `${mission.title} (fork @${formatHHMM(atMs)})`,
    task: `${preamble}\n\n${originalTask}`,
    agentName: mission.agentName,
    model: mission.model,
    createdBy: 'user',
    isolated: true,
    forkOf: { missionId, atMs },
  };
}
