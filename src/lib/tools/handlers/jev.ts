/* Jev-domain tool handler: ask_jev.

   Delegates entirely to runAskJev (src/lib/jev/jevAskRunner.ts) — the
   same executor the LazyManager's ask_jev grounding action uses, so both
   surfaces share one contract, one validator, one formatter. Returns the
   formatted result (or an explicit unavailable string) — never throws,
   per the ToolHandler convention.
*/

import type { ToolExecutionContext } from './types.js';
import { runAskJev } from '../../jev/jevAskRunner.js';
import type { AskJevQuestion } from '../../jev/jevAskRunner.js';

export async function askJev(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<string> {
  return runAskJev(
    args.context ?? args.state,
    args.questions as AskJevQuestion[] | undefined,
    { subject: 'tool', projectId: ctx.projectId, missionId: ctx.missionId },
  );
}
