/**
 * manager-mention.spec.ts — E2E smoke test for the @-agent-mention
 * autocomplete popup in the LazyManager orchestrator composer (see
 * AgentMentionPopup.tsx / LazyManagerComposer.tsx). Modeled on
 * orchestrator.spec.ts's own web-mode setup (manager-input is always
 * visible in the right ManagerOverlay, no navigation required).
 *
 * Relies on the built-in ECC agent library (src/lib/agents/eccAgents.ts)
 * being present — it is statically bundled, so the popup is never empty
 * even in this mocked web build with no saved user/project agents.
 */

import { test, expect } from 'playwright/test';

test.setTimeout(120000);

test.describe('LazyManager orchestrator @-agent-mention popup', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('lazy.onboarded', '1');
        localStorage.setItem('lazy.locale', 'en');
      } catch {
        // ignore
      }
    });
    await page.goto('/');
  });

  test('typing "@" opens the popup, narrowing the query filters it, and Enter inserts the mention', async ({ page }) => {
    const input = page.getByTestId('manager-input');
    await expect(input).toBeVisible();

    await input.click();
    await input.type('@', { delay: 50 });

    const popup = page.getByTestId('manager-mention-popup');
    await expect(popup).toBeVisible();

    // At least one built-in ECC agent row renders — the exact set isn't
    // asserted (the library evolves), only that the popup is genuinely
    // populated, not showing the "no agent" empty state.
    const rows = popup.locator('[role="option"]');
    await expect(rows.first()).toBeVisible();
    const initialCount = await rows.count();
    expect(initialCount).toBeGreaterThan(0);

    // Narrow the query — code-reviewer is one of the built-in ECC agents
    // (src/lib/agents/ecc/code-reviewer.ts), so this must resolve to at
    // least that one row and never more than the unfiltered count.
    await input.type('code-review', { delay: 20 });
    await expect(popup).toBeVisible();
    const filteredItem = page.getByTestId('manager-mention-item-code-reviewer');
    await expect(filteredItem).toBeVisible();
    const filteredCount = await rows.count();
    expect(filteredCount).toBeLessThanOrEqual(initialCount);

    // Enter selects the highlighted (first) row and inserts "@<name> ".
    await input.press('Enter');
    await expect(popup).not.toBeVisible();
    await expect(input).toHaveValue(/^@code-reviewer /);
  });
});
