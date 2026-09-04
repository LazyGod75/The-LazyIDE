/* redesign/shared.tsx — small presentational primitives shared across the
   4 Team viewpoints (Solo/Lead/Member/Multi-team) and the member drawer.

   Pure, stateless, no data fetching — consumes real values passed by the
   caller. Colors/tokens come from design-system.css custom properties
   (D11) rather than raw hex literals, per the redesign's convention.
*/

import { useState } from 'react';
import type { OrgRole } from '../../../lib/teams/types';
import type { UsageState } from '../../../lib/teams/roleView';
import { useI18n } from '../../../i18n';

// ── Deterministic color palette (avatars, dept dots, org dots) ──────

const PALETTE = ['#7C5CFF', '#E64980', '#38BDF8', '#0CA678', '#FBB924', '#8A7FB8', '#F87171'];

/** Stable hash so the same id always maps to the same palette color. */
export function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** Real display name resolution — display_name, else email prefix, else a
    truncated id. Matches D5c. */
export function displayNameFor(m: { display_name?: string; email?: string; user_id: string }): string {
  if (m.display_name && m.display_name.trim()) return m.display_name;
  if (m.email && m.email.trim()) return m.email.split('@')[0];
  return `${m.user_id.slice(0, 8)}…`;
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// ── Avatar ────────────────────────────────────────────────────────

export function Avatar({ id, name, size = 42 }: { id: string; name: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: colorForId(id),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.4),
        fontWeight: 700,
        color: '#fff',
        flexShrink: 0,
      }}
    >
      {initialsFor(name)}
    </div>
  );
}

// ── Section label ─────────────────────────────────────────────────

export function SectionLabel({
  children,
  color = 'var(--color-text-muted)',
  style,
}: {
  children: React.ReactNode;
  color?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        fontSize: 11.5,
        fontWeight: 700,
        letterSpacing: '1.8px',
        textTransform: 'uppercase',
        color,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ── Role badge (restyled RoleBadge, matches design-team.md §4.1.2) ──

const ROLE_BADGE_STYLE: Record<OrgRole, { bg: string; text: string }> = {
  'org-admin': { bg: 'var(--color-accent)', text: '#fff' },
  'team-lead': { bg: 'rgba(56,189,248,0.25)', text: '#7DD3FC' },
  member: { bg: 'rgba(255,255,255,0.1)', text: 'var(--color-text-muted)' },
  viewer: { bg: 'rgba(255,255,255,0.05)', text: 'var(--color-text-ghost)' },
};

export function RedesignRoleBadge({ role }: { role: OrgRole }) {
  const { t } = useI18n();
  const style = ROLE_BADGE_STYLE[role];
  return (
    <span
      style={{
        padding: '1px 7px',
        borderRadius: 4,
        background: style.bg,
        color: style.text,
        fontSize: 10.5,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      {t(`team.role.${role}`)}
    </span>
  );
}

// ── Usage state -> colors ────────────────────────────────────────────

export function usageColor(state: UsageState): string {
  if (state === 'hot') return 'var(--color-danger)';
  if (state === 'warm') return 'var(--color-warning)';
  return 'var(--color-success)';
}

export function usageBorder(state: UsageState): string {
  return state === 'hot' ? 'rgba(248,113,113,0.4)' : 'rgba(255,255,255,0.08)';
}

// ── Budget bar ────────────────────────────────────────────────────

export function BudgetBarTrack({
  pct,
  color,
  height = 7,
}: {
  pct: number;
  color: string;
  height?: number;
}) {
  return (
    <div
      style={{
        height,
        background: 'rgba(255,255,255,0.07)',
        borderRadius: height / 2 + 1,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          height: '100%',
          background: color,
          borderRadius: height / 2 + 1,
        }}
      />
    </div>
  );
}

// ── KPI tile (Solo rail, Lead rail) ──────────────────────────────────

export function KpiTile({
  value,
  label,
  valueColor = 'var(--color-text)',
  onClick,
  testId,
}: {
  value: React.ReactNode;
  label: string;
  valueColor?: string;
  /** B1: when provided, the tile becomes a real button (role, tabIndex,
   *  hover state, Enter/Space activation) — e.g. the Solo view's credits
   *  tile opening the account popover via the shared bus event. */
  onClick?: () => void;
  testId?: string;
}) {
  const [hover, setHover] = useState(false);
  const interactive = !!onClick;

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      onMouseEnter={interactive ? () => setHover(true) : undefined}
      onMouseLeave={interactive ? () => setHover(false) : undefined}
      data-testid={testId}
      style={{
        background: hover ? 'var(--color-panel-3, rgba(255,255,255,0.06))' : 'var(--color-panel-2)',
        border: `1px solid ${hover ? 'rgba(124,92,255,0.35)' : 'var(--color-border)'}`,
        borderRadius: 12,
        padding: 16,
        cursor: interactive ? 'pointer' : 'default',
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      <div style={{ fontSize: 26, fontWeight: 700, color: valueColor, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-muted)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

// ── Card shell (used across Solo/Lead/Member cards) ──────────────────

export function Card({
  children,
  style,
  border = '1px solid var(--color-border)',
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { border?: string }) {
  return (
    <div
      {...rest}
      style={{
        background: 'var(--color-panel)',
        border,
        borderRadius: 13,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
