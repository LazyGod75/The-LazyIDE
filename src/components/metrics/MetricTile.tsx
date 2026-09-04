/* MetricTile — single KPI tile with label, value, optional sub-text and sparkline */

import { useState } from 'react';
import { Sparkline } from './Sparkline';

export interface MetricTileProps {
  label: string;
  value: string;
  sub?: string;
  /** Native browser tooltip (title attribute) — useful when `sub` carries a
   *  per-item breakdown that may be longer than the tile's own ellipsis. */
  title?: string;
  accent?: boolean;
  sparkline?: number[];
  sparklineColor?: string;
  /** QA fix (B1): when set, the tile becomes a real clickable control
   *  (role="button", hover state, keyboard-activatable) instead of a plain
   *  read-only stat. */
  onActivate?: () => void;
  testId?: string;
  triggerRef?: React.RefObject<HTMLDivElement | null>;
}

export function MetricTile({
  label,
  value,
  sub,
  title,
  accent = false,
  sparkline,
  sparklineColor = '#7C5CFF',
  onActivate,
  testId,
  triggerRef,
}: MetricTileProps) {
  const [hover, setHover] = useState(false);
  const clickable = !!onActivate;
  const valueColor = accent ? sparklineColor : '#E2E2F0';

  return (
    <div
      ref={triggerRef}
      title={title}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      data-testid={testId}
      onClick={onActivate}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onActivate?.();
              }
            }
          : undefined
      }
      onMouseEnter={clickable ? () => setHover(true) : undefined}
      onMouseLeave={clickable ? () => setHover(false) : undefined}
      style={{
        flex: '1 1 0',
        minWidth: 0,
        background: clickable && hover ? '#1C1C28' : '#16161D',
        border: clickable && hover ? '1px solid rgba(124,92,255,0.35)' : '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8,
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        cursor: clickable ? 'pointer' : undefined,
        outline: 'none',
        transition: clickable ? 'background 0.15s, border-color 0.15s' : undefined,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: 'rgba(255,255,255,0.40)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 600,
          lineHeight: 1,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span
            style={{
              fontSize: 18,
              fontWeight: 700,
              lineHeight: 1,
              color: valueColor,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {value}
          </span>
          {sub !== undefined && (
            <span
              style={{
                fontSize: 10,
                color: 'rgba(255,255,255,0.38)',
                lineHeight: 1.3,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {sub}
            </span>
          )}
        </div>
        {sparkline !== undefined && (
          <Sparkline
            data={sparkline}
            color={sparklineColor}
            width={60}
            height={24}
          />
        )}
      </div>
    </div>
  );
}
