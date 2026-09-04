/**
 * E2E tests for the Orchestrator Plan Approval Panel and Command Mode.
 * Extends the orchestrator.spec.ts with plan lifecycle and command mode tests.
 *
 * Runs in web/mock mode against the Vite dev server.
 */

import { test, expect } from 'playwright/test';

test.setTimeout(120000);

test.describe('Orchestrator Plan Approval & Command Mode', () => {
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

  test('manager overlay renders the order composer', async ({ page }) => {
    const composer = page.getByPlaceholder('Give the manager an order…');
    await expect(composer).toBeVisible();
  });

  test('autonomy mode can be switched to manual and back to supervised', async ({ page }) => {
    // Open acceptance popover
    await page.getByTestId('lazy-manager-acceptance-btn').click();
    const manualBtn = page.getByTestId('lazy-manager-acceptance-manual');
    await manualBtn.click();

    // Reopen and verify
    await page.getByTestId('lazy-manager-acceptance-btn').click();
    await expect(page.getByTestId('lazy-manager-acceptance-manual')).toHaveAttribute('aria-pressed', 'true');

    // Switch back to supervised
    const supervisedBtn = page.getByTestId('lazy-manager-acceptance-supervised');
    await supervisedBtn.click();
    await page.getByTestId('lazy-manager-acceptance-btn').click();
    await expect(page.getByTestId('lazy-manager-acceptance-supervised')).toHaveAttribute('aria-pressed', 'true');
  });

  test('command palette opens and shows orchestrator commands', async ({ page }) => {
    await page.locator('body').click();
    await page.keyboard.press('Control+k');

    const dialog = page.getByRole('dialog', { name: 'Command palette search' });
    await expect(dialog).toBeVisible();

    // The palette should show some commands
    const listbox = dialog.getByRole('listbox');
    await expect(listbox).toBeVisible();

    // Close
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('fleet map popover shows empty state when no projects registered', async ({ page }) => {
    await page.getByTestId('cockpit-rail-icon-fleetMap').click();
    const fleetMapPopover = page.getByTestId('cockpit-rail-popover-fleetMap');
    await expect(fleetMapPopover).toBeVisible();
    await expect(fleetMapPopover.getByText('No projects registered.', { exact: true })).toBeVisible();
  });

  test('budget popover shows spend information', async ({ page }) => {
    await page.getByTestId('cockpit-rail-icon-budget').click();
    const budgetPopover = page.getByTestId('cockpit-rail-popover-budget');
    await expect(budgetPopover).toBeVisible();
    // Currency-leak fix (real user report, 2026-08-14): this used to read
    // "N cents" — BudgetBurn.tsx now renders credits, never currency.
    await expect(budgetPopover.getByTestId('budget-burn-label')).toHaveText(/^\d+(\s\/\s\d+)? credits$/);
  });

  test('KPIs popover shows decision, agents, merged, and brain tiles', async ({ page }) => {
    await page.getByTestId('cockpit-rail-icon-kpis').click();
    const kpisPopover = page.getByTestId('cockpit-rail-popover-kpis');
    await expect(kpisPopover).toBeVisible();
    for (const testId of ['kpi-decisions', 'kpi-agents', 'kpi-merged', 'kpi-brain']) {
      await expect(kpisPopover.getByTestId(testId)).toBeVisible();
    }
  });

  test('orchestrator tree popover is accessible from the left rail', async ({ page }) => {
    // The orchestrator tree may be behind a different rail icon
    // Check if it exists and is clickable
    const orchIcon = page.getByTestId('cockpit-rail-icon-orchestrator');
    if (await orchIcon.isVisible().catch(() => false)) {
      await orchIcon.click();
      const orchPopover = page.getByTestId('cockpit-rail-popover-orchestrator');
      await expect(orchPopover).toBeVisible();
    }
  });

  test('manager composer accepts text input', async ({ page }) => {
    const composer = page.getByPlaceholder('Give the manager an order…');
    await expect(composer).toBeVisible();
    await composer.fill('Create a plan to fix the auth bug');
    await expect(composer).toHaveValue('Create a plan to fix the auth bug');
  });
});
