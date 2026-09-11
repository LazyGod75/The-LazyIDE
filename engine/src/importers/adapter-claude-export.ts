/**
 * Import adapter for Claude.ai conversation exports.
 *
 * VALIDATION STATUS: VALIDATED against the standard Claude export format
 * (claude.ai → Settings → Export Data).
 *
 * Format: JSON file containing an array of conversation objects.
 * Each conversation has:
 *   uuid, name, created_at, updated_at,
 *   chat_messages: Array<{
 *     uuid, sender: "human"|"assistant",
 *     text?: string,
 *     content?: Array<{type, text}>,
 *     created_at, updated_at
 *   }>
 *
 * Note: older exports use a top-level `conversations` key.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { scrubText } from './scrub.js';
import type { ImportAdapter, ImportedConversation } from './types.js';

interface ClaudeMessage {
  uuid: string;
  sender: 'human' | 'assistant';
  text?: string;
  content?: Array<{ type: string; text?: string }>;
  created_at?: string;
  updated_at?: string;
}

interface ClaudeConversation {
  uuid: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeMessage[];
}

export class ClaudeExportAdapter implements ImportAdapter {
  readonly source = 'claude-export' as const;

  private readonly inputPath: string;

  constructor(inputPath: string) {
    this.inputPath = inputPath;
  }

  isAvailable(): boolean {
    return existsSync(this.inputPath);
  }

  list(since?: string): ImportedConversation[] {
    if (!existsSync(this.inputPath)) return [];
    const sinceMs = since ? new Date(since).getTime() : 0;

    let rawData: unknown;
    try {
      rawData = JSON.parse(readFileSync(this.inputPath, 'utf-8'));
    } catch {
      return [];
    }

    const conversations = normalizeTopLevel(rawData);
    const results: ImportedConversation[] = [];

    for (const conv of conversations) {
      const updatedMs = conv.updated_at
        ? new Date(conv.updated_at).getTime()
        : conv.created_at
          ? new Date(conv.created_at).getTime()
          : 0;

      if (updatedMs > 0 && updatedMs < sinceMs) continue;

      const text = extractConversationText(conv);
      if (!text || text.length < 30) continue;

      const scrubbed = scrubText(text);
      const contentHash = createHash('sha256').update(scrubbed).digest('hex');
      const timestamp = conv.updated_at ?? conv.created_at ?? new Date().toISOString();
      const title = (conv.name ?? 'Claude conversation').slice(0, 80);

      results.push({
        contentHash,
        title,
        text: scrubbed.slice(0, 4000),
        timestamp,
        source: 'import:claude-export',
        topic: 'import/claude',
      });
    }

    return results;
  }
}

function normalizeTopLevel(raw: unknown): ClaudeConversation[] {
  if (Array.isArray(raw)) return raw as ClaudeConversation[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.conversations)) return obj.conversations as ClaudeConversation[];
  }
  return [];
}

function extractConversationText(conv: ClaudeConversation): string {
  const messages = conv.chat_messages ?? [];
  const texts: string[] = [];

  for (const msg of messages) {
    if (msg.sender !== 'human' && msg.sender !== 'assistant') continue;
    const text = extractMessageText(msg);
    if (text && text.length > 10) {
      texts.push(text.slice(0, 600));
    }
  }

  return texts.join('\n\n').slice(0, 4000);
}

function extractMessageText(msg: ClaudeMessage): string {
  if (typeof msg.text === 'string' && msg.text.length > 0) return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text ?? '')
      .join(' ')
      .trim();
  }
  return '';
}
