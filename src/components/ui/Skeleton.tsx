/* Skeleton — reusable loading placeholder.
   Subtle shimmer animation, themed to dark/violet design system.
*/

import type { CSSProperties } from 'react';
import { useI18nOptional } from '../../i18n';

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: number;
  style?: CSSProperties;
}

export function Skeleton({ width = '100%', height = 14, borderRadius = 4, style }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius,
        background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 100%)',
        backgroundSize: '200% 100%',
        animation: 'skeleton-shimmer 1.6s ease-in-out infinite',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

// ── Compound skeleton layouts ──────────────────────────────────────

export function SkeletonCard() {
  return (
    <div
      aria-hidden="true"
      style={{
        padding: '12px 14px',
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Skeleton width={28} height={28} borderRadius={6} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Skeleton width="60%" height={12} />
          <Skeleton width="40%" height={10} />
        </div>
      </div>
      <Skeleton width="100%" height={10} />
      <Skeleton width="80%" height={10} />
    </div>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
          }}
        >
          <Skeleton width={8} height={8} borderRadius={99} />
          <Skeleton width={`${50 + (i * 17) % 35}%`} height={12} />
          <Skeleton width={40} height={10} style={{ marginLeft: 'auto', flexShrink: 0 }} />
        </div>
      ))}
    </div>
  );
}

// ── Spinner ────────────────────────────────────────────────────────

interface SpinnerProps {
  size?: number;
  color?: string;
}

export function Spinner({ size = 20, color = 'var(--color-accent)' }: SpinnerProps) {
  // Boot-time/fallback UI (e.g. AuthGate's pre-auth splash, Suspense
  // fallbacks) can render before I18nProvider is guaranteed to be mounted —
  // useI18nOptional degrades to a hardcoded label instead of throwing. See
  // its doc comment in src/i18n/index.tsx.
  const i18n = useI18nOptional();
  const label = i18n ? i18n.t('common.loading') : 'Loading…';
  return (
    <div
      aria-label={label}
      role="status"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid rgba(255,255,255,0.08)`,
        borderTop: `2px solid ${color}`,
        animation: 'spin 0.7s linear infinite',
        flexShrink: 0,
      }}
    />
  );
}
