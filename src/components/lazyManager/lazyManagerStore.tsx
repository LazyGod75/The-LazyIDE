/* lazyManagerStore — unified store adapter that wraps both agentsStore
   (orchestrator/manager chat) and assistantStore (coder/assistant chat)
   into a single entity. Mode toggle ('orchestrator' | 'coder') routes
   the send to the appropriate underlying store without creating separate
   conversations. Both stores remain intact — this is a composition layer,
   not a replacement. */

import { useCallback, useMemo, useState, useEffect, type ReactNode } from 'react';
import { useAgentsStoreOptional } from '../agents/agentsStore';
import { useAssistantStoreOptional } from '../assistant/assistantStore';
import { ALL_MODELS } from '../../lib/models';
import type { ManagerMessage } from '../../lib/agents/types';
import type { ChatMessage } from '../../lib/models';
import {
  LazyManagerStoreContext,
  type LazyManagerStoreValue,
  type ManagerMode,
  type UnifiedMessage,
  type UnifiedSession,
} from './lazyManagerStoreContext';

export type {
  ManagerMode,
  UnifiedMessage,
  UnifiedSession,
  LazyManagerStoreValue,
} from './lazyManagerStoreContext';
export {
  useLazyManagerStore,
  useLazyManagerStoreOptional,
} from './lazyManagerStoreContext';

// ── Coder session previews ────────────────────────────────────────
//
// assistantStore's own `chatSessions` summary only carries
// id/createdAt/updatedAt/messageCount (see that store's `chatSessions`
// memo) — no preview text, unlike agentsStore's managerSessions, which
// already derives one from the first user message. That gap is why every
// coder entry in the unified history drawer used to show as "Sans titre":
// there was simply no preview to show. The full message content DOES live
// in localStorage (lib/ai/chatPersistence.ts's ChatSession[]) — this reads
// that same storage key directly rather than plumbing a new field through
// assistantStore, to derive an equivalent first-user-message preview.
const CHAT_SESSIONS_STORAGE_KEY = 'lazy.chatSessions'; // must match chatPersistence.ts's STORAGE_KEY
const PREVIEW_MAX_CHARS = 60;

function truncatePreview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PREVIEW_MAX_CHARS ? `${trimmed.slice(0, PREVIEW_MAX_CHARS)}...` : trimmed;
}

function loadChatSessionPreviews(): Map<string, string> {
  const previews = new Map<string, string>();
  try {
    const raw = localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
    if (!raw) return previews;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return previews;
    for (const session of parsed as Array<{ id?: unknown; messages?: unknown }>) {
      if (typeof session?.id !== 'string' || !Array.isArray(session.messages)) continue;
      const firstUser = session.messages.find(
        (m): m is { role: string; content: string } =>
          typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'user',
      );
      if (typeof firstUser?.content === 'string') previews.set(session.id, firstUser.content);
    }
  } catch { /* malformed/unavailable storage — no previews, not fatal */ }
  return previews;
}

// ── Mode persistence ──────────────────────────────────────────────

const MODE_KEY = 'lazy.manager.unifiedMode';

function loadMode(): ManagerMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    if (stored === 'coder' || stored === 'orchestrator') return stored;
  } catch { /* ignore */ }
  return 'orchestrator';
}

function saveMode(mode: ManagerMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
}

// ── Normalization helpers ─────────────────────────────────────────

function normalizeManagerMessage(msg: ManagerMessage): UnifiedMessage {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    mode: 'orchestrator' as const,
    actions: msg.actions,
    actionStatuses: msg.actionStatuses,
    approxCreditsUsed: msg.approxCreditsUsed,
    creditsBlocked: msg.creditsBlocked,
    sessionBlocked: msg.sessionBlocked,
    timedOut: msg.timedOut,
    retryText: msg.retryText,
    isStreaming: msg.isStreaming,
    timestamp: msg.timestamp,
  };
}

function normalizeChatMessage(msg: ChatMessage): UnifiedMessage {
  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content,
    mode: 'coder' as const,
    isStreaming: msg.isStreaming,
    error: msg.error,
    interrupted: msg.interrupted,
    codeBlock: msg.codeBlock,
    citations: msg.citations,
    parts: msg.parts,
    chatMode: msg.mode,
  };
}

// ── Provider ──────────────────────────────────────────────────────

interface Props {
  children: ReactNode;
}

export function LazyManagerStoreProvider({ children }: Props) {
  const agents = useAgentsStoreOptional();
  const assistant = useAssistantStoreOptional();
  const [mode, setModeState] = useState<ManagerMode>(loadMode);

  useEffect(() => { saveMode(mode); }, [mode]);

  const setMode = useCallback((m: ManagerMode) => {
    setModeState(m);
  }, []);

  // Unified messages: show the current mode's messages
  const messages = useMemo<UnifiedMessage[]>(() => {
    if (mode === 'orchestrator') {
      return (agents?.managerMessages ?? []).map(normalizeManagerMessage);
    }
    return (assistant?.messages ?? []).map(normalizeChatMessage);
  }, [mode, agents, assistant]);

  const busy = mode === 'orchestrator' ? (agents?.managerBusy ?? false) : (assistant?.isStreaming ?? false);

  const phase: 'idle' | 'turn' | 'grounding' | 'streaming' | 'queued' =
    mode === 'orchestrator'
      ? (!agents?.managerBusy
          ? 'idle'
          : agents.managerPhase === 'grounding'
            ? 'grounding'
            : agents.managerPhase === 'queued'
              ? 'queued'
              : agents.managerMessages.some((m) => m.isStreaming)
                ? 'streaming'
                : 'turn')
      : (assistant?.isStreaming ? 'streaming' : 'idle');

  // Send routes to the appropriate store. Orchestrator mode always targets
  // the agentsStore's currently ACTIVE conversation (multi-conversation
  // LazyManager, wave 1 — this unified adapter still shows exactly ONE
  // conversation's transcript/composer at a time; switching which
  // conversation that is happens via agentsStore's own
  // setActiveConversationId, e.g. from the tab strip — send always follows
  // whichever one is active at click time).
  const send = useCallback(async (text: string) => {
    if (mode === 'orchestrator') {
      if (!agents) return;
      await agents.sendManagerMessage(agents.activeConversationId, text, agents.managerModel);
    } else {
      await assistant?.send(text);
    }
  }, [mode, agents, assistant]);

  // Stop routes to whichever store is busy — orchestrator mode stops the
  // ACTIVE conversation's own turn, never any OTHER open conversation still
  // working in the background (see stopManagerMessage's own doc comment).
  const stop = useCallback(() => {
    if (mode === 'orchestrator') {
      if (agents) agents.stopManagerMessage(agents.activeConversationId);
    } else {
      assistant?.abortStream();
    }
  }, [mode, agents, assistant]);

  // Unified sessions: merge both lists, sorted by updatedAt desc. Both
  // sources get a first-user-message preview (truncated the same way),
  // not just the orchestrator side — see loadChatSessionPreviews' doc
  // comment for why the coder side needs its own lookup.
  const sessions = useMemo<UnifiedSession[]>(() => {
    const chatPreviews = loadChatSessionPreviews();
    const mgrSessions = (agents?.managerSessions ?? []).map(s => ({
      id: s.id,
      source: 'orchestrator' as const,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount,
      preview: truncatePreview(s.preview || ''),
    }));
    const chatSessions = (assistant?.chatSessions ?? []).map(s => ({
      id: s.id,
      source: 'coder' as const,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount,
      preview: truncatePreview(chatPreviews.get(s.id) ?? ''),
    }));
    return [...mgrSessions, ...chatSessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [agents, assistant]);

  // New session: clear ONLY the current mode's store — clearing both wipes
  // the other role's conversation too, which is a P0 bug when the user just
  // wants a fresh orchestrator chat without losing their coder history.
  const newSession = useCallback(() => {
    if (mode === 'orchestrator') {
      agents?.newManagerConversation();
    } else {
      assistant?.clearConversation();
      assistant?.newChatSession();
    }
  }, [mode, agents, assistant]);

  // Load session: route based on source AND switch the mode to match —
  // opening a coder session must flip the chip to Code, opening an
  // orchestrator session must flip to Orchestrateur (P0: loadSession didn't
  // call setMode, so the header chip stayed on the wrong role).
  const loadSession = useCallback((id: string, source: ManagerMode) => {
    setModeState(source);
    if (source === 'orchestrator') {
      agents?.loadManagerSession(id);
    } else {
      assistant?.loadChatSession(id);
    }
  }, [agents, assistant]);

  // Delete session: route based on source
  const deleteSession = useCallback((id: string, source: ManagerMode) => {
    if (source === 'orchestrator') {
      agents?.deleteManagerSession(id);
    } else {
      assistant?.deleteChatSession(id);
    }
  }, [agents, assistant]);

  // Model: reflect current mode
  const modelId = mode === 'orchestrator' ? (agents?.managerModel ?? '') : (assistant?.selectedModel.id ?? ALL_MODELS[0]?.id ?? '');

  const setModelId = useCallback((id: string) => {
    if (mode === 'orchestrator') {
      agents?.setManagerModel(id);
    }
  }, [mode, agents]);

  const value: LazyManagerStoreValue = {
    mode,
    setMode,
    messages,
    busy,
    phase,
    send,
    stop,
    sessions,
    newSession,
    loadSession,
    deleteSession,
    modelId,
    setModelId,
    // Coder-only
    chatMode: assistant?.selectedMode ?? 'ask',
    setChatMode: assistant?.setMode ?? (() => {}),
    selectedModel: assistant?.selectedModel ?? ALL_MODELS[0],
    setModel: assistant?.setModel ?? (() => {}),
    brainEnabled: assistant?.brainEnabled ?? false,
    brainRecall: assistant?.brainRecall ?? null,
    brainError: assistant?.brainError ?? null,
    toggleBrain: assistant?.toggleBrain ?? (() => {}),
    setScope: assistant?.setScope ?? (() => {}),
    selectedScope: assistant?.selectedScope ?? 'current',
    retryBrain: assistant?.retryBrain ?? (async () => {}),
    pendingInput: assistant?.pendingInput ?? null,
    cacheColdWarning: assistant?.cacheColdWarning ?? false,
    // Orchestrator-only
    managerModel: agents?.managerModel ?? '',
    setManagerModel: agents?.setManagerModel ?? (() => {}),
    managerMessages: agents?.managerMessages ?? [],
  };

  return (
    <LazyManagerStoreContext.Provider value={value}>
      {children}
    </LazyManagerStoreContext.Provider>
  );
}
