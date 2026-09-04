/* managedProviderEvents — structured-event counterpart to managedProvider's
   streamChatImpl (assistant chat only).

   streamChatEventsImpl delegates to assistantToolLoop.ts's
   withAssistantToolLoopEvents — the SAME extended ReAct loop (brain
   directives + general tool directives) used by the plain-string path
   (managedProvider.ts's streamChatImpl) and by the other three chat
   providers (claudeCode/anthropic/cliBackend), imported under the
   withBrainSearchLoopEvents alias for call-site continuity with those three.

   Reuses managedProvider.ts's resolveManagedTurnContext/buildManagedRunTurn
   so session resolution, system-prompt assembly, and the streamProxyBody
   wiring live in exactly one place — see managedProvider.ts's header for the
   full rationale. This file used to hand-roll a SECOND, independent ReAct
   loop that only understood brain directives (BRAIN_SEARCH/BRAIN_QUERY_CSS/
   BRAIN_NEIGHBOURS) — that gap is what let managed-mode users hit the
   2026-07 READ_FILE-hallucination defect: a general tool directive fell
   through as unrecognized prose with zero tool execution.

   Split into its own file (rather than living inline in managedProvider.ts)
   purely to keep managedProvider.ts under the project's file-size guideline
   — this file has zero behavior of its own beyond the delegation below.
*/

import type { StreamChatRequest, StreamEvent } from './types.js';
import { withAssistantToolLoopEvents as withBrainSearchLoopEvents } from './assistantToolLoop.js';
import { resolveManagedTurnContext, buildManagedRunTurn } from './managedProvider.js';

export async function* streamChatEventsImpl(req: StreamChatRequest): AsyncGenerator<StreamEvent> {
  const ctx = await resolveManagedTurnContext(req);
  yield* withBrainSearchLoopEvents(req, buildManagedRunTurn(ctx, req.signal));
}
