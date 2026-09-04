/* TeamSpace — role-derived Team page (redesign, wave2/team).

   4 mutually-exclusive viewpoints (design-team.md §0): Solo / Lead / Member
   / Multi-team, picked by deriveTeamView() (src/lib/teams/roleView.ts) from
   the signed-in user's REAL org membership(s) — never a user-facing toggle,
   in production or otherwise.

   Loading/error/no-org handling: useOrg() still drives the active org's
   data fetch exactly as before; the "no org" case now renders the richer
   SoloView instead of the old interstitial OrgOnboarding (whose create/join
   logic is reused by SoloView's modals, not deleted).
*/

import { useEffect } from 'react';
import { useOrg } from '../lib/teams/useOrg';
import { useOrgMemberships } from '../lib/teams/useOrgMemberships';
import { useOrgUsageSummary } from '../lib/teams/useOrgUsageSummary';
import { deriveTeamView } from '../lib/teams/roleView';
import { SoloView } from '../components/team/redesign/SoloView';
import { LeadView } from '../components/team/redesign/LeadView';
import { MemberView } from '../components/team/redesign/MemberView';
import { MultiTeamView } from '../components/team/redesign/MultiTeamView';
import { Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useI18n } from '../i18n';

// ── Loading / error screens (unchanged shape from the pre-redesign space) ──

function LoadingScreen() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg)' }}>
      <Spinner size={28} />
    </div>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 32,
        background: 'var(--color-bg)',
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 22,
          color: '#FCA5A5',
        }}
      >
        !
      </div>
      <div style={{ textAlign: 'center' }}>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>{t('team.error.title')}</p>
        <p style={{ margin: '6px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.28)', maxWidth: 320 }}>{message}</p>
      </div>
      <button
        onClick={onRetry}
        style={{
          padding: '8px 20px',
          borderRadius: 8,
          border: '1px solid rgba(124,92,255,0.4)',
          background: 'rgba(124,92,255,0.12)',
          color: '#C4B5FD',
          fontSize: 13,
          fontWeight: 500,
          fontFamily: 'inherit',
          cursor: 'pointer',
        }}
      >
        {t('team.error.retry')}
      </button>
    </div>
  );
}

// ── TeamSpace ─────────────────────────────────────────────────────

export function TeamSpace() {
  const { user } = useAuth();
  const callerUserId = user?.id ?? '';
  const { orgId, data, loading, error, refetch, setOrgId, clearActiveOrg } = useOrg();
  const { memberships, loading: membershipsLoading, refresh: refreshMemberships } = useOrgMemberships(user?.id ?? null);
  const usageSummary = useOrgUsageSummary(orgId);

  // B26: after the caller leaves or deletes the active org, drop the local
  // "active org" pointer and re-list memberships so the viewpoint re-derives
  // (falls back to Solo, or to another org if the caller belongs to one).
  function handleLeftOrg() {
    clearActiveOrg();
    refreshMemberships();
  }

  // Reconcile: if this device has no stored "active org" pointer but the
  // user is (now) a member of exactly one org — e.g. first login elsewhere,
  // or the org was just created by SoloView — adopt it automatically so
  // returning users land on Lead/Member, not a stale Solo view.
  useEffect(() => {
    if (!orgId && memberships.length === 1) {
      setOrgId(memberships[0].orgId);
    }
  }, [orgId, memberships, setOrgId]);

  const orgCount = memberships.length;
  const realRole = orgId && data ? data.members.find((m) => m.user_id === callerUserId)?.role ?? null : null;
  const view = deriveTeamView(realRole, orgCount);

  // `view` is derived from realRole (needs `data`) and orgCount (needs
  // `memberships`) — both default to their "empty" value (null / 0) while
  // unresolved, which is indistinguishable from a genuinely Solo user.
  // Rendering off either unresolved default is what flashed the "no team"
  // empty state for ~0.2s before a real member's data landed: this used to
  // only gate on `!orgId`, so a cached `orgId` from a previous session (the
  // common case for an established member) skipped straight past it even
  // though `data` for that org hadn't loaded yet. Gate on BOTH signals —
  // memberships still loading, OR a known org whose data/error hasn't
  // settled yet.
  // Unsigned: a leftover lazy.teams.orgId in localStorage must not stall
  // SoloView while useOrg waits on a session that does not exist (measured
  // 2026-08-28: Team tab spinner ~4s in the browser with no login).
  if (user && (membershipsLoading || (orgId && !data && !error))) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        <LoadingScreen />
      </div>
    );
  }

  // Multi-team never needs the active org's full data — render as soon as
  // memberships have resolved >1, independent of useOrg's loading state.
  if (view === 'multi') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, background: 'var(--color-bg)' }}>
        <MultiTeamView memberships={memberships} onSwitchOrg={setOrgId} />
      </div>
    );
  }

  // Solo: no org data required at all.
  if (view === 'solo') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, background: 'var(--color-bg)' }}>
        <SoloView onOrgReady={setOrgId} />
      </div>
    );
  }

  // Lead / Member both need the active org's data loaded.
  if (loading && !data) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        <LoadingScreen />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        <ErrorScreen message={error} onRetry={refetch} />
      </div>
    );
  }

  if (!data) {
    // Real role/orgCount resolved to 'lead'/'member' but the active org's
    // data hasn't landed yet (and isn't loading/erroring) — fall back to
    // Solo rather than rendering an empty shell.
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, background: 'var(--color-bg)' }}>
        <SoloView onOrgReady={setOrgId} />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, background: 'var(--color-bg)' }}>
      {view === 'lead' ? (
        <LeadView data={data} usageRows={usageSummary.rows} callerUserId={callerUserId} onRefetch={refetch} onLeftOrg={handleLeftOrg} />
      ) : (
        <MemberView data={data} callerUserId={callerUserId} usageRows={usageSummary.rows} onLeftOrg={handleLeftOrg} />
      )}
    </div>
  );
}
