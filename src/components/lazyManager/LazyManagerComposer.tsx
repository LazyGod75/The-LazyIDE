/* LazyManagerComposer — unified input area for both orchestrator and
   coder modes. In orchestrator mode: presets (Standup/Récap/Stop) + input
   with send/stop. In coder mode: delegates to the existing Composer
   component which has context picker, mode selector, brain scope, etc. */

import { type RefObject, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import type { ManagerMode } from './lazyManagerStore';
import { Composer } from '../assistant/Composer';
import { StopIcon } from '../agents/canvas/chrome/HoverActionStrip';
import type { AssistantIdentity, AssistantQuickAction } from '../assistant/assistantIdentity';
import { listAgents } from '../../lib/agents/agentsStorage';
import { ECC_AGENTS } from '../../lib/agents/eccAgents';
import { AgentMentionPopup, type MentionAgentEntry } from './AgentMentionPopup';
import { on } from '../../lib/bus';


/** Matches "@" plus an in-progress kebab-case token right before the caret —
 *  the hyphen MUST be in the character class (agent names look like
 *  "code-reviewer"): a plain \w* class would close the popup at the first
 *  hyphen, mid-name. */
const MENTION_TRIGGER = /@([\w-]*)$/;

// Real defect, 2026-08-14 (docked panel ~500px wide): these four pills sat
// in a plain `display:flex` row with no wrap, and design-system.css's
// global `button { overflow-wrap: break-word; word-break: break-word; }`
// safety net (meant for genuinely long unbroken strings, e.g. a pasted
// URL) has a documented side effect on FLEX children — a box that can
// break its text anywhere no longer floors its flex-shrink minimum at the
// text's min-content (unbreakable-run) width, so the flex algorithm was
// free to squeeze each pill narrower than a single word needs, and the
// word itself split across two lines ("Recap" -> "Reca" / "p"). `flexShrink:
// 0` removes the squeeze at its source (a pill keeps its natural content
// width, never asked to go narrower); `whiteSpace: nowrap` +
// `wordBreak: 'keep-all'` + `overflowWrap: 'normal'` are the belt-and-
// braces override of that same global rule so nothing in this row can
// ever hyphenate a word even if a future change re-introduces shrinking.
// Combined with the row's own `flexWrap: 'wrap'` below, a panel too
// narrow for all four pills on one line now wraps them as WHOLE items
// onto a second row instead of either overflowing or breaking a word.
const presetPillStyle: React.CSSProperties = {
  fontSize: 11.5, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 20, padding: '5px 12px', color: 'var(--color-text-muted)', cursor: 'pointer', fontFamily: 'inherit',
  flexShrink: 0, whiteSpace: 'nowrap', wordBreak: 'keep-all', overflowWrap: 'normal',
};

interface LazyManagerComposerProps {
  mode: ManagerMode;
  input: string;
  setInput: (v: string) => void;
  onSend: (text?: string) => void;
  onStop: () => void;
  busy: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onLaunchAgent: () => void;
  quickActions?: AssistantQuickAction[];
  identity?: AssistantIdentity;
  /** 2026-08-06 (founder: "c'est une catastrophe que le lazymanager ne fasse
   *  pas ce qu'on demande") — DIRECT actions, no LLM round-trip: the
   *  "Stoppe tout" / "Nettoyer" pills execute the real primitives even when
   *  the manager model fails to emit <lazy_actions>. Optional so every
   *  pre-existing caller/test keeps compiling. */
  onStopAll?: () => void;
  onCleanup?: () => void;
}

export function LazyManagerComposer({
  mode,
  input,
  setInput,
  onSend,
  onStop,
  busy,
  inputRef,
  onKeyDown,
  onLaunchAgent,
  quickActions,
  onStopAll,
  onCleanup,
}: LazyManagerComposerProps) {
  const { t } = useI18n();

  // Auto-grow the textarea to fit its content (up to maxHeight, then
  // scroll) — same pattern as Composer.tsx's own textarea (see that file's
  // matching effect). No-ops harmlessly in coder mode, where inputRef never
  // attaches to a rendered element.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input, inputRef]);

  // @-agent-mention autocomplete (orchestrator mode only) — self-contained
  // state, per the recon brief, to avoid touching the parent LazyManager.tsx
  // beyond the input/inputRef it already threads through. `mentionQuery`
  // null = popup closed; a string (possibly empty, for a bare "@") = open.
  const [agentList, setAgentList] = useState<MentionAgentEntry[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [contextPill, setContextPill] = useState<{ ref: string; label: string } | null>(null);



  // Listen for "Send to Manager" events from the canvas context menu
  useEffect(() => {
    const off = on('manager:sendToManager', (payload) => {
      setContextPill(payload);
    });
    return () => { off(); };
  }, []);

  // Load once: user/project agents (listAgents()) first, then the built-in
  // ECC library, deduped by name — ECC_AGENTS is statically bundled, so the
  // popup is never empty even on web builds with no saved agents.
  useEffect(() => {
    let cancelled = false;
    void listAgents().then((stored) => {
      if (cancelled) return;
      const userEntries: MentionAgentEntry[] = stored.map((s) => ({
        name: s.agent.name,
        displayName: s.agent.displayName || s.agent.name,
        color: s.agent.color,
        modelTier: s.agent.modelTier,
      }));
      const seen = new Set(userEntries.map((a) => a.name));
      const eccEntries: MentionAgentEntry[] = ECC_AGENTS.filter((a) => !seen.has(a.name)).map((a) => ({
        name: a.name,
        displayName: a.displayName,
        color: a.color,
        modelTier: a.modelTier,
      }));
      setAgentList([...userEntries, ...eccEntries]);
    });
    return () => { cancelled = true; };
  }, []);

  const filteredMentionAgents = useMemo(() => {
    if (mentionQuery === null) return [];
    const needle = mentionQuery.toLowerCase();
    if (!needle) return agentList;
    return agentList.filter(
      (a) => a.name.toLowerCase().includes(needle) || a.displayName.toLowerCase().includes(needle),
    );
  }, [agentList, mentionQuery]);

  const mentionOpen = mentionQuery !== null;

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const newValue = e.target.value;
    setInput(newValue);
    const cursorPos = e.target.selectionStart ?? newValue.length;
    const match = newValue.slice(0, cursorPos).match(MENTION_TRIGGER);
    if (match) {
      setMentionQuery(match[1]);
      setMentionActiveIndex(0);
    } else {
      setMentionQuery(null);
    }
  }

  // Replaces the matched "@query" before the caret with "@<agent.name> "
  // (trailing space) — managerEngine.ts documents mentions to the LLM in
  // exactly this shape (kebab-case name, see that file's dynamic-context
  // builder) — and restores focus + caret position after the insertion.
  function selectMentionAgent(agent: MentionAgentEntry) {
    const el = inputRef.current;
    const cursorPos = el?.selectionStart ?? input.length;
    const beforeCursor = input.slice(0, cursorPos);
    const afterCursor = input.slice(cursorPos);
    const match = beforeCursor.match(MENTION_TRIGGER);
    setMentionQuery(null);
    if (!match || match.index === undefined) return;
    const beforeAt = beforeCursor.slice(0, match.index);
    const inserted = `@${agent.name} `;
    setInput(`${beforeAt}${inserted}${afterCursor}`);
    setTimeout(() => {
      const newPos = beforeAt.length + inserted.length;
      el?.setSelectionRange(newPos, newPos);
      el?.focus();
    }, 0);
  }

  // Coder mode: delegate to existing Composer (preserves context picker,
  // mode selector, brain scope, quick actions, model dropdown, etc.)
  if (mode === 'coder') {
    return (
      <Composer onLaunchAgent={onLaunchAgent} quickActions={quickActions} />
    );
  }

  // Orchestrator mode: presets + input + send/stop
  function sendPreset(text: string) {
    if (busy) return;
    onSend(text);
  }

  return (
    <div style={{
      padding: '11px 16px 14px', borderTop: '1px solid var(--color-border)',
      display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0,
    }}>
      {/* Context pill — shows when a canvas node was sent to the manager */}
      {contextPill && (
        <div
          data-testid="manager-context-pill"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, color: 'var(--color-text-muted)',
            background: 'rgba(124,92,255,0.08)', border: '1px solid rgba(124,92,255,0.2)',
            borderRadius: 8, padding: '4px 8px',
          }}
        >
          <span style={{ fontSize: 10, color: 'var(--color-text-disabled)' }}>
            {t('lazyManager.contextLabel')}:
          </span>
          <span style={{ fontWeight: 600, color: 'var(--color-text-secondary)' }}>
            {contextPill.label}
          </span>
          <button
            type="button"
            onClick={() => setContextPill(null)}
            aria-label={t('lazyManager.dismissContext')}
            style={{
              border: 'none', background: 'transparent', color: 'var(--color-text-disabled)',
              cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0, marginLeft: 'auto',
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* Presets — disabled while busy (NEVER DEGRADE IN SILENCE: these used
          to stay clickable while the manager was mid-turn, and `sendPreset`
          silently no-op'd on `if (busy) return`; a real click on a
          fully-live-looking button must never just vanish — see
          useManagerActionQueue.ts's own doc comment for the wider fix this
          matches). Unlike the card actions in LazyManagerMessageList.tsx,
          these presets are simple, instantly-re-clickable shortcuts once the
          manager frees up (not a decision made in response to specific
          proposed content), so disabling — same convention already used by
          the textarea/send button below — is enough: nothing the user
          "committed to" is ever at risk of being lost. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button data-testid="manager-preset-standup" onClick={() => sendPreset(t('cockpit.manager.standupOrder'))} disabled={busy} style={{ ...presetPillStyle, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}>
          {t('cockpit.manager.presetStandup')}
        </button>
        <button data-testid="manager-preset-recap" onClick={() => sendPreset(t('cockpit.manager.recapOrder'))} disabled={busy} style={{ ...presetPillStyle, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}>
          {t('cockpit.manager.presetRecap')}
        </button>
        <button
          data-testid="manager-preset-stopall"
          onClick={() => (onStopAll ? onStopAll() : sendPreset(t('cockpit.manager.stopAllOrder')))}
          disabled={busy}
          title={onStopAll ? t('cockpit.manager.stopAllDirectHint') : undefined}
          style={{ ...presetPillStyle, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
        >
          {t('cockpit.manager.presetStopAll')}
        </button>
        <button
          data-testid="manager-preset-cleanup"
          onClick={() => (onCleanup ? onCleanup() : sendPreset(t('cockpit.manager.cleanupOrder')))}
          disabled={busy}
          title={onCleanup ? t('cockpit.manager.cleanupDirectHint') : undefined}
          style={{ ...presetPillStyle, opacity: busy ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' }}
        >
          {t('cockpit.manager.presetCleanup')}
        </button>
      </div>

      {/* Input row — auto-growing textarea (Enter sends, Shift+Enter inserts
          a newline), same interaction contract as Composer.tsx's own field. */}
      <div
        onKeyDown={onKeyDown}
        style={{
          position: 'relative', display: 'flex', alignItems: 'flex-end',
          background: 'var(--color-input)',
          border: busy ? '1px solid rgba(124,92,255,0.45)' : '1px solid rgba(255,255,255,0.12)',
          boxShadow: busy ? '0 0 0 1px rgba(124,92,255,0.18)' : 'none',
          transition: 'border-color 0.18s ease, box-shadow 0.18s ease',
          borderRadius: 10, padding: '4px 4px 4px 13px',
        }}
      >
        <textarea
          ref={inputRef}
          data-testid="manager-input"
          value={input}
          onChange={handleInputChange}
          onKeyDown={e => {
            // While the mention popup is open, arrow keys move the
            // highlighted row and Enter/Tab select it — this MUST run
            // before (and suppress) the plain Enter-sends handler below,
            // otherwise selecting a mention would also send the message.
            if (mentionOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionActiveIndex(i => (filteredMentionAgents.length === 0 ? 0 : (i + 1) % filteredMentionAgents.length));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionActiveIndex(i => (filteredMentionAgents.length === 0 ? 0 : (i - 1 + filteredMentionAgents.length) % filteredMentionAgents.length));
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const agent = filteredMentionAgents[mentionActiveIndex];
                if (agent) selectMentionAgent(agent);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={busy}
          placeholder={t('cockpit.manager.inputPlaceholder')}
          rows={1}
          style={{
            flex: 1, background: 'transparent', border: 'none', outline: 'none',
            resize: 'none', color: 'var(--color-text)', fontSize: 13.5, fontFamily: 'inherit',
            lineHeight: 1.5, minHeight: 20, maxHeight: 120, overflow: 'auto',
            paddingRight: 34, paddingTop: 6, paddingBottom: 6,
          }}
        />
        {mentionOpen && (
          <AgentMentionPopup
            agents={filteredMentionAgents}
            activeIndex={mentionActiveIndex}
            onHover={setMentionActiveIndex}
            onSelect={selectMentionAgent}
            onClose={() => setMentionQuery(null)}
          />
        )}
        <button
          data-testid={busy ? 'manager-stop' : 'manager-send'}
          onClick={busy ? onStop : () => onSend()}
          disabled={!busy && !input.trim()}
          title={busy ? t('cockpit.manager.stop') : t('cockpit.manager.send')}
          aria-label={busy ? t('cockpit.manager.stop') : t('cockpit.manager.send')}
          style={{
            position: 'absolute', right: 5, bottom: 5,
            flexShrink: 0, width: 26, height: 26, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: busy || input.trim() ? 'var(--color-accent)' : 'rgba(124,92,255,0.25)',
            color: '#fff', border: 'none', cursor: busy || input.trim() ? 'pointer' : 'default',
            fontFamily: 'inherit',
          }}
        >
          {busy ? <StopIcon /> : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M5 9V1M1 5l4-4 4 4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
