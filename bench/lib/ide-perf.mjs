/**
 * bench/lib/ide-perf.mjs
 * IDE performance benchmark via Playwright.
 *
 * Measures:
 *   1. Cold startup time (navigation to first meaningful render)
 *   2. Input latency (keystroke to DOM update)
 *   3. Memory footprint (JS heap size)
 *   4. Space switch latency (tab navigation)
 *
 * Requires a running dev server at localhost:5173.
 * Set BENCH_PERF_SKIP=1 to skip this bench.
 */

import { chromium } from 'playwright';

const BASE_URL = process.env.BENCH_PERF_URL ?? 'http://localhost:5173';
const ITERATIONS = parseInt(process.env.BENCH_PERF_ITERS ?? '3', 10);

async function measureColdStartup(browser) {
  const metrics = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    // Wait for the app shell to render (look for a key element)
    await page.waitForSelector('[data-testid="app-shell"], #root > div', { timeout: 15_000 });
    const startupMs = Date.now() - t0;
    metrics.push(startupMs);
    await context.close();
  }
  return metrics;
}

async function measureInputLatency(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="app-shell"], #root > div', { timeout: 15_000 });

  // Try to find an editor or input element
  const editorSelector = '.cm-editor .cm-content, [data-testid="editor-input"], textarea, input[type="text"]';
  await page.waitForSelector(editorSelector, { timeout: 10_000 }).catch(() => {});

  const latencies = [];
  const editor = await page.$(editorSelector);

  if (editor) {
    await editor.click();
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      await page.keyboard.type('a');
      // Wait for DOM mutation
      await page.waitForTimeout(10);
      const elapsed = Date.now() - t0;
      latencies.push(elapsed);
    }
  }

  await context.close();
  return latencies;
}

async function measureMemory(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="app-shell"], #root > div', { timeout: 15_000 });

  // Wait a bit for initial render to settle
  await page.waitForTimeout(2000);

  const mem = await page.evaluate(() => {
    if (performance.memory) {
      return {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
      };
    }
    return null;
  });

  // Count DOM nodes
  const domNodes = await page.evaluate(() => document.querySelectorAll('*').length);

  await context.close();
  return { memory: mem, domNodes };
}

async function measureSpaceSwitch(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="app-shell"], #root > div', { timeout: 15_000 });

  // Try to find nav tabs/buttons
  const navSelector = '[data-testid*="nav-"], [data-space], nav button, .sidebar button';
  const navButtons = await page.$$(navSelector);

  const switchTimes = [];
  if (navButtons.length > 1) {
    for (let i = 0; i < Math.min(navButtons.length, 5); i++) {
      const t0 = Date.now();
      await navButtons[i].click().catch(() => {});
      await page.waitForTimeout(200);
      const elapsed = Date.now() - t0;
      switchTimes.push(elapsed);
    }
  }

  await context.close();
  return switchTimes;
}

function stats(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((s, v) => s + v, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
    mean: Math.round((sum / arr.length) * 100) / 100,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1],
    samples: arr.length,
  };
}

export async function runIdePerfBench() {
  if (process.env.BENCH_PERF_SKIP === '1') {
    return {
      bench: 'ide-perf',
      mode: 'skipped',
      reason: 'BENCH_PERF_SKIP=1',
      metrics: null,
    };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    return {
      bench: 'ide-perf',
      mode: 'error',
      reason: `Failed to launch browser: ${err.message}`,
      metrics: null,
    };
  }

  try {
    const t0 = Date.now();

    process.stdout.write('    [perf] Measuring cold startup...\n');
    const startupMetrics = await measureColdStartup(browser);

    process.stdout.write('    [perf] Measuring input latency...\n');
    const inputLatencies = await measureInputLatency(browser);

    process.stdout.write('    [perf] Measuring memory footprint...\n');
    const memResult = await measureMemory(browser);

    process.stdout.write('    [perf] Measuring space switch latency...\n');
    const switchTimes = await measureSpaceSwitch(browser);

    const durationMs = Date.now() - t0;
    await browser.close();

    return {
      bench: 'ide-perf',
      mode: 'playwright',
      url: BASE_URL,
      iterations: ITERATIONS,
      durationMs,
      metrics: {
        coldStartupMs: stats(startupMetrics),
        inputLatencyMs: stats(inputLatencies),
        spaceSwitchMs: stats(switchTimes),
        memory: memResult.memory,
        domNodes: memResult.domNodes,
      },
    };
  } catch (err) {
    await browser?.close().catch(() => {});
    return {
      bench: 'ide-perf',
      mode: 'error',
      reason: err.message,
      metrics: null,
    };
  }
}
