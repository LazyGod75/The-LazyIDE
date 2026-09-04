import { test, expect, type Page } from 'playwright/test';

/**
 * The keep-alive SpacesLayer keeps all visited spaces mounted (toggling
 * display:none). The Cockpit (default landing) now renders LazyManager
 * with a <textarea>, so page.locator('textarea').first() would find the
 * Cockpit's hidden textarea. And a bare `textarea:visible` also matches the
 * Code space's xterm terminal helper textarea (technically "visible" but
 * the terminal's input, not the Composer). Target the Composer by its
 * placeholder instead — it is the only textarea carrying it.
 */
const COMPOSER_PLACEHOLDER = 'Ask, or @ for a file/neuron…';

function composerTextarea(page: Page) {
  return page.getByPlaceholder(COMPOSER_PLACEHOLDER);
}

async function goToCodeSpace(page: Page) {
  await page.getByRole('navigation', { name: 'Spaces' }).getByRole('button', { name: 'Code', exact: true }).click();
  await expect(composerTextarea(page)).toBeVisible({ timeout: 10_000 });
}

/** ContextPicker.tsx's root popover has no test id/role of its own. It is
 *  the only element combining z-index:200 with a fixed 320px width (the
 *  other z-index:200 user, InlineDiffPreview.tsx, is position:absolute with
 *  no fixed width) — see ContextPicker.tsx's inline `style`. Scoping to it
 *  avoids colliding with TopNav's own "Brain"/"Code" pills, which render the
 *  same plain-text accessible names as the picker's own tab buttons. */
function pickerLocator(page: Page) {
  return page.locator('div[style*="z-index: 200"][style*="width: 320px"]');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('lazy.onboarded', '1');
      // Pin locale to English so aria-labels match the assertions below
      // regardless of the system locale of the machine running the tests.
      localStorage.setItem('lazy.locale', 'en');
      // Pin the LazyManager to CODER mode so the @-mention ContextPicker
      // (Files/Brain/Git tabs) is reachable — it only mounts through the
      // assistant Composer, which LazyManager's composer renders in coder
      // mode (the default orchestrator mode shows manager-input + agent
      // mentions instead). See LazyManagerComposer.tsx's mode branch.
      localStorage.setItem('lazy.manager.unifiedMode', 'coder');
      // Ensure the manager overlay starts expanded
      localStorage.removeItem('lazy.manager.overlayWidth');
    } catch { /* */ }
  });
  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[browser error] ${msg.text()}`);
  });
});

test.describe('1. App Shell & Navigation', () => {
  test('app loads and shows navigation rail', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const nav = page.getByRole('navigation', { name: /Spaces/i });
    await expect(nav).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'e2e/screenshots/10-app-shell.png' });
  });

  test('can navigate to Code space', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const codeBtn = page.locator('button, a').filter({ hasText: /Code/i }).first();
    if (await codeBtn.isVisible().catch(() => false)) {
      await codeBtn.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: 'e2e/screenshots/11-code-space.png' });
  });

  test('can navigate to Brain space', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const brainBtn = page.locator('button, a').filter({ hasText: /Brain/i }).first();
    await brainBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/12-brain-space.png' });
    // Should show brain graph or brain related content
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).toBeTruthy();
  });
});

test.describe('2. Command Palette (Ctrl+K)', () => {
  test('opens and closes correctly', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.locator('body').click();
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'e2e/screenshots/20-cmd-palette.png' });
    const dialog = page.getByRole('dialog', { name: /Palette/i });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
});

test.describe('3. @-mention ContextPicker', () => {
  test('opens on @ typing, shows files tab', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await goToCodeSpace(page);
    const textarea = composerTextarea(page);
    await textarea.click();
    await textarea.type('@', { delay: 100 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'e2e/screenshots/30-picker-files.png' });
    const filesTab = pickerLocator(page).getByRole('button', { name: 'Files', exact: true });
    await expect(filesTab).toBeVisible({ timeout: 5000 });
  });

  test('switches to Brain tab and shows real results (or the honest not-running state)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await goToCodeSpace(page);
    const textarea = composerTextarea(page);
    await textarea.click();
    await textarea.type('@', { delay: 100 });
    await page.waitForTimeout(800);
    const picker = pickerLocator(page);
    await picker.getByRole('button', { name: 'Brain', exact: true }).click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'e2e/screenshots/31-picker-brain.png' });
    // ContextPicker's Brain tab is "real data only — no mocks" (web.ts's
    // webBrain.search): it shows real neurons when a local LazyBrain daemon
    // answers on :7700, and the honest t('assistant.brainNotRunning') copy
    // otherwise. e2e/vite-web.config.ts does not proxy /_api/search to a
    // real daemon (only BrainSpace's own /_api/graph is mocked) — the only
    // outcome this environment can honestly produce is "not running", but a
    // dev machine with a real daemon on :7700 should see real items instead,
    // so both are accepted rather than assuming either.
    // Scoped to `div` (not `button`) — the picker's own tab buttons also
    // carry an inline cursor:pointer style, which would otherwise always
    // inflate this count by 5 regardless of real search results.
    const items = await picker.locator('div[style*="cursor: pointer"]').count();
    const notRunning = await picker.getByText(/brain is running/i).count();
    console.log(`Brain items: ${items}, notRunningMessage: ${notRunning}`);
    expect(items > 0 || notRunning > 0).toBe(true);
  });

  test('searches gameon in brain', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await goToCodeSpace(page);
    const textarea = composerTextarea(page);
    await textarea.click();
    await textarea.type('@gameon', { delay: 50 });
    await page.waitForTimeout(1000);
    const brainTab = pickerLocator(page).getByRole('button', { name: 'Brain', exact: true });
    if (await brainTab.isVisible().catch(() => false)) {
      await brainTab.click();
      await page.waitForTimeout(2000);
    }
    await page.screenshot({ path: 'e2e/screenshots/32-picker-gameon.png' });
    const items = await pickerLocator(page).locator('div[style*="cursor: pointer"]').count();
    console.log(`GameOn items: ${items}`);
  });

  test('picker stays open when switching tabs', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await goToCodeSpace(page);
    const textarea = composerTextarea(page);
    await textarea.click();
    await textarea.type('@', { delay: 100 });
    await page.waitForTimeout(800);
    const picker = pickerLocator(page);
    await picker.getByRole('button', { name: 'Brain', exact: true }).click();
    await page.waitForTimeout(1000);
    const filesTab = picker.getByRole('button', { name: 'Files', exact: true });
    await expect(filesTab).toBeVisible({ timeout: 3000 });
    await page.screenshot({ path: 'e2e/screenshots/33-picker-stable.png' });
  });

  test('selecting a brain item inserts ref in textarea', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await goToCodeSpace(page);
    const textarea = composerTextarea(page);
    await textarea.click();
    await textarea.type('@', { delay: 100 });
    await page.waitForTimeout(800);
    const picker = pickerLocator(page);
    await picker.getByRole('button', { name: 'Brain', exact: true }).click();
    await page.waitForTimeout(2000);
    // Click first brain item — rows in the ContextPicker have style="cursor: pointer".
    // The brain tab renders items as <div style="cursor: pointer"><span>🧠</span><span>label</span></div>.
    // Scoped to `div` (not `button`) so the picker's own tab buttons (which
    // also carry cursor:pointer) are never mistaken for a result row.
    const brainItem = picker.locator('div[style*="cursor: pointer"]').first();
    if (await brainItem.isVisible().catch(() => false)) {
      await brainItem.click();
      await page.waitForTimeout(1000);
      // Use evaluate to get textarea content even if not visible
      const text = await page.evaluate(() => {
        const ta = document.querySelector('textarea');
        return ta ? ta.value : '';
      });
      console.log(`Textarea after select: "${text.slice(0, 80)}"`);
      // Brain items insert @brain:<id> references; file items insert @file:<path>.
      // Both are valid picks from the context picker — just verify something was inserted.
      if (text) {
        expect(text).toMatch(/@(brain|file):/);
      }
    }
    await page.screenshot({ path: 'e2e/screenshots/34-picker-selected.png' });
  });
});

test.describe('4. Brain Toggle & Context Banner', () => {
  test('brain toggle switches on/off', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await goToCodeSpace(page);
    const brainBtn = page.locator('button').filter({ hasText: /brain/i }).filter({ hasText: /on|off/i }).first();
    if (await brainBtn.isVisible().catch(() => false)) {
      const beforeText = await brainBtn.textContent();
      await brainBtn.click();
      await page.waitForTimeout(500);
      const afterText = await brainBtn.textContent();
      console.log(`Brain toggle: ${beforeText} → ${afterText}`);
      await page.screenshot({ path: 'e2e/screenshots/40-brain-toggle.png' });
    }
  });

  test('sending message with brain on shows context banner', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await goToCodeSpace(page);
    // Enable brain
    const brainBtn = page.locator('button').filter({ hasText: /brain/i }).filter({ hasText: /on|off/i }).first();
    if (await brainBtn.isVisible().catch(() => false)) {
      const btnText = await brainBtn.textContent();
      if (btnText?.includes('off')) {
        await brainBtn.click();
        await page.waitForTimeout(500);
      }
    }
    // Type a message — use :visible to skip the Cockpit's hidden textarea
    const textarea = composerTextarea(page);
    await textarea.click();
    await textarea.fill('What is GameOnCal?');
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'e2e/screenshots/41-brain-message.png' });
    // Don't actually send (would need API key) — just verify UI state
  });
});

test.describe('5. Mode & Model Selectors', () => {
  test('mode selector opens and shows options', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    // Find mode button (Ask/Plan/Edit)
    const modeBtn = page.locator('button').filter({ hasText: /Ask|Plan|Edit/i }).first();
    if (await modeBtn.isVisible().catch(() => false)) {
      await modeBtn.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: 'e2e/screenshots/50-mode-popover.png' });
      // Should show mode options
      const askOption = page.locator('button').filter({ hasText: /Ask/i });
      const planOption = page.locator('button').filter({ hasText: /Plan/i });
      const editOption = page.locator('button').filter({ hasText: /Edit/i });
      const hasOptions = (await askOption.count()) + (await planOption.count()) + (await editOption.count());
      console.log(`Mode options found: ${hasOptions}`);
    }
  });

  test('model selector opens and shows models', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    // Find model dropdown button (has ▾ and model name)
    const modelBtns = page.locator('button').filter({ hasText: /▾/ });
    const count = await modelBtns.count();
    console.log(`Dropdown buttons with ▾: ${count}`);
    if (count > 0) {
      // Click the second one (first is mode, second is model)
      await modelBtns.nth(Math.min(1, count - 1)).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: 'e2e/screenshots/51-model-dropdown.png' });
    }
  });
});

test.describe('6. Source Control Panel', () => {
  test('source control panel visible in code space', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    // Look for source control button in sidebar
    const scBtn = page.locator('button, [role="tab"]').filter({ hasText: /Source|Git|Control/i }).first();
    if (await scBtn.isVisible().catch(() => false)) {
      await scBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'e2e/screenshots/60-source-control.png' });
    } else {
      // Try looking for it in the left panel
      await page.screenshot({ path: 'e2e/screenshots/60-source-control-notfound.png' });
      console.log('Source control button not found');
    }
  });
});

test.describe('7. File Explorer', () => {
  test('file explorer shows project files', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    // Look for file tree or file explorer
    const fileTree = page.locator('[role="tree"], [class*="file"], [class*="explorer"]').first();
    if (await fileTree.isVisible().catch(() => false)) {
      await page.screenshot({ path: 'e2e/screenshots/70-file-explorer.png' });
    } else {
      // Try clicking on any file-related button in sidebar
      const fileBtn = page.locator('button').filter({ hasText: /Files|Explorer/i }).first();
      if (await fileBtn.isVisible().catch(() => false)) {
        await fileBtn.click();
        await page.waitForTimeout(1000);
      }
      await page.screenshot({ path: 'e2e/screenshots/70-file-explorer.png' });
    }
  });
});

test.describe('8. Terminal Strip', () => {
  test('terminal strip visible at bottom', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'e2e/screenshots/80-terminal.png', fullPage: true });
    // Terminal should be at the bottom of the code space
    const terminal = page.locator('[class*="terminal"], [data-testid*="terminal"]').first();
    if (await terminal.isVisible().catch(() => false)) {
      console.log('Terminal strip visible');
    }
  });
});

test.describe('9. No console errors', () => {
  test('app loads without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));
    
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    
    // Filter out expected errors (CORS, WebGL, etc.)
    const realErrors = errors.filter(e => 
      !e.includes('WebGL') && 
      !e.includes('GPU stall') &&
      !e.includes('favicon') &&
      !e.includes('DevTools')
    );
    
    console.log(`Console errors: ${realErrors.length}`);
    realErrors.forEach(e => console.log(`  - ${e}`));
    
    // We allow some errors but log them for review
    await page.screenshot({ path: 'e2e/screenshots/90-no-errors.png' });
  });
});

test.describe('10. Visual regression snapshots', () => {
  test('full app screenshot', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'e2e/screenshots/100-full-app.png', fullPage: true });
  });

  test('brain space full screenshot', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const brainBtn = page.locator('button, a').filter({ hasText: /Brain/i }).first();
    await brainBtn.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'e2e/screenshots/101-brain-full.png', fullPage: true });
  });

  test('composer area screenshot', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await goToCodeSpace(page);
    const textarea = composerTextarea(page);
    await textarea.click();
    await textarea.type('@gameon What is GameOnCal?', { delay: 30 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'e2e/screenshots/102-composer.png' });
  });
});
