/**
 * Mistral Vibe conversation source.
 *
 * Discovers and parses, under $VIBE_HOME (default ~/.vibe):
 *   logs/session/<dir>/messages.jsonl              -> transcript payloads
 *   logs/session/<dir>/agents/<dir>/messages.jsonl -> subagent payloads
 *   plans/*.md                                     -> decision-grade plan payloads
 *   vibehistory                                    -> one user-profile history payload
 *
 * Compaction lineage: a transcript containing an injected compaction summary
 * additionally yields a 'compaction-summary' payload whose sessionParent is
 * meta.parent_session_id — the brain keeps what Vibe's compaction destroys.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ConversationPayload, ConversationRef, ConversationSource } from './types.js';
import { makeSourceSessionId } from './types.js';
import {
  type VibeSessionMeta,
  extractVibeSummary,
  extractVibeToolFiles,
  findCompactionSummary,
  parseVibeMessages,
  parseVibeMeta,
} from './vibe-parser.js';

export interface VibeSourceOptions {
  /** Override $VIBE_HOME (tests). */
  home?: string;
}

export function vibeHome(): string {
  return process.env.VIBE_HOME ? resolve(process.env.VIBE_HOME) : join(homedir(), '.vibe');
}

/**
 * Session log dir: honour config.toml [session_logging].save_dir when set,
 * else <home>/logs/session. Best-effort: a broken config falls back silently.
 *
 * A relative save_dir is resolved against $VIBE_HOME (not process.cwd()), which
 * matches Vibe's own path resolution semantics.
 */
export function vibeSessionLogDir(home: string): string {
  const fallback = join(home, 'logs', 'session');
  const configPath = join(home, 'config.toml');
  if (!existsSync(configPath)) return fallback;
  try {
    const config = parseToml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const section = config.session_logging as Record<string, unknown> | undefined;
    const saveDir = section?.save_dir;
    if (typeof saveDir === 'string' && saveDir.trim().length > 0) {
      // Resolve relative paths against VIBE_HOME, not the daemon's cwd.
      return isAbsolute(saveDir) ? saveDir : join(home, saveDir);
    }
  } catch {
    /* unparseable config — fall back */
  }
  return fallback;
}

const SELF_INGEST_GUARD = /cerveau|lazybrain/i;

export class VibeSource implements ConversationSource {
  readonly agent = 'vibe' as const;
  private readonly homeOverride?: string;

  constructor(opts: VibeSourceOptions = {}) {
    this.homeOverride = opts.home;
  }

  /** Resolved lazily so tests can change VIBE_HOME between instances. */
  private home(): string {
    return this.homeOverride ?? vibeHome();
  }

  listConversations(): ConversationRef[] {
    const home = this.home();
    if (!existsSync(home)) return [];
    const refs: ConversationRef[] = [];

    const sessionDir = vibeSessionLogDir(home);
    if (existsSync(sessionDir)) {
      for (const entry of safeReaddir(sessionDir)) {
        const dir = join(sessionDir, entry);
        const transcript = join(dir, 'messages.jsonl');
        const projectRoot = readWorkingDirectory(join(dir, 'meta.json'));
        pushRef(refs, transcript, projectRoot, 'transcript');

        const agentsDir = join(dir, 'agents');
        if (existsSync(agentsDir)) {
          for (const sub of safeReaddir(agentsDir)) {
            pushRef(refs, join(agentsDir, sub, 'messages.jsonl'), projectRoot, 'subagent');
          }
        }
      }
    }

    const plansDir = join(home, 'plans');
    if (existsSync(plansDir)) {
      for (const f of safeReaddir(plansDir)) {
        if (f.endsWith('.md')) pushRef(refs, join(plansDir, f), '', 'plan');
      }
    }

    pushRef(refs, join(home, 'vibehistory'), '', 'history');

    return refs;
  }

  async readConversation(ref: ConversationRef): Promise<ConversationPayload[]> {
    switch (ref.kind) {
      case 'transcript':
      case 'subagent':
        return this.readTranscript(ref);
      case 'plan':
        return readPlan(ref);
      case 'history':
        return readHistory(ref);
      default:
        return [];
    }
  }

  private async readTranscript(ref: ConversationRef): Promise<ConversationPayload[]> {
    const meta = parseVibeMeta(await safeRead(join(dirname(ref.path), 'meta.json')));
    const cwd = meta?.environment?.working_directory ?? ref.projectRoot ?? '';
    if (cwd && SELF_INGEST_GUARD.test(cwd)) return [];

    const messages = parseVibeMessages(await readFile(ref.path, 'utf-8'));
    if (messages.length === 0) return [];

    const base = payloadBase(ref, meta, cwd);
    const payloads: ConversationPayload[] = [];

    const text = extractVibeSummary(messages);
    if (text && text.length > 50) {
      const { filesModified, filesRead } = extractVibeToolFiles(messages, cwd);
      payloads.push({
        ...base,
        sessionId: makeSourceSessionId('vibe', ref.path),
        text,
        filesModified,
        filesRead,
        sourceKind: ref.kind,
      });
    }

    const compaction = findCompactionSummary(messages);
    if (compaction && compaction.length > 50) {
      payloads.push({
        ...base,
        sessionId: makeSourceSessionId('vibe', `${ref.path}#compaction`),
        text: compaction,
        filesModified: [],
        filesRead: [],
        sourceKind: 'compaction-summary',
        sessionParent: meta?.parent_session_id ?? undefined,
      });
    }

    return payloads;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readPlan(ref: ConversationRef): Promise<ConversationPayload[]> {
  const content = (await readFile(ref.path, 'utf-8')).trim();
  if (content.length <= 50) return [];
  return [
    {
      sessionId: makeSourceSessionId('vibe', ref.path),
      text: content.slice(0, 4000),
      timestamp: new Date(ref.mtimeMs).toISOString(),
      cwd: '',
      filesModified: [],
      filesRead: [],
      agent: 'vibe',
      sourceKind: 'plan',
    },
  ];
}

async function readHistory(ref: ConversationRef): Promise<ConversationPayload[]> {
  const raw = await readFile(ref.path, 'utf-8');
  const prompts: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      prompts.push(typeof parsed === 'string' ? parsed : String(parsed));
    } catch {
      prompts.push(trimmed); // Vibe's HistoryManager tolerates plain lines; so do we
    }
  }
  if (prompts.length === 0) return [];
  const text = `Recurring user prompts (Vibe history):\n${prompts.join('\n')}`.slice(0, 4000);
  return [
    {
      sessionId: makeSourceSessionId('vibe', ref.path),
      text,
      timestamp: new Date(ref.mtimeMs).toISOString(),
      cwd: '',
      filesModified: [],
      filesRead: [],
      agent: 'vibe',
      sourceKind: 'history',
    },
  ];
}

interface PayloadBase {
  timestamp: string;
  cwd: string;
  agent: 'vibe';
  gitCommit?: string;
  gitBranch?: string;
}

function payloadBase(ref: ConversationRef, meta: VibeSessionMeta | null, cwd: string): PayloadBase {
  return {
    timestamp: meta?.start_time ?? new Date(ref.mtimeMs).toISOString(),
    cwd,
    agent: 'vibe',
    gitCommit: meta?.git_commit ?? undefined,
    gitBranch: meta?.git_branch ?? undefined,
  };
}

function pushRef(
  refs: ConversationRef[],
  path: string,
  projectRoot: string,
  kind: ConversationRef['kind'],
): void {
  if (!existsSync(path)) return;
  try {
    const stat = statSync(path);
    refs.push({ path, mtimeMs: stat.mtimeMs, projectRoot, agent: 'vibe', kind });
  } catch {
    /* skip unreadable */
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isFile())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function readWorkingDirectory(metaPath: string): string {
  try {
    const meta = parseVibeMeta(readFileSync(metaPath, 'utf8'));
    return meta?.environment?.working_directory ?? '';
  } catch {
    return '';
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}
