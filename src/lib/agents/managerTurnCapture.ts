/* managerTurnCapture — D91 fire-and-forget conversation capture at turn end.

   Close-conversation capture (agentsStore) stays the source of truth on
   close; this path is a debounced mid-conversation upsert so memory is not
   only written when the user closes the thread.
*/

import {
  maybeCaptureManagerConversation,
  type ConversationTurn,
} from '../brain/capture.js';

export function scheduleManagerTurnCapture(opts: {
  conversationId?: string;
  messages: ReadonlyArray<{ role: string; content: string }>;
  responseText: string;
  cwd?: string;
}): void {
  if (!opts.conversationId) return;
  try {
    const turns: ConversationTurn[] = [
      ...opts.messages.map((m) => ({
        role: (m.role === 'assistant' || m.role === 'system' ? m.role : 'user') as ConversationTurn['role'],
        content: m.content,
      })),
      { role: 'assistant', content: opts.responseText },
    ];
    maybeCaptureManagerConversation({
      conversationId: opts.conversationId,
      turns,
      cwd: opts.cwd,
    });
  } catch {
    /* capture is best-effort — never fail a manager turn */
  }
}
