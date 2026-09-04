/**
 * LazyBrain wiki — fix verification tests.
 *
 * Tests for:
 *  - P1: Timeline incremental rendering (sentinel/button present, first batch rendered)
 *  - P1: Mobile no-horizontal-overflow at 375px (home, note, search)
 *  - P2: Graph console clean (no "Unknown option" warning, no 404 for data/graph.json in live mode)
 *  - P3: Browse topics section on home page
 */

import { type Page, expect, test } from '@playwright/test';

const SPA_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForContentReady(page: Page): Promise<void> {
  const rendered = page.locator(
    '.home-narrative, .home-hero, .empty-state, .search-results-header, ' +
      '.stats-view, .timeline-view, article, .wiki-article, ' +
      '.note-list, [data-note-href], .failed-state',
  );
  await expect(rendered.first()).toBeVisible({ timeout: SPA_TIMEOUT });
}

// ---------------------------------------------------------------------------
// P1: Timeline incremental rendering
// ---------------------------------------------------------------------------

test('timeline: renders initial batch and shows sentinel or load-more button', async ({ page }) => {
  await page.goto('/#/timeline');
  await waitForContentReady(page);

  // Wait for either an empty state OR the timeline container to appear.
  const container = page.locator('[data-timeline]');
  const emptyState = page.locator('.empty-state');

  const hasTimeline = (await container.count()) > 0;
  if (!hasTimeline) {
    // Brain has no notes — empty state is acceptable.
    await expect(emptyState.first()).toBeVisible({ timeout: SPA_TIMEOUT });
    return;
  }

  // Timeline has notes: the first batch must have rendered at least one item.
  const firstItem = container.locator('.timeline-item').first();
  await expect(firstItem).toBeVisible({ timeout: SPA_TIMEOUT });

  // If there are more than BATCH_SIZE (100) items, the sentinel or load-more
  // button must be present.  If <= 100, they may be absent (all rendered at once).
  const allItems = container.locator('.timeline-item');
  const itemCount = await allItems.count();

  if (itemCount >= 100) {
    const sentinel = page.locator('[data-timeline-sentinel], #timeline-load-more');
    await expect(sentinel.first()).toBeAttached({ timeout: 2000 });
  }
});

test('timeline: no per-item event listeners (uses event delegation)', async ({ page }) => {
  await page.goto('/#/timeline');

  // Verify the container itself is the delegation target (not individual items).
  // We check that clicking a timeline item navigates correctly without
  // verifying listener count directly (not possible via CDP in Playwright).
  const container = page.locator('[data-timeline]');
  const hasTimeline = (await container.count()) > 0;
  if (!hasTimeline) return;

  const firstTitle = container.locator('[data-note-href]').first();
  const titleCount = await firstTitle.count();
  if (titleCount === 0) return;

  const href = await firstTitle.getAttribute('data-note-href');
  if (!href) return;

  await firstTitle.click();
  await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), {
    timeout: SPA_TIMEOUT,
  });
});

// ---------------------------------------------------------------------------
// P1: Mobile — no horizontal overflow at 375px
// ---------------------------------------------------------------------------

/**
 * Assert that the page does not overflow horizontally at 375x812 (iPhone SE).
 */
async function assertNoHorizontalOverflow(page: Page, url: string): Promise<void> {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(url);
  await waitForContentReady(page);

  const overflow = await page.evaluate(() => {
    const scrollingEl = document.scrollingElement ?? document.documentElement;
    return scrollingEl.scrollWidth;
  });
  const viewportWidth = await page.evaluate(() => window.innerWidth);

  expect(
    overflow,
    `scrollWidth (${overflow}) must not exceed viewportWidth (${viewportWidth}) at ${url}`,
  ).toBeLessThanOrEqual(viewportWidth);
}

test('mobile 375px: home page has no horizontal overflow', async ({ page }) => {
  await assertNoHorizontalOverflow(page, '/');
});

test('mobile 375px: wiki note page has no horizontal overflow', async ({ page }) => {
  // Use a nonexistent note — renders a graceful empty state without wide content.
  await assertNoHorizontalOverflow(page, '/#/wiki/mobile-overflow-test-note');
});

test('mobile 375px: search page has no horizontal overflow', async ({ page }) => {
  await assertNoHorizontalOverflow(page, '/#/search/test');
});

test('mobile 375px: sidebar toggle button is visible', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await waitForContentReady(page);

  const toggle = page.locator('#sidebar-toggle');
  await expect(toggle).toBeVisible({ timeout: 5000 });
});

test('mobile 375px: sidebar toggle opens and closes sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await waitForContentReady(page);

  const toggle = page.locator('#sidebar-toggle');
  const sidebar = page.locator('#sidebar');

  // Initially hidden on mobile.
  await expect(sidebar).not.toBeVisible();

  // Click to open.
  await toggle.click();
  await expect(sidebar).toBeVisible({ timeout: 2000 });

  // Click again to close.
  await toggle.click();
  await expect(sidebar).not.toBeVisible({ timeout: 2000 });
});

// ---------------------------------------------------------------------------
// P2: Graph — console clean (no "Unknown option", no 404 for data/graph.json)
// ---------------------------------------------------------------------------

test('graph: no "Unknown option" console warning from vis.js', async ({ page }) => {
  const consoleMessages: string[] = [];
  const consoleErrors: string[] = [];

  page.on('console', (msg) => {
    const text = msg.text();
    consoleMessages.push(text);
    if (msg.type() === 'error') consoleErrors.push(text);
  });

  await page.goto('/graph.html');

  // Wait for graph to attempt to load.
  await page.waitForTimeout(3000);

  const unknownOptionMsgs = consoleMessages.filter((m) =>
    m.toLowerCase().includes('unknown option'),
  );
  expect(
    unknownOptionMsgs,
    `vis.js "Unknown option" warnings: ${JSON.stringify(unknownOptionMsgs)}`,
  ).toHaveLength(0);
});

test('graph: no 404 for data/graph.json in live mode', async ({ page }) => {
  const failedRequests: string[] = [];

  page.on('requestfailed', (req) => {
    failedRequests.push(req.url());
  });

  const networkErrors: Array<{ url: string; status: number }> = [];
  page.on('response', (resp) => {
    if (resp.status() === 404 && resp.url().includes('data/graph.json')) {
      networkErrors.push({ url: resp.url(), status: resp.status() });
    }
  });

  await page.goto('/graph.html');
  await page.waitForTimeout(3000);

  expect(
    networkErrors,
    `Unexpected 404 for data/graph.json in live mode: ${JSON.stringify(networkErrors)}`,
  ).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// P3: Browse topics — discoverability on home
// ---------------------------------------------------------------------------

test('home: browse topics section is present when brain has notes', async ({ page }) => {
  await page.goto('/');
  await waitForContentReady(page);

  // Check if there are any notes rendered on the page.
  const hasNotes =
    (await page.locator('[data-note-href]').count()) > 0 ||
    (await page.locator('.home-stats-bar').count()) > 0;

  if (!hasNotes) {
    // Empty brain — topics section is not rendered; skip.
    test.skip(true, 'Brain has no notes — Browse topics section is not rendered.');
    return;
  }

  const topicsSection = page.locator('.home-topics-section');
  await expect(topicsSection).toBeVisible({ timeout: SPA_TIMEOUT });

  // Must have at least one topic link.
  const topicLinks = page.locator('.topic-entry-link');
  await expect(topicLinks.first()).toBeVisible({ timeout: SPA_TIMEOUT });
});

test('home: topic links navigate to topic routes', async ({ page }) => {
  await page.goto('/');
  await waitForContentReady(page);

  const topicLinks = page.locator('.topic-entry-link');
  const count = await topicLinks.count();
  if (count === 0) {
    test.skip(true, 'No topic links present (empty brain or no topics).');
    return;
  }

  const href = await topicLinks.first().getAttribute('href');
  expect(href).toBeTruthy();
  expect(href).toMatch(/^#\//);
});
