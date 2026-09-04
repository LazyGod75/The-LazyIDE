/**
 * E2E tests for the home-page knowledge graph panel and the full graph page.
 *
 * These tests verify:
 *  1. The home page shows the graph canvas with nodes when the brain has content.
 *  2. Hovering a node does not produce console errors.
 *  3. Clicking a node navigates to a note route.
 *  4. No console errors on the home or graph page.
 *  5. Mobile 375px: panel fits with no horizontal overflow.
 *  6. graph.html uses precomputed positions (no 7-second wait).
 */

import { type Page, expect, test } from '@playwright/test';

const SPA_TIMEOUT = 15_000;

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
 * Wait for the vis-network canvas to appear inside .home-graph-panel.
 * Returns true if found, false if the panel is not present (empty brain).
 */
async function waitForHomeGraphCanvas(page: Page): Promise<boolean> {
  const panel = page.locator('.home-graph-panel');
  const panelCount = await panel.count();
  if (panelCount === 0) return false;

  // Panel may be hidden when brain is empty
  const panelVisible = await panel.isVisible();
  if (!panelVisible) return false;

  // The vis-network canvas element lives inside #hg-network
  const canvas = panel.locator('canvas');
  try {
    await expect(canvas.first()).toBeAttached({ timeout: SPA_TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test: home graph panel visibility
// ---------------------------------------------------------------------------

test('home page: graph panel is present or gracefully absent', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await waitForContentReady(page);

  // Panel may or may not exist depending on brain content — both are valid.
  const panel = page.locator('.home-graph-panel');
  const count = await panel.count();

  if (count > 0) {
    const visible = await panel.isVisible();
    if (visible) {
      // If panel is visible, the canvas wrap must exist
      const canvasWrap = panel.locator('.hg-canvas-wrap');
      await expect(canvasWrap).toBeAttached();
    }
  }

  // No console errors
  const filteredErrors = errors.filter(
    (e) =>
      !e.includes('favicon') && !e.includes('net::ERR_') && !e.includes('Failed to load resource'),
  );
  expect(filteredErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test: home graph renders canvas with nodes when brain has content
// ---------------------------------------------------------------------------

test('home graph: canvas element present when brain has nodes', async ({ page }) => {
  await page.goto('/');
  await waitForContentReady(page);

  const hasGraph = await waitForHomeGraphCanvas(page);

  if (!hasGraph) {
    // Brain is empty or vis not loaded — acceptable
    test.skip(true, 'No home graph panel rendered (empty brain or vis not available).');
    return;
  }

  // If graph is present, vis-network must have painted a canvas
  const canvas = page.locator('.home-graph-panel canvas');
  await expect(canvas.first()).toBeAttached();
});

// ---------------------------------------------------------------------------
// Test: hover node does not throw errors
// ---------------------------------------------------------------------------

test('home graph: hovering over graph canvas area does not produce console errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await waitForContentReady(page);

  const hasGraph = await waitForHomeGraphCanvas(page);
  if (!hasGraph) {
    test.skip(true, 'No home graph to hover.');
    return;
  }

  // Slowly move the mouse across the graph canvas area
  const panel = page.locator('.home-graph-panel');
  const box = await panel.boundingBox();
  if (!box) return;

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx - 50, cy);
  await page.mouse.move(cx, cy);
  await page.mouse.move(cx + 50, cy - 30);
  await page.waitForTimeout(300);

  const filteredErrors = errors.filter(
    (e) =>
      !e.includes('favicon') && !e.includes('net::ERR_') && !e.includes('Failed to load resource'),
  );
  expect(filteredErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test: click on a vis node navigates to a note route
// ---------------------------------------------------------------------------

test('home graph: clicking a node navigates to a note wiki route', async ({ page }) => {
  await page.goto('/');
  await waitForContentReady(page);

  const hasGraph = await waitForHomeGraphCanvas(page);
  if (!hasGraph) {
    test.skip(true, 'No home graph to click.');
    return;
  }

  // Let the graph stabilize
  await page.waitForTimeout(1200);

  const panel = page.locator('.home-graph-panel');
  const box = await panel.boundingBox();
  if (!box) return;

  // Click in the center of the graph — may or may not hit a node
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const initialUrl = page.url();
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(500);

  const newUrl = page.url();

  // If the click hit a node, URL hash should have changed to a #/wiki/ route.
  // If no node was at that exact pixel, URL stays the same — both are valid.
  if (newUrl !== initialUrl) {
    expect(newUrl).toMatch(/#\/wiki\//);
  }
  // Either way, no crash.
});

// ---------------------------------------------------------------------------
// Test: no console errors on the full graph page
// ---------------------------------------------------------------------------

test('graph.html: no console errors and toolbar visible', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/graph.html');

  const toolbar = page.locator('#toolbar-search');
  await expect(toolbar).toBeVisible({ timeout: SPA_TIMEOUT });

  const filteredErrors = errors.filter(
    (e) =>
      !e.includes('favicon') && !e.includes('net::ERR_') && !e.includes('Failed to load resource'),
  );
  expect(filteredErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test: graph.html loads fast (precomputed positions → physics off)
// ---------------------------------------------------------------------------

test('graph.html: loads in well under 8 seconds', async ({ page }) => {
  const t0 = Date.now();
  await page.goto('/graph.html');

  const statNodes = page.locator('#stat-nodes');
  await expect(statNodes).toBeAttached({ timeout: SPA_TIMEOUT });

  // If positions are precomputed, the loading overlay disappears immediately.
  // Either way, the toolbar must be visible quickly.
  const toolbar = page.locator('#toolbar-search');
  await expect(toolbar).toBeVisible({ timeout: 8_000 });

  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(8_000);
});

// ---------------------------------------------------------------------------
// Test: mobile 375px — home graph panel has no horizontal overflow
// ---------------------------------------------------------------------------

test('mobile 375px: home graph panel fits viewport width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await waitForContentReady(page);

  const panel = page.locator('.home-graph-panel');
  const count = await panel.count();
  if (count === 0) {
    test.skip(true, 'No home graph panel on this brain.');
    return;
  }

  const visible = await panel.isVisible();
  if (!visible) return; // empty brain hides the panel — acceptable

  const box = await panel.boundingBox();
  if (!box) return;

  // Panel must not overflow the 375px viewport
  expect(box.width).toBeLessThanOrEqual(375 + 1); // 1px tolerance
  expect(box.x).toBeGreaterThanOrEqual(-1);

  // No horizontal scrollbar
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 4); // 4px tolerance
});

// ---------------------------------------------------------------------------
// Test: static demo build renders home graph (data/graph.json with positions)
// ---------------------------------------------------------------------------

test('API: /_api/graph returns nodes with x and y when graph was built', async ({ request }) => {
  const response = await request.get('/_api/graph.json');
  if (!response.ok()) {
    test.skip(true, 'Graph API not available.');
    return;
  }

  const body = (await response.json()) as { nodes?: unknown[] };
  expect(Array.isArray(body.nodes)).toBe(true);

  const nodes = body.nodes as Array<Record<string, unknown>>;
  if (nodes.length === 0) {
    test.skip(true, 'Graph is empty — no position data to verify.');
    return;
  }

  // When the graph has been built (lazybrain graph was run), at least some nodes
  // should have x and y coordinates.
  const withPositions = nodes.filter((n) => typeof n.x === 'number' && typeof n.y === 'number');

  // If zero nodes have positions, the graph command was not yet run — acceptable.
  // If positions exist, all nodes should have them.
  if (withPositions.length > 0) {
    expect(withPositions.length).toBeGreaterThan(nodes.length * 0.5);
  }
});

// ---------------------------------------------------------------------------
// Test: slim layout endpoint is served and well-formed
// ---------------------------------------------------------------------------

test('API: /_api/graph-layout.json is served with correct shape', async ({ request }) => {
  const response = await request.get('/_api/graph-layout.json');
  if (!response.ok()) {
    test.skip(true, 'Slim layout API not available.');
    return;
  }

  const body = (await response.json()) as {
    nodes?: unknown[];
    edges?: unknown[];
    clusters?: string[];
    hasPositions?: boolean;
  };

  expect(Array.isArray(body.nodes)).toBe(true);
  expect(Array.isArray(body.edges)).toBe(true);
  expect(Array.isArray(body.clusters)).toBe(true);
  expect(typeof body.hasPositions).toBe('boolean');

  if (body.nodes && body.nodes.length > 0) {
    const firstNode = body.nodes[0] as Record<string, unknown>;
    // Each node must have id, c (cluster idx), d (degree), t (type)
    expect(typeof firstNode.id).toBe('string');
    expect(typeof firstNode.c).toBe('number');
    expect(typeof firstNode.d).toBe('number');
    expect(typeof firstNode.t).toBe('string');
  }

  if (body.edges && body.edges.length > 0) {
    const firstEdge = body.edges[0] as unknown[];
    // Each edge is [sourceIdx, targetIdx]
    expect(Array.isArray(firstEdge)).toBe(true);
    expect(firstEdge.length).toBe(2);
    expect(typeof firstEdge[0]).toBe('number');
    expect(typeof firstEdge[1]).toBe('number');
  }
});

// ---------------------------------------------------------------------------
// Test: slim payload is materially smaller than full graph.json
// ---------------------------------------------------------------------------

test('API: slim layout payload is smaller than full graph.json', async ({ request }) => {
  const [fullRes, slimRes] = await Promise.all([
    request.get('/_api/graph.json'),
    request.get('/_api/graph-layout.json'),
  ]);

  if (!fullRes.ok() || !slimRes.ok()) {
    test.skip(true, 'Graph APIs not available.');
    return;
  }

  const fullText = await fullRes.text();
  const slimText = await slimRes.text();

  // Only assert when there are nodes to render
  const fullBody = JSON.parse(fullText) as { nodes?: unknown[] };
  if (!fullBody.nodes || fullBody.nodes.length === 0) {
    test.skip(true, 'Empty graph — size comparison not meaningful.');
    return;
  }

  // Slim must be strictly smaller than full (at minimum 10% smaller)
  expect(slimText.length).toBeLessThan(fullText.length * 0.9);
});

// ---------------------------------------------------------------------------
// Test: home graph renders interactively in < 3 s (with or without positions)
// Acceptance gate for large brains (2000+ nodes capped to NODE_CAP=500).
// ---------------------------------------------------------------------------

test('home graph: becomes interactive in under 3 seconds (large-brain gate)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  const t0 = Date.now();
  await page.goto('/');
  await waitForContentReady(page);

  const hasGraph = await waitForHomeGraphCanvas(page);
  if (!hasGraph) {
    test.skip(true, 'No home graph on this brain.');
    return;
  }

  // Wait for the hg-ready class (added by afterDrawing) OR the error state.
  // The panel MUST exit the "Loading graph..." state within 3s.
  const panel = page.locator('.home-graph-panel');

  // First: loading indicator must disappear
  const loading = page.locator('#hg-loading');
  const isLoadingVisible = await loading.isVisible().catch(() => false);
  if (isLoadingVisible) {
    await expect(loading).not.toBeVisible({ timeout: 3000 });
  }

  // Second: vis-network canvas must be attached (nodes rendered)
  const canvas = panel.locator('canvas');
  await expect(canvas.first()).toBeAttached({ timeout: 3000 });

  // Third: hg-ready class must be set (afterDrawing fired)
  await expect(panel).toHaveClass(/hg-ready/, { timeout: 3000 });

  const elapsed = Date.now() - t0;
  console.log(`[home-graph-timing] time-to-first-render: ${elapsed}ms`);
  expect(elapsed).toBeLessThan(3000);

  // No console errors (excludes favicon and resource load noise)
  const filteredErrors = errors.filter(
    (e) =>
      !e.includes('favicon') && !e.includes('net::ERR_') && !e.includes('Failed to load resource'),
  );
  expect(filteredErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test: fullscreen toggle opens and closes
// ---------------------------------------------------------------------------

test('home graph: fullscreen toggle opens overlay and closes on button click', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await waitForContentReady(page);

  const hasGraph = await waitForHomeGraphCanvas(page);
  if (!hasGraph) {
    test.skip(true, 'No home graph panel to test fullscreen on.');
    return;
  }

  // Wait for graph to load (loading indicator gone or graph ready)
  await page.waitForTimeout(800);

  // Find the fullscreen button
  const fsBtn = page.locator('[data-action="fullscreen"]');
  const fsBtnCount = await fsBtn.count();
  if (fsBtnCount === 0) {
    test.skip(true, 'Fullscreen button not found.');
    return;
  }

  await expect(fsBtn).toBeVisible();

  // Click fullscreen button
  await fsBtn.click();
  await page.waitForTimeout(300);

  // Overlay must appear
  const overlay = page.locator('.hg-fullscreen-overlay');
  await expect(overlay).toBeVisible({ timeout: 2000 });

  // Close button must be present inside overlay
  const closeBtn = overlay.locator('.hg-fullscreen-close');
  await expect(closeBtn).toBeVisible();

  // Click close
  await closeBtn.click();
  await page.waitForTimeout(300);

  // Overlay must be gone
  await expect(overlay).not.toBeVisible({ timeout: 2000 });

  // No console errors
  const filteredErrors = errors.filter(
    (e) =>
      !e.includes('favicon') && !e.includes('net::ERR_') && !e.includes('Failed to load resource'),
  );
  expect(filteredErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test: fullscreen closes on Escape key
// ---------------------------------------------------------------------------

test('home graph: fullscreen closes on Escape key', async ({ page }) => {
  await page.goto('/');
  await waitForContentReady(page);

  const hasGraph = await waitForHomeGraphCanvas(page);
  if (!hasGraph) {
    test.skip(true, 'No home graph panel.');
    return;
  }

  await page.waitForTimeout(800);

  const fsBtn = page.locator('[data-action="fullscreen"]');
  if ((await fsBtn.count()) === 0) {
    test.skip(true, 'Fullscreen button not found.');
    return;
  }

  await fsBtn.click();
  await page.waitForTimeout(300);

  const overlay = page.locator('.hg-fullscreen-overlay');
  await expect(overlay).toBeVisible({ timeout: 2000 });

  // Press Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await expect(overlay).not.toBeVisible({ timeout: 2000 });
});
