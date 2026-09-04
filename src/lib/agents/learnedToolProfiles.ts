/* learnedToolProfiles — brain-powered tool learning layer.

   Implements the Trace-Free+ / DRAFT insight at runtime: each tool
   accumulates per-project "overlays" — short addenda to its description
   learned from execution traces (successes, failures, corrections).

   The overlay is stored as a brain note with data-cerveau-type='tool-profile'
   and data-cerveau-tool='run_command' (etc.). At mission start, we query
   the brain for all tool-profile notes, parse them, and inject the
   addenda into the system prompt's tool descriptions.

   This is the "couche 2" from the design doc: tools that learn.
   No fine-tuning, no external service — just the brain the project
   already has.

   One-directional dependency: imports from toolRegistry (types only)
   and platform (brain). Nothing imports back except managedAgentPolicy.

   NAMING: renamed from toolProfiles.ts (2026-07) — it collided with
   src/lib/tools/toolProfiles.ts (identical basename AND identical exported
   type name `ToolProfile`), a completely different concept: that module is
   a per-surface tool PERMISSION allow-list (assistant/manager/agent), while
   THIS module is a brain-learned description ADDENDUM overlay. The exported
   type below is renamed to LearnedToolProfile for the same reason.
*/

import { getPlatform } from '../platform/index.js';
import { isConflictError } from '../brain/captureQueue.js';
import { runBrainQueryCss } from '../brain/brainTool.js';

export interface LearnedToolProfile {
  toolName: string;
  /** Short addendum text injected into the tool description. */
  addendum: string;
  /** How many traces contributed to this profile (confidence). */
  traceCount: number;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/**
 * Query the brain for all tool-profile notes for this project.
 * Returns a map of toolName → addendum text.
 *
 * The brain stores these as notes with data-cerveau-type='tool-profile'
 * and data-cerveau-tool='<tool_name>'. The note text contains the
 * addendum, and data-cerveau-trace-count contains the confidence.
 */
export async function loadToolProfiles(): Promise<Map<string, string>> {
  const overlays = new Map<string, string>();
  try {
    const raw = await runBrainQueryCss(
      "article[data-cerveau-type='tool-profile']",
      100,
    );
    if (!raw || raw === '0 matches' || raw.startsWith('(')) return overlays;

    // Parse the brain output — each hit has an #id and text
    // Format from brain_query_css: "#id | text..." per line (or similar)
    // We extract tool name from data-cerveau-tool attribute if present,
    // otherwise infer from the text content.
    const lines = raw.split('\n');
    for (const line of lines) {
      const match = line.match(/#([\w-]+).*?tool[:\s]+(\w+)/i);
      if (match) {
        const toolName = match[2].toLowerCase();
        const text = line.replace(/^#\S+\s*/, '').trim();
        if (toolName && text) {
          // Merge: if multiple profiles for same tool, keep the longest
          const existing = overlays.get(toolName);
          if (!existing || text.length > existing.length) {
            overlays.set(toolName, text);
          }
        }
      }
    }
  } catch {
    // Brain unavailable — continue without overlays
  }
  return overlays;
}

/**
 * Record a tool-profile note to the brain after a trace pattern is detected.
 * Called by the trace processing logic (toolTraces.ts) when enough evidence
 * accumulates for a tool.
 */
export async function saveToolProfile(
  toolName: string,
  addendum: string,
  _traceCount: number,
): Promise<void> {
  try {
    const platform = getPlatform();
    // MUST be awaited: an un-awaited call here would let a rejection (e.g.
    // a duplicate note's "Note already exists" conflict) escape this
    // try/catch as an unhandled promise rejection instead of being handled
    // below — same bug class as managedAgent.ts's FINAL-handler mission-
    // summary capture (see its doc comment for the full story).
    await platform.brain.capture({
      kind: 'agent',
      title: `[tool-profile] ${toolName}`,
      text: addendum,
      tags: ['agent', 'tool-profile', toolName],
      source: 'lazy-ide:tool-profiles',
      space: 'code',
    });
  } catch (err: unknown) {
    if (!isConflictError(err)) {
      console.warn('[learnedToolProfiles] saveToolProfile capture failed:', err);
    }
    // Non-blocking either way — a capture failure must never fail tool-profile learning.
  }
}

/**
 * Build a concise addendum from a set of traces for a given tool.
 * Extracts the most common patterns (failures, corrections, conventions).
 *
 * This is the "learning" step — it distills N traces into a short
 * overlay (max ~150 tokens) that gets injected into the tool description.
 */
export function buildAddendumFromTraces(
  _toolName: string,
  traces: ToolTraceRecord[],
): string | null {
  if (traces.length < 2) return null; // need at least 2 traces to find a pattern

  const patterns: string[] = [];

  // Extract failure patterns
  const failures = traces.filter(t => !t.success && t.errorType);
  if (failures.length >= 2) {
    const errorTypes = new Map<string, number>();
    for (const f of failures) {
      const et = f.errorType!;
      errorTypes.set(et, (errorTypes.get(et) ?? 0) + 1);
    }
    const topError = [...errorTypes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topError && topError[1] >= 2) {
      patterns.push(`Known issue: ${topError[0]} (${topError[1]}× failed)`);
      // Find a correction if one exists — a successful trace with the same
      // error type that also carries a convention or correction field
      const corrected = traces.find(t => t.success && t.errorType === topError[0]);
      const fixText = corrected?.correction ?? corrected?.convention;
      if (fixText) {
        patterns.push(`Fix: ${fixText}`);
      }
    }
  }

  // Extract convention patterns (from successful runs)
  const successes = traces.filter(t => t.success && t.convention);
  if (successes.length >= 2) {
    const conventions = new Map<string, number>();
    for (const s of successes) {
      const c = s.convention!;
      conventions.set(c, (conventions.get(c) ?? 0) + 1);
    }
    const topConv = [...conventions.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topConv && topConv[1] >= 2) {
      patterns.push(`Convention: ${topConv[0]}`);
    }
  }

  if (patterns.length === 0) return null;
  return patterns.join('. ');
}

// ── Trace record (shared with toolTraces.ts) ────────────────────────

export interface ToolTraceRecord {
  toolName: string;
  /** The arguments passed to the tool (JSON string, truncated). */
  args: string;
  /** Whether the tool call succeeded. */
  success: boolean;
  /** Error type/category if failed. */
  errorType?: string;
  /** Correction that was applied (if the agent fixed the issue in a subsequent call). */
  correction?: string;
  /** Convention discovered (e.g. "tests = npm test -- --run"). */
  convention?: string;
  /** Timestamp. */
  timestamp: number;
}
