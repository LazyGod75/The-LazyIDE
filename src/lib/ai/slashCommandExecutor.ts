/* slashCommandExecutor.ts — Executes a ParsedSlashCommand (slashCommands.ts)
   against the assistant Composer's live dependencies (store actions, brain
   docs, brain search, i18n).

   Kept as a plain async function with an injected deps object — no React,
   no direct store/platform imports — so it is unit-testable without
   mounting Composer.tsx or an AssistantStoreProvider tree. Composer.tsx owns
   turning `deps` into real store/platform calls and showing the returned
   toast.
*/

import { formatSlashHelp, parseDocsAddArgs, type ParsedSlashCommand } from './slashCommands.js';
import { addBrainDoc, searchBrainDocs } from '../brain/brainDocs.js';

// ── Types ─────────────────────────────────────────────────────────

export interface SlashCommandChatSession {
  id: string;
}

/** Result of trying to switch the active model by id. */
export interface ApplyModelResult {
  applied: boolean;
  /** Display label of the applied model — only set when applied is true. */
  label?: string;
}

export interface SlashCommandDeps {
  /** Clears the current conversation (assistantStore.clearConversation). */
  clearConversation: () => void;
  /** Existing chat sessions, for /resume lookup (assistantStore.chatSessions). */
  chatSessions: SlashCommandChatSession[];
  /** Loads a session by id (assistantStore.loadChatSession). */
  loadChatSession: (id: string) => void;
  /** Applies a model by id if it exists in either catalog (native or OpenRouter). */
  applyModelById: (id: string) => ApplyModelResult;
  /** Opens the model picker dropdown — used for /model with no argument. */
  openModelPicker: () => void;
  /** Runs a brain search (platform.brain.search) and returns matching titles. */
  brainSearch: (query: string) => Promise<Array<{ title: string }>>;
  /** Fold older turns into verbatim excerpts (assistantStore.compactConversation). */
  compactConversation: () => { foldedTurns: number };
  /** Translate a key with optional interpolation params (useI18n's t). */
  t: (key: string, params?: Record<string, string | number>) => string;
}

export type SlashCommandToastType = 'success' | 'error' | 'info' | 'warning';

export interface SlashCommandOutcome {
  message: string;
  type: SlashCommandToastType;
}

// ── Execution ─────────────────────────────────────────────────────

const MAX_RESULT_TITLES = 5;

function joinTitles(titles: string[]): string {
  return titles.slice(0, MAX_RESULT_TITLES).join(', ');
}

/**
 * Execute a parsed slash command. Returns a toast to show the user, or null
 * when the command already produced its own visible effect (e.g. opening
 * the model picker) and needs no follow-up message.
 */
export async function executeSlashCommand(
  parsed: ParsedSlashCommand,
  deps: SlashCommandDeps,
): Promise<SlashCommandOutcome | null> {
  switch (parsed.name) {
    case 'clear': {
      deps.clearConversation();
      return { message: deps.t('assistant.slashCommands.cleared'), type: 'success' };
    }

    case 'help': {
      return { message: formatSlashHelp(), type: 'info' };
    }

    case 'model': {
      const id = parsed.args.trim();
      if (!id) {
        deps.openModelPicker();
        return null;
      }
      const result = deps.applyModelById(id);
      return result.applied
        ? { message: deps.t('assistant.slashCommands.modelSet', { label: result.label ?? id }), type: 'success' }
        : { message: deps.t('assistant.slashCommands.modelNotFound', { id }), type: 'error' };
    }

    case 'docs': {
      const query = parsed.args.trim();
      const results = searchBrainDocs(query);
      if (results.length === 0) {
        return { message: deps.t('assistant.slashCommands.docsNoResults'), type: 'info' };
      }
      const titles = joinTitles(results.map(r => r.doc.title));
      return {
        message: deps.t('assistant.slashCommands.docsResults', { count: results.length, titles }),
        type: 'success',
      };
    }

    case 'docs-add': {
      const args = parseDocsAddArgs(parsed.args);
      if (!args) {
        return { message: deps.t('assistant.slashCommands.docsAddUsage'), type: 'error' };
      }
      const entry = addBrainDoc({ ...args, source: 'manual' });
      return { message: deps.t('assistant.slashCommands.docsAdded', { title: entry.title }), type: 'success' };
    }

    case 'brain-search': {
      const query = parsed.args.trim();
      if (!query) {
        return { message: deps.t('assistant.slashCommands.brainSearchUsage'), type: 'error' };
      }
      const results = await deps.brainSearch(query);
      if (results.length === 0) {
        return { message: deps.t('assistant.slashCommands.brainSearchNoResults'), type: 'info' };
      }
      const titles = joinTitles(results.map(r => r.title));
      return {
        message: deps.t('assistant.slashCommands.brainSearchResults', { count: results.length, titles }),
        type: 'success',
      };
    }

    case 'resume': {
      const id = parsed.args.trim();
      if (!id) {
        return { message: deps.t('assistant.slashCommands.resumeUsage'), type: 'error' };
      }
      const found = deps.chatSessions.find(s => s.id === id);
      if (!found) {
        return { message: deps.t('assistant.slashCommands.resumeNotFound', { id }), type: 'error' };
      }
      deps.loadChatSession(id);
      return { message: deps.t('assistant.slashCommands.resumed'), type: 'success' };
    }

    case 'compact': {
      const { foldedTurns } = deps.compactConversation();
      if (foldedTurns <= 0) {
        return { message: deps.t('assistant.slashCommands.compactNothing'), type: 'info' };
      }
      return {
        message: deps.t('assistant.slashCommands.compacted', { count: foldedTurns }),
        type: 'success',
      };
    }

    // Declared by slashCommands.ts but with no corresponding capability
    // wired up on this surface yet (no session-fork, agent-diff, or
    // apply-diff primitive exists on the assistant chat store to hook
    // into) — surfaced honestly instead of faked.
    case 'diff':
    case 'apply':
    case 'fork':
      return { message: deps.t('assistant.slashCommands.notAvailable'), type: 'info' };

    case 'unknown':
    default:
      return { message: deps.t('assistant.slashCommands.unknown'), type: 'error' };
  }
}
