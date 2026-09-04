/* reportPeriod.ts — pure period-filter helper for ProjectReportPage's
   "Aujourd'hui / 7 jours / Tout" selector. Kept pure/unit-testable, no React.
*/

import type { CompletedMissionReport } from '../../../lib/journal/projectReport';

export type ReportPeriod = 'today' | 'week' | 'all';

export const REPORT_PERIODS: readonly ReportPeriod[] = ['today', 'week', 'all'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Filters completed missions by period relative to `nowMs`:
 *   - 'today': same LOCAL calendar day as nowMs (mirrors projectReport.ts's
 *     own `mergedToday` definition — reused via each mission's own flag
 *     rather than re-deriving the local-day comparison here).
 *   - 'week': completedAtMs within the last 7*24h from nowMs.
 *   - 'all': no filtering.
 */
export function filterMissionsByPeriod(
  missions: readonly CompletedMissionReport[],
  period: ReportPeriod,
  nowMs: number = Date.now(),
): readonly CompletedMissionReport[] {
  if (period === 'all') return missions;
  if (period === 'today') return missions.filter((m) => m.mergedToday);
  const cutoff = nowMs - 7 * DAY_MS;
  return missions.filter((m) => m.completedAtMs >= cutoff);
}
