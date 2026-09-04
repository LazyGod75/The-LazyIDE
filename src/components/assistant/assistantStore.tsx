/* Assistant store — conversation state with immutable updates */

import React, { createContext, useCallback, useContext, useRef, useState, useEffect } from 'react';
import type { ChatMessage, ChatMode, ModelInfo, StreamChatRequest, StreamEvent, StreamPart } from '../../lib/models';
import { DEFAULT_MODEL, getProvider, describeProviderReadiness, findModelById, findOpenRouterModel } from '../../lib/models';
import { migrateRetiredOpenRouterId } from '../../lib/models/openrouterCatalog';
import { streamTimeout, StreamTimeoutError } from '../../lib/models/streamTimeout';
import { DEFAULT_CEILING_MS as CLAUDE_CODE_ACTIVITY_CEILING_MS } from '../../lib/models/activityWatchdog';
import { withTimeout, BRAIN_RECALL_TIMEOUT_MS, BRAIN_RECALL_FALLBACK_TIMEOUT_MS } from '../../lib/models/brainSearchLoop';
import { applyStreamEvent, textEventsFromStrings } from '../../lib/models/streamEvents';
import { capMessageHistory } from '../../lib/models/messageHistory';
import { compactTranscript } from '../../lib/agents/transcriptCompact';
import { captureAssistant, captureChatLearning, stripLeakedReasoning } from '../../lib/brain/capture';
import { normalizeRecall } from '../../lib/brain/context';
import { BRAIN_SEARCH_TOOL, STRUCTURAL_BRAIN_TOOLS } from '../../lib/brain/brainTool';
import { ASSISTANT_TOOLS } from '../../lib/models/assistantTools';
import { recordRecallSaving } from '../../lib/models/costStore';
import { parseFenceInfo } from '../../lib/markdown';
import { getPlatform } from '../../lib/platform';
import type { Brain, BrainRecallResult, BrainScope } from '../../lib/platform/types';
import type { BrainInfo } from '../../lib/platform/tauri';
import { useI18n } from '../../i18n';
import { useChatPersistence, capChatMessages } from '../../lib/ai/chatPersistence';
import { useLazyRules } from '../../lib/ai/lazyRules';
import { useAppContext } from '../../app/AppContext';

// ── Types ─────────────────────────────────────────────────────────

interface AssistantState {
  messages: ChatMessage[];
  isStreaming: boolean;
  selectedMode: ChatMode;
  selectedModel: ModelInfo;
  brainRecall: BrainRecallResult | null;
  brainError: string | null;
  brainEnabled: boolean;
  selectedScope: BrainScope;
  /** Queued user input — when the user sends while a stream is active,
   *  the message is stored here and auto-sent when the stream completes. */
  pendingInput: string | null;
  /** Cache warmth warning — set when the brain recall for this turn came
   *  back with a cold/miss signal so the UI can warn the user. */
  cacheColdWarning: boolean;
}

interface AssistantStoreValue extends AssistantState {
  send: (content: string) => Promise<void>;
  clearConversation: () => void;
  setMode: (mode: ChatMode) => void;
  setModel: (model: ModelInfo) => void;
  abortStream: () => void;
  toggleBrain: () => void;
  setScope: (scope: BrainScope) => void;
  /** "Réessayer" action for the brain-unreachable banner (BrainContextBanner):
   *  clears the cached init-failure marker and re-runs the sidecar
   *  start/ensure_brain_init sequence (Rust's brain_retry_sidecar — same
   *  mechanism BrainSpace.tsx's own "Réessayer" button already uses), then
   *  clears `brainError` on a healthy result so the NEXT turn's recall gets
   *  a clean slate instead of repeating the stale error. Never throws — a
   *  failed retry attempt just leaves `brainError` as it was. */
  retryBrain: () => Promise<void>;
  compactConversation: () => { foldedTurns: number };
  chatSessions: Array<{ id: string; createdAt: number; updatedAt: number; messageCount: number }>;
  loadChatSession: (id: string) => void;
  newChatSession: () => void;
  deleteChatSession: (id: string) => void;
}

// ── Persistence helpers ───────────────────────────────────────────

const BRAIN_ENABLED_KEY = 'assistant:brainEnabled';
const BRAIN_SCOPE_KEY = 'lazy.brain.scope';

function loadBrainEnabled(): boolean {
  try {
    const stored = localStorage.getItem(BRAIN_ENABLED_KEY);
    if (stored === null) return true;
    return stored !== 'false';
  } catch {
    return true;
  }
}

function saveBrainEnabled(value: boolean): void {
  try {
    localStorage.setItem(BRAIN_ENABLED_KEY, String(value));
  } catch {
    // storage unavailable — ignore
  }
}

function loadBrainScope(): BrainScope {
  try {
    const stored = localStorage.getItem(BRAIN_SCOPE_KEY);
    if (!stored) return 'current';
    const parsed: unknown = JSON.parse(stored);
    if (parsed === 'current' || parsed === 'all') return parsed;
    if (typeof parsed === 'object' && parsed !== null && 'project' in parsed) {
      return parsed as { project: string };
    }
    return 'current';
  } catch {
    return 'current';
  }
}

function saveBrainScope(scope: BrainScope): void {
  try {
    localStorage.setItem(BRAIN_SCOPE_KEY, JSON.stringify(scope));
  } catch {
    // storage unavailable — ignore
  }
}

const SELECTED_MODEL_KEY = 'lazy.assistant.model';

/** Restore the last model the user picked for this composer, validated
 *  against the live catalogs before trusting it — a stale id (removed
 *  model, corrupted storage) must fall back to DEFAULT_MODEL rather than
 *  hand the provider an id it can't resolve. Checks BOTH namespaces (see
 *  registry.ts's module comment): native Anthropic ids (claude-code/BYOK
 *  path) and OpenRouter ids (managed/Pro path) — the composer's ModelPicker
 *  can set either (see Composer.tsx's handleModelSelect), so restricting
 *  validation to one namespace would silently drop a Pro user's persisted
 *  choice on every reload. */
function loadSelectedModel(): ModelInfo {
  try {
    const raw = localStorage.getItem(SELECTED_MODEL_KEY);
    if (!raw) return DEFAULT_MODEL;
    const id = migrateRetiredOpenRouterId(raw);
    const native = findModelById(id);
    if (native) return native;
    const openRouter = findOpenRouterModel(id);
    if (openRouter) return { id: openRouter.id, label: openRouter.label, provider: openRouter.provider };
    return DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

function saveSelectedModel(model: ModelInfo): void {
  try {
    localStorage.setItem(SELECTED_MODEL_KEY, model.id);
  } catch {
    // storage unavailable — ignore
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function nextId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Fresh id for a NEW conversation's recall-dedup session — see
 * `recallSessionIdRef` in AssistantStoreProvider for how this is kept
 * stable within a conversation and regenerated at its boundaries.
 *
 * Same string shape as chatPersistence.ts's lazily-minted ChatSession ids
 * (`chat-${now}-${rand}`), but generated eagerly here: chatPersistence's
 * `currentSessionId` stays null until the first saveMessages() call, which
 * only runs AFTER send()'s first recall completes — reusing it directly
 * would leave turn 1's shown notes untracked under any id, so dedup could
 * never kick in starting from turn 2.
 */
function generateSessionId(): string {
  return `recall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Brain discoverability (BRAIN DISCOVERABILITY) ────────────────────
//
// `info()` is intentionally NOT part of the shared `Brain` interface (see
// tauri.ts's "BRAIN-PATH TRANSPARENCY" note) — accessed here via the same
// widened-cast convention MemoryPanel.tsx already uses.
//
// Best-effort, Tauri-only fetch of whether the ACTIVE brain has zero notes
// — used to distinguish "this query found nothing" (normal) from "the
// brain itself is empty" (actionable: point the user at Settings > Memory)
// instead of both collapsing into the same silent empty recall. Cheap and
// sidecar-independent (get_brain_info is a fast, filesystem-only Rust
// computation — see BrainInfo's doc comment), so calling it whenever a
// recall comes back empty adds negligible latency. Never throws: resolves
// to `null` on the web platform, when the `info()` extension is
// unavailable, or on any platform error — callers must treat `null` as
// "unknown", not "not empty".
async function fetchBrainIsEmpty(): Promise<boolean | null> {
  const platform = getPlatform();
  if (platform.name !== 'tauri') return null;
  try {
    const info = await (platform.brain as Brain & { info(): Promise<BrainInfo> }).info();
    return info.isEmpty;
  } catch {
    return null;
  }
}

function parseContent(raw: string): Omit<ChatMessage, 'id' | 'role'> {
  // Extract the first fenced code block into its own field so MessageList
  // can render it via the dedicated CodeBlock chrome (Copy/Apply). The
  // info string (everything after the backticks on the opening line, e.g.
  // "tsx" or "tsx src/components/Foo.tsx") is parsed by parseFenceInfo —
  // see its doc comment for what counts as an explicit target.
  const codeMatch = raw.match(/```([^\n`]*)\n([\s\S]*?)```/);
  if (codeMatch) {
    const before = raw.slice(0, codeMatch.index ?? 0);
    const afterStart = (codeMatch.index ?? 0) + codeMatch[0].length;
    const after = raw.slice(afterStart);
    const { language, targetPath } = parseFenceInfo(codeMatch[1] ?? '');
    return {
      content: (before + after).trim(),
      codeBlock: {
        language,
        code: codeMatch[2].trim(),
        ...(targetPath ? { targetPath } : {}),
      },
    };
  }
  return { content: raw };
}

// ── Initial state ─────────────────────────────────────────────────

const INITIAL_STATE: AssistantState = {
  messages: [],
  isStreaming: false,
  pendingInput: null,
  cacheColdWarning: false,
  selectedMode: 'ask',
  selectedModel: loadSelectedModel(),
  brainRecall: null,
  brainError: null,
  brainEnabled: loadBrainEnabled(),
  selectedScope: loadBrainScope(),
};

// ── Context ───────────────────────────────────────────────────────

const AssistantStoreContext = createContext<AssistantStoreValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useAssistantStore(): AssistantStoreValue {
  const ctx = useContext(AssistantStoreContext);
  if (!ctx) throw new Error('useAssistantStore must be inside AssistantStoreProvider');
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAssistantStoreOptional(): AssistantStoreValue | null {
  return useContext(AssistantStoreContext);
}

// ── Provider ──────────────────────────────────────────────────────

interface Props {
  children: React.ReactNode;
  initialSessionId?: string;
}

export function AssistantStoreProvider({ children, initialSessionId }: Props) {
  const [state, setState] = useState<AssistantState>(INITIAL_STATE);
  // Ref mirror of state for reading the latest pendingInput inside the
  // stream completion handler without re-creating the send callback on
  // every state change (which would break the stream's closure).
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);
  const sendRef = useRef<(content: string) => Promise<void>>(() => Promise.resolve());
  const abortRef = useRef<AbortController | null>(null);
  const { t } = useI18n();
  const { projectRoot } = useAppContext();
  const { rules } = useLazyRules(projectRoot || null);
  const rulesRef = useRef<string | null>(null);
  const startupContextRef = useRef<string>('');
  const { projectSessions, saveMessages, flushAndSwitch, loadSession, deleteSession } = useChatPersistence(projectRoot ?? null);

  // Capture initialSessionId at mount time so the effect below can read it
  // without adding loadSession to the dependency array (would cause re-runs).
  const initialSessionIdRef = useRef(initialSessionId);

  // Stable id for the brain's per-turn recall session-dedup (Q3
  // differential-injection dedup — search.rs's brain_fetch_recall_scoped
  // `session_id` param, platform/types.ts's `recallScoped` doc comment).
  // Constant across every turn of ONE conversation so the engine can
  // accumulate "already shown" notes and skip them on later turns; reset to
  // a NEW value whenever a conversation boundary is crossed — clearConversation
  // / handleNewSession / handleLoadSession below, and the lazy-init guard
  // here at mount — so one conversation's dedup state never leaks into, or
  // gets hidden by, a different one.
  //
  // Reuses an EXISTING session id when this mount is restoring a specific
  // history entry (initialSessionId, handled by the guard below); mints a
  // fresh one otherwise. Deliberately NOT the same value as
  // useChatPersistence's own `currentSessionId`: that one stays null until
  // the first saveMessages() call below, which only runs AFTER send()'s
  // first recall — see generateSessionId()'s doc comment for why that would
  // leave turn 1 permanently untracked. A plain ref (not state) is enough:
  // send() reads `.current` fresh at call time (same pattern as rulesRef/
  // startupContextRef above/below), so mutating it never needs to force a
  // re-render or appear in a useCallback dependency array.
  const recallSessionIdRef = useRef<string | null>(null);
  if (recallSessionIdRef.current === null) {
    recallSessionIdRef.current = initialSessionId ?? generateSessionId();
  }

  // Keep rulesRef in sync so send() can read it synchronously without a stale closure.
  useEffect(() => {
    rulesRef.current = rules;
  }, [rules]);

  // Restore the persisted session — MOUNT ONLY.
  // Previously this effect depended on [projectRoot]. projectRoot resolves
  // asynchronously from '' to the real path on cold start, so the effect
  // re-fired mid-conversation and overwrote state.messages with a stale
  // localStorage snapshot — erasing the in-flight exchange and making the
  // response flicker/vanish. Restore must run once and never clobber an
  // active conversation (guarded by prev.messages.length === 0).
  useEffect(() => {
    const sessionId = initialSessionIdRef.current;
    if (sessionId) {
      // An explicit session was requested (history tab open) — load it.
      const messages = loadSession(sessionId);
      if (messages) {
        const chatMessages: ChatMessage[] = messages.map(m => ({ id: m.id, role: m.role, content: m.content }));
        setState(prev => (prev.messages.length === 0
          ? { ...prev, messages: chatMessages, isStreaming: false }
          : prev));
      }
      return;
    }
    // No initialSessionId -> restore the most recently updated persisted
    // conversation, mirroring agentsStore.tsx's identical restore-latest-
    // on-mount effect for the manager rail (see its own doc comment).
    // This branch used to deliberately do nothing: it was written for the
    // OLD per-tab AssistantPanel, where every "+" tab mounted its OWN
    // AssistantStoreProvider and auto-restoring would have duplicated
    // whatever conversation was already open in another tab. AssistantStoreProvider
    // is now a SINGLE global instance (AppShell.tsx mounts exactly one, with
    // no initialSessionId — see its own module doc comment on AppShell), so
    // there is only ever one Codeur conversation surface; resuming the last
    // one on relaunch is the honest "pick up where you left off" behaviour,
    // not a duplication risk. Uses loadSession() (not a manual reconstruction)
    // so currentSessionId is set too — the NEXT saveMessages() call appends
    // to this same restored session instead of minting an unrelated new one.
    const latest = [...projectSessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!latest) return;
    const messages = loadSession(latest.id);
    if (messages) {
      recallSessionIdRef.current = latest.id;
      const chatMessages: ChatMessage[] = messages.map(m => ({ id: m.id, role: m.role, content: m.content }));
      setState(prev => (prev.messages.length === 0
        ? { ...prev, messages: chatMessages, isStreaming: false }
        : prev));
    }
  // Mount-only on purpose; loadSession/projectSessions are stable at mount
  // because useChatPersistence initialises sessions synchronously via
  // useState.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prefetch brain highlights for the current project root. Safe to re-run when
  // the project root resolves; stored for the first user turn only.
  useEffect(() => {
    const cwd = localStorage.getItem('lazy.projectRoot') ?? projectRoot ?? '';
    if (!cwd) return;
    const timeout = new Promise<string>(resolve => setTimeout(() => resolve(''), 5000));
    Promise.race([getPlatform().brain.startupContext(cwd), timeout])
      .then(ctx => { startupContextRef.current = ctx; })
      .catch(() => { startupContextRef.current = ''; });
  }, [projectRoot]);

  // Persist messages after streaming completes
  const persistMessages = useCallback((messages: ChatMessage[]) => {
    if (messages.length === 0) return;
    saveMessages(messages.map(m => ({ id: m.id, role: m.role, content: m.content })));
  }, [saveMessages]);

  const setMode = useCallback((mode: ChatMode) => {
    setState(prev => ({ ...prev, selectedMode: mode }));
  }, []);

  const setModel = useCallback((model: ModelInfo) => {
    saveSelectedModel(model);
    setState(prev => ({ ...prev, selectedModel: model }));
  }, []);

  const clearConversation = useCallback(() => {
    abortRef.current?.abort();
    // New conversation boundary — see recallSessionIdRef's doc comment.
    recallSessionIdRef.current = generateSessionId();
    setState({ ...INITIAL_STATE });
  }, []);

  const compactConversation = useCallback((): { foldedTurns: number } => {
    const current = stateRef.current.messages;
    const next = compactTranscript(current, { force: true });
    if (next.length === current.length) return { foldedTurns: 0 };
    const foldedTurns = current.length - next.length + 1;
    setState(prev => ({ ...prev, messages: next }));
    persistMessages(next);
    return { foldedTurns };
  }, [persistMessages]);

  /** Stop button (composer click) / Escape while streaming. Aborts the
   *  in-flight controller (LLM call + any pre-step awaiting it, e.g. brain
   *  recall — see send()'s two abort branches) and flips the UI back to
   *  idle SYNCHRONOUSLY, so the user never waits on the abort to actually
   *  unwind through send()'s own async cleanup. Marks the message
   *  `interrupted` right away — send()'s later abort branch re-applies the
   *  same flag with the fully-accumulated text once it unwinds, so this
   *  is never overwritten with a "finished normally" version. */
  const abortStream = useCallback(() => {
    abortRef.current?.abort();
    setState(prev => ({
      ...prev,
      isStreaming: false,
      messages: prev.messages.map(m =>
        m.isStreaming ? { ...m, isStreaming: false, interrupted: true } : m
      ),
    }));
  }, []);

  const toggleBrain = useCallback(() => {
    setState(prev => {
      const next = !prev.brainEnabled;
      saveBrainEnabled(next);
      return { ...prev, brainEnabled: next };
    });
  }, []);

  // "Réessayer" for the brain-unreachable banner — see AssistantStoreValue's
  // doc comment. Mirrors BrainSpace.tsx's retryConnection() exactly (same
  // platform.brain.retrySidecar() call, same try/catch-never-throws
  // contract), applied to the assistant chat's own brainError state instead
  // of BrainSpace's sidecarUnavailable state.
  const retryBrain = useCallback(async () => {
    try {
      const healthy = await getPlatform().brain.retrySidecar();
      if (healthy) {
        setState(prev => ({ ...prev, brainError: null }));
      }
    } catch (err) {
      // Retry itself failed to even run (e.g. platform.brain.retrySidecar
      // unavailable on the web mock) — leave the existing brainError as-is
      // rather than throwing out of a UI button handler.
      console.warn('[assistantStore] retryBrain failed:', err);
    }
  }, []);

  const setScope = useCallback((scope: BrainScope) => {
    saveBrainScope(scope);
    setState(prev => ({ ...prev, selectedScope: scope }));
  }, []);

  const send = useCallback(async (content: string) => {
    if (!content.trim()) return;

    // Input interleaving: if a stream is active, queue the message instead
    // of blocking. It will be auto-sent when the current stream completes.
    if (state.isStreaming) {
      setState(prev => ({ ...prev, pendingInput: content.trim() }));
      return;
    }

    const userMsg: ChatMessage = {
      id: nextId(),
      role: 'user',
      content: content.trim(),
    };

    const assistantId = nextId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      isStreaming: true,
      // Snapshot the mode THIS turn was sent under — see ChatMessage.mode's
      // doc comment. Read once here, not re-derived later, so switching
      // modes mid-conversation never changes what an already-rendered
      // message is allowed to do (Apply-gating, MessageList.tsx).
      mode: state.selectedMode,
    };

    setState(prev => ({
      ...prev,
      // Bound the live rendered list too, not just what gets persisted —
      // AssistantStoreProvider is mounted ONCE for the app's whole (often
      // multi-day) lifetime (see this file's own module doc comment), so an
      // ever-growing conversation would otherwise hold an unbounded
      // ChatMessage[] in memory for as long as the app runs. Independent of
      // messageHistory.ts's MAX_SENT_MESSAGES (that one only trims what is
      // SENT to the provider, see its own doc comment) — reuses
      // chatPersistence's own cap/number instead so live and persisted
      // history stay bounded the same way, mirroring how agentsStore.tsx's
      // live managerMessages and its persisted sessions already share ONE
      // cap (missionCaps.ts's capManagerMessages).
      messages: capChatMessages([...prev.messages, userMsg, assistantMsg]),
      isStreaming: true,
      brainRecall: null,
      brainError: null,
    }));

    const abort = new AbortController();
    abortRef.current = abort;

    const readiness = describeProviderReadiness(undefined, t);
    if (!readiness.ready) {
      setState(prev => ({
        ...prev,
        isStreaming: false,
        messages: prev.messages.map(m =>
          m.id === assistantId
            ? { ...m, content: readiness.reason ?? t('editor.inlineEdit.noEngine'), isStreaming: false, error: true }
            : m
        ),
      }));
      return;
    }

    const provider = getProvider(t);
    let accumulated = '';
    // Ordered thinking/tool-call steps (assistant chat only) — see
    // StreamPart's doc comment in types.ts. Stays [] for simple/non-agentic
    // completions, so the message renders exactly like before this existed.
    let parts: StreamPart[] = [];

    try {
      let brainRecall: BrainRecallResult | null = null;
      if (state.brainEnabled) {
        // Recall must NEVER block the turn forever: bounded by
        // BRAIN_RECALL_TIMEOUT_MS (~150s for large brains), cancellable via
        // abort.signal (Stop). Surface progress so a long wait is never silent.
        setState(prev => ({
          ...prev,
          messages: prev.messages.map(m =>
            m.id === assistantId
              ? { ...m, content: t('assistant.brainRecallProgress') !== 'assistant.brainRecallProgress'
                  ? t('assistant.brainRecallProgress')
                  : 'Recherche dans le brain…', isStreaming: true }
              : m
          ),
        }));
        try {
          const primary = normalizeRecall(
            await withTimeout(
              getPlatform().brain.recallScoped(
                content.trim(),
                state.selectedScope,
                recallSessionIdRef.current ?? undefined,
              ),
              BRAIN_RECALL_TIMEOUT_MS,
              'brain recall',
              abort.signal,
            )
          );

          // WS1/WS2 scope fallback: if the SELECTED scope's recall comes
          // back empty, retry with a DIFFERENT scope before giving up — an
          // empty result is not proof the brain has nothing relevant, it
          // may only mean THIS scope has nothing to search.
          //
          // ROOT CAUSE this guards against (2026-07-03 live bug: banner
          // showed "0 neurons" for a project brain that get_brain_info
          // confirmed had 120 populated notes): brain_fetch_recall_scoped's
          // "all" branch fans out over get_brain_projects() — the
          // Settings-managed multi-project registry persisted at
          // <app_local_data_dir>/lazy/brain-projects.json — and returns a
          // flatly empty result when that list is empty, REGARDLESS of how
          // populated the CURRENT project's own brain is (confirmed empty
          // on a real machine that had never used the "add project"
          // feature). BrainScopeSelector's "All brains" choice persists in
          // localStorage (lazy.brain.scope) across app restarts AND project
          // switches with no reset and no warning, so a user who ever
          // clicked it once (even in an unrelated session) is silently
          // stuck getting zero recall on every future project until they
          // manually reopen the scope dropdown — the original 'current' ->
          // 'all' fallback below could never catch this because it only
          // fires when the scope that just failed WAS 'current'.
          //
          // Direction picked by what just failed: 'current' failing
          // broadens to 'all' (original WS1 behavior — maybe another
          // configured project has it); anything else ('all', or a specific
          // {project}) failing narrows to 'current' (WS2 — the active
          // project's own brain is the single most likely place to hold
          // something relevant, and it's already warm/fast).
          const primaryIsEmpty = !primary.injectedContext && primary.nodes.length === 0;
          const fallbackScope: 'current' | 'all' | null = !primaryIsEmpty
            ? null
            : state.selectedScope === 'current'
              ? 'all'
              : 'current';

          if (fallbackScope) {
            // Shorter budget than the primary recall — see
            // BRAIN_RECALL_FALLBACK_TIMEOUT_MS's doc comment: this is a
            // bonus lookup after an already-warm sidecar, not the
            // correctness-critical first call, so a chat turn should not
            // wait a second full BRAIN_RECALL_TIMEOUT_MS for it.
            const fallback = normalizeRecall(
              await withTimeout(
                getPlatform().brain.recallScoped(
                  content.trim(),
                  fallbackScope,
                  recallSessionIdRef.current ?? undefined,
                ),
                BRAIN_RECALL_FALLBACK_TIMEOUT_MS,
                `brain recall (${fallbackScope} scope fallback)`,
                abort.signal,
              )
            );
            brainRecall = (fallback.injectedContext || fallback.nodes.length > 0)
              ? fallback
              : primary;
          } else {
            brainRecall = primary;
          }

          // Inject the context now (the model needs it for grounding), but DEFER
          // the savings reveal — the banner number + cumulative counter must
          // appear WITH/AFTER the answer, not before it. Show neurons/injected
          // immediately; surface tokensSaved only at finalize (below).
          //
          // BRAIN DISCOVERABILITY: when this recall came back genuinely empty
          // (no nodes, no injected text — already tried the 'all'-scope
          // fallback above), check whether the ACTIVE brain itself has zero
          // notes so the banner can show an actionable "configure your
          // brain" message instead of the ambiguous "no relevant neurons
          // found for this scope". fetchBrainIsEmpty is only awaited on the
          // empty-recall path — never on a successful recall — so this adds
          // no latency to the common case.
          if (!abort.signal.aborted) {
            const recallIsEmpty = !!brainRecall && !brainRecall.injectedContext && brainRecall.nodes.length === 0;
            const emptyBrain = recallIsEmpty ? await fetchBrainIsEmpty() : false;
            // Cache awareness: flag a cold cache when recall came back empty
            // but the brain itself has notes (cache miss, not empty brain).
            const cacheCold = recallIsEmpty && emptyBrain === false;
            // Reassign the outer `brainRecall` itself (immutably — a new
            // object, never mutated in place) so `emptyBrain` survives into
            // the LATER setState below (after streaming completes, which
            // reveals tokensSaved by reusing this same variable) — setting
            // it only on the object passed to THIS setState would have been
            // overwritten by that later update.
            if (brainRecall && emptyBrain === true) {
              brainRecall = { ...brainRecall, emptyBrain: true };
            }
            setState(prev => ({
              ...prev,
              cacheColdWarning: cacheCold,
              brainRecall: brainRecall ? { ...brainRecall, tokensSaved: 0 } : null,
            }));
          }
        } catch (err) {
          // Timeout or platform error — degrade gracefully: no brain context,
          // just a short banner note. Do NOT rethrow; the turn continues below.
          brainRecall = null;
          const msg = err instanceof Error ? err.message : t('assistant.brainUnavailable');
          if (!abort.signal.aborted) {
            setState(prev => ({ ...prev, brainError: `${t('assistant.brainUnavailable')}: ${msg}` }));
          }
        }
      }

      // Stop clicked while brain recall was still in flight (the exact
      // "spun forever on a brain search" complaint this feature fixes) —
      // bail before ever starting the LLM call instead of silently waiting
      // for the recall's own timeout to elapse first. Mirrors the
      // post-stream-loop abort branch below (same interrupted finalize).
      if (abort.signal.aborted) {
        setState(prev => ({
          ...prev,
          isStreaming: false,
          messages: prev.messages.map(m =>
            m.id === assistantId ? { ...m, isStreaming: false, interrupted: true } : m
          ),
        }));
        return;
      }

      // Consume startup context on the first user turn only.
      // state.messages.length === 0 means this is the first turn in the session.
      const startupCtx = state.messages.length === 0 ? startupContextRef.current : '';
      startupContextRef.current = '';

      // Semantic skill injection — load skills relevant to the user's message.
      // Non-blocking: a brain failure never prevents the turn from proceeding.
      //
      // Reuses `brainRecall.nodes` from the memory recall above (same trimmed
      // `content` query) instead of letting injectSkills issue its OWN
      // recallScoped call — a REAL regression this fixes: without passing
      // preloadedNodes, every brain-enabled turn fired 2-3 recallScoped
      // round-trips (1-2 memory + 1 skill) instead of the intended 1-2,
      // doubling sidecar latency/token cost for no benefit (skill injection
      // searches the identical query text the memory block already recalled
      // for). See skillInjection.ts's loadRelevantSkills doc comment.
      let skillContext = '';
      if (state.brainEnabled) {
        try {
          const { injectSkills } = await import('../../lib/agents/skillInjection');
          const skillResult = await injectSkills(content, undefined, brainRecall?.nodes ?? []);
          if (skillResult.text) skillContext = skillResult.text;
        } catch {
          // Skill injection unavailable — continue without it
        }
      }

      const req: StreamChatRequest = {
        // Capped to bound what is actually SENT to the provider — the UI
        // (state.messages, persistence) keeps the FULL, untrimmed history;
        // see messageHistory.ts's doc comment.
        messages: capMessageHistory(compactTranscript([...state.messages, userMsg])),
        model: state.selectedModel,
        mode: state.selectedMode,
        brainRecall,
        rulesContext: rulesRef.current,
        signal: abort.signal,
        startupContext: startupCtx || undefined,
        skillContext: skillContext || undefined,
        // The real, live AppContext project root — see StreamChatRequest.
        // projectRoot's doc comment for the trust bug this replaces
        // (assistantToolLoop.ts's tool directives used to always run
        // against '.' because localStorage's 'lazy.projectRoot' was never
        // written by any code path).
        projectRoot: projectRoot || undefined,
        // Offer on-demand memory recall when the brain is enabled so the model
        // can retrieve project knowledge mid-response: semantic (brain_search)
        // plus the two STRUCTURAL tools (brain_query_css / brain_neighbours).
        // The structural tools are now genuinely runnable on this surface — the
        // BRAIN_QUERY_CSS: / BRAIN_NEIGHBOURS: directives are wired into the
        // shared ReAct loop (brainSearchLoop.ts) — so advertising them here is
        // real, not just prose teaching.
        // Additionally, general tools (web_search, web_fetch, read_file, etc.)
        // are advertised and routed through the shared toolRuntime via
        // assistantToolLoop.ts's extended ReAct loop.
        tools: state.brainEnabled
          ? [BRAIN_SEARCH_TOOL, ...STRUCTURAL_BRAIN_TOOLS, ...ASSISTANT_TOOLS]
          : ASSISTANT_TOOLS,
        // Forwarded to brainSearchLoop.ts's recallForDirective for every
        // in-turn BRAIN_SEARCH round — see recallSessionIdRef's doc comment.
        sessionId: recallSessionIdRef.current ?? undefined,
        // Translates the ReAct loop's in-chat status lines (brain/tool
        // directive labels) — see StreamChatRequest.t's doc comment.
        t,
      };

      // Structured path (thinking/tool/text kept distinct) when the active
      // provider supports it (claude-code/anthropic/cli-backend/managed —
      // see ModelProvider.streamChatEvents' doc comment); otherwise adapt
      // the plain string stream into a single running 'text' part so this
      // loop always consumes one uniform AsyncIterable<StreamEvent> shape.
      // mockProvider/webAnthropicProvider/noModelProvider take this second
      // path, and — since it only ever produces 'text' events — `parts`
      // naturally stays [] for them, rendering exactly like today.
      const eventSource: AsyncIterable<StreamEvent> = provider.streamChatEvents
        ? provider.streamChatEvents(req)
        : textEventsFromStrings(provider.streamChat(req));

      // claude-code (subscription CLI): buildRunTurn (claudeCodeProvider.ts)
      // now owns its own activity-based watchdog tuned for a CLI subprocess
      // (tool calls can legitimately stay quiet on stdout for tens of
      // seconds — see activityWatchdog.ts) and unblocks the stream itself
      // on genuine silence/ceiling. This generic wrap's 15s/30s budget is
      // tuned for HTTP-backed providers and must not preempt that CLI-aware
      // watchdog with a false "no response" — relaxed to the same ceiling
      // here so it becomes a pure backstop rather than the real enforcer.
      const isSubscriptionCli = provider.id === 'claude-code';
      const stream = streamTimeout(eventSource, {
        signal: abort.signal,
        ...(isSubscriptionCli
          ? { firstTokenMs: CLAUDE_CODE_ACTIVITY_CEILING_MS, idleMs: CLAUDE_CODE_ACTIVITY_CEILING_MS }
          : {}),
      });

      // Throttled flush: rebuilding the ENTIRE messages array (React state)
      // on every single streamed chunk is the dominant source of render
      // churn on a long conversation. `accumulated`/`parts` above are plain
      // local variables that already accumulate every chunk immediately —
      // only how often that gets pushed into React state is throttled here.
      // lastFlushAt starts at 0 so the very first chunk always flushes
      // right away (no artificial startup delay); the unconditional final
      // setState after this loop (success path below) and the catch block
      // both already push the fully-accumulated content regardless of this
      // throttle, so stream end/error is always flushed for real.
      const FLUSH_INTERVAL_MS = 80;
      let lastFlushAt = 0;

      for await (const event of stream) {
        if (abort.signal.aborted) break;
        if (event.type === 'text') {
          accumulated += event.text;
        } else {
          parts = applyStreamEvent(parts, event);
        }
        const now = Date.now();
        if (now - lastFlushAt >= FLUSH_INTERVAL_MS) {
          lastFlushAt = now;
          setState(prev => ({
            ...prev,
            messages: prev.messages.map(m =>
              m.id === assistantId ? { ...m, content: accumulated, parts } : m
            ),
          }));
        }
      }

      // Turn was aborted (Stop button / Escape) mid-stream — finalize with
      // whatever text accumulated before the signal fired instead of
      // running the normal success finalize below (citations/capture/
      // learning): the turn never really completed, so there is nothing to
      // attribute those to. abortStream() already flips isStreaming/
      // interrupted immediately for instant feedback; this is the
      // source-of-truth finalize once the aborted stream actually unwinds,
      // using the FULL accumulated text (which may include a few more
      // characters than abortStream()'s last-flushed snapshot).
      if (abort.signal.aborted) {
        const cleanedOnAbort = stripLeakedReasoning(accumulated);
        const parsedOnAbort = parseContent(cleanedOnAbort);
        setState(prev => {
          const updated = {
            ...prev,
            isStreaming: false,
            messages: prev.messages.map(m =>
              m.id === assistantId
                ? { ...m, ...parsedOnAbort, parts, isStreaming: false, interrupted: true }
                : m
            ),
          };
          persistMessages(updated.messages);
          return updated;
        });
        return;
      }

      // Defense-in-depth against a reasoning-channel leak that splits across
      // stream chunks (see stripLeakedReasoning's doc comment in
      // capture.ts): per-chunk detection upstream can miss a marker
      // straddling two chunks, so the COMMITTED final message is re-checked
      // here — deliberately NOT per-chunk (the visible during-stream text
      // may still briefly show the fragment; only the finalized content
      // must be guaranteed clean).
      const cleanedAccumulated = stripLeakedReasoning(accumulated);
      const parsed = parseContent(cleanedAccumulated);
      const citations = brainRecall?.nodes.slice(0, 5).map(node => ({ ref: `#${node.id}`, label: node.title }));
      setState(prev => {
        const updated = {
          ...prev,
          isStreaming: false,
          // Reveal the brain savings now — together with the finished answer.
          brainRecall: brainRecall ?? prev.brainRecall,
          messages: prev.messages.map(m =>
            m.id === assistantId
              ? { ...m, ...parsed, citations, parts, isStreaming: false }
              : m
          ),
        };
        persistMessages(updated.messages);
        return updated;
      });
      // Single choke point (costStore.recordRecallSaving) — every brain
      // recall path funnels its measured saving here so CockpitKpiBar's
      // aggregate reflects every real recall, not just this Codeur panel.
      recordRecallSaving(brainRecall, 'codeur');
      // Fire-and-forget capture — never blocks or throws into the UI
      captureAssistant(content, accumulated, state.selectedMode);
      // Chat learning loop — generate insights and feed brain
      captureChatLearning(content, accumulated);

      // Input interleaving: drain the pending queue — if the user sent a
      // message while this stream was active, auto-send it now.
      const pending = stateRef.current.pendingInput;
      if (pending) {
        setState(prev => ({ ...prev, pendingInput: null }));
        // Microtask delay so the UI updates (isStreaming: false) before the
        // next turn starts (which sets it back to true).
        queueMicrotask(() => { void sendRef.current(pending); });
      }
    } catch (err) {
      const isTimeout = err instanceof StreamTimeoutError;
      const fallbackMsg = isTimeout
        ? t('assistant.timeoutError')
        : t('assistant.generationError');
      // Same defense-in-depth as the success path above: a stream that
      // errors mid-response still commits whatever text was accumulated so
      // far, which may itself end mid-leak.
      const cleanedAccumulated = stripLeakedReasoning(accumulated);
      setState(prev => ({
        ...prev,
        isStreaming: false,
        messages: prev.messages.map(m =>
          m.id === assistantId
            ? { ...m, content: cleanedAccumulated || fallbackMsg, isStreaming: false, error: !cleanedAccumulated }
            : m
        ),
      }));
    }
  }, [state.messages, state.selectedModel, state.selectedMode, state.brainEnabled, state.selectedScope, t, persistMessages, projectRoot]);

  useEffect(() => { sendRef.current = send; }, [send]);

  const handleLoadSession = useCallback((id: string) => {
    const target = projectSessions.find(s => s.id === id);
    if (!target) return;
    // Atomic flushAndSwitch (not a separate saveMessages + a separate
    // "load id" call) — same race newManagerConversation/loadManagerSession
    // fix in agentsStore.tsx (see managerPersistence.ts's flushAndSwitch doc
    // comment): flushes the OUTGOING conversation into its own session
    // before pointing currentSessionId at the INCOMING one, so switching
    // history entries mid-conversation never silently drops what hasn't
    // been saved yet.
    flushAndSwitch(
      stateRef.current.messages.map(m => ({ id: m.id, role: m.role, content: m.content })),
      id,
    );
    // Different conversation boundary — reuse ITS OWN persisted id as the
    // recall-dedup session (see recallSessionIdRef's doc comment) so
    // reopening the same history entry later still dedups correctly,
    // instead of minting an unrelated fresh id every time it's loaded.
    recallSessionIdRef.current = id;
    const chatMessages: ChatMessage[] = target.messages.map(m => ({ id: m.id, role: m.role, content: m.content }));
    setState(prev => ({ ...prev, messages: chatMessages, isStreaming: false }));
  }, [projectSessions, flushAndSwitch]);

  const handleNewSession = useCallback(() => {
    // Flush the OUTGOING conversation before switching — mirrors
    // agentsStore.tsx's newManagerConversation (same atomic flushAndSwitch,
    // same race it fixes — see managerPersistence.ts's doc comment). Without
    // this, clearConversation's synchronous local-state reset (called right
    // alongside this by lazyManagerStore.newSession/AssistantHeader's "+"
    // button) races ahead of send()'s own async abort-finalize persistMessages
    // call: by the time that later call runs, state.messages is already []
    // (cleared), so the outgoing conversation was silently lost instead of
    // saved. stateRef always holds the latest COMMITTED state (see its own
    // doc comment above), read here before any of this tick's pending state
    // updates land.
    flushAndSwitch(
      stateRef.current.messages.map(m => ({ id: m.id, role: m.role, content: m.content })),
      null,
    );
    // New conversation boundary — see recallSessionIdRef's doc comment.
    recallSessionIdRef.current = generateSessionId();
    setState(prev => ({ ...prev, messages: [], isStreaming: false }));
  }, [flushAndSwitch]);

  const handleDeleteSession = useCallback((id: string) => {
    deleteSession(id);
  }, [deleteSession]);

  const chatSessions = projectSessions.map(s => ({
    id: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
  }));

  const value: AssistantStoreValue = {
    ...state,
    send,
    clearConversation,
    setMode,
    setModel,
    abortStream,
    toggleBrain,
    setScope,
    retryBrain,
    compactConversation,
    chatSessions,
    loadChatSession: handleLoadSession,
    newChatSession: handleNewSession,
    deleteChatSession: handleDeleteSession,
  };

  return (
    <AssistantStoreContext.Provider value={value}>
      {children}
    </AssistantStoreContext.Provider>
  );
}
