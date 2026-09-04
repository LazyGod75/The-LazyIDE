/* scorecardFootnotes.ts — QW2: Scorecard staleness footnotes.

   Provides footnotes for the orchestrator scorecard that honestly indicate
   when features (contest, join, maxDuration) exist in the codebase but have
   no journal data yet — rather than hiding them or showing fabricated zeros.

   i18n note (2026-08 pass): footnotes carry an i18n `textKey`, not resolved
   text — same rationale as scorecardRefresh.ts's own doc comment (pure,
   no-React code; ScorecardPanel.tsx resolves it at render time).
*/

export interface ScorecardFootnote {
  id: string;
  textKey: string;
  severity: 'info' | 'warning';
}

/** Generate footnotes for scorecard entries based on available data. */
export function generateScorecardFootnotes(opts: {
  hasContestData: boolean;
  hasJoinData: boolean;
  hasMaxDurationData: boolean;
  contestFeatureExists: boolean;
  joinFeatureExists: boolean;
  maxDurationFeatureExists: boolean;
}): ScorecardFootnote[] {
  const notes: ScorecardFootnote[] = [];

  if (opts.contestFeatureExists && !opts.hasContestData) {
    notes.push({
      id: 'contest-no-data',
      textKey: 'cockpit.scorecard.footnote.contestNoData',
      severity: 'info',
    });
  }

  if (opts.joinFeatureExists && !opts.hasJoinData) {
    notes.push({
      id: 'join-no-data',
      textKey: 'cockpit.scorecard.footnote.joinNoData',
      severity: 'info',
    });
  }

  if (opts.maxDurationFeatureExists && !opts.hasMaxDurationData) {
    notes.push({
      id: 'maxduration-no-data',
      textKey: 'cockpit.scorecard.footnote.maxDurationNoData',
      severity: 'info',
    });
  }

  return notes;
}
