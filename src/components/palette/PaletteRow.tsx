/* PaletteRow — a single result row in the command palette. */

import type { PaletteItem, PaletteItemKind } from './paletteItems';
import { useI18n } from '../../i18n';

interface PaletteRowProps {
  item: PaletteItem;
  isHighlighted: boolean;
  onMouseEnter: () => void;
  onMouseDown: () => void; // mousedown to avoid blur before click fires
}

const KIND_COLORS: Record<PaletteItemKind, string> = {
  file:    'rgba(124, 92, 255, 0.7)',
  command: 'rgba(255, 255, 255, 0.35)',
  brain:   'rgba(102, 226, 122, 0.7)',
  agent:   'rgba(79, 195, 247, 0.7)',
};

export function PaletteRow({ item, isHighlighted, onMouseEnter, onMouseDown }: PaletteRowProps) {
  const { t } = useI18n();
  const KIND_LABELS: Record<PaletteItemKind, string> = {
    file:    t('palette.kind.file'),
    command: t('palette.kind.command'),
    brain:   t('palette.kind.brain'),
    agent:   t('palette.kind.agent'),
  };

  return (
    <div
      role="option"
      aria-selected={isHighlighted}
      id={`palette-option-${item.id}`}
      onMouseEnter={onMouseEnter}
      onMouseDown={onMouseDown}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 14px',
        cursor: 'pointer',
        background: isHighlighted ? 'rgba(124, 92, 255, 0.15)' : 'transparent',
        borderLeft: isHighlighted ? '2px solid #7C5CFF' : '2px solid transparent',
        transition: 'background 80ms ease',
        userSelect: 'none',
      }}
    >
      {/* Icon — either a drawn component from icons.tsx or a typographic
          glyph fallback (never emoji, see paletteItems.ts's buildCommandItems). */}
      <span
        style={{
          width: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: isHighlighted ? '#A78BFF' : 'rgba(255,255,255,0.4)',
          flexShrink: 0,
        }}
      >
        {typeof item.icon === 'function'
          ? <item.icon size={14} />
          : <span style={{ fontSize: 13, fontFamily: 'monospace' }}>{item.icon}</span>}
      </span>

      {/* Label + hint path */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            color: isHighlighted ? '#E6E8EF' : 'rgba(255,255,255,0.75)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {item.label}
        </div>
        {item.hint && (
          <div
            title={item.title}
            style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.28)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              marginTop: 1,
            }}
          >
            {item.hint}
          </div>
        )}
      </div>

      {/* Kind badge */}
      <span
        style={{
          fontSize: 10,
          color: KIND_COLORS[item.kind],
          background: `${KIND_COLORS[item.kind].replace('0.7', '0.1').replace('0.35', '0.07')}`,
          border: `1px solid ${KIND_COLORS[item.kind].replace('0.7', '0.2').replace('0.35', '0.1')}`,
          borderRadius: 4,
          padding: '1px 6px',
          flexShrink: 0,
          whiteSpace: 'nowrap',
          fontWeight: 500,
        }}
      >
        {item.shortcut ?? KIND_LABELS[item.kind]}
      </span>
    </div>
  );
}
