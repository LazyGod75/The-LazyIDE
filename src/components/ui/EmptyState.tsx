/* EmptyState — clean, inviting empty state with optional CTA.
   Shared across spaces: Library, Brain, Review, MissionControl.
*/

import type { ReactNode } from 'react';
import type { IconComponent } from '../icons';

interface EmptyStateProps {
  icon: string | IconComponent;
  title: string;
  subtitle?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({ icon, title, subtitle, action }: EmptyStateProps) {
  const isComponent = typeof icon === 'function';
  const renderIcon = (): ReactNode => {
    if (isComponent) {
      return icon({ size: 24, color: 'currentColor' });
    }
    return icon;
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: '60px 32px',
        textAlign: 'center',
        flex: 1,
      }}
    >
      {/* Icon ring */}
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          background: 'rgba(124,92,255,0.08)',
          border: '1px solid rgba(124,92,255,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 24,
          color: isComponent ? 'rgba(124,92,255,0.6)' : undefined,
          flexShrink: 0,
        }}
      >
        {renderIcon()}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h3
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.6)',
            letterSpacing: '-0.01em',
          }}
        >
          {title}
        </h3>
        {subtitle && (
          <p
            style={{
              margin: 0,
              fontSize: 12,
              color: 'rgba(255,255,255,0.28)',
              maxWidth: 280,
              lineHeight: 1.5,
            }}
          >
            {subtitle}
          </p>
        )}
      </div>

      {action && (
        <button
          onClick={action.onClick}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 20px',
            borderRadius: 8,
            border: '1px solid rgba(124,92,255,0.4)',
            background: 'rgba(124,92,255,0.12)',
            color: '#C4B5FD',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: 'inherit',
            cursor: 'pointer',
            transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
          }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.background = 'rgba(124,92,255,0.2)';
            el.style.borderColor = 'rgba(124,92,255,0.6)';
            el.style.transform = 'translateY(-1px)';
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.background = 'rgba(124,92,255,0.12)';
            el.style.borderColor = 'rgba(124,92,255,0.4)';
            el.style.transform = 'translateY(0)';
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1, marginTop: -1 }}>+</span>
          {action.label}
        </button>
      )}
    </div>
  );
}
