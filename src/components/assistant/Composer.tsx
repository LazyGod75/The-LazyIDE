/* Composer — input + mode selector + model selector + send */

import { useCallback, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Platform } from '../../lib/platform';
import { ALL_MODELS } from '../../lib/models';
import { getProviderMode } from '../../lib/models/index';
import { loadAccessSettings, saveAccessSettings } from '../../lib/models/accessSettings';
import {
  DEFAULT_OPENROUTER_MODEL_ID,
  findOpenRouterModel,
} from '../../lib/models/openrouterCatalog';
import { getModelPickerOptions, noModelFallbackMessage, modelManagedByCodexMessage } from '../../lib/models/modelPickerOptions';
import { getEngineReadiness, engineReasonKey } from '../../lib/models/entitlement';
import type { EngineReadiness } from '../../lib/models/entitlement';
import { useAssistantStoreOptional } from './assistantStore';
import { useI18n } from '../../i18n';
import { StopIcon } from '../agents/canvas/chrome/HoverActionStrip';
import { BrainScopeSelector } from './BrainScopeSelector';
import { ContextPicker, type ContextItem } from './ContextPicker';
import { SlashCommandPicker } from './SlashCommandPicker';
import { parseSlashCommand, suggestSlashCommands, type SlashCommandDef } from '../../lib/ai/slashCommands';
import { executeSlashCommand, type SlashCommandDeps } from '../../lib/ai/slashCommandExecutor';
import { on, emit } from '../../lib/bus';
import type { SelectionToChatRequest } from '../../lib/bus';
import { useAppContext } from '../../app/AppContext';
import { getLastTerminalCommand, getTerminalOutput } from '../../lib/terminal/history';
import type { AssistantQuickAction } from './assistantIdentity';
import { useToast } from '../ui';
import { MODES, ModeIcon, ModePopover, ModelDropdown } from './ComposerMenus';

// ── Composer ──────────────────────────────────────────────────────

interface ComposerProps {
  onLaunchAgent: () => void;
  /** Host-space-provided quick actions (D8), rendered alongside the
   *  composer's own chip row. Omit for the default composer. */
  quickActions?: AssistantQuickAction[];
}

/** Derive the current model id/label to display in managed/pro mode.
 *  Reads the persisted accessSettings.model (an OpenRouter id), falls back
 *  to the catalog default. Returns { id, label }. */
function getManagedModelDisplay(): { id: string; label: string } {
  const settings = loadAccessSettings();
  const id = settings.model ?? DEFAULT_OPENROUTER_MODEL_ID;
  const entry = findOpenRouterModel(id);
  return { id, label: entry?.label ?? id };
}

const MAX_CONTEXT_CHARS = 6000;
const WEB_REF_PATTERN = /@web:https?:\/\/[^\s<>'"]+/g;

function limitContext(content: string): string {
  return content.length > MAX_CONTEXT_CHARS ? `${content.slice(0, MAX_CONTEXT_CHARS)}\n…` : content;
}

function formatContextBlock(ref: string, label: string, content: string): string {
  return `${ref} (${label})\n\`\`\`\n${limitContext(content)}\n\`\`\``;
}

function deriveQuickActionTitle(task: string): string {
  const trimmed = task.trim();
  return trimmed.length <= 60 ? trimmed : `${trimmed.slice(0, 57)}...`;
}

function contextError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function contextItemsFromText(content: string, selectedItems: ContextItem[]): ContextItem[] {
  const selectedRefs = new Set(selectedItems.map(item => item.ref));
  const inferred: ContextItem[] = [];
  const add = (item: ContextItem) => {
    if (!selectedRefs.has(item.ref) && !inferred.some(existing => existing.ref === item.ref)) inferred.push(item);
  };

  for (const item of [
    { kind: 'git' as const, label: 'Git Diff', ref: '@git:diff' },
    { kind: 'git' as const, label: 'Recent Commits', ref: '@git:log' },
    { kind: 'git' as const, label: 'Current Branch', ref: '@git:branch' },
    { kind: 'terminal' as const, label: 'Terminal Output', ref: '@terminal:output' },
    { kind: 'terminal' as const, label: 'Last Command', ref: '@terminal:last' },
  ]) {
    if (content.includes(item.ref)) add(item);
  }

  for (const ref of content.match(WEB_REF_PATTERN) ?? []) {
    add({ kind: 'web', label: ref.replace('@web:', ''), ref });
  }

  return [...selectedItems, ...inferred];
}

async function resolveContextItem(item: ContextItem, platform: Platform, projectRoot: string): Promise<string> {
  try {
    if (item.kind === 'file') {
      const path = item.ref.replace('@file:', '');
      const content = item.content ?? await platform.fs.readFile(path);
      return formatContextBlock(item.ref, item.label, content || 'File is empty.');
    }

    if (item.kind === 'git') {
      const repoPath = projectRoot || (platform.name === 'web' ? '/project' : '');
      if (!repoPath) return formatContextBlock(item.ref, item.label, 'No project is open.');
      if (item.ref === '@git:diff') {
        const diff = await platform.git.diff(repoPath);
        return formatContextBlock(item.ref, item.label, diff || 'No working tree diff.');
      }
      if (item.ref === '@git:log') {
        const entries = await platform.git.log(repoPath, 10);
        const content = entries.map(entry => `${entry.hash.slice(0, 8)} ${entry.subject} — ${entry.author} ${entry.date}`).join('\n');
        return formatContextBlock(item.ref, item.label, content || 'No recent commits.');
      }
      if (item.ref === '@git:branch') {
        const status = await platform.git.status(repoPath);
        return formatContextBlock(item.ref, item.label, status.branch || 'No branch detected.');
      }
    }

    if (item.kind === 'terminal') {
      const content = item.ref === '@terminal:last'
        ? getLastTerminalCommand() || 'No terminal command captured yet.'
        : getTerminalOutput(50) || 'No terminal output captured yet.';
      return formatContextBlock(item.ref, item.label, content);
    }

    if (item.kind === 'web') {
      const url = item.ref.replace('@web:', '');
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = await response.text();
      return formatContextBlock(item.ref, item.label, `HTTP ${response.status} ${response.statusText}\n\n${body}`);
    }
  } catch (err) {
    return formatContextBlock(item.ref, item.label, `Context unavailable: ${contextError(err)}`);
  }

  return item.ref;
}

export function Composer(props: ComposerProps) {
  const store = useAssistantStoreOptional();
  if (!store) return null;
  return <ComposerReady store={store} {...props} />;
}

function ComposerReady({
  store,
  onLaunchAgent,
  quickActions,
}: ComposerProps & { store: NonNullable<ReturnType<typeof useAssistantStoreOptional>> }) {
  const { send, isStreaming, abortStream, pendingInput, selectedMode, selectedModel, setMode, setModel, brainEnabled, toggleBrain, selectedScope, setScope, clearConversation, compactConversation, chatSessions, loadChatSession } = store;
  const { t } = useI18n();
  const { toast } = useToast();
  const { platform, projectRoot } = useAppContext();
  const [text, setText] = useState('');
  const [showModes, setShowModes] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextQuery, setContextQuery] = useState('');
  const [contextItems, setContextItems] = useState<ContextItem[]>([]);
  const [showSlashPicker, setShowSlashPicker] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  /** Engine preflight verdict from the last blocked send (v0.1.5 W2.3).
      Single state slot -> a single inline notice, never stacked, never a
      toast. Cleared on the next send attempt that passes the check. */
  const [preflightBlock, setPreflightBlock] = useState<EngineReadiness | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Determine provider mode once per render (synchronous, no side effects) —
  // still needed below for "what's the currently ACTIVE model"
  // (getManagedModelDisplay), a different question from "what CAN be
  // picked" just below, which now comes from the same entitlement helper
  // NewMissionModal/LazyManager use (modelPickerOptions.ts): a user with
  // both a Claude subscription (CLI/BYOK) and a Lazy Pro subscription sees
  // both catalogs, independent of which one accessMode currently privileges
  // for routing (see that module's header for the full rationale).
  const providerMode = getProviderMode();
  const isManagedMode = providerMode === 'managed' || providerMode === 'pro';

  const pickerOptions = getModelPickerOptions(t);
  const showNative = pickerOptions.claudeSub;
  const showOpenRouter = pickerOptions.pro === 'active';

  // In managed/pro mode the displayed model comes from accessSettings, not the store
  const managedDisplay = isManagedMode ? getManagedModelDisplay() : null;
  const displayModelLabel = managedDisplay ? managedDisplay.label : selectedModel.label;
  const displayModelId = managedDisplay ? managedDisplay.id : selectedModel.id;

  // Listen for editor:selectionToChat events (Ctrl+L from editor)
  useEffect(() => {
    return on('editor:selectionToChat', (req: SelectionToChatRequest) => {
      const ctxRef = `@file:${req.filename}`;
      const codeBlock = `\`\`\`${req.language}\n${req.code}\n\`\`\``;
      setText(prev => {
        const prefix = prev.trim() ? prev + '\n\n' : '';
        return `${prefix}${ctxRef}\n${codeBlock}\n\n`;
      });
      textareaRef.current?.focus();
    });
  }, []);

  // Detect @-mention typing in textarea
  const handleTextChange = useCallback((newText: string) => {
    const cursorPos = textareaRef.current?.selectionStart ?? newText.length;
    const beforeCursor = newText.slice(0, cursorPos);
    const atMatch = beforeCursor.match(/@(\w*)$/);
    if (atMatch) {
      setContextQuery(atMatch[0]);
      setShowContextPicker(true);
    } else {
      setShowContextPicker(false);
    }
    // Slash command trigger: only while the WHOLE message is still just the
    // command token being typed ("/" or "/partial", no space yet) — once a
    // space appears the user has either finished the command name or moved
    // on to its arguments, so the picker closes (same "\S*" no-space
    // convention as slashCommands.ts's own suggestSlashCommands).
    const slashMatch = newText.match(/^\/(\S*)$/);
    if (slashMatch) {
      setSlashQuery(slashMatch[0]);
      setShowSlashPicker(true);
    } else {
      setShowSlashPicker(false);
    }
    setText(newText);
  }, []);

  // Auto-grow the textarea to fit its content (up to maxHeight, then scroll).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const handleContextSelect = useCallback((item: ContextItem) => {
    // Replace the @query with the context reference
    const cursorPos = textareaRef.current?.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const afterCursor = text.slice(cursorPos);
    const atMatch = beforeCursor.match(/@(\w*)$/);
    if (atMatch) {
      const beforeAt = beforeCursor.slice(0, atMatch.index);
      const newText = `${beforeAt}${item.ref} ${afterCursor}`;
      setText(newText);
      // Store context content for sending
      setContextItems(prev => prev.some(i => i.ref === item.ref) ? prev : [...prev, item]);
      // Move cursor after the inserted ref
      setTimeout(() => {
        const newPos = beforeAt.length + item.ref.length + 1;
        textareaRef.current?.setSelectionRange(newPos, newPos);
        textareaRef.current?.focus();
      }, 0);
    }
    setShowContextPicker(false);
  }, [text]);

  const handleModelSelect = useCallback((id: string) => {
    const current = loadAccessSettings();

    // OpenRouter ids contain a '/' (e.g. 'anthropic/claude-sonnet-5'),
    // native Anthropic ids don't (e.g. 'claude-sonnet-5').
    const isOpenRouter = id.includes('/');

    if (isOpenRouter) {
      // Switch to Pro mode and persist the chosen OpenRouter model id
      saveAccessSettings({ ...current, accessMode: 'pro', model: id });
      const orEntry = findOpenRouterModel(id);
      if (orEntry) {
        setModel({ id: orEntry.id, label: orEntry.label, provider: orEntry.provider });
      }
    } else {
      // Switch to CLI mode and persist the chosen native model id
      saveAccessSettings({ ...current, accessMode: 'cli', model: id });
      const found = ALL_MODELS.find(m => m.id === id);
      if (found) setModel(found);
    }
  }, [setModel]);

  /** /model <id> support — resolves the id against BOTH catalogs (same
   *  namespace check as handleModelSelect above) before switching, so an
   *  unrecognized id reports failure instead of silently no-op-ing. */
  const applyModelById = useCallback((id: string): { applied: boolean; label?: string } => {
    const isOpenRouter = id.includes('/');
    const found = isOpenRouter ? findOpenRouterModel(id) : ALL_MODELS.find(m => m.id === id);
    if (!found) return { applied: false };
    handleModelSelect(id);
    return { applied: true, label: found.label };
  }, [handleModelSelect]);

  /** /model with no argument — opens the same dropdown the model chip does. */
  const openModelPicker = useCallback(() => {
    setShowModels(true);
    setShowModes(false);
  }, []);

  /** Picking a suggestion inserts "/name " (never an alias) and keeps the
   *  input focused for the user to type arguments — same insert-then-keep-
   *  typing pattern as handleContextSelect above. Execution only happens on
   *  actual send (Enter/click), not on selection. */
  const handleSlashSelect = useCallback((def: SlashCommandDef) => {
    setText(`/${def.name} `);
    setShowSlashPicker(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Slash commands never reach the model: parse and dispatch locally,
    // then show whatever toast the executor returns (null means the command
    // already produced its own visible effect, e.g. opening the model
    // picker). Deliberately checked BEFORE the engine-readiness preflight
    // below — /clear, /docs, etc. must work even with no engine configured.
    if (trimmed.startsWith('/')) {
      const parsed = parseSlashCommand(trimmed);
      if (parsed) {
        setText('');
        setShowSlashPicker(false);
        const deps: SlashCommandDeps = {
          clearConversation,
          chatSessions,
          loadChatSession,
          applyModelById,
          openModelPicker,
          brainSearch: query => platform.brain.search(query, 5),
          compactConversation,
          t,
        };
        const outcome = await executeSlashCommand(parsed, deps);
        if (outcome) toast(outcome.message, outcome.type);
        return;
      }
    }

    // Input interleaving: send() handles queueing internally when streaming.
    // The user can type and send while a stream is active; the message is
    // queued and auto-sent when the current stream completes.
    // Engine preflight (v0.1.5 W2.3): block the send BEFORE clearing the
    // draft so the user's text survives; re-checked on every attempt.
    const readiness = getEngineReadiness();
    if (!readiness.ready && readiness.reason) {
      setPreflightBlock(readiness);
      return;
    }
    setPreflightBlock(null);
    setText('');
    setContextItems([]);
    setShowContextPicker(false);
    let enriched = trimmed;
    const itemsToResolve = contextItemsFromText(trimmed, contextItems);
    for (const item of itemsToResolve) {
      const resolved = await resolveContextItem(item, platform, projectRoot);
      enriched = enriched.split(item.ref).join(resolved);
    }
    try { localStorage.setItem('lazy.firstAssistantSend', '1'); } catch { /* ignore */ } // W3.2 getting-started signal
    send(enriched);
  }, [text, send, contextItems, platform, projectRoot, clearConversation, compactConversation, chatSessions, loadChatSession, applyModelById, openModelPicker, toast, t]);

  const handleQuickAction = useCallback((action: AssistantQuickAction) => {
    const builtText = action.buildText(text);
    if (action.kind === 'launch') {
      emit('agent:launch', { task: builtText, title: deriveQuickActionTitle(builtText) });
      toast(t('codespace.assistant.missionLaunched'), 'success');
      return;
    }
    setText('');
    void (async () => {
      try { localStorage.setItem('lazy.firstAssistantSend', '1'); } catch { /* ignore */ }
      send(builtText);
    })();
  }, [text, send, toast, t]);

  /** Stop button (composer send/stop toggle) — aborts the in-flight turn
   *  and refocuses the input immediately (clicking the button moves focus
   *  onto it, so this restores it to where typing continues naturally). */
  const handleStop = useCallback(() => {
    abortStream();
    textareaRef.current?.focus();
  }, [abortStream]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Escape = Stop, but ONLY while a turn is actually streaming — never
    // hijack Escape otherwise (standard IDE convention).
    if (e.key === 'Escape' && isStreaming) {
      e.preventDefault();
      handleStop();
      return;
    }
    if (showContextPicker) return; // ContextPicker handles its own keys
    // SlashCommandPicker handles its own keys — but only bail out here when
    // it actually has something to navigate/select. An unrecognized token
    // (e.g. "/nope") leaves the picker open with zero matches; without this
    // check, Enter would be silently swallowed forever (no match to select,
    // nothing to fall through to send either) with no way to submit it as a
    // real command and see the "unknown command" toast.
    if (showSlashPicker && suggestSlashCommands(slashQuery).length > 0) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, handleStop, isStreaming, showContextPicker, showSlashPicker, slashQuery]);

  const currentMode = MODES.find(m => m.id === selectedMode) ?? MODES[0];

  const closeAll = useCallback(() => {
    setShowModes(false);
    setShowModels(false);
  }, []);

  // Same navigation mechanism as the mission preflight (W2.2): 'models'
  // deep-links Settings > Models; Pro entitlement reasons go to Settings >
  // Account where the plan/credits live.
  const goConfigureEngine = useCallback(() => {
    const proReason =
      preflightBlock?.reason === 'pro-inactive' || preflightBlock?.reason === 'pro-no-credits';
    emit('nav:navigateSpace', proReason ? 'account' : 'models');
  }, [preflightBlock]);

  return (
    <div
      style={{
        padding: '8px 12px 10px',
        borderTop: '1px solid var(--color-border-2)',
        flexShrink: 0,
      }}
      onClick={closeAll}
    >
      {/* Engine preflight notice — single line, single instance, no toast */}
      {preflightBlock?.reason && (
        <div
          data-testid="composer-preflight-notice"
          role="alert"
          onClick={e => e.stopPropagation()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 7,
            padding: '6px 10px',
            borderRadius: 7,
            background: 'rgba(251,185,36,0.08)',
            border: '1px solid rgba(251,185,36,0.3)',
            fontSize: 11,
            lineHeight: 1.4,
            color: '#FBB924',
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            {t(engineReasonKey(preflightBlock.reason))}
          </span>
          <button
            type="button"
            data-testid="composer-preflight-configure"
            onClick={goConfigureEngine}
            style={{
              background: 'none',
              border: 'none',
              color: '#C4B5FD',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              padding: 0,
              whiteSpace: 'nowrap',
              textDecoration: 'underline',
            }}
          >
            {t('engine.preflight.configure')}
          </button>
        </div>
      )}

      {/* Text input — position:relative anchors the Send/Stop button inside
          the field at the right edge (standard composer pattern: Cursor/
          ChatGPT/Claude all float the button over the textarea instead of a
          separate row below it). padding-right reserves room so typed text
          never runs under the button. */}
      <div
        style={{
          position: 'relative',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8,
          padding: '8px 40px 8px 11px',
          marginBottom: 7,
        }}
        onClick={e => e.stopPropagation()}
      >
        {showSlashPicker && (
          <SlashCommandPicker
            query={slashQuery}
            onSelect={handleSlashSelect}
            onClose={() => setShowSlashPicker(false)}
          />
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => handleTextChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('assistant.composerPlaceholder')}
          rows={1}
          style={{
            width: '100%',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            resize: 'none',
            fontSize: 12,
            color: 'var(--color-text)',
            fontFamily: 'inherit',
            lineHeight: 1.5,
            minHeight: 20,
            maxHeight: 120,
            overflow: 'auto',
          }}
        />

        {/* Send / Stop button — anchored bottom-right INSIDE the field
            (standard composer pattern). Becomes Stop (square icon, standard
            IDE pattern) for the whole duration of a pending/streaming turn;
            reuses canvas HoverActionStrip's existing StopIcon rather than a
            new glyph. Always enabled while streaming so Stop is always
            clickable, unlike Send which stays disabled on empty input. */}
        <button
          onClick={isStreaming ? handleStop : handleSend}
          disabled={!isStreaming && !text.trim()}
          title={isStreaming ? t('assistant.stopTooltip') : undefined}
          aria-label={isStreaming ? t('assistant.stopTooltip') : undefined}
          data-testid={isStreaming ? 'composer-stop' : 'composer-send'}
          style={{
            position: 'absolute',
            right: 6,
            bottom: 6,
            width: 26,
            height: 26,
            borderRadius: '50%',
            color: '#fff',
            background: isStreaming || text.trim() ? '#7C5CFF' : 'rgba(124,92,255,0.25)',
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: isStreaming || text.trim() ? 'pointer' : 'default',
            boxShadow: isStreaming || text.trim() ? '0 2px 8px rgba(124,92,255,0.4)' : 'none',
            transition: 'background 0.15s, box-shadow 0.15s',
            fontFamily: 'inherit',
          }}
        >
          {isStreaming ? <StopIcon /> : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M5 9V1M1 5l4-4 4 4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      </div>

      {/* Pending input indicator — shows when a message is queued for auto-send */}
      {pendingInput && (
        <div style={{
          fontSize: 11,
          color: '#7C5CFF',
          padding: '2px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}>
          <span style={{ opacity: 0.7 }}>⏎</span>
          <span style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pendingInput}
          </span>
          <span style={{ opacity: 0.5 }}>— queued, will send when stream completes</span>
        </div>
      )}

      {/* Control row */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Mode selector */}
        <div style={{ position: 'relative' }}>
          {showModes && (
            <ModePopover
              current={selectedMode}
              onSelect={setMode}
              onClose={() => setShowModes(false)}
              t={t}
            />
          )}
          <button
            onClick={() => { setShowModes(v => !v); setShowModels(false); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'rgba(124,92,255,0.15)',
              border: '1px solid rgba(124,92,255,0.3)',
              borderRadius: 5,
              padding: '3px 8px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <ModeIcon modeId={currentMode.id} active={true} />
            <span style={{ fontSize: 10, color: 'var(--color-accent-light)', fontWeight: 600 }}>
              {currentMode.label} ▾
            </span>
          </button>
        </div>

        {/* Model selector */}
        <div style={{ position: 'relative' }}>
          {showModels && (
            <ModelDropdown
              currentId={displayModelId}
              showNative={showNative}
              showOpenRouter={showOpenRouter}
              emptyMessage={
                pickerOptions.emptyReadiness?.reason
                  ? t(engineReasonKey(pickerOptions.emptyReadiness.reason))
                  : pickerOptions.codexManaged
                    ? modelManagedByCodexMessage(t)
                    : noModelFallbackMessage(t)
              }
              t={t}
              onSelect={handleModelSelect}
              onClose={() => setShowModels(false)}
            />
          )}
          <button
            onClick={() => { setShowModels(v => !v); setShowModes(false); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 5,
              padding: '3px 8px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>
              {displayModelLabel} ▾
            </span>
          </button>
        </div>

        {/* Host-space quick actions (D8) */}
        {quickActions?.map((action) => (
          <button
            key={action.id}
            onClick={() => handleQuickAction(action)}
            style={{
              display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0,
              background: 'rgba(56,189,248,0.15)', border: '1px solid rgba(56,189,248,0.45)',
              borderRadius: 8, padding: '5px 11px', cursor: 'pointer', fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(56,189,248,0.3)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(56,189,248,0.15)'; }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: '#7DD3FC', whiteSpace: 'nowrap' }}>{action.label}</span>
          </button>
        ))}

        {/* @ contexte chip */}
        <div style={{ position: 'relative' }}>
          {showContextPicker && createPortal(
            <ContextPicker
              query={contextQuery}
              onSelect={handleContextSelect}
              onClose={() => setShowContextPicker(false)}
              anchorRect={null}
            />,
            document.body
          )}
          <button
            onClick={() => {
              setShowContextPicker(v => !v);
              setContextQuery('@');
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 3,
              background: showContextPicker ? 'rgba(124,92,255,0.15)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${showContextPicker ? 'rgba(124,92,255,0.3)' : 'rgba(255,255,255,0.1)'}`,
              borderRadius: 5,
              padding: '3px 7px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 10, color: showContextPicker ? 'var(--color-accent-light)' : 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap' }}>@ ctx</span>
          </button>
        </div>

        {/* Brain chip — real toggle */}
        <button
          onClick={toggleBrain}
          aria-pressed={brainEnabled}
          title={brainEnabled ? t('assistant.brainToggle.onTooltip') : t('assistant.brainToggle.offTooltip')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            background: brainEnabled ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${brainEnabled ? 'rgba(34,197,94,0.22)' : 'rgba(255,255,255,0.1)'}`,
            borderRadius: 5,
            padding: '3px 7px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.15s, border-color 0.15s',
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: brainEnabled ? 'var(--color-success-alt)' : 'rgba(255,255,255,0.3)',
              fontWeight: 500,
            }}
          >
            brain {brainEnabled ? 'on' : 'off'}
          </span>
        </button>

        {/* Brain scope selector — only visible when brain is on */}
        {brainEnabled && (
          <BrainScopeSelector selectedScope={selectedScope} onSelect={setScope} />
        )}

        <div style={{ flex: 1 }} />

        {/* Agent link */}
        <button
          onClick={onLaunchAgent}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 10,
            color: 'var(--color-accent-light)',
            fontFamily: 'inherit',
            padding: '0 4px',
            textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {t('assistant.launchAgent')}
        </button>
      </div>
    </div>
  );
}
