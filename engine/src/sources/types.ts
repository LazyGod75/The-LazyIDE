/**
 * Agent-agnostic conversation ingestion.
 *
 * A ConversationSource knows how to DISCOVER conversation artifacts for one
 * coding agent (Claude Code, Mistral Vibe, ...) and how to PARSE one artifact
 * into zero or more neutral payloads that annotateSession() can consume.
 * Fingerprinting (skip-unchanged) stays in dream.ts and is keyed on ref.path.
 */

import { createHash } from 'node:crypto';

export type AgentName = 'claude-code' | 'vibe';

export type SourceKind = 'transcript' | 'subagent' | 'plan' | 'history' | 'compaction-summary';

export interface ConversationRef {
  /** Absolute path of the file whose content drives fingerprinting. */
  path: string;
  mtimeMs: number;
  /** Project root the conversation belongs to ('' when unknown, e.g. plans). */
  projectRoot: string;
  agent: AgentName;
  kind: SourceKind;
}

export interface ConversationPayload {
  sessionId: string;
  text: string;
  /** ISO timestamp for the note. */
  timestamp: string;
  cwd: string;
  filesModified: string[];
  filesRead: string[];
  agent: AgentName;
  sourceKind: SourceKind;
  gitCommit?: string;
  gitBranch?: string;
  /** Parent session id for compaction lineage (Vibe). */
  sessionParent?: string;
}

export interface ConversationSource {
  readonly agent: AgentName;
  /** Discover all candidate conversation artifacts on this machine. */
  listConversations(): ConversationRef[];
  /** Parse one artifact into zero or more annotatable payloads. */
  readConversation(ref: ConversationRef): Promise<ConversationPayload[]>;
}

/**
 * Deterministic session id derived from an artifact path, namespaced per agent
 * so notes from different agents never collide:
 *   makeSourceSessionId('vibe', p)  -> "vibe-<8hex>"
 * Claude Code keeps its historical "dream-<8hex>" ids (golden lock) via
 * makeConversationSessionId in dream.ts — do NOT route it through this helper.
 */
export function makeSourceSessionId(agent: AgentName, filePath: string): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 8);
  return `${agent}-${hash}`;
}
