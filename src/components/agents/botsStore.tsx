/* botsStore — React context/hook for LazyBot management.

   Lightweight store that loads bots from botStorage, exposes CRUD actions,
   and tracks runtime state (active runs). Deliberately separate from the
   heavy agentsStore.tsx so bot UI components don't pull the whole agent
   machinery into their render graph.
*/

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { BotConfig } from '../../lib/bots/botTypes';
import { DEFAULT_CAPABILITIES } from '../../lib/bots/botTypes';
import {
  listBots,
  saveBot,
  deleteBot,
  setBotEnabled,
} from '../../lib/bots/botStorage';
import { getBotRuntimeState } from '../../lib/bots/botEngine';
import { getCachedProjectRoot } from '../../lib/agents/projectRootCache';
import { on } from '../../lib/bus';

export interface BotsStoreValue {
  bots: BotConfig[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createBot: (input: NewBotInput) => Promise<BotConfig>;
  updateBot: (bot: BotConfig) => Promise<void>;
  removeBot: (id: string) => Promise<void>;
  toggleEnabled: (id: string, enabled: boolean) => Promise<void>;
  getRuntimeState: (botId: string) => { activeRuns: string[]; lastError?: string };
}

export interface NewBotInput {
  name: string;
  description: string;
  systemPrompt: string;
  autonomy: BotConfig['autonomy'];
  capabilities: Partial<BotConfig['capabilities']>;
  profileIds?: string[];
  routines?: BotConfig['routines'];
  avatar?: string;
  budgetCapUsd?: number;
}

const BotsStoreContext = createContext<BotsStoreValue | null>(null);

function generateBotId(): string {
  return `bot_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBots(): BotsStoreValue {
  const ctx = useContext(BotsStoreContext);
  if (!ctx) throw new Error('useBots must be inside BotsStoreProvider');
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBotsOptional(): BotsStoreValue | null {
  return useContext(BotsStoreContext);
}

export function BotsStoreProvider({ children }: { children: ReactNode }) {
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // botStorage resolves its file via getCachedProjectRoot(), populated
      // ASYNC by resolveProjectRoot() shortly after boot — wait (bounded) so a
      // fresh mount reads the real persisted bots instead of an empty store.
      for (let i = 0; i < 30 && !getCachedProjectRoot(); i++) {
        await new Promise((r) => setTimeout(r, 300));
      }
      const list = await listBots();
      setBots(list);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return on('lazybots:changed', () => { void refresh(); });
  }, [refresh]);

  const createBot = useCallback(async (input: NewBotInput): Promise<BotConfig> => {
    const now = new Date().toISOString();
    const bot: BotConfig = {
      id: generateBotId(),
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      autonomy: input.autonomy,
      capabilities: { ...DEFAULT_CAPABILITIES, ...input.capabilities },
      routines: input.routines ?? [],
      profileIds: input.profileIds ?? [],
      ...(input.avatar ? { avatar: input.avatar } : {}),
      ...(typeof input.budgetCapUsd === 'number' ? { budgetCapUsd: input.budgetCapUsd } : {}),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await saveBot(bot);
    setBots((prev) => [...prev, bot]);
    return bot;
  }, []);

  const updateBot = useCallback(async (bot: BotConfig): Promise<void> => {
    const updated = { ...bot, updatedAt: new Date().toISOString() };
    await saveBot(updated);
    setBots((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
  }, []);

  const removeBot = useCallback(async (id: string): Promise<void> => {
    await deleteBot(id);
    setBots((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const toggleEnabled = useCallback(async (id: string, enabled: boolean): Promise<void> => {
    await setBotEnabled(id, enabled);
    setBots((prev) => prev.map((b) => (b.id === id ? { ...b, enabled } : b)));
  }, []);

  const getRuntimeState = useCallback((botId: string) => {
    const state = getBotRuntimeState(botId);
    return { activeRuns: state.activeRuns, lastError: state.lastError };
  }, []);

  const value = useMemo<BotsStoreValue>(
    () => ({
      bots,
      loading,
      error,
      refresh,
      createBot,
      updateBot,
      removeBot,
      toggleEnabled,
      getRuntimeState,
    }),
    [bots, loading, error, refresh, createBot, updateBot, removeBot, toggleEnabled, getRuntimeState],
  );

  return <BotsStoreContext.Provider value={value}>{children}</BotsStoreContext.Provider>;
}
