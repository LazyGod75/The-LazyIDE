/**
 * orchestrator.spec.ts — E2E smoke test for the LazyManager Orchestrator
 * Command & Control rail (Pillar E). Runs in web/mock mode.
 *
 * Updated for the ManagerOverlay redesign: autonomy control moved from
 * ManagerAutonomyBar (always-visible buttons in the overlay) to
 * LazyManagerHeader's Acceptation popover (click to open, then select
 * mode). The popover button has data-testid="lazy-manager-acceptance-btn"
 * and each mode button has data-testid="lazy-manager-acceptance-{mode}"
 * with aria-pressed reflecting the active mode. Fleet Map and Budget
 * remain in CockpitLeftRail popovers.
 */

import { test, expect } from 'playwright/test';

test.setTimeout(120000);

test.describe('Orchestrator Command & Control', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('lazy.onboarded', '1');
        localStorage.setItem('lazy.locale', 'en');
        localStorage.removeItem('lazy.manager.overlayWidth');
      } catch {
        // ignore
      }
    });
    await page.goto('/');
  });

  test('renders the autonomy control in the manager overlay, and Fleet Map / Budget / KPIs via the left rail popovers', async ({ page }) => {
    // Autonomy control — behind the Acceptation popover in the manager header.
    const acceptanceBtn = page.getByTestId('lazy-manager-acceptance-btn');
    await expect(acceptanceBtn).toBeVisible();
    await acceptanceBtn.click();
    const acceptancePopover = page.getByTestId('lazy-manager-acceptance-popover');
    await expect(acceptancePopover).toBeVisible();
    for (const mode of ['manual', 'supervised', 'yolo', 'custom']) {
      await expect(page.getByTestId(`lazy-manager-acceptance-${mode}`)).toBeVisible();
    }

    // Fleet Map — behind the left rail's 'fleetMap' popover.
    await page.getByTestId('cockpit-rail-icon-fleetMap').click();
    const fleetMapPopover = page.getByTestId('cockpit-rail-popover-fleetMap');
    await expect(fleetMapPopover).toBeVisible();
    // FleetMap.tsx renders no heading of its own (duplicate-heading fix —
    // see its own doc comment: "the popover chrome IS the heading"), so the
    // dialog's own aria-label (CockpitRailPopover's `title` prop) is the
    // only "Fleet Map" text — assert it there, plus the real empty-state
    // content underneath.
    await expect(fleetMapPopover).toHaveAttribute('aria-label', 'Fleet Map');
    await expect(fleetMapPopover.getByText('No projects registered.', { exact: true })).toBeVisible();

    // Budget — behind the left rail's 'budget' popover (only one popover open at a time).
    await page.getByTestId('cockpit-rail-icon-budget').click();
    const budgetPopover = page.getByTestId('cockpit-rail-popover-budget');
    await expect(budgetPopover).toBeVisible();
    // BudgetBurn.tsx no longer renders its own "Budget" label (duplicate-
    // heading fix, real user report 2026-08-14 — the popover title bar
    // already reads "Budget") — assert its real content, the credits spend
    // line (currency-leak fix, same report: this used to read "N cents").
    await expect(budgetPopover.getByTestId('budget-burn-label')).toHaveText(/^\d+(\s\/\s\d+)? credits$/);
    await expect(fleetMapPopover).not.toBeVisible();

    // KPIs — replaces the old "Live Feed" assertion: the kpis popover now
    // shows the real KPI tiles instead, and Live Feed has no mount point
    // left anywhere in the cockpit (see this file's header comment).
    await page.getByTestId('cockpit-rail-icon-kpis').click();
    const kpisPopover = page.getByTestId('cockpit-rail-popover-kpis');
    await expect(kpisPopover).toBeVisible();
    for (const testId of ['kpi-decisions', 'kpi-agents', 'kpi-merged', 'kpi-brain']) {
      await expect(kpisPopover.getByTestId(testId)).toBeVisible();
    }
    await expect(page.getByText('Live Feed', { exact: true })).toHaveCount(0);
  });

  test('switching autonomy mode updates the active button', async ({ page }) => {
    // Open the Acceptation popover first
    await page.getByTestId('lazy-manager-acceptance-btn').click();
    const yoloBtn = page.getByTestId('lazy-manager-acceptance-yolo');
    const manualBtn = page.getByTestId('lazy-manager-acceptance-manual');

    await yoloBtn.click();
    // Popover closes on selection — reopen to verify state
    await page.getByTestId('lazy-manager-acceptance-btn').click();
    await expect(page.getByTestId('lazy-manager-acceptance-yolo')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('lazy-manager-acceptance-manual')).toHaveAttribute('aria-pressed', 'false');
  });
});
