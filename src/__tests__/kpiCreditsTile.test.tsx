/* QA fix (B1) — Cockpit KPI "CRÉDITS" tile and Home dashboard credits tile
   are now real clickable controls (role="button", hover state, testid)
   that open the SAME AccountPopover as the header AccountChip (shared
   trigger hook + popover component — see components/account/AccountPopover.tsx).
   Both useSubscriptionContext() and useActiveTeamContext() fall back to a
   safe inert default with no provider mounted, so these render with only
   I18nProvider — same convention as other lightweight component tests in
   this suite (e.g. AppShell.test.tsx's SpaceFallback check).
*/

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui';
import { KpiGroup } from '../components/agents/cockpit/KpiGroup';
import { HomeKpiBar } from '../components/home/HomeKpiBar';
import type { FleetProject } from '../lib/agents/fleetMissions';

// AccountPopover calls useToast() (billing action errors surface via
// toast), so every render needs a real ToastProvider, not just I18nProvider.
function withI18n(children: React.ReactNode) {
  return (
    <I18nProvider>
      <ToastProvider>{children}</ToastProvider>
    </I18nProvider>
  );
}

describe('Cockpit KpiGroup — credits tile (B1)', () => {
  const projects: FleetProject[] = [];

  it('renders the credits tile as a real button with a testid', () => {
    render(withI18n(<KpiGroup projects={projects} pendingDecisions={0} />));

    const tile = screen.getByTestId('cockpit-kpi-credits');
    expect(tile).toHaveAttribute('role', 'button');
    expect(tile).toHaveAttribute('tabIndex', '0');
  });

  it('clicking the credits tile opens the AccountPopover', () => {
    render(withI18n(<KpiGroup projects={projects} pendingDecisions={0} />));

    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('cockpit-kpi-credits'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Enter key activates the tile (keyboard-accessible, not mouse-only)', () => {
    render(withI18n(<KpiGroup projects={projects} pendingDecisions={0} />));

    fireEvent.keyDown(screen.getByTestId('cockpit-kpi-credits'), { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('a second click closes the popover (toggle behavior)', () => {
    render(withI18n(<KpiGroup projects={projects} pendingDecisions={0} />));

    const tile = screen.getByTestId('cockpit-kpi-credits');
    fireEvent.click(tile);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(tile);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('HomeKpiBar — credits tile (B1)', () => {
  it('renders the credits tile as a real button with a testid', () => {
    render(withI18n(<HomeKpiBar />));

    const tile = screen.getByTestId('home-kpi-credits');
    expect(tile).toHaveAttribute('role', 'button');
  });

  it('clicking the credits tile opens the AccountPopover', () => {
    render(withI18n(<HomeKpiBar />));

    fireEvent.click(screen.getByTestId('home-kpi-credits'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
