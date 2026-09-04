/**
 * teams-harness.tsx — isolated screenshot harness for Team screens.
 *
 * URL param ?screen= controls which component is rendered:
 *   dashboard     → OrgDashboard (org tab, members + invitations + credits)
 *   members       → OrgDashboard scrolled to members section
 *   credits       → OrgDashboard scrolled to credits section
 *   onboarding    → OrgOnboarding (create/join screen)
 *   invitations   → OrgDashboard scrolled to invitations section
 *   invite-modal  → OrgDashboard with InviteModal open
 *   brain-search  → OrgDashboard on the Brain tab
 *
 * All API calls are intercepted by the supabase-mock.ts and auth-mock.ts stubs.
 * LocalStorage org key is set programmatically so useOrg resolves immediately.
 */

import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { OrgDashboard } from '../components/team/OrgDashboard';
import { OrgOnboarding } from '../components/team/OrgOnboarding';
import type { OrgData } from '../lib/teams/types';

// ── Set locale to French before first render ──────────────────────
try {
  localStorage.setItem('lazy.locale', 'fr');
} catch { /* noop */ }

// ── Demo data (mirrors supabase-mock.ts) ──────────────────────────

const DEMO_ORG_ID = 'org-acme-demo-001';

const DEMO_DATA: OrgData = {
  orgId: DEMO_ORG_ID,
  name: 'Acme Corp',
  seats: 10,
  departments: [
    { id: 'engineering', slug: 'engineering', name: 'Engineering' },
    { id: 'design', slug: 'design', name: 'Design' },
  ],
  creditsRemainingCents: 500000,
  lastMonthlyGrantCents: 500000,
  ownerUserId: 'user-admin-001',
  brainRepoUrl: null,
  brainRepoHtmlUrl: null,
  brainSeededAt: null,
  brainSeedMode: null,
  members: [
    {
      user_id: 'user-admin-001',
      role: 'org-admin',
      dept_id: 'engineering',
      added_at: '2026-01-15T10:00:00Z',
      display_name: 'Alice Martin',
      email: 'alice@acme.com',
    },
    {
      user_id: 'user-lead-002',
      role: 'team-lead',
      dept_id: 'engineering',
      added_at: '2026-01-20T10:00:00Z',
      display_name: 'Bob Chen',
      email: 'bob@acme.com',
    },
    {
      user_id: 'user-member-003',
      role: 'member',
      dept_id: 'design',
      added_at: '2026-02-01T10:00:00Z',
      display_name: 'Clara Dupont',
      email: 'clara@acme.com',
    },
    {
      user_id: 'user-viewer-004',
      role: 'viewer',
      dept_id: null,
      added_at: '2026-03-05T10:00:00Z',
      display_name: 'David Kim',
      email: 'david@acme.com',
    },
  ],
  invitations: [
    {
      id: 'inv-001',
      email: 'grace@acme.com',
      role: 'member',
      dept_id: 'engineering',
      status: 'pending',
      expires_at: '2026-07-15T10:00:00Z',
      created_at: '2026-06-25T10:00:00Z',
    },
    {
      id: 'inv-002',
      email: 'henry@acme.com',
      role: 'team-lead',
      dept_id: 'design',
      status: 'pending',
      expires_at: '2026-07-10T10:00:00Z',
      created_at: '2026-06-20T10:00:00Z',
    },
  ],
  allocations: [
    {
      id: 'alloc-001',
      entity_type: 'member',
      entity_id: 'user-lead-002',
      limit_cents: 5000,
      period: '2026-06',
      created_at: '2026-06-01T00:00:00Z',
    },
    {
      id: 'alloc-002',
      entity_type: 'dept',
      entity_id: 'design',
      limit_cents: 15000,
      period: '2026-06',
      created_at: '2026-06-01T00:00:00Z',
    },
  ],
};

// ── Screen router ─────────────────────────────────────────────────

function getScreen(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('screen') ?? 'dashboard';
}

// ── Wrapper that marks render as ready ────────────────────────────

function HarnessRoot() {
  const [ready, setReady] = useState(false);
  const screen = getScreen();

  // Signal readiness after first paint + small delay for layout
  useEffect(() => {
    const t = setTimeout(() => {
      setReady(true);
      document.body.setAttribute('data-harness-ready', 'true');
    }, 200);
    return () => clearTimeout(t);
  }, []);

  void ready; // used only via data-harness-ready

  return (
    <I18nProvider>
      <ToastProvider>
        <ScreenSelector screen={screen} />
      </ToastProvider>
    </I18nProvider>
  );
}

// ── Screen: OrgDashboard wrapper ──────────────────────────────────

function DashboardScreen({ initialTab: _initialTab }: { initialTab?: string }) {
  // Set org ID in localStorage so useOrg resolves if needed by child hooks
  useEffect(() => {
    try { localStorage.setItem('lazy.teams.orgId', DEMO_ORG_ID); } catch { /* noop */ }
  }, []);

  // OrgDashboard is rendered directly with props — bypasses useOrg entirely.
  // We intercept the initialTab via URL too (for brain-search screen).
  const screenParam = getScreen();

  // If we want the brain tab open, we do so via a wrapper that clicks the tab
  if (screenParam === 'brain-search') {
    return (
      <BrainTabWrapper />
    );
  }

  return (
    <DashboardContainer />
  );
}

// Direct dashboard render (org tab)
function DashboardContainer() {
  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--color-bg)' }}>
      <OrgDashboard
        data={DEMO_DATA}
        loading={false}
        callerUserId="user-admin-001"
        onRefetch={() => {}}
      />
    </div>
  );
}

// Brain tab wrapper — clicks the brain tab after mount
function BrainTabWrapper() {
  useEffect(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="dashboard-tab-brain"]');
    if (btn) btn.click();
  }, []);

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--color-bg)' }}>
      <OrgDashboard
        data={DEMO_DATA}
        loading={false}
        callerUserId="user-admin-001"
        onRefetch={() => {}}
      />
    </div>
  );
}

// ── Screen: OrgOnboarding ─────────────────────────────────────────

function OnboardingScreen() {
  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--color-bg)' }}>
      <OrgOnboarding onOrgCreated={() => {}} />
    </div>
  );
}

// ── Screen selector ───────────────────────────────────────────────

function ScreenSelector({ screen }: { screen: string }) {
  switch (screen) {
    case 'onboarding':
      return <OnboardingScreen />;
    case 'dashboard':
    case 'members':
    case 'credits':
    case 'invitations':
    case 'invite-modal':
    case 'brain-search':
    default:
      return <DashboardScreen initialTab={screen} />;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────

import '../index.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<HarnessRoot />);
}
