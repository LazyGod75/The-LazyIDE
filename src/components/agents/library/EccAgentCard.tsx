/* eccAgentCard.tsx — Read-only card for built-in ECC agents.
   Supports run, favorite toggle, and duplicate-to-own-scope.
*/

import type { EccAgent } from '../../../lib/agents/eccAgents';
import { AGENT_COLOR_MAP } from '../../../lib/agents/agentDef';
import { useI18n } from '../../../i18n';

interface EccAgentCardProps {
  agent: EccAgent;
  isFavorite: boolean;
  onRun: () => void;
  onToggleFavorite: () => void;
  onDuplicate: () => void;
}

const MODEL_LABEL: Record<string, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
  inherit: 'Inherit',
};

export function EccAgentCard({ agent, isFavorite, onRun, onToggleFavorite, onDuplicate }: EccAgentCardProps) {
  const { t } = useI18n();
  const accentColor = AGENT_COLOR_MAP[agent.color] ?? '#7C5CFF';

  const descPreview = agent.description.length > 90
    ? `${agent.description.slice(0, 90)}…`
    : agent.description;

  return (
    <div
      data-testid="ecc-agent-card"
      style={{
        background: '#16161D',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        position: 'relative',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = `${accentColor}55`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.08)';
      }}
    >
      {/* Color chip + name + favorite star */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: accentColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: '#E2E2F0',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {agent.displayName}
        </span>
        <button
          data-testid="agent-fav-btn"
          onClick={onToggleFavorite}
          title={isFavorite ? t('agents.eccCard.removeFavorite') : t('agents.eccCard.addFavorite')}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            color: isFavorite ? '#FFC76B' : 'rgba(255,255,255,0.25)',
            padding: 0,
            flexShrink: 0,
            fontFamily: 'inherit',
          }}
        >
          {isFavorite ? '★' : '☆'}
        </button>
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: accentColor,
            background: `${accentColor}18`,
            border: `1px solid ${accentColor}33`,
            borderRadius: 4,
            padding: '1px 6px',
            flexShrink: 0,
          }}
        >
          {MODEL_LABEL[agent.modelTier] ?? agent.modelTier}
        </span>
      </div>

      {/* Description */}
      <p
        style={{
          fontSize: 12,
          color: 'rgba(255,255,255,0.50)',
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        {descPreview}
      </p>

      {/* Tags */}
      {agent.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {agent.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              style={{
                fontSize: 10,
                color: 'rgba(255,255,255,0.4)',
                background: 'rgba(255,255,255,0.06)',
                borderRadius: 4,
                padding: '1px 6px',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* ECC badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: 'rgba(124,92,255,0.7)',
            background: 'rgba(124,92,255,0.08)',
            border: '1px solid rgba(124,92,255,0.15)',
            borderRadius: 3,
            padding: '1px 5px',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          ECC
        </span>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        <button
          data-testid="agent-run-btn"
          onClick={onRun}
          style={{
            flex: 1,
            padding: '5px 0',
            borderRadius: 6,
            border: 'none',
            background: accentColor,
            color: '#fff',
            fontSize: 12,
            fontWeight: 600,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          {t('agents.card.run')}
        </button>
        <button
          onClick={onDuplicate}
          title={t('agents.eccCard.duplicateToMine')}
          style={{
            padding: '5px 10px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'transparent',
            color: 'rgba(255,255,255,0.4)',
            fontSize: 13,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          ⧉
        </button>
      </div>
    </div>
  );
}
