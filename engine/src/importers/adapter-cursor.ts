/**
 * Import adapter for Cursor AI chat history.
 *
 * VALIDATION STATUS: BEST-EFFORT.
 * Schema observed from real Cursor globalStorage/state.vscdb (Cursor 1.x, Windows).
 * The storage format is undocumented and may change across Cursor versions.
 *
 * Data layout (observed):
 *   %APPDATA%/Cursor/User/globalStorage/state.vscdb  (SQLite)
 *   Tables: ItemTable (key/value), cursorDiskKV (key/value)
 *
 *   ItemTable key "composer.composerHeaders":
 *     JSON: { allComposers: Array<ComposerHeader> }
 *     ComposerHeader has: composerId, name, lastUpdatedAt, createdAt, subtitle, ...
 *
 *   cursorDiskKV key "composerData:<composerId>":
 *     JSON: { fullConversationHeadersOnly, conversationMap, text, ... }
 *
 *   cursorDiskKV key "agentKv:blob:<sha>":
 *     JSON: { role: "user"|"assistant"|"system", content: string }
 *
 * Fallback: when full conversation text is unavailable, adapter emits one
 * note per composer header (title + subtitle) for a searchable catalog.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { scrubText } from './scrub.js';
import type { ImportAdapter, ImportedConversation } from './types.js';

const _require = createRequire(import.meta.url);

interface ComposerHeader {
  composerId: string;
  name?: string;
  subtitle?: string;
  lastUpdatedAt?: number;
  createdAt?: number;
}

interface ComposerHeadersData {
  allComposers?: ComposerHeader[];
}

// Minimal interface for the parts of better-sqlite3 we use
interface SqliteStatement {
  get(...args: unknown[]): unknown;
}

interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteConstructor = new (path: string, opts: { readonly: boolean }) => SqliteDb;

function loadSqlite(): SqliteConstructor | null {
  try {
    return _require('better-sqlite3') as SqliteConstructor;
  } catch {
    return null;
  }
}

export class CursorImportAdapter implements ImportAdapter {
  readonly source = 'cursor' as const;

  private dbPath(): string | null {
    const appdata = process.env.APPDATA;
    if (!appdata) return null;
    const p = join(appdata, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    return existsSync(p) ? p : null;
  }

  isAvailable(): boolean {
    return this.dbPath() !== null;
  }

  list(since?: string): ImportedConversation[] {
    const dbPath = this.dbPath();
    if (!dbPath) return [];

    const sinceMs = since ? new Date(since).getTime() : 0;
    const Database = loadSqlite();
    if (!Database) return [];

    let db: SqliteDb;
    try {
      db = new Database(dbPath, { readonly: true });
    } catch {
      return [];
    }

    try {
      return this.readComposers(db, sinceMs);
    } finally {
      db.close();
    }
  }

  private readComposers(db: SqliteDb, sinceMs: number): ImportedConversation[] {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'")
      .get() as { value: string | Buffer } | undefined;

    if (!row) return [];

    const raw = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
    let data: ComposerHeadersData;
    try {
      data = JSON.parse(raw) as ComposerHeadersData;
    } catch {
      return [];
    }

    const composers = data.allComposers ?? [];
    const results: ImportedConversation[] = [];

    for (const composer of composers) {
      const updatedAt = composer.lastUpdatedAt ?? composer.createdAt ?? 0;
      if (updatedAt < sinceMs) continue;

      const title = sanitizeTitle(composer.name ?? composer.subtitle ?? composer.composerId);
      const subtitle = composer.subtitle ?? '';
      const text = this.loadComposerText(db, composer.composerId, title, subtitle);
      if (!text || text.length < 30) continue;

      const scrubbed = scrubText(text);
      const contentHash = createHash('sha256').update(scrubbed).digest('hex');
      const timestamp = new Date(updatedAt || Date.now()).toISOString();

      results.push({
        contentHash,
        title: title.slice(0, 80),
        text: scrubbed.slice(0, 4000),
        timestamp,
        source: 'import:cursor',
        topic: 'import/cursor',
      });
    }

    return results;
  }

  private loadComposerText(
    db: SqliteDb,
    composerId: string,
    title: string,
    subtitle: string,
  ): string {
    try {
      const row = db
        .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
        .get(`composerData:${composerId}`) as { value: string | Buffer } | undefined;

      if (!row?.value) return buildFallback(title, subtitle);

      const raw = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
      const data = JSON.parse(raw) as Record<string, unknown>;

      // Try conversationMap first (richest source)
      const convMap = data.conversationMap as Record<string, unknown> | undefined;
      if (convMap && typeof convMap === 'object') {
        const texts = extractTextsFromConversationMap(convMap);
        if (texts.length > 0) return texts.join('\n\n').slice(0, 4000);
      }

      // Fallback: plain text field
      if (typeof data.text === 'string' && data.text.length > 10) {
        return data.text.slice(0, 4000);
      }
    } catch {
      // best-effort
    }

    return buildFallback(title, subtitle);
  }
}

function buildFallback(title: string, subtitle: string): string {
  const parts = [title, subtitle].filter(Boolean);
  return parts.join('\n').trim();
}

function sanitizeTitle(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex -- strip raw control chars (0x00-0x1f) from untrusted title text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: same — raw control chars are stripped from untrusted input on purpose
      .replace(/[\x00-\x1f]/g, ' ')
      .trim()
      .slice(0, 80) || 'Cursor conversation'
  );
}

function extractTextsFromConversationMap(convMap: Record<string, unknown>): string[] {
  const texts: string[] = [];
  for (const conv of Object.values(convMap)) {
    if (!conv || typeof conv !== 'object') continue;
    const c = conv as Record<string, unknown>;
    const messages = c.conversation;
    if (!Array.isArray(messages)) continue;
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      const role = m.role ?? m.type;
      if (role !== 'user' && role !== 'human' && role !== 'assistant') continue;
      const content = extractMessageText(m);
      if (content && content.length > 20) {
        texts.push(content.slice(0, 600));
      }
    }
  }
  return texts;
}

function extractMessageText(msg: Record<string, unknown>): string | null {
  if (typeof msg.content === 'string') return msg.content;
  if (typeof msg.text === 'string') return msg.text;
  if (Array.isArray(msg.content)) {
    return (
      msg.content
        .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
        .map((b) => (typeof b.text === 'string' ? b.text : ''))
        .join(' ')
        .trim() || null
    );
  }
  return null;
}
