/* AgentMentionPopup.tsx — Discord/Notion-style @-agent-mention autocomplete
   list for the LazyManager orchestrator composer.

   Purely a rendering + dismiss surface: LazyManagerComposer.tsx owns the
   mention state (the "@query" being typed, the filtered agent list, and the
   active index) and the ArrowUp/ArrowDown/Enter/Tab keyboard handling —
   that lives on the textarea's own onKeyDown, right next to the Enter-sends
   guard it must suppress while this popup is open (see that file's header
   comment). This component only renders the list and reacts to hover/click,
   plus outside-click/Escape dismissal via the canonical useDismissable hook
   (same convention as every other icon-triggered popover in the app — see
   that hook's own header comment for the close-then-reopen race it avoids).
*/

import { AGENT_COLOR_MAP, type AgentColor, type ModelTier } from '../../lib/agents/agentDef';
import { useDismissable } from '../common/useDismissable';
import { useI18n } from '../../i18n';

/** Minimal agent shape the popup needs to render a row — built by
 *  LazyManagerComposer.tsx from both listAgents() (user/project scope) and
 *  ECC_AGENTS (built-in library), deduped by name. */
export interface MentionAgentEntry {
  name: string;
  displayName: string;
  color: AgentColor;
  modelTier: ModelTier;
}

interface AgentMentionPopupProps {
  agents: MentionAgentEntry[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (agent: MentionAgentEntry) => void;
  onClose: () => void;
}

export function AgentMentionPopup({ agents, activeIndex, onHover, onSelect, onClose }: AgentMentionPopupProps) {
  const { t } = useI18n();
  const popupRef = useDismissable<HTMLDivElement>({ open: true, onClose });

  return (
    <div
      ref={popupRef}
      data-testid="manager-mention-popup"
      role="listbox"
      aria-label={t('cockpit.manager.mention.ariaLabel')}
      style={{
        position: 'absolute',
        left: 9,
        right: 4,
        bottom: 'calc(100% + 6px)',
        maxHeight: 240,
        overflowY: 'auto',
        background: 'var(--color-panel-3)',
        border: '1px solid var(--color-border-3)',
        borderRadius: 10,
        padding: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        zIndex: 20,
      }}
    >
      {agents.length === 0 && (
        <p style={{ margin: '8px 8px', fontSize: 11.5, color: 'var(--color-text-disabled)' }}>
          {t('cockpit.manager.mention.empty')}
        </p>
      )}
      {agents.map((agent, index) => {
        const active = index === activeIndex;
        return (
          <div
            key={agent.name}
            data-testid={`manager-mention-item-${agent.name}`}
            role="option"
            aria-selected={active}
            onMouseEnter={() => onHover(index)}
            onClick={() => onSelect(agent)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
            }}
          >
            <span
              style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: AGENT_COLOR_MAP[agent.color] ?? '#7C5CFF',
              }}
            />
            <span
              style={{
                flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600,
                color: 'var(--color-text)', whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {agent.displayName}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-text-muted)', flexShrink: 0 }}>
              @{agent.name}
            </span>
            <span
              style={{
                fontSize: 10, color: 'var(--color-text-muted)', background: 'var(--color-panel-2)',
                border: '1px solid var(--color-border-3)', borderRadius: 5, padding: '1px 5px', flexShrink: 0,
              }}
            >
              {agent.modelTier}
            </span>
          </div>
        );
      })}
    </div>
  );
}
