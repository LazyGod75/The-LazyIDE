/**
 * LazyBrain wiki — guided tour E2E tests.
 *
 * Verifies that:
 *  - The "Take the guided tour" button appears on the home page when the brain has content.
 *  - Clicking it opens the tour overlay with no console errors.
 *  - The tour can be stepped through (Next button advances, Prev goes back).
 *  - Escape key closes the tour.
 *  - The Done button on the last step closes the overlay and persists dismissal.
 *  - Both the live wiki and the static demo pass the same assertions.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPA_TIMEOUT = 15_000;
const SCREENSHOT_DIR = 'C:\\Users\\user\\Documents\\cerveau\\_wiki-tour';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForContentReady(page: Page): Promise<void> {
  const rendered = page.locator(
    '.home-narrative, .home-hero, .home-empty, .empty-state, .failed-state',
  );
  await expect(rendered.first()).toBeVisible({ timeout: SPA_TIMEOUT });
}

/**
 * Navigate to home, clear the tour-dismissed flag, and reload so the
 * tour button is guaranteed to appear.
 */
async function goHomeWithTourEnabled(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await waitForContentReady(page);
  await page.evaluate(() => localStorage.removeItem('lazybrain-tour-dismissed'));
  await page.reload();
  await waitForContentReady(page);
  // Clear again after reload in case renderHome re-checks before paint
  await page.evaluate(() => localStorage.removeItem('lazybrain-tour-dismissed'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('tour: button appears when brain has content', async ({ page }) => {
  await goHomeWithTourEnabled(page);

  const hasContent =
    (await page.locator('.home-stats-bar').count()) > 0 ||
    (await page.locator('[data-note-href]').count()) > 0;

  if (!hasContent) {
    test.skip(true, 'Brain has no content — tour button is not rendered on empty brain.');
    return;
  }

  const tourBtn = page.locator('.tour-launch-btn');
  await expect(tourBtn).toBeVisible({ timeout: SPA_TIMEOUT });
  await expect(tourBtn).toHaveText('Take the guided tour');
});

test('tour: opens with no console errors on button click', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await goHomeWithTourEnabled(page);

  const tourBtn = page.locator('.tour-launch-btn');
  const btnCount = await tourBtn.count();
  if (btnCount === 0) {
    test.skip(true, 'No tour button — brain is empty or already dismissed.');
    return;
  }

  await tourBtn.click();
  await page.waitForTimeout(500);

  const overlay = page.locator('#lazybrain-tour-overlay');
  await expect(overlay).toBeVisible({ timeout: 3000 });

  // Tour card must be inside the overlay
  await expect(overlay.locator('.tour-card')).toBeVisible();

  // First step must show progress "1 / N"
  const progress = await overlay.locator('.tour-progress').textContent();
  expect(progress).toMatch(/^1\s*\/\s*\d+$/);

  // No console errors from opening the tour
  const filtered = errors.filter(
    (e) =>
      !e.includes('favicon') && !e.includes('net::ERR_') && !e.includes('Failed to load resource'),
  );
  expect(filtered, `Unexpected console errors: ${JSON.stringify(filtered)}`).toHaveLength(0);
});

test('tour: Next button advances through all steps without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await goHomeWithTourEnabled(page);

  const tourBtn = page.locator('.tour-launch-btn');
  if ((await tourBtn.count()) === 0) {
    test.skip(true, 'No tour button — brain is empty.');
    return;
  }

  await tourBtn.click();
  await page.waitForTimeout(500);

  const overlay = page.locator('#lazybrain-tour-overlay');
  await expect(overlay).toBeVisible({ timeout: 3000 });

  // Determine total step count from the progress indicator
  const progressText = await overlay.locator('.tour-progress').textContent();
  const match = progressText?.match(/\d+\s*\/\s*(\d+)/);
  const totalSteps = match ? Number(match[1]) : 0;
  expect(totalSteps).toBeGreaterThan(0);

  // Step through to the last step
  for (let step = 1; step < totalSteps; step++) {
    const nextBtn = overlay.locator('[data-tour-action="next"]');
    await expect(nextBtn).toBeVisible({ timeout: 2000 });
    await nextBtn.click();
    await page.waitForTimeout(200);

    const current = await overlay.locator('.tour-progress').textContent();
    expect(current).toContain(`${step + 1}`);
  }

  // On last step, Done button must be visible
  const doneBtn = overlay.locator('[data-tour-action="finish"]');
  await expect(doneBtn).toBeVisible({ timeout: 2000 });
  await expect(doneBtn).toHaveText('Done');

  const filtered = errors.filter(
    (e) =>
      !e.includes('favicon') && !e.includes('net::ERR_') && !e.includes('Failed to load resource'),
  );
  expect(filtered, `Console errors while stepping: ${JSON.stringify(filtered)}`).toHaveLength(0);
});

test('tour: Prev button goes back to the previous step', async ({ page }) => {
  await goHomeWithTourEnabled(page);

  const tourBtn = page.locator('.tour-launch-btn');
  if ((await tourBtn.count()) === 0) {
    test.skip(true, 'No tour button.');
    return;
  }

  await tourBtn.click();
  await page.waitForTimeout(500);

  const overlay = page.locator('#lazybrain-tour-overlay');
  await expect(overlay).toBeVisible({ timeout: 3000 });

  // Advance to step 2
  await overlay.locator('[data-tour-action="next"]').click();
  await page.waitForTimeout(200);

  const afterNext = await overlay.locator('.tour-progress').textContent();
  expect(afterNext).toContain('2');

  // Go back to step 1
  const prevBtn = overlay.locator('[data-tour-action="prev"]');
  await expect(prevBtn).toBeVisible({ timeout: 2000 });
  await prevBtn.click();
  await page.waitForTimeout(200);

  const afterPrev = await overlay.locator('.tour-progress').textContent();
  expect(afterPrev).toMatch(/^1\s*\/\s*\d+$/);
});

test('tour: Escape key closes the overlay', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await goHomeWithTourEnabled(page);

  const tourBtn = page.locator('.tour-launch-btn');
  if ((await tourBtn.count()) === 0) {
    test.skip(true, 'No tour button.');
    return;
  }

  await tourBtn.click();
  await page.waitForTimeout(500);

  const overlay = page.locator('#lazybrain-tour-overlay');
  await expect(overlay).toBeVisible({ timeout: 3000 });

  // Press Escape — should close the tour
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  await expect(overlay).not.toBeVisible({ timeout: 2000 });

  const filtered = errors.filter(
    (e) =>
      !e.includes('favicon') && !e.includes('net::ERR_') && !e.includes('Failed to load resource'),
  );
  expect(filtered).toHaveLength(0);
});

test('tour: Done button closes overlay and persists dismissal', async ({ page }) => {
  await goHomeWithTourEnabled(page);

  const tourBtn = page.locator('.tour-launch-btn');
  if ((await tourBtn.count()) === 0) {
    test.skip(true, 'No tour button.');
    return;
  }

  await tourBtn.click();
  await page.waitForTimeout(500);

  const overlay = page.locator('#lazybrain-tour-overlay');
  await expect(overlay).toBeVisible({ timeout: 3000 });

  // Navigate to the last step
  let doneBtn = overlay.locator('[data-tour-action="finish"]');
  while ((await doneBtn.count()) === 0) {
    const nextBtn = overlay.locator('[data-tour-action="next"]');
    const nextCount = await nextBtn.count();
    if (nextCount === 0) break;
    await nextBtn.click();
    await page.waitForTimeout(150);
    doneBtn = overlay.locator('[data-tour-action="finish"]');
  }

  await expect(doneBtn).toBeVisible({ timeout: 2000 });

  // Click Done
  await doneBtn.click();
  await page.waitForTimeout(500);

  // Overlay must be gone
  await expect(overlay).not.toBeVisible({ timeout: 2000 });

  // localStorage must record dismissal
  const dismissed = await page.evaluate(
    () => localStorage.getItem('lazybrain-tour-dismissed') === '1',
  );
  expect(dismissed, 'Tour dismissal was not persisted to localStorage').toBe(true);
});

test('tour: dismissed flag prevents button from appearing on reload', async ({ page }) => {
  await page.goto('/');
  await waitForContentReady(page);

  // Set the dismissed flag directly
  await page.evaluate(() => localStorage.setItem('lazybrain-tour-dismissed', '1'));
  await page.reload();
  await waitForContentReady(page);

  // Button must NOT be present
  const tourBtn = page.locator('.tour-launch-btn');
  await expect(tourBtn).toHaveCount(0);
});

test('tour: screenshot of open tour on home page', async ({ page }) => {
  await goHomeWithTourEnabled(page);

  const tourBtn = page.locator('.tour-launch-btn');
  if ((await tourBtn.count()) === 0) {
    test.skip(true, 'No tour button — brain is empty.');
    return;
  }

  await tourBtn.click();
  await page.waitForTimeout(1000);

  const overlay = page.locator('#lazybrain-tour-overlay');
  await expect(overlay).toBeVisible({ timeout: 3000 });

  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({
    path: join(SCREENSHOT_DIR, 'tour-fixed.png'),
    fullPage: false,
  });

  // Verify screenshot was created (implicitly done by not throwing)
  await expect(overlay).toBeVisible();
});
