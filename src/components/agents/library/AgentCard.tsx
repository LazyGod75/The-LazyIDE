/* AgentCard — display card for a saved LazyAgent in the Library grid.
   Phase 2: draggable=true, emits agent id + name via dataTransfer.
*/

import React from 'react';
import type { LazyAgent } from '../../../lib/agents/agentDef';
import { AGENT_COLOR_MAP } from '../../../lib/agents/agentDef';
import { nextCronRun } from '../../../lib/agents/scheduleUtils';
import { useI18n } from '../../../i18n';

interface AgentCardProps {
  agent: LazyAgent;
  onRun: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** W-BYO row 1 (additive, optional — absent renders no export button,
   *  same convention CanvasPalette.tsx's onAddRouter etc. already use) —
   *  exports this agent as a `.lazyagent.json` file. */
  onExport?: () => void;
}

const MODEL_LABEL: Record<string, string> = {
  haiku:   'Haiku',
  sonnet:  'Sonnet',
  opus:    'Opus',
  inherit: 'Inherit',
};

export function AgentCard({ agent, onRun, onEdit, onDuplicate, onDelete, onExport }: AgentCardProps) {
  const { t } = useI18n();
  const accentColor = AGENT_COLOR_MAP[agent.color] ?? '#7C5CFF';

  const descPreview = agent.description.length > 90
    ? `${agent.description.slice(0, 90)}…`
    : agent.description;

  const schedule = agent.triggers.schedule;
  const isScheduled = schedule?.enabled && schedule.mode === 'local';
  const nextRun = isScheduled ? nextCronRun(schedule.cron) : null;

  function handleDragStart(e: React.DragEvent<HTMLDivElement>) {
    e.dataTransfer.setData('application/lazy-agent-id', agent.id);
    e.dataTransfer.setData('application/lazy-agent-name', agent.name);
    e.dataTransfer.effectAllowed = 'copy';
  }

  return (
    <div
      data-testid="agent-card"
      draggable
      onDragStart={handleDragStart}
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
      {/* Color chip + name */}
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
          {agent.displayName || agent.name}
        </span>
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
        {descPreview || <em style={{ opacity: 0.4 }}>{t('agents.card.noDescription')}</em>}
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

      {/* Schedule badge */}
      {isScheduled && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: '#4FC3F7',
              background: 'rgba(79,195,247,0.10)',
              border: '1px solid rgba(79,195,247,0.25)',
              borderRadius: 4,
              padding: '1px 6px',
            }}
          >
            {t('agents.card.scheduled')}
          </span>
          {nextRun && (
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
              {nextRun}
            </span>
          )}
        </div>
      )}

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
          data-testid="agent-edit-btn"
          onClick={onEdit}
          style={{
            padding: '5px 10px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'transparent',
            color: 'rgba(255,255,255,0.6)',
            fontSize: 12,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          {t('agents.card.edit')}
        </button>
        {onExport && (
          <button
            data-testid="agent-export-btn"
            onClick={onExport}
            title={t('agents.card.export')}
            style={{
              padding: '5px 8px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.4)',
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            &#8659;
          </button>
        )}
        <button
          onClick={onDuplicate}
          title={t('agents.card.duplicate')}
          style={{
            padding: '5px 8px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'transparent',
            color: 'rgba(255,255,255,0.4)',
            fontSize: 13,
            fontFamily: 'inherit',
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ⧉
        </button>
        <button
          onClick={onDelete}
          title={t('agents.card.delete')}
          style={{
            padding: '5px 8px',
            borderRadius: 6,
            border: '1px solid rgba(248,113,113,0.18)',
            background: 'transparent',
            color: 'rgba(248,113,113,0.6)',
            fontSize: 13,
            fontFamily: 'inherit',
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
