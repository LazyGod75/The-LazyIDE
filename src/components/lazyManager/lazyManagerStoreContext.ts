/* lazyManagerStoreContext — Context object + hooks for the unified
   LazyManager store, kept OUT of lazyManagerStore.tsx.

   Same root cause as ToastContext.ts: mixing `createContext()` and
   `useLazyManagerStore` in the same module as the Provider component
   breaks React Fast Refresh. After HMR of agentsStore / ManagerHost /
   LazyManager, the provider can re-render under a NEW context object
   while LazyManager still calls useContext on the OLD one — the hook
   then throws and RootErrorBoundary takes down the whole shell
   ("useLazyManagerStore must be inside LazyManagerStoreProvider").

   This file is hooks-only. Editing the Provider's render path no longer
   recreates the context identity. */
import { createContext, useContext } from 'react';
import type { ActionStatus, ManagerMessage, ManagerAction } from '../../lib/agents/types';
import type { ChatMode, ModelInfo } from '../../lib/models';
import type { BrainRecallResult, BrainScope } from '../../lib/platform/types';

export type ManagerMode = 'orchestrator' | 'coder';

export interface UnifiedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  mode: ManagerMode;
  isStreaming?: boolean;
  error?: boolean;
  interrupted?: boolean;
  codeBlock?: { language: string; code: string; targetPath?: string };
  citations?: Array<{ ref: string; label?: string }>;
  parts?: unknown[];
  chatMode?: ChatMode;
  actions?: ManagerAction[];
  actionStatuses?: ActionStatus[];
  approxCreditsUsed?: number;
  creditsBlocked?: boolean;
  sessionBlocked?: boolean;
  timedOut?: boolean;
  retryText?: string;
  timestamp?: string;
}

export interface UnifiedSession {
  id: string;
  source: ManagerMode;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
}

export interface LazyManagerStoreValue {
  mode: ManagerMode;
  setMode: (mode: ManagerMode) => void;
  messages: UnifiedMessage[];
  busy: boolean;
  phase: 'idle' | 'turn' | 'grounding' | 'streaming' | 'queued';
  send: (text: string) => Promise<void>;
  stop: () => void;
  sessions: UnifiedSession[];
  newSession: () => void;
  loadSession: (id: string, source: ManagerMode) => void;
  deleteSession: (id: string, source: ManagerMode) => void;
  modelId: string;
  setModelId: (id: string) => void;
  chatMode: ChatMode;
  setChatMode: (m: ChatMode) => void;
  selectedModel: ModelInfo;
  setModel: (m: ModelInfo) => void;
  brainEnabled: boolean;
  brainRecall: BrainRecallResult | null;
  brainError: string | null;
  toggleBrain: () => void;
  setScope: (s: BrainScope) => void;
  selectedScope: BrainScope;
  retryBrain: () => Promise<void>;
  pendingInput: string | null;
  cacheColdWarning: boolean;
  managerModel: string;
  setManagerModel: (m: string) => void;
  managerMessages: ManagerMessage[];
}

export const LazyManagerStoreContext = createContext<LazyManagerStoreValue | null>(null);

export function useLazyManagerStore(): LazyManagerStoreValue {
  const ctx = useContext(LazyManagerStoreContext);
  if (!ctx) throw new Error('useLazyManagerStore must be inside LazyManagerStoreProvider');
  return ctx;
}

/** Same as useLazyManagerStore, but returns null outside the provider so
 *  chrome that can mount a beat before ManagerHost (or survive HMR with a
 *  split context identity) degrades instead of taking down the shell. */
export function useLazyManagerStoreOptional(): LazyManagerStoreValue | null {
  return useContext(LazyManagerStoreContext);
}
