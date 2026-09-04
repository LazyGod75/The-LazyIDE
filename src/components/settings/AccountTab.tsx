/* AccountTab — Settings > Account (auth, plan, credits, teams CTA).
   Split from SettingsSpace.tsx so each piece stays under the ESLint
   ratchet (complexity 12, 80 lines/function). */

import type { User } from '@supabase/supabase-js';
import { useI18n } from '../../i18n';
import { useAuth } from '../../lib/auth';
import { useSubscriptionContext } from '../../lib/billing';
import type { Subscription } from '../../lib/billing';
import { AuthScreen } from '../auth/AuthScreen';
import { TeamsCtaSection } from '../team/TeamsCtaSection';
import { useActiveTeamContext } from '../../lib/teams/ActiveTeamContext';
import { teamsActive } from '../../lib/features';
import { ACCOUNT_PANEL_STYLE } from './account/accountPanelStyle';
import { AccountFreePlans } from './account/AccountFreePlans';
import { AccountProBilling } from './account/AccountProBilling';
import { AccountUserCard } from './account/AccountUserCard';
import { CreditsUsageBlock } from './account/CreditsUsageBlock';
import { useAccountBilling, type AccountBilling } from './account/useAccountBilling';

export function AccountTab({ initialAuthMode }: { initialAuthMode?: 'signin' | 'signup' }) {
  const { t } = useI18n();
  const { user, loading: authLoading, signOut } = useAuth();
  // BUG-3: shared subscription context — a second useSubscription(user)
  // fetch was the root cause of the header badge going stale vs Compte.
  const { subscription, loading: subLoading, isPro, isProPlus, refresh } = useSubscriptionContext();
  const { hasActiveTeam, refresh: refreshTeam } = useActiveTeamContext();
  const billing = useAccountBilling(signOut);

  if (authLoading) {
    return (
      <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>
        {t('settings.auth.loading')}
      </div>
    );
  }
  if (!user) {
    return (
      <div style={{ padding: '8px 0', display: 'flex', alignItems: 'flex-start' }}>
        <AuthScreen
          key={initialAuthMode ?? 'auth-default'}
          initialMode={initialAuthMode}
          onSkip={() => { /* no-op in settings — user stays on the tab */ }}
        />
      </div>
    );
  }
  return (
    <AccountSignedIn
      user={user}
      subscription={subscription}
      subLoading={subLoading}
      isPro={isPro}
      isProPlus={isProPlus}
      refresh={refresh}
      hasActiveTeam={hasActiveTeam}
      refreshTeam={refreshTeam}
      billing={billing}
    />
  );
}

function AccountSignedIn({
  user,
  subscription,
  subLoading,
  isPro,
  isProPlus,
  refresh,
  hasActiveTeam,
  refreshTeam,
  billing,
}: {
  user: User;
  subscription: Subscription | null;
  subLoading: boolean;
  isPro: boolean;
  isProPlus: boolean;
  refresh: () => void;
  hasActiveTeam: boolean;
  refreshTeam: () => void;
  billing: AccountBilling;
}) {
  const { t } = useI18n();
  const planLabel = isProPlus ? 'Pro+' : isPro ? 'Pro' : 'Free';
  const planColor = isPro ? '#A78BFF' : 'var(--color-text-muted)';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <AccountUserCard
        user={user}
        planLabel={planLabel}
        planColor={planColor}
        subLoading={subLoading}
        onSignOut={billing.handleSignOut}
      />
      <div style={ACCOUNT_PANEL_STYLE}>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
          {t('settings.account.subscription')}
        </div>
        {isPro ? (
          <AccountProBilling isProPlus={isProPlus} subscription={subscription} billing={billing} />
        ) : (
          <AccountFreePlans billing={billing} />
        )}
        <button
          onClick={refresh}
          style={{
            marginTop: 10,
            padding: '4px 8px',
            background: 'transparent',
            border: '1px solid var(--color-border)',
            borderRadius: 5,
            color: 'var(--color-text-muted)',
            fontSize: 11,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {t('common.refresh')}
        </button>
      </div>
      {isPro && subscription && (
        <CreditsUsageBlock subscription={subscription} user={user} />
      )}
      {!teamsActive(hasActiveTeam) && (
        <TeamsCtaSection onCreated={refreshTeam} />
      )}
    </div>
  );
}
