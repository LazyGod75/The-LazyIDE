/**
 * smoke.spec.ts — Deterministic E2E smoke test for the Lazy IDE shell.
 * Runs against the Vite dev server in web/mock mode (WebPlatform).
 * Tests: shell renders, TopNav pill navigation, command palette open/close.
 *
 * Rewritten for the 2026-07-11 manager-first redesign (commit 3af8d7b):
 * the old left SpacesRail (Home/Code/Agents/Brain/Review buttons) is dead
 * code — navigation is now TopNav.tsx's segmented pill bar (Cockpit/Code/
 * Brain + a settings gear), default landing space is 'agents' (Cockpit),
 * and the nav element's aria-label stays "Spaces" (t('nav.spaces')) with
 * aria-current="page" on whichever pill is active — see TopNav.tsx:92, 166.
 * Home and Review have no header pill anymore (Review's functionality
 * moved into Cockpit decision cards + Code's diff drawer) so their nav
 * assertions are gone, not just renamed.
 *
 * Updated for the Team brain release: the Team pill is LIVE —
 * AppShell.tsx's showTeamTab is hardcoded true and TopNav.tsx's
 * NAV_PILL_ITEMS includes 'team'. Clicking Team navigates to TeamSpace,
 * which renders a role-derived view (Solo when no org membership).
 */

import { test, expect } from 'playwright/test';

test.describe('AppShell smoke', () => {
  test.beforeEach(async ({ page }) => {
    // Seed localStorage before the app loads so the onboarding modal does not appear.
    // Also pin the locale to English so aria-labels match the assertions below
    // regardless of the system locale of the machine running the tests.
    // addInitScript runs in the page context before any scripts execute.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('lazy.onboarded', '1');
        localStorage.setItem('lazy.locale', 'en');
        // Ensure the manager overlay starts expanded — a previous test run
        // may have left it collapsed in localStorage, hiding the textarea.
        localStorage.removeItem('lazy.manager.overlayWidth');
      } catch {
        // localStorage unavailable in this context — ignore.
      }
    });
    await page.goto('/');
  });

  test('top nav is visible with the real pills: Cockpit, Code, Brain + settings gear', async ({ page }) => {
    // aria-label comes from t('nav.spaces'). The app resolves locale from
    // navigator.language at runtime; in Playwright / CI the browser reports
    // English, so the label is 'Spaces' (en).
    const nav = page.getByRole('navigation', { name: 'Spaces' });
    await expect(nav).toBeVisible();

    // Segmented pills rendered as buttons — accessible name comes from
    // their text content (TopNav.tsx's NavPill has no aria-label, just the
    // translated label as a child), one per NAV_PILL_ITEMS entry.
    for (const label of ['Cockpit', 'Code', 'Brain', 'Team']) {
      await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    // The settings gear pill: glyph "⚙" with a title of t('nav.settings').
    await expect(nav.locator('button[title="Settings"]')).toBeVisible();
  });

  test('Cockpit is the default landing space', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Spaces' });
    const cockpitBtn = nav.getByRole('button', { name: 'Cockpit', exact: true });
    await expect(cockpitBtn).toHaveAttribute('aria-current', 'page');

    // No other pill is current. (Team is live — see the Team nav test below.)
    for (const label of ['Code', 'Brain', 'Team']) {
      await expect(nav.getByRole('button', { name: label, exact: true })).not.toHaveAttribute('aria-current', 'page');
    }

    // Something real and stable for the Cockpit/LazyManager rail: the
    // manager order composer (LazyManagerRail.tsx).
    await expect(page.getByPlaceholder('Give the manager an order…')).toBeVisible();
  });

  test('clicking Code switches to the Code space (Composer textarea mounts)', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Spaces' });
    const codeBtn = nav.getByRole('button', { name: 'Code', exact: true });

    await codeBtn.click();

    await expect(codeBtn).toHaveAttribute('aria-current', 'page');
    // CodeSpace renders LazyManager whose composer has a <textarea> with
    // data-testid="manager-input". The keep-alive SpacesLayer keeps the
    // Cockpit's textarea in the DOM but hidden (display:none) — use :visible
    // to match only the CodeSpace's visible textarea.
    await expect(page.locator('textarea:visible').first()).toBeVisible();
  });

  test('clicking Brain switches to the Brain space', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Spaces' });
    const brainBtn = nav.getByRole('button', { name: 'Brain', exact: true });

    await brainBtn.click();

    await expect(brainBtn).toHaveAttribute('aria-current', 'page');
    // "Add neuron" (t('brain.addNeuron')) only renders in BrainSpace.
    await expect(page.getByRole('button', { name: 'Add neuron' })).toBeVisible();
  });

  test('Team nav entry is visible and clicking it switches to the Team space (Solo view)', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Spaces' });
    await expect(nav).toBeVisible();

    // AppShell.tsx's showTeamTab is hardcoded true and TopNav.tsx's
    // NAV_PILL_ITEMS includes 'team' — assert the pill is genuinely
    // present, proving the Team space is reachable.
    const teamBtn = nav.getByRole('button', { name: 'Team', exact: true });
    await expect(teamBtn).toBeVisible();

    await teamBtn.click();

    await expect(teamBtn).toHaveAttribute('aria-current', 'page');
    // TeamSpace renders a role-derived view. With no org membership (the
    // default in the mocked web build), deriveTeamView returns 'solo' and
    // SoloView renders its hero heading (team.redesign.solo.heroLine1).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('clicking the settings gear switches to the Settings space', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Spaces' });
    const gearBtn = nav.locator('button[title="Settings"]');

    await gearBtn.click();

    await expect(gearBtn).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('command palette opens on Ctrl+K and closes on Escape', async ({ page }) => {
    // aria-label comes from t('palette.searchLabel'): 'Command palette search' (en).
    // Palette is not visible initially
    await expect(page.getByRole('dialog', { name: 'Command palette search' })).not.toBeVisible();

    // Ensure the page body has focus before firing keyboard shortcuts
    await page.locator('body').click();

    // Open with Ctrl+K
    await page.keyboard.press('Control+k');

    const dialog = page.getByRole('dialog', { name: 'Command palette search' });
    await expect(dialog).toBeVisible();

    // Input is focused — aria-label also comes from t('palette.searchLabel')
    const input = dialog.getByRole('textbox', { name: 'Command palette search' });
    await expect(input).toBeFocused();

    // Listbox is rendered with results
    await expect(dialog.getByRole('listbox')).toBeVisible();

    // Close with Escape
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('command palette closes when clicking the backdrop', async ({ page }) => {
    await page.locator('body').click();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette search' });
    await expect(dialog).toBeVisible();

    // Click outside the modal (top-left corner of the backdrop)
    await page.mouse.click(10, 10);
    await expect(dialog).not.toBeVisible();
  });

  test('command palette can be opened and closed twice in a row', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Command palette search' });

    // First open: focus body, open via Ctrl+K, close via Escape
    await page.locator('body').click();
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible();
    // Wait for auto-focus (30ms setTimeout in AppShell)
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // Second open: re-focus body, open via Ctrl+K, close via Escape
    await page.locator('body').click();
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
});
