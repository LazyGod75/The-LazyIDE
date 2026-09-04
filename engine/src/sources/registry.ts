import { ClaudeCodeSource } from './claude-code.js';
import type { AgentName, ConversationSource } from './types.js';
import { VibeSource } from './vibe.js';

/**
 * All registered conversation sources. A source whose data directory does not
 * exist simply returns [] from listConversations(), so registration is safe on
 * machines that only run one agent.
 */
export function getSources(agent?: string): ConversationSource[] {
  const all: ConversationSource[] = [new ClaudeCodeSource(), new VibeSource()];
  if (!agent) return all;
  return all.filter((s) => s.agent === (agent as AgentName));
}
