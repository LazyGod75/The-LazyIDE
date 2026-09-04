/* contestChrome.tsx — best-of-N contest winner badge (W-CONTEST: Cursor
   "run N agents, auto-pick best" parity). Split out of chrome/nodeChrome.tsx
   deliberately — that file is already near this repo's 800-line file-size
   cap (coding-style.md: "200-400 lines typical, 800 max") — rather than
   growing it further, this small file owns just the one new chip, same
   "small, composable, never one giant shell" convention nodeChrome.tsx's own
   header already establishes for UrgentRankChip/VerdictChip/MetaChip.

   Purely presentational: driven entirely by canvasStore's `contests` slice
   (never a second source of truth) — the caller (MissionNode.tsx) resolves
   "is THIS mission a contest winner" via `findContestWinner` below and only
   renders {@link ContestWinnerChip} when it returns a match.
*/

import { useI18n } from '../../../../i18n';
import type { ContestSpec } from '../canvasTypes';

/**
 * Resolves whether `missionId` is the recorded winner of any COMPLETED
 * contest — pure, so it's usable both from MissionNode.tsx's render and from
 * a plain unit test with no store/DOM involved. A `'running'` contest (no
 * winner decided yet) or a completed contest with no eligible winner
 * (contestEngine.ts's honest no-winner case) never matches — `winnerId` is
 * only ever set once {@link ContestSpec.status} is `'completed'` AND a real
 * winner was chosen (canvasStore's `completeContest` action).
 */
export function findContestWinner(contests: readonly ContestSpec[], missionId: string): ContestSpec | undefined {
  return contests.find((contest) => contest.status === 'completed' && contest.winnerId === missionId);
}

/**
 * Small gold crown badge — a mission node's marker that it WON a best-of-N
 * contest. Rendered at full LOD only (MissionNode.tsx's chip row, alongside
 * VerdictChip), same "chip row" convention as every other badge in
 * nodeChrome.tsx.
 */
export function ContestWinnerChip() {
  const { t } = useI18n();
  return (
    <span
      data-testid="contest-winner-chip"
      title={t('canvas.node.contestWinner')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 10.5,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 4,
        background: 'rgba(250, 204, 21, 0.16)',
        color: '#FACC15',
        fontFamily: 'var(--font-mono)',
        flexShrink: 0,
      }}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" data-testid="glyph-contest-winner">
        <path d="M2 5.5 5 8l3-4.5L11 8l3-2.5-1 6.5H3L2 5.5Z" fill="currentColor" />
      </svg>
      {t('canvas.node.contestWinner')}
    </span>
  );
}
