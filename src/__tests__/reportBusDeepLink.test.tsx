/* reportBusDeepLink.test.tsx — Agent Canvas W8e integration test for
   AgentsSpace.tsx's Rapport wiring:
     - the "report-open-trigger" button opens the ProjectReportPage overlay
       for the active project,
     - the 'report:open' bus event (lib/bus.ts) opens it too — with no
       payload (active project) or a specific projectId (deep link),
     - closing it (ProjectReportPage's onClose) tears the overlay down.

   Cockpit/AgentLibrary/ProjectReportPage are stubbed — this test exercises
   ONLY AgentsSpace.tsx's own state/bus wiring, not those components' own
   rendering (Cockpit needs a full reactflow/canvas test env unrelated to
   this wave; ProjectReportPage's own rendering is covered by
   ProjectReportPage.test.tsx).

   W-CHROME: the real "report-open-trigger" button used to live in
   AgentsSpace.tsx's own JSX (a standalone header row). It has since moved
   INSIDE Cockpit — CockpitLeftRail's 'report' round icon, which calls the
   onOpenReport prop AgentsSpace now passes down (see Cockpit.tsx/
   CockpitLeftRail.tsx). Since Cockpit is stubbed here (by design, see
   above), the stub below takes over rendering that trigger from the real
   onOpenReport prop it receives — same testid, same click -> same
   AgentsSpace state change this file has always asserted; only the real
   button's location moved, not what this integration test proves.
*/

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { AgentsUiProvider, AgentsStoreProvider } from '../components/agents';
import { emit } from '../lib/bus';

vi.mock('../app/AppContext', () => {
  const fixture = {
    projectRoot: '/fixtures/demo-project',
    openProjects: [
      { id: 'p1', root: '/fixtures/demo-project', brainId: null, active: true },
      { id: 'p2', root: '/fixtures/other-project', brainId: null, active: false },
    ],
  };
  return {
    useAppContext: () => fixture,
    // P58 fleet hygiene reads AppContext via the SAFE optional variant
    // (agentsStore.tsx's AgentsStoreProvider) — same fixture, neither
    // project root here matches the e2e/soak-scratch naming convention, so
    // the hygiene sweep's project-closure rule is simply a no-op here.
    useAppContextOptional: () => fixture,
  };
});

vi.mock('../components/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents')>();
  return {
    ...actual,
    // W-CHROME: proxies the real onOpenReport prop AgentsSpace.tsx passes,
    // standing in for CockpitLeftRail's real 'report' rail icon (see this
    // file's header comment) — same testid/click contract this suite has
    // always exercised. W-PARCHEMIN: onOpenReport now takes the clicked
    // icon's anchor rect (to position the report popover) — a fixed stub
    // rect stands in for the real el.getBoundingClientRect() here, since
    // this suite only asserts AgentsSpace's own reportProjectId/bus wiring,
    // not the popover's real positioning math.
    Cockpit: ({ onOpenReport }: { onOpenReport: (anchorRect: { top: number; bottom: number; left: number; right: number }) => void }) => (
      <div data-testid="cockpit-stub">
        <button
          data-testid="report-open-trigger"
          onClick={() => onOpenReport({ top: 0, bottom: 0, left: 0, right: 0 })}
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
      <button data-testid="report-page-close" onClick={props.onClose}>
        close
      </button>
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

const ACTIVE_PROJECT_ID = '/fixtures/demo-project';
const OTHER_PROJECT_ID = '/fixtures/other-project';

describe('AgentsSpace — Rapport overlay wiring (W8e)', () => {
  it('is closed by default', () => {
    renderSpace();
    expect(screen.queryByTestId('report-page-stub')).not.toBeInTheDocument();
  });

  // W-CHROME: the old "report-trigger-bar" strip — a standalone row below
  // TopNav existing ONLY to host this button — is gone; the real trigger
  // now lives INSIDE Cockpit (CockpitLeftRail's 'report' round icon, see
  // this file's header comment), so it must render as a descendant of the
  // cockpit stub, not as a sibling row above it.
  it('no longer renders the old standalone "report-trigger-bar" header row', () => {
    renderSpace();
    expect(screen.queryByTestId('report-trigger-bar')).not.toBeInTheDocument();
    const stub = screen.getByTestId('cockpit-stub');
    expect(within(stub).getByTestId('report-open-trigger')).toBeInTheDocument();
  });

  it('the "report-open-trigger" button opens the overlay for the active project', () => {
    renderSpace();
    fireEvent.click(screen.getByTestId('report-open-trigger'));

    const stub = screen.getByTestId('report-page-stub');
    expect(within(stub).getByTestId('report-page-project-id')).toHaveTextContent(ACTIVE_PROJECT_ID);
  });

  it('the report:open bus event with no payload opens the overlay for the active project', () => {
    renderSpace();
    act(() => emit('report:open', {}));

    const stub = screen.getByTestId('report-page-stub');
    expect(within(stub).getByTestId('report-page-project-id')).toHaveTextContent(ACTIVE_PROJECT_ID);
  });

  it('the report:open bus event with an explicit projectId deep-links to that project', () => {
    renderSpace();
    act(() => emit('report:open', { projectId: OTHER_PROJECT_ID }));

    const stub = screen.getByTestId('report-page-stub');
    expect(within(stub).getByTestId('report-page-project-id')).toHaveTextContent(OTHER_PROJECT_ID);
  });

  it('closing the report page (onClose) tears the overlay down', () => {
    renderSpace();
    fireEvent.click(screen.getByTestId('report-open-trigger'));
    expect(screen.getByTestId('report-page-stub')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('report-page-close'));
    expect(screen.queryByTestId('report-page-stub')).not.toBeInTheDocument();
  });
});
