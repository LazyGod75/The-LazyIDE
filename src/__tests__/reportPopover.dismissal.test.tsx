/**
 * reportPopover.dismissal.test.tsx — founder bug fix audit: the "Rapport"
 * rail icon opens its report popover via a real CockpitRailPopover instance
 * owned directly by AgentsSpace.tsx (not one of CockpitLeftRail's own five
 * `openId`-driven icons — see CockpitLeftRail.tsx's header comment), so it
 * needed its own re-click-to-close wiring (AgentsSpace.tsx's
 * `handleOpenReport` + `reportTriggerRef`).
 *
 * Same harness/mocking shape as reportBusDeepLink.test.tsx (Cockpit is
 * stubbed — real rendering needs a full reactflow/canvas test env unrelated
 * to this fix — but AgentsSpace's own state wiring and the REAL
 * CockpitRailPopover it mounts directly are exercised as-is). The stub's
 * trigger button proxies onOpenReport with a real element + rect, exactly
 * like CockpitLeftRail's real "report" icon does, so the same pointerdown/
 * click sequence a real re-click produces can be simulated here.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AgentsUiProvider, AgentsStoreProvider } from '../components/agents';

vi.mock('../app/AppContext', () => {
  const fixture = {
    projectRoot: '/fixtures/demo-project',
    openProjects: [
      { id: 'p1', root: '/fixtures/demo-project', brainId: null, active: true },
    ],
  };
  return {
    useAppContext: () => fixture,
    // P58 fleet hygiene reads AppContext via the SAFE optional variant
    // (agentsStore.tsx's AgentsStoreProvider) — same fixture, the project
    // root here does not match the e2e/soak-scratch naming convention, so
    // the hygiene sweep's project-closure rule is simply a no-op here.
    useAppContextOptional: () => fixture,
  };
});

vi.mock('../components/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents')>();
  return {
    ...actual,
    // Stands in for CockpitLeftRail's real 'report' rail icon: forwards a
    // REAL element + its rect through onOpenReport, same signature the real
    // icon uses (see CockpitLeftRail.tsx's onClick), so re-clicking this
    // stub button reproduces the same pointerdown/click sequence.
    Cockpit: ({ onOpenReport }: { onOpenReport: (anchorRect: DOMRect, triggerEl: HTMLButtonElement) => void }) => (
      <div data-testid="cockpit-stub">
        <button
          data-testid="report-open-trigger"
          onClick={(e) => onOpenReport(e.currentTarget.getBoundingClientRect(), e.currentTarget)}
        >
          report
        </button>
      </div>
    ),
  };
});

vi.mock('../components/agents/library/AgentLibrary', () => ({
  AgentLibrary: () => <div data-testid="library-stub" />,
}));

vi.mock('../components/agents/report', () => ({
  ProjectReportPage: (props: { projectId: string; onClose: () => void }) => (
    <div data-testid="report-page-stub">
      <span data-testid="report-page-project-id">{props.projectId}</span>
      <button data-testid="report-page-close" onClick={props.onClose}>close</button>
    </div>
  ),
}));

// Imported AFTER the mocks above so AgentsSpace picks up the stubbed modules.
import { AgentsSpace } from '../spaces/AgentsSpace';

function renderSpace() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AgentsUiProvider>
          <AgentsStoreProvider>
            <AgentsSpace />
          </AgentsStoreProvider>
        </AgentsUiProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('AgentsSpace — report popover dismissal (founder bug fix)', () => {
  it('opens the real CockpitRailPopover on click', () => {
    renderSpace();
    fireEvent.click(screen.getByTestId('report-open-trigger'));

    const popover = screen.getByTestId('project-report-overlay');
    expect(popover).toBeInTheDocument();
    expect(within(popover).getByTestId('report-page-stub')).toBeInTheDocument();
  });

  it('re-clicking the same rail icon while open closes it (does not reopen)', () => {
    renderSpace();
    const trigger = screen.getByTestId('report-open-trigger');

    fireEvent.click(trigger);
    expect(screen.getByTestId('project-report-overlay')).toBeInTheDocument();

    // Real browsers fire pointerdown before click for a single re-click.
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);

    expect(screen.queryByTestId('project-report-overlay')).not.toBeInTheDocument();
  });

  it('clicking outside the popover closes it', () => {
    renderSpace();
    fireEvent.click(screen.getByTestId('report-open-trigger'));
    expect(screen.getByTestId('project-report-overlay')).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId('project-report-overlay')).not.toBeInTheDocument();
  });

  it('pressing Escape closes it', () => {
    renderSpace();
    fireEvent.click(screen.getByTestId('report-open-trigger'));
    expect(screen.getByTestId('project-report-overlay')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('project-report-overlay')).not.toBeInTheDocument();
  });
});
