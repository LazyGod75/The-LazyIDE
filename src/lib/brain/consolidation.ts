/* consolidation.ts — Journal→brain consolidation + root trunk promotion (spec §7).

   Two responsibilities:
   1. consolidateMissionsToBrain: Reads completed missions from the journal
      and captures their key learnings/outcomes as brain neurons (kind: 'learning').
      This closes the loop — mission results become long-term memory.

   2. promoteToRootTrunk: Promotes high-value neurons from project brains to
      a shared "root trunk" brain at the workspace root. The root trunk acts
      as a cross-project knowledge layer: decisions, success patterns, and
      reusable solutions that apply regardless of which project is active.

   Both functions are designed to be called periodically (e.g. by the night
   shift standing loops in T3.4) or on-demand from the Settings UI.

   AUDIT FIX (spec §5.3): the root trunk used to be just a tag ('promoted',
   'root-trunk') recaptured into whichever project brain happened to be
   active — not a separate brain at all. promoteToRootTrunk now registers a
   REAL brain at a stable, project-independent path (appDataDir()/root-brain)
   with the engine's T0.8 registry (label 'trunk'), so it is a durable,
   discoverable brain (GET /brains, federated 'all-open'/'team' search — see
   server/routes/search.ts) rather than a fiction. See promoteToRootTrunk's
   doc comment for the one part that is still honestly a fallback: capture()
   itself has no brainId-targeting parameter yet, verified against both the
   CaptureEvent type and the Tauri brain_capture command, so the neuron
   content still lands in the active project brain until that Rust-side
   plumbing exists.
*/

import { getPlatform, isTauri } from '../platform/index.js';
import type { CaptureEvent, InsightPayload } from '../platform/types.js';
import { journalQuery, emitBuffered } from '../journal/journal.js';
import { joinPath } from '../paths.js';

// ── Types ───────────────────────────────────────────────────────────

export interface ConsolidationResult {
  missionsProcessed: number;
  neuronsCaptured: number;
  errors: string[];
}

export interface RootTrunkPromotionResult {
  neuronsPromoted: number;
  errors: string[];
  /** Set when the dedicated root-trunk brain was successfully registered
   *  with the engine this run (see promoteToRootTrunk's doc comment). */
  trunkBrainId?: string;
}

// ── Constants ───────────────────────────────────────────────────────

const MAX_MISSIONS_PER_RUN = 50;
const ROOT_TRUNK_MIN_SCORE = 0.7;
const ROOT_TRUNK_MAX_PROMOTIONS = 10;
const ROOT_TRUNK_DIR_NAME = 'root-brain';

// ── Root trunk registration (spec §5.3 follow-up) ────────────────────

/** Minimal shape returned by the engine's `POST /brains/open`. */
interface OpenBrainResponse {
  brainId: string;
}

/**
 * Register `brainPath` with the running engine's multi-tenant brain
 * registry (`POST /brains/open`), tagged with `label` (T0.8 registry
 * labels — see engine/src/server/brain-registry.ts).
 *
 * Uses the existing `get_brain_connection` + direct-fetch escape hatch
 * (same pattern as BrainSpace.tsx's graph/note-meta sidecar fallbacks)
 * rather than a new Tauri command: get_brain_connection already exposes
 * everything (port + Bearer token) needed to reach any sidecar HTTP
 * endpoint from the renderer, so no Rust changes are required to pass a
 * label through.
 */
async function openLabeledBrain(brainPath: string, label: 'team' | 'trunk'): Promise<string> {
  const { getBrainConnection } = await import('../platform/tauri.js');
  const { port, token } = await getBrainConnection();
  const res = await fetch(`http://127.0.0.1:${port}/brains/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ brainPath, label }),
  });
  if (!res.ok) {
    throw new Error(`/brains/open returned ${res.status}`);
  }
  const data = (await res.json()) as OpenBrainResponse;
  return data.brainId;
}

/**
 * Stable, project-independent root-trunk brain path: `<appDataDir>/root-brain`.
 * Uses Tauri's own `appDataDir()` (already permitted under this app's
 * `core:default` capability, no extra plugin/permission needed) rather than
 * any project root, so the trunk stays the SAME directory no matter which
 * project is active — the entire point of a cross-project knowledge layer.
 */
async function rootTrunkPath(): Promise<string> {
  const { appDataDir } = await import('@tauri-apps/api/path');
  const base = await appDataDir();
  return joinPath(base, ROOT_TRUNK_DIR_NAME);
}

// ── Journal→Brain consolidation ─────────────────────────────────────

/**
 * Read completed missions from the journal and capture their key outcomes
 * as learning neurons in the project brain.
 *
 * Queries `mission.completed` events, extracts the mission title + result
 * from the payload, and captures a structured learning neuron with insights.
 */
export async function consolidateMissionsToBrain(
  _projectId?: string,
): Promise<ConsolidationResult> {
  const errors: string[] = [];
  let missionsProcessed = 0;
  let neuronsCaptured = 0;

  try {
    const rows = await journalQuery({
      types: ['mission.completed'],
      limit: MAX_MISSIONS_PER_RUN,
    });

    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload);
        const missionTitle = payload.title ?? row.mission_id ?? 'Unknown mission';
        const result = payload.result ?? '';
        const diffAdded = payload.diffAdded ?? 0;
        const diffRemoved = payload.diffRemoved ?? 0;
        const filesCount = payload.filesCount ?? 0;

        if (!result && !filesCount) continue;

        const insights: InsightPayload[] = [];

        if (result) {
          insights.push({
            kind: 'success_pattern',
            title: `${missionTitle} — outcome`,
            description: result.slice(0, 400),
            actionable: false,
          });
        }

        if (filesCount > 0) {
          insights.push({
            kind: 'test_insight',
            title: `${missionTitle} — files touched`,
            description: `${filesCount} files modified (+${diffAdded} / -${diffRemoved} lines)`,
            actionable: false,
          });
        }

        const event: CaptureEvent = {
          kind: 'learning',
          title: `Mission complete: ${missionTitle}`.slice(0, 80),
          text: `Project: ${row.project_id}\nResult: ${result.slice(0, 500)}`,
          tags: ['mission', 'consolidation', 'completed'],
          source: 'lazy-ide:consolidation',
          insights,
        };

        await getPlatform().brain.capture(event);
        neuronsCaptured++;
        missionsProcessed++;

        emitBuffered({
          tsMs: Date.now(),
          projectId: row.project_id,
          actor: 'system',
          type: 'brain.captured',
          payload: {
            neuronId: missionTitle,
            kind: 'learning',
          },
        });
      } catch (err) {
        errors.push(`Failed to consolidate mission ${row.mission_id}: ${err}`);
      }
    }
  } catch (err) {
    errors.push(`Journal query failed: ${err}`);
  }

  return { missionsProcessed, neuronsCaptured, errors };
}

// ── Root trunk promotion ────────────────────────────────────────────

/**
 * Promote high-value neurons from project brains to the root trunk brain.
 *
 * Searches across all open project brains for decision-type and learning-type
 * neurons with high relevance scores, then captures them into the root trunk
 * as promoted neurons with provenance tags.
 *
 * The root trunk is now a REAL, separate brain registered with the engine at
 * a stable path (see rootTrunkPath()/openLabeledBrain() above) — not just a
 * tag recaptured into whichever project brain happens to be active.
 *
 * HONEST FALLBACK: `platform.brain.capture()` (Tauri: `brain_capture`) has no
 * brainId-targeting parameter today — verified against both the CaptureEvent
 * type and the Rust command, which always resolves the CURRENT project's
 * brain path. So even when the trunk brain is registered successfully below,
 * the actual neuron content still lands in the active project brain, tagged
 * 'promoted'/'root-trunk' exactly as before. That tagging is what makes the
 * promotion discoverable until brainId-targeted capture is wired through on
 * the Rust side; when it opens successfully, the trunk brain is at least
 * real, durable, and searchable (GET /brains, 'all-open'/'team' scopes) —
 * this function no longer silently pretends the two are the same thing.
 */
export async function promoteToRootTrunk(
  query?: string,
): Promise<RootTrunkPromotionResult> {
  const errors: string[] = [];
  let neuronsPromoted = 0;

  const searchQuery = query ?? 'decision success pattern solution architecture';

  let trunkBrainId: string | undefined;
  if (isTauri()) {
    try {
      const path = await rootTrunkPath();
      trunkBrainId = await openLabeledBrain(path, 'trunk');
    } catch (err) {
      console.warn(
        '[consolidation] failed to open the root-trunk brain — promoted neurons will stay in the active project brain:',
        err,
      );
    }
  }

  try {
    const hits = await getPlatform().brain.searchScoped(searchQuery, 'all', ROOT_TRUNK_MAX_PROMOTIONS);

    for (const hit of hits) {
      if (hit.score < ROOT_TRUNK_MIN_SCORE) continue;
      if (!hit.sourceProject) continue;

      const event: CaptureEvent = {
        kind: 'learning',
        title: hit.title.slice(0, 80),
        text: `Promoted from: ${hit.sourceProject}\n\n${hit.snippet.slice(0, 500)}`,
        tags: ['promoted', 'root-trunk', hit.sourceProject],
        source: 'lazy-ide:root-trunk-promotion',
        insights: [{
          kind: 'success_pattern',
          title: hit.title,
          description: hit.snippet.slice(0, 300),
          actionable: true,
        }],
      };

      try {
        // Same-brain capture is the honest fallback described above — no
        // in-scope capture path can target trunkBrainId explicitly yet.
        await getPlatform().brain.capture(event);
        neuronsPromoted++;

        emitBuffered({
          tsMs: Date.now(),
          projectId: hit.sourceProject,
          actor: 'system',
          type: 'brain.promoted',
          payload: {
            neuronId: hit.id,
            scope: 'org',
          },
        });
      } catch (err) {
        errors.push(`Failed to promote neuron ${hit.id}: ${err}`);
      }
    }
  } catch (err) {
    errors.push(`Root trunk promotion search failed: ${err}`);
  }

  if (trunkBrainId && neuronsPromoted > 0) {
    console.warn(
      `[consolidation] root-trunk brain ${trunkBrainId} is registered but capture cannot target it yet — ` +
        `${neuronsPromoted} promoted neuron(s) were written to the active project brain instead (tagged root-trunk).`,
    );
  }

  return { neuronsPromoted, errors, trunkBrainId };
}

/**
 * Run the full consolidation pipeline: first consolidate completed missions
 * into project brains, then promote high-value neurons to the root trunk.
 *
 * Root trunk promotion is disabled for initial release — capture() has no
 * brainId-targeting parameter yet, so promoted neurons land in the wrong
 * brain. The promotion call is commented out below; re-enable when Rust-side
 * brainId targeting is implemented.
 */
export async function runConsolidationPipeline(
  projectId?: string,
): Promise<{ consolidation: ConsolidationResult; promotion: RootTrunkPromotionResult }> {
  const consolidation = await consolidateMissionsToBrain(projectId);
  // Root trunk promotion disabled for initial release.
  const promotion: RootTrunkPromotionResult = { neuronsPromoted: 0, errors: [] };
  return { consolidation, promotion };
}
