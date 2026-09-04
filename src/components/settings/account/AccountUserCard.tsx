/* Signed-in user chip on Settings > Account. */

import type { User } from '@supabase/supabase-js';
import { useI18n } from '../../../i18n';
import { ACCOUNT_PANEL_STYLE } from './accountPanelStyle';

export function AccountUserCard({
  user,
  planLabel,
  planColor,
  subLoading,
  onSignOut,
}: {
  user: User;
  planLabel: string;
  planColor: string;
  subLoading: boolean;
  onSignOut: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        ...ACCOUNT_PANEL_STYLE,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: '50%',
          background: 'var(--color-accent-soft)',
          border: '1px solid var(--color-accent-border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 15,
          fontWeight: 700,
          color: 'var(--color-accent-light)',
          flexShrink: 0,
        }}
      >
        {user.email?.[0]?.toUpperCase() ?? '?'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text)',
            marginBottom: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {user.email}
        </div>
        <div style={{ fontSize: 11, color: planColor, fontWeight: 500 }}>
          {planLabel}
          {subLoading && ` — ${t('settings.account.loading')}`}
        </div>
      </div>
      <button
        onClick={onSignOut}
        style={{
          padding: '5px 10px',
          background: 'transparent',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          color: 'var(--color-text-muted)',
          fontSize: 11,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {t('settings.account.signOut')}
      </button>
    </div>
  );
}
