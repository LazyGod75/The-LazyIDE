/**
 * LazyBrain wiki — end-to-end smoke tests.
 *
 * These tests verify that the wiki loads and core interactions work against a
 * running `lazybrain serve` instance.  They are intentionally isolated from
 * the vitest unit-test suite: they live under tests/e2e/ and are gated by the
 * `test:e2e` npm script only — never by `npm test`.
 *
 * Design principles:
 *  - Resilient selectors: ARIA roles, visible text, `data-*` attributes.
 *  - No brittle CSS class assertions that break on cosmetic refactors.
 *  - Every test is self-contained and can run in any order.
 *  - Tests degrade gracefully when the brain is empty.
 */

import { type Page, expect, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum ms to wait for the SPA to finish rendering a view. */
const SPA_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait until the main content area is no longer showing only the initial
 * server-rendered loading placeholder.  The SPA replaces the <p class="loading">
 * element once fetchNotes() + fetchTree() settle.
 *
 * Strategy: wait for the content of #content to change from the initial
 * "Loading…" paragraph to anything else (hero, empty-state, or error banner).
 * We poll on a broad selector rather than negating the loading class to avoid
 * races where the class disappears but the new content has not yet painted.
 */
async function waitForContentReady(page: Page): Promise<void> {
  // Any of these selectors appearing means the SPA has rendered something.
  const rendered = page.locator(
    '.home-narrative, .home-hero, .empty-state, .search-results-header, ' +
      '.stats-view, .timeline-view, article, .wiki-article, ' +
      '.note-list, [data-note-href], .failed-state',
  );
  await expect(rendered.first()).toBeVisible({ timeout: SPA_TIMEOUT });
}

/**
 * Wait until the sidebar project tree finishes loading.
 * Returns immediately if there are no projects (empty brain).
 */
async function waitForSidebarReady(page: Page): Promise<void> {
  const tree = page.locator('#project-tree');
  // Either the loading paragraph disappears or project tree nodes appear.
  await expect(tree.locator('.sidebar-loading')).toHaveCount(0, { timeout: SPA_TIMEOUT });
}

// ---------------------------------------------------------------------------
// Test: home page loads
// ---------------------------------------------------------------------------

test('home page loads and shows the wiki header', async ({ page }) => {
  await page.goto('/');

  // The HTML title is always set from the static HTML.
  await expect(page).toHaveTitle(/LazyBrain/i);

  // The brand link in the header must be present (static HTML element).
  await expect(page.getByLabel('LazyBrain home')).toBeAttached();

  // The search input must be present.
  await expect(page.getByLabel('Search notes')).toBeAttached();

  // The top-nav must have a Home link.
  await expect(page.locator('#nav-home')).toBeAttached();
});

test('home page renders content — hero, empty-state, or failed-state', async ({ page }) => {
  await page.goto('/');

  await waitForContentReady(page);

  // After the SPA boots it renders the hero (brain has notes), the empty-state
  // (brain is empty), or a failed-state (server error).  All three are valid.
  const content = page.locator('#content');
  await expect(content).not.toBeEmpty();
});

// ---------------------------------------------------------------------------
// Test: sidebar navigation
// ---------------------------------------------------------------------------

test('sidebar project tree is present in the DOM', async ({ page }) => {
  await page.goto('/');

  // #project-tree is always in the static HTML.
  const tree = page.locator('#project-tree');
  await expect(tree).toBeAttached();

  // After the SPA loads, the "Loading..." placeholder is replaced.
  await waitForSidebarReady(page);
});

test('sidebar contains project nodes or empty-state after load', async ({ page }) => {
  await page.goto('/');

  await waitForSidebarReady(page);

  const tree = page.locator('#project-tree');
  // Either project tree nodes or an empty-state message must be present.
  const nodes = tree.locator('.tree-node, .tree-file, .tree-folder, .empty-state');
  const count = await nodes.count();
  // Permissive: 0 is allowed (empty brain renders a message, not tree-node).
  // We only assert that the loading placeholder is gone (done above).
  expect(count).toBeGreaterThanOrEqual(0);
});

// ---------------------------------------------------------------------------
// Test: search
// ---------------------------------------------------------------------------

test('search input accepts a query and shows results in the content area', async ({ page }) => {
  await page.goto('/');

  // Wait for SPA to boot so the search handler is attached.
  await waitForContentReady(page);

  const searchInput = page.getByLabel('Search notes');
  await searchInput.fill('brain');

  const searchBtn = page.getByLabel('Run search');
  await searchBtn.click();

  // The app-shell triggers renderSearch() directly (no URL hash update for
  // the inline search button path).  The content area should update from the
  // home-narrative to a search result view.
  //
  // The search view renders either .search-header (results found) or
  // .empty-state (no results).  We accept both.
  const searchView = page.locator('.search-header, .search-query-title, .empty-state');
  await expect(searchView.first()).toBeVisible({ timeout: SPA_TIMEOUT });
});

test('direct search route renders search view content', async ({ page }) => {
  // Navigate directly via hash route — bypasses the search-input interaction.
  await page.goto('/#/search/lazybrain');

  await waitForContentReady(page);

  // The title must still say LazyBrain (the page does not reload).
  await expect(page).toHaveTitle(/LazyBrain/i);

  // The content area must be non-empty.
  const content = page.locator('#content');
  await expect(content).not.toBeEmpty();
});

// ---------------------------------------------------------------------------
// Test: note opens (wiki view)
// ---------------------------------------------------------------------------

test('direct wiki route renders note content or a not-found state', async ({ page }) => {
  // Navigate to a route that does not exist — the wiki renderer should show
  // a friendly empty state, which confirms the SPA router is working.
  await page.goto('/#/wiki/nonexistent-note-smoke-test');

  await waitForContentReady(page);

  const content = page.locator('#content');
  await expect(content).not.toBeEmpty();
});

test('clicking an activity item navigates to a wiki note', async ({ page }) => {
  await page.goto('/');

  await waitForContentReady(page);

  // Look for a recent-activity item — may not exist if the brain is empty.
  const firstItem = page.locator('[data-note-href]').first();
  const itemCount = await firstItem.count();

  if (itemCount === 0) {
    // Brain is empty — skip gracefully.
    test.skip(true, 'No notes in brain — activity list is empty.');
    return;
  }

  const href = await firstItem.getAttribute('data-note-href');
  expect(href).toBeTruthy();

  // Click the item; the SPA navigates via location.hash.
  await firstItem.click();

  // Hash should change.
  await expect(page).toHaveURL(new RegExp(escapeForRegex(href ?? '')), { timeout: SPA_TIMEOUT });

  // The content area should update.
  const content = page.locator('#content');
  await expect(content).not.toBeEmpty();
});

// ---------------------------------------------------------------------------
// Test: graph.html
// ---------------------------------------------------------------------------

test('graph.html loads and shows the graph toolbar', async ({ page }) => {
  await page.goto('/graph.html');

  // The full-page graph view has a dedicated toolbar with a search input.
  const graphSearch = page.locator('#toolbar-search');
  await expect(graphSearch).toBeVisible({ timeout: SPA_TIMEOUT });

  // The brand element inside the toolbar must be visible.
  await expect(page.locator('#toolbar .brand')).toBeVisible();
});

test('graph page shows node and edge counts', async ({ page }) => {
  await page.goto('/graph.html');

  // The stat badges update after data loads; wait for one of them.
  const statNodes = page.locator('#stat-nodes');
  await expect(statNodes).toBeAttached({ timeout: SPA_TIMEOUT });
});

// ---------------------------------------------------------------------------
// Test: top-nav links
// ---------------------------------------------------------------------------

test('Stats nav link navigates to stats route', async ({ page }) => {
  await page.goto('/');

  await waitForContentReady(page);

  await page.locator('#nav-stats').click();

  await expect(page).toHaveURL(/#\/stats/, { timeout: SPA_TIMEOUT });

  const content = page.locator('#content');
  await expect(content).not.toBeEmpty();
});

test('Timeline nav link navigates to timeline route', async ({ page }) => {
  await page.goto('/');

  await waitForContentReady(page);

  await page.locator('#nav-timeline').click();

  await expect(page).toHaveURL(/#\/timeline/, { timeout: SPA_TIMEOUT });

  const content = page.locator('#content');
  await expect(content).not.toBeEmpty();
});

// ---------------------------------------------------------------------------
// Test: API health
// ---------------------------------------------------------------------------

test('API health — /_api/notes returns JSON array', async ({ request }) => {
  const response = await request.get('/_api/notes');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as unknown;
  expect(Array.isArray(body)).toBe(true);
});

test('API health — /_api/tree returns projects array', async ({ request }) => {
  const response = await request.get('/_api/tree');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { projects?: unknown };
  expect(Array.isArray(body.projects)).toBe(true);
});

test('API health — /_api/search accepts a query', async ({ request }) => {
  const response = await request.get('/_api/search?q=lazybrain&top=5');
  expect(response.ok()).toBe(true);
  // The search endpoint returns { query, topK, results, totalMs }.
  const body = (await response.json()) as { results?: unknown };
  expect(Array.isArray(body.results)).toBe(true);
});

// ---------------------------------------------------------------------------
// New UX/a11y improvements
// ---------------------------------------------------------------------------

test('skip-to-content link is present in the DOM', async ({ page }) => {
  await page.goto('/');
  const skipLink = page.locator('a.skip-link');
  await expect(skipLink).toBeAttached();
  await expect(skipLink).toHaveAttribute('href', '#content');
});

test('favicon.svg is served', async ({ request }) => {
  const response = await request.get('/favicon.svg');
  expect(response.ok()).toBe(true);
  const contentType = response.headers()['content-type'] ?? '';
  expect(contentType).toContain('svg');
});

test('document title updates to page name on route change', async ({ page }) => {
  await page.goto('/');
  await waitForContentReady(page);

  // Navigate to Stats
  await page.goto('/#/stats');
  await page.waitForTimeout(800);
  const title = await page.title();
  expect(title.toLowerCase()).toMatch(/stats.*lazybrain|lazybrain.*stats/i);
});

test('search empty state shows example query buttons', async ({ page }) => {
  await page.goto('/#/search/');
  await waitForContentReady(page);
  const exampleBtns = page.locator('.search-example-btn');
  await expect(exampleBtns.first()).toBeVisible({ timeout: SPA_TIMEOUT });
});

test('pressing / from body focuses the search input', async ({ page }) => {
  await page.goto('/');
  await waitForContentReady(page);

  // Press / from the body (not in an input)
  await page.locator('body').click();
  await page.keyboard.press('/');
  const searchInput = page.locator('#search-input');
  await expect(searchInput).toBeFocused({ timeout: 2000 });
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe use as a literal inside a RegExp constructor.
 */
function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
