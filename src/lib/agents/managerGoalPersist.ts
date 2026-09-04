import type { ConversationGoal } from './managerEngine.js';

const STORAGE_KEY = 'lazy.managerGoals.v1';

function readAll(): Record<string, ConversationGoal> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, ConversationGoal>
      : {};
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, ConversationGoal>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode — in-memory Map still works this session */
  }
}

export function loadPersistedGoals(): Map<string, ConversationGoal> {
  return new Map(Object.entries(readAll()));
}

export function persistConversationGoal(conversationId: string, goal: ConversationGoal): void {
  if (!conversationId) return;
  const all = readAll();
  all[conversationId] = goal;
  writeAll(all);
}

export function clearPersistedGoal(conversationId: string): void {
  const all = readAll();
  if (!(conversationId in all)) return;
  delete all[conversationId];
  writeAll(all);
}
