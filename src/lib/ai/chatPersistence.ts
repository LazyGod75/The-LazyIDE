/* chatPersistence — localStorage-backed history for the Code assistant
   (Codeur mode). Modeled on lib/agents/managerPersistence.ts (the manager
   rail's equivalent) — same mint-on-first-save / loadSession / newSession /
   deleteSession / flushAndSwitch contract.

   Historically this was gated on a truthy `projectRoot`: saveMessages()
   early-returned and the session list came back empty whenever no project
   was open. AssistantStoreProvider is now mounted ONCE for the whole app
   (AppShell.tsx, no per-project remount — same shape as AgentsStoreProvider/
   managerPersistence.ts), and `projectRoot` starts as '' and stays '' until
   the user explicitly opens a project (AppContext.tsx), which the cockpit
   never requires. Gating persistence on it made the Codeur side's history
   a permanent no-op for any session that never opens a project — history
   now saves and lists globally, exactly like the manager side; `projectRoot`
   is kept on each session as metadata only (still backward-compatible with
   older stored sessions, which always had a truthy value here).

   Bounded like every other unbounded-growth surface in this codebase (see
   missionCaps.ts's own doc comment, and managerPersistence.ts which this
   module is modeled on): MAX_CHAT_SESSIONS caps how many past conversations
   localStorage keeps, and each session's own messages are run through
   capChatMessages before being written to disk. AssistantStoreProvider is a
   mount-once global provider (this module's header above) with NO
   session-count cap and NO per-session message cap until this fix — a
   conversation left open for the app's whole (potentially multi-day)
   lifetime, or a fleet of past conversations never pruned, both grew
   without bound. capChatMessages is exported so assistantStore.tsx can
   apply the SAME cap to the live rendered `state.messages` array too (not
   just what gets persisted) — mirrors managerPersistence.ts/missionCaps.ts's
   capManagerMessages, which agentsStore.tsx already applies to BOTH its own
   live in-memory managerMessages and the persisted session in one shared
   function.
*/

import { useCallback, useState } from 'react';

/** Keep-last cap for how many past chat conversations localStorage
 *  retains — mirrors managerPersistence.ts's MAX_MANAGER_SESSIONS (same
 *  number, same "keep-last N" convention). */
export const MAX_CHAT_SESSIONS = 30;

/** Keep-last cap for a single conversation's message count — mirrors
 *  missionCaps.ts's MAX_MANAGER_MESSAGES (same number). Applied both to
 *  what gets persisted (saveMessages/flushAndSwitch below) and, via
 *  assistantStore.tsx importing capChatMessages directly, to the live
 *  rendered `state.messages` array. */
export const MAX_CHAT_MESSAGES = 300;

export interface ChatSession {
  id: string;
  /** Project root active when this session was created, or '' when no
   *  project was open. Metadata only — sessions are neither filtered nor
   *  scoped by this field; see this module's doc comment above. */
  projectRoot: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }>;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'lazy.chatSessions';

function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ChatSession[];
  } catch {
    return [];
  }
}

function saveSessions(sessions: ChatSession[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch { /* quota */ }
}

/** Keep-last N entries — a no-op (shallow copy) when already within budget.
 *  Generic (not tied to ChatSession's own message shape) so the SAME
 *  function bounds both this module's persisted messages (plain
 *  `{id, role, content, timestamp}`) and assistantStore.tsx's live
 *  `ChatMessage[]` (which carries extra fields — isStreaming, parts,
 *  citations, mode…) — mirrors missionCaps.ts's capActionTimeline/
 *  capManagerMessages shape (pure, always returns a new array). */
export function capChatMessages<T>(messages: readonly T[], max: number = MAX_CHAT_MESSAGES): T[] {
  return messages.length <= max ? [...messages] : messages.slice(-max);
}

/** Keep-last N sessions by recency (`updatedAt`) — a no-op when already
 *  within budget. Mirrors managerPersistence.ts's capManagerSessions. */
export function capChatSessions(
  sessions: readonly ChatSession[],
  max: number = MAX_CHAT_SESSIONS,
): ChatSession[] {
  if (sessions.length <= max) return [...sessions];
  return [...sessions].sort((a, b) => a.updatedAt - b.updatedAt).slice(-max);
}

export function useChatPersistence(projectRoot: string | null) {
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions());
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  // Global list — ALL persisted sessions regardless of projectRoot, same
  // "the whole fleet at once" scope as managerPersistence.ts's `sessions`
  // (see that module's doc comment). No live consumer needs project-scoped
  // filtering today (AssistantPanel.tsx, the one place that used to read
  // this with per-tab project scoping, is dead code — see lazyManagerStore.tsx/
  // LazyManager.tsx, which replaced it); if one ever does, add a dedicated
  // selector rather than re-narrowing this one.
  const projectSessions = sessions;

  const currentSession = currentSessionId
    ? sessions.find(s => s.id === currentSessionId) ?? null
    : null;

  const saveMessages = useCallback((messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>) => {
    if (messages.length === 0) return;
    const now = Date.now();
    const cappedMessages = capChatMessages(messages).map(m => ({ ...m, timestamp: now }));
    setSessions(prev => {
      let sessionId = currentSessionId;
      let updated = prev;
      if (!sessionId) {
        sessionId = `chat-${now}-${Math.random().toString(36).slice(2, 8)}`;
        const newSession: ChatSession = {
          id: sessionId,
          projectRoot: projectRoot ?? '',
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        updated = [...prev, newSession];
        setCurrentSessionId(sessionId);
      }
      updated = updated.map(s => s.id === sessionId
        ? { ...s, messages: cappedMessages, updatedAt: now }
        : s
      );
      updated = capChatSessions(updated);
      saveSessions(updated);
      return updated;
    });
  }, [projectRoot, currentSessionId]);

  /**
   * Atomically flushes `messages` (the conversation being LEFT) into its own
   * session — minting one if it doesn't have one yet, same rule as
   * saveMessages — and then points currentSessionId at `nextSessionId`
   * (`null` for "start a fresh conversation", or a specific past session id
   * for "switch to it"). Mirrors managerPersistence.ts's flushAndSwitch
   * exactly, including the race it documents and fixes: a plain saveMessages
   * followed by a separate newSession/loadSession call is TWO independent
   * setCurrentSessionId updates in the same synchronous caller tick, which
   * React does not guarantee apply in the intended order — losing that race
   * silently merges the NEXT conversation's messages into the PREVIOUS
   * one's session. Folding both into one setCurrentSessionId call removes
   * the race. Used by assistantStore.tsx's handleNewSession/handleLoadSession
   * so switching or starting a new conversation never drops the outgoing one.
   */
  const flushAndSwitch = useCallback((
    messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>,
    nextSessionId: string | null,
  ) => {
    if (messages.length > 0) {
      const now = Date.now();
      const cappedMessages = capChatMessages(messages).map(m => ({ ...m, timestamp: now }));
      setSessions(prev => {
        let sessionId = currentSessionId;
        let updated = prev;
        if (!sessionId) {
          sessionId = `chat-${now}-${Math.random().toString(36).slice(2, 8)}`;
          updated = [...prev, { id: sessionId, projectRoot: projectRoot ?? '', messages: [], createdAt: now, updatedAt: now }];
        }
        updated = updated.map(s => s.id === sessionId
          ? { ...s, messages: cappedMessages, updatedAt: now }
          : s
        );
        updated = capChatSessions(updated);
        saveSessions(updated);
        return updated;
      });
    }
    setCurrentSessionId(nextSessionId);
  }, [projectRoot, currentSessionId]);

  const loadSession = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      setCurrentSessionId(sessionId);
      return session.messages;
    }
    return null;
  }, [sessions]);

  const newSession = useCallback(() => {
    setCurrentSessionId(null);
  }, []);

  const deleteSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const updated = prev.filter(s => s.id !== sessionId);
      saveSessions(updated);
      return updated;
    });
    if (currentSessionId === sessionId) {
      setCurrentSessionId(null);
    }
  }, [currentSessionId]);

  return {
    projectSessions,
    currentSession,
    currentSessionId,
    saveMessages,
    flushAndSwitch,
    loadSession,
    newSession,
    deleteSession,
  };
}
