/* botApprovalScreenshot — C79 producer: attach the live bot VM screenshot
   to approval page context so BotApprovalPanel can preview the page. */

import type { PageContext } from '../agents/approval/approvalTypes.js';
import { botIdForMission } from './botEngine.js';
import { getLastBotVmState } from '../solari/botVmState.js';

/** Enrich page context with the latest screenshot for this mission's bot. */
export function enrichApprovalPageContext(
  missionId: string,
  page: PageContext,
): PageContext {
  if (page.screenshotDataUrl) return page;
  const botId = botIdForMission(missionId);
  if (!botId) return page;
  const shot = getLastBotVmState(botId)?.screenshotDataUrl;
  if (!shot) return page;
  return { ...page, screenshotDataUrl: shot };
}
