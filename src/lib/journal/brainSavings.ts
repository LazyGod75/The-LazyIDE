/* brainSavings.ts — pure "Brain" report-card read-model: what the project's
   brain measurably contributed to its missions, derived exclusively from
   journal events. Same honesty contract as zoneDigest.ts/projectReport.ts:
   a field with no real originating event is absent/zero, never fabricated.

   Deliberately does NOT report an "injected context tokens" figure or any
   dollar "amount saved": brain.recalled (eventTypes.ts's BrainRecalledPayload)
   carries `query`/`nodeIds`/`sourceProject` only — no token/char count for
   the recalled content — so a "tokens injected instead of re-discovering"
   number would have to be invented, and a "$X saved" figure would be an
   invented counterfactual (never billed, never observed) on top of that.
   Both are explicitly forbidden (see this feature's spec: "NO invented
   counterfactual"). What IS real and already tracked end-to-end: how many
   recalls happened, and how many prompt-cache READ tokens were served
   (SpendTokensPayload.cacheReadInputTokens, M12) — cache reads are billed at
   a reduced rate (or absorbed into a subscription) vs a fresh read, so a
   real count of them is a genuine "served from cache instead of freshly
   processed" signal even without pricing it in dollars.
*/

import type { JournalEventRow } from './eventTypes.js';

export interface BrainSavingsSummary {
  /** Count of brain.recalled events — real recalls that injected brain
   *  context into a mission's prompt (federatedRecall.ts's emit call site). */
  recallCount: number;
  /** Sum of every spend.tokens event's cacheReadInputTokens (M12 field) —
   *  real tokens served from Anthropic's prompt cache rather than freshly
   *  processed. 0 when never recorded, same honest-zero convention as
   *  ProjectReportTotals — never absent, since it is always derivable from
   *  whatever events were queried. */
  cacheReadTokens: number;
  /** True when there is anything real to show — drives the card's
   *  visibility (ReportKpiStrip.brainNeuronsToday's precedent: no tile/card
   *  for an all-zero project, never a fabricated/uninteresting empty
   *  state). */
  hasActivity: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Best-effort JSON.parse of a row's raw payload text — mirrors
 *  missionHistory.ts's own private parsePayload (each module keeps its own
 *  small copy, established convention — see e.g. zoneDigest.ts's header). */
function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Builds the brain-savings summary from a flat (any order) list of one
 * project's journal rows. Pure: no I/O, no React — see useBrainSavings.ts
 * for the hook wiring this to the live journal.
 */
export function buildBrainSavings(events: readonly JournalEventRow[]): BrainSavingsSummary {
  let recallCount = 0;
  let cacheReadTokens = 0;

  for (const e of events) {
    if (e.type === 'brain.recalled') {
      recallCount += 1;
    } else if (e.type === 'spend.tokens') {
      const payload = parsePayload(e.payload);
      const cache = payload && typeof payload.cacheReadInputTokens === 'number' ? payload.cacheReadInputTokens : 0;
      cacheReadTokens += cache;
    }
  }

  return { recallCount, cacheReadTokens, hasActivity: recallCount > 0 || cacheReadTokens > 0 };
}
