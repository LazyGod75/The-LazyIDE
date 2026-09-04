/**
 * Import adapter for ChatGPT conversation exports.
 *
 * VALIDATION STATUS: VALIDATED against the standard ChatGPT export format
 * (Settings → Data Controls → Export Data → conversations.json).
 *
 * Format: JSON file with top-level array of conversation objects.
 * Each conversation has:
 *   id, title, create_time, update_time,
 *   mapping: { [nodeId]: { id, message: { author: {role}, content: {parts} }, ... } }
 *
 * The mapping is a tree of message nodes; we walk it in linear order (topological)
 * and concatenate human + assistant messages into a single text chunk.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { scrubText } from './scrub.js';
import type { ImportAdapter, ImportedConversation } from './types.js';

interface GptMessageAuthor {
  role: 'user' | 'assistant' | 'system' | 'tool';
}

interface GptMessageContent {
  parts?: Array<string | Record<string, unknown>>;
  text?: string;
}

interface GptMessage {
  id: string;
  author: GptMessageAuthor;
  content: GptMessageContent;
  create_time?: number;
}

interface GptNode {
  id: string;
  message?: GptMessage;
  parent?: string;
  children: string[];
}

interface GptConversation {
  id: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  mapping?: Record<string, GptNode>;
}

export class ChatGptExportAdapter implements ImportAdapter {
  readonly source = 'chatgpt-export' as const;

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
      const updatedMs = (conv.update_time ?? conv.create_time ?? 0) * 1000;
      if (updatedMs > 0 && updatedMs < sinceMs) continue;

      const text = extractConversationText(conv);
      if (!text || text.length < 30) continue;

      const scrubbed = scrubText(text);
      const contentHash = createHash('sha256').update(scrubbed).digest('hex');
      const timestamp =
        updatedMs > 0 ? new Date(updatedMs).toISOString() : new Date().toISOString();
      const title = (conv.title ?? 'ChatGPT conversation').slice(0, 80);

      results.push({
        contentHash,
        title,
        text: scrubbed.slice(0, 4000),
        timestamp,
        source: 'import:chatgpt-export',
        topic: 'import/chatgpt',
      });
    }

    return results;
  }
}

/**
 * Handle both top-level array and wrapped `{ conversations: [...] }` formats.
 */
function normalizeTopLevel(raw: unknown): GptConversation[] {
  if (Array.isArray(raw)) return raw as GptConversation[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.conversations)) return obj.conversations as GptConversation[];
  }
  return [];
}

/**
 * Walk the node mapping in topological order and concatenate user+assistant messages.
 * Returns concatenated text capped at 4000 chars.
 */
function extractConversationText(conv: GptConversation): string {
  const mapping = conv.mapping;
  if (!mapping) return conv.title ?? '';

  // Find root node (no parent)
  const nodes = Object.values(mapping);
  const root = nodes.find((n) => !n.parent || !mapping[n.parent]);
  if (!root) return conv.title ?? '';

  const texts: string[] = [];
  walkNode(root.id, mapping, texts, 0);

  return texts.join('\n\n').slice(0, 4000);
}

function walkNode(
  nodeId: string,
  mapping: Record<string, GptNode>,
  texts: string[],
  depth: number,
): void {
  if (depth > 200) return; // guard against cycles
  const node = mapping[nodeId];
  if (!node) return;

  if (node.message) {
    const role = node.message.author?.role;
    if (role === 'user' || role === 'assistant') {
      const text = extractPartText(node.message.content);
      if (text && text.length > 10) {
        texts.push(text.slice(0, 600));
      }
    }
  }

  // Walk the last child (main thread, not branches)
  const lastChild = node.children[node.children.length - 1];
  if (lastChild) {
    walkNode(lastChild, mapping, texts, depth + 1);
  }
}

function extractPartText(content: GptMessageContent): string {
  if (typeof content.text === 'string') return content.text;
  if (!Array.isArray(content.parts)) return '';
  return content.parts
    .map((p) => (typeof p === 'string' ? p : ''))
    .join(' ')
    .trim();
}
