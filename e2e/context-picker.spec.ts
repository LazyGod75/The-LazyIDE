import { test, expect, type Page } from 'playwright/test';

/**
 * ContextPicker @-mention tests, rewritten for the 2026-07-11 manager-first
 * redesign (commit 3af8d7b):
 *   - The Composer's <textarea> (src/components/assistant/Composer.tsx) only
 *     mounts inside CodeSpace (via AssistantPanel, CodeSpace.tsx) — the
 *     default landing space is now 'agents' (Cockpit), whose own composer is
 *     an <input> (LazyManagerRail.tsx), not a <textarea>. Every test below
 *     must navigate to the Code pill first.
 *   - TopNav.tsx's segmented pills render plain-text accessible names
 *     ("Brain", "Code", …) with no aria-label — the SAME text the
 *     ContextPicker's own tab buttons use ("Brain", "Files", …). A bare
 *     `page.locator('button').filter({ hasText: /^Brain$/ }).first()` now
 *     matches the NAV PILL first (it precedes the picker in DOM order),
 *     which navigates away from Code entirely instead of switching the
 *     picker's tab. pickerLocator() scopes lookups to the picker itself.
 *   - Locale is pinned to English (matching smoke.spec.ts/onboarding.spec.ts)
 *     so tab labels are deterministic regardless of the host OS locale —
 *     this file previously assumed French ("Fichiers") which only matched on
 *     a French-locale machine, not Playwright's own default (en-US).
 */

const COMPOSER_PLACEHOLDER = 'Ask, or @ for a file/neuron…';

function composerTextarea(page: Page) {
  return page.getByPlaceholder(COMPOSER_PLACEHOLDER);
}

async function goToCodeSpace(page: Page) {
  await page.getByRole('navigation', { name: 'Spaces' }).getByRole('button', { name: 'Code', exact: true }).click();
  // The keep-alive SpacesLayer keeps every space mounted (display:none when
  // inactive), and the Code space's xterm terminal contributes a helper
  // textarea that is technically "visible" — target the Composer by its
  // placeholder instead, so the typing below reaches the real input.
  await expect(composerTextarea(page)).toBeVisible({ timeout: 10_000 });
}

/** ContextPicker.tsx's root popover has no test id/role of its own. It is
 *  the only element combining z-index:200 with a fixed 320px width (the
 *  other z-index:200 user, InlineDiffPreview.tsx, is position:absolute with
 *  no fixed width) — see ContextPicker.tsx's inline `style`. */
function pickerLocator(page: Page) {
  return page.locator('div[style*="z-index: 200"][style*="width: 320px"]');
}

test.describe('ContextPicker @-mention', () => {
  test.beforeEach(async ({ page }) => {
    // Seed localStorage to skip onboarding wizard, and pin locale to English
    // so tab labels are deterministic (see file header).
    await page.addInitScript(() => {
      try {
        localStorage.setItem('lazy.onboarded', '1');
        localStorage.setItem('lazy.locale', 'en');
        // Pin the LazyManager to CODER mode: the @-mention ContextPicker
        // only mounts through the assistant Composer, which LazyManager's
        // composer renders in coder mode. The default (orchestrator) mode
        // renders `manager-input` with an agent-mention list instead, which
        // has no Files/Brain tabs.
        localStorage.setItem('lazy.manager.unifiedMode', 'coder');
        localStorage.removeItem('lazy.manager.overlayWidth');
      } catch { /* ignore */ }
    });
  });

  test('opens picker, switches to Brain tab, shows results', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await goToCodeSpace(page);

    const textarea = composerTextarea(page);

    // Type @ to trigger the picker
    await textarea.click();
    await textarea.type('@', { delay: 100 });
    await page.waitForTimeout(800);

    // Screenshot: picker should be visible
    await page.screenshot({ path: 'e2e/screenshots/01-picker-open.png' });

    // The ContextPicker should be visible — look for the tab buttons inside the picker
    const picker = pickerLocator(page);
    const brainTabInPicker = picker.getByRole('button', { name: 'Brain', exact: true });
    await expect(brainTabInPicker).toBeVisible({ timeout: 5000 });

    // Click on the Brain tab
    await brainTabInPicker.click();
    await page.waitForTimeout(2000);

    // Screenshot: brain tab
    await page.screenshot({ path: 'e2e/screenshots/02-brain-tab.png' });

    // Check for results — look for any clickable item rows in the picker.
    // ContextPicker's Brain tab is "real data only — no mocks" (web.ts) — it
    // only shows neurons when a real LazyBrain daemon answers on :7700, which
    // e2e/vite-web.config.ts does not proxy, so an honest "not running"
    // message is an equally valid outcome here — this test only observes and
    // logs, it does not assert a specific outcome (see full-app.spec.ts for
    // the test that reasons about both branches explicitly).
    // Scoped to `div` (not `button`) — the picker's own tab buttons also
    // carry an inline cursor:pointer style, which would otherwise always
    // inflate this count by 5 regardless of real search results (see
    // ContextRow/allItems.map in ContextPicker.tsx: only real item rows are
    // <div>s).
    const pickerItems = picker.locator('div[style*="cursor: pointer"]');
    const itemCount = await pickerItems.count();
    const noResults = await picker.getByText(/brain is running/i).count();
    const loading = await picker.getByText('Searching brain').count();

    console.log(`Brain: items=${itemCount}, noResults=${noResults}, loading=${loading}`);

    // Close picker with Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Re-focus textarea and type @gameon
    await textarea.click();
    await textarea.fill('');
    await textarea.type('@gameon', { delay: 50 });
    await page.waitForTimeout(2000);

    // Screenshot: gameon search
    await page.screenshot({ path: 'e2e/screenshots/03-gameon-search.png' });

    // Click Brain tab again — scoped to the picker
    const brainTab2 = pickerLocator(page).getByRole('button', { name: 'Brain', exact: true });
    if (await brainTab2.isVisible().catch(() => false)) {
      await brainTab2.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'e2e/screenshots/03b-gameon-brain.png' });
      const gameonItems = await pickerLocator(page).locator('div[style*="cursor: pointer"]').count();
      console.log(`GameOn brain items: ${gameonItems}`);
    }
  });

  test('picker stays stable when switching tabs', async ({ page }) => {
    // Capture console logs
    page.on('console', msg => console.log(`[browser] ${msg.text()}`));

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await goToCodeSpace(page);

    const textarea = composerTextarea(page);
    await textarea.click();
    await textarea.type('@', { delay: 100 });
    await page.waitForTimeout(800);

    // Screenshot on Files tab
    await page.screenshot({ path: 'e2e/screenshots/04a-files-tab.png' });

    // Verify picker is visible on Files tab — scoped to the picker itself
    // (TopNav has no "Files" pill, so this one never collided, but scoping
    // keeps this test consistent with its sibling below).
    const picker = pickerLocator(page);
    const filesTabBtn = picker.getByRole('button', { name: 'Files', exact: true });
    await expect(filesTabBtn).toBeVisible({ timeout: 5000 });
    console.log('Files tab visible');

    // Switch to Brain tab — the picker's own tab, not TopNav's "Brain" pill
    // (both now render the identical plain-text accessible name "Brain").
    const brainTabInPicker = picker.getByRole('button', { name: 'Brain', exact: true });
    console.log('Clicking Brain tab in picker...');
    await brainTabInPicker.click();
    await page.waitForTimeout(1000);

    // Screenshot on Brain tab
    await page.screenshot({ path: 'e2e/screenshots/04b-brain-tab.png' });

    // Check if picker is still visible (Files tab button still in the DOM,
    // just no longer the active tab)
    const filesTabAfter = picker.getByRole('button', { name: 'Files', exact: true });
    const isFilesVisible = await filesTabAfter.isVisible().catch(() => false);
    console.log(`Files tab visible after Brain click: ${isFilesVisible}`);

    // Inspect DOM directly
    const domInfo = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const pickerInfo = buttons
        .filter(b => b.textContent === 'Brain' || b.textContent === 'Files')
        .map(b => ({ text: b.textContent, visible: b.offsetParent !== null, rect: b.getBoundingClientRect() }));
      const ctxBtn = buttons.find(b => b.textContent?.includes('@ ctx'));
      return {
        pickerButtons: pickerInfo,
        ctxBtn: ctxBtn ? { text: ctxBtn.textContent, visible: ctxBtn.offsetParent !== null } : null,
        showContextPicker: (window as any).__showContextPicker,
      };
    });
    console.log(`DOM info: ${JSON.stringify(domInfo, null, 2)}`);

    // If picker closed, take screenshot to see state
    if (!isFilesVisible) {
      await page.screenshot({ path: 'e2e/screenshots/04c-picker-closed.png' });
      console.log('PICKER CLOSED after clicking Brain tab!');
    }

    expect(isFilesVisible).toBe(true);
  });
});
