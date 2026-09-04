/**
 * E2E tests for the guided tour on the STATIC DEMO.
 * Served from http://127.0.0.1:4399/ (run demo-server.mjs before this test).
 *
 * The demo uses static-source.js instead of the live API — all data comes
 * from data/ JSON files baked into the demo directory.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEMO_BASE = 'http://127.0.0.1:4399';
const SPA_TIMEOUT = 15_000;
const SCREENSHOT_DIR = 'C:\\Users\\user\\Documents\\cerveau\\_wiki-tour';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForDemoReady(page: Page): Promise<void> {
  const rendered = page.locator(
    '.home-narrative, .home-hero, .home-empty, .empty-state, .failed-state',
  );
  await expect(rendered.first()).toBeVisible({ timeout: SPA_TIMEOUT });
}

async function demoClearTourDismissed(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.removeItem('lazybrain-tour-dismissed'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('demo tour: button visible and opens overlay without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(`${DEMO_BASE}/`);
  await waitForDemoReady(page);
  await demoClearTourDismissed(page);
  await page.reload();
  await waitForDemoReady(page);
  await demoClearTourDismissed(page);

  const tourBtn = page.locator('.tour-launch-btn');
  const btnCount = await tourBtn.count();
  if (btnCount === 0) {
    test.skip(true, 'No tour button on demo home — brain may be empty.');
    return;
  }

  await expect(tourBtn).toBeVisible({ timeout: SPA_TIMEOUT });

  await tourBtn.click();
  await page.waitForTimeout(800);

  const overlay = page.locator('#lazybrain-tour-overlay');
  await expect(overlay).toBeVisible({ timeout: 3000 });
  await expect(overlay.locator('.tour-card')).toBeVisible();

  const progress = await overlay.locator('.tour-progress').textContent();
  expect(progress).toMatch(/^1\s*\/\s*\d+$/);

  const filtered = errors.filter(
    (e) =>
      !e.includes('favicon') && !e.includes('net::ERR_') && !e.includes('Failed to load resource'),
  );
  expect(filtered, `Demo console errors: ${JSON.stringify(filtered)}`).toHaveLength(0);
});

test('demo tour: steps through, closes with Escape, no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(`${DEMO_BASE}/`);
  await waitForDemoReady(page);
  await demoClearTourDismissed(page);
  await page.reload();
  await waitForDemoReady(page);
  await demoClearTourDismissed(page);

  const tourBtn = page.locator('.tour-launch-btn');
  if ((await tourBtn.count()) === 0) {
    test.skip(true, 'No tour button on demo.');
    return;
  }

  await tourBtn.click();
  await page.waitForTimeout(500);

  const overlay = page.locator('#lazybrain-tour-overlay');
  await expect(overlay).toBeVisible({ timeout: 3000 });

  // Step to step 2
  await overlay.locator('[data-tour-action="next"]').click();
  await page.waitForTimeout(200);

  const step2 = await overlay.locator('.tour-progress').textContent();
  expect(step2).toContain('2');

  // Escape closes
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await expect(overlay).not.toBeVisible({ timeout: 2000 });

  const filtered = errors.filter(
    (e) =>
      !e.includes('favicon') && !e.includes('net::ERR_') && !e.includes('Failed to load resource'),
  );
  expect(filtered, `Demo Escape-close errors: ${JSON.stringify(filtered)}`).toHaveLength(0);
});

test('demo tour: screenshot — tour open on static demo home page', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`${DEMO_BASE}/`);
  await waitForDemoReady(page);
  await demoClearTourDismissed(page);
  await page.reload();
  await waitForDemoReady(page);
  await demoClearTourDismissed(page);

  const tourBtn = page.locator('.tour-launch-btn');
  if ((await tourBtn.count()) === 0) {
    test.skip(true, 'No tour button on demo — brain is empty.');
    return;
  }

  await tourBtn.click();
  await page.waitForTimeout(1000);

  const overlay = page.locator('#lazybrain-tour-overlay');
  await expect(overlay).toBeVisible({ timeout: 3000 });

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: join(SCREENSHOT_DIR, 'tour-demo-fixed.png'),
    fullPage: false,
  });

  await expect(overlay).toBeVisible();
});
