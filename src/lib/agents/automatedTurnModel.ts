/* automatedTurnModel — which model a BACKGROUND manager turn uses.

   The LazyManager runs synthetic turns on the user's behalf: the resume
   after an approval queue drains, proactive wake-ups, loop promotion /
   demotion notices, fleet-hygiene alerts. Those were hard-wired to
   `resolveManagerModelId('haiku', getProviderMode())` — the cheap tier of
   the AMBIENT provider mode. On a desktop whose provider mode is "cli"
   that is the native Claude CLI's haiku, whether or not the user's account
   is entitled to it: live QA (2026-09-02) saw every approval followed by
   "Your organization has disabled Claude subscription access for Claude
   Code" in the chat, while the conversation itself ran fine on a BYOK
   DeepSeek the user had picked.

   Rule: stay cheap, but on the rail the user's OWN chat model actually
   runs on (state.managerModel — the model that just answered). The
   "haiku" tier hint is applied within that rail's catalog when it has
   tiers (CLI → claude-haiku-4-5, Pro → anthropic/claude-haiku-4.5) and
   is a no-op on rails without them (BYOK, free). The old provider-mode
   default remains the fallback when no chat model is known or its rail is
   not ready right now. */

import { applyTierHintWithinRail, classifyBotModelRail, isBotRailReady } from '../bots/botRunModel.js';
import { getProviderMode } from '../models/index.js';
import { resolveManagerModelId } from './managerModelResolve.js';

export const AUTOMATED_TURN_TIER = 'sonnet';

export function resolveAutomatedTurnModel(chatModel: string | undefined): string {
  const id = chatModel?.trim();
  if (id) {
    const rail = classifyBotModelRail(id);
    if (rail && isBotRailReady(rail)) return applyTierHintWithinRail(AUTOMATED_TURN_TIER, { model: id, rail });
  }
  return resolveManagerModelId(AUTOMATED_TURN_TIER, getProviderMode());
}
