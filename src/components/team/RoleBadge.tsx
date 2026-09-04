/* RoleBadge — colored pill for org member and invitation roles. */

import { useI18n } from '../../i18n';

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  'org-admin': { bg: 'rgba(124,92,255,0.15)', text: '#A78BFF' },
  'team-lead':  { bg: 'rgba(246,169,69,0.12)', text: '#F6A945' },
  'member':     { bg: 'rgba(255,255,255,0.05)', text: 'var(--color-text-muted)' },
  'viewer':     { bg: 'rgba(255,255,255,0.03)', text: 'var(--color-text-ghost)' },
};

export function RoleBadge({ role }: { role: string }) {
  const { t } = useI18n();
  const colors = ROLE_COLORS[role] ?? ROLE_COLORS['member'];
  return (
    <span
      style={{
        padding: '2px 8px',
        borderRadius: 99,
        background: colors.bg,
        color: colors.text,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {t(`team.role.${role}`)}
    </span>
  );
}
