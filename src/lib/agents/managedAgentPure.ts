/* managedAgentPure.ts — R6/R7/R8 helpers extracted from managedAgent.ts so
   aftermath can import them without a cycle (managedAgent.ts imports
   managedAgentAftermath.ts). Behavior is copied, not redesigned. */

import { estimateTokens } from '../brain/context.js';
import { stripReasoningLines } from './reasoningLeak.js';

const HANDOFF_THRESHOLD = 80000;

/** R6 — Parses a <reflect>…</reflect> block: trimmed content (max 600 chars ≈ 150 tokens), or null if absent.
 *  R13 — stripped of leaked `[reasoning]…` lines at the producer. */
export function parseReflectBlock(text: string): string | null {
  const match = text.match(/<reflect>([\s\S]*?)<\/reflect>/);
  if (!match) return null;
  const content = stripReasoningLines(match[1]).trim();
  if (!content) return null;
  return content.slice(0, 600);
}

/** R7 — Total estimated token count for a messages array (ceil(chars/4)). */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  return messages.reduce((acc, m) => acc + estimateTokens(m.content), 0);
}

/** R7 — True when messages exceed the handoff threshold (default 80000 tokens). */
export function shouldHandoff(
  messages: Array<{ role: string; content: string }>,
  threshold: number = HANDOFF_THRESHOLD,
): boolean {
  return estimateMessagesTokens(messages) >= threshold;
}

/** R8 — Parses a PRM verifier response into { ok, correction }. */
export function parsePrmVerdict(
  text: string,
): { ok: boolean; correction: string | null } {
  if (/\bOK\b/i.test(text)) {
    return { ok: true, correction: null };
  }
  return { ok: false, correction: stripReasoningLines(text).trim().slice(0, 300) };
}
