/**
 * Capture home-graph-v2 screenshots using the wiki-tour brain (1933 nodes).
 * Saves to C:\Users\user\Documents\cerveau\_wiki-tour\
 *
 * Usage:
 *   node scripts/screenshot-home-graph.mjs
 *
 * Requires: Playwright installed, lazybrain dist built, wiki-tour-brain at
 * C:\Users\user\AppData\Local\Temp\wiki-tour-brain\brain
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BRAIN_PATH = 'C:/Users/user/AppData/Local/Temp/wiki-tour-brain/brain';
const OUT_DIR = 'C:/Users/user/Documents/cerveau/_wiki-tour';
const PORT = 4388;
const BASE_URL = `http://127.0.0.1:${PORT}`;

mkdirSync(OUT_DIR, { recursive: true });

async function startServer() {
  console.log(`Starting lazybrain serve on port ${PORT} with brain at ${BRAIN_PATH}...`);
  // On Windows, npx resolves to npx.cmd; use 'node' + dist build for reliability.
  const isWindows = process.platform === 'win32';
  const lazybrainBin = path.join(REPO_ROOT, 'dist', 'bin', 'lazybrain.js');
  const server = spawn(
    isWindows ? 'node' : 'node',
    [lazybrainBin, '--brain', BRAIN_PATH, 'serve', '--port', String(PORT)],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: false,
    },
  );

  server.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.includes('error') || s.includes('Error')) process.stderr.write(`[server] ${s}`);
  });

  // Wait for the server to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 30_000);
    server.stdout.on('data', (d) => {
      const s = d.toString();
      if (s.includes('listening') || s.includes('ready') || s.includes(String(PORT))) {
        clearTimeout(timeout);
        resolve(null);
      }
    });
    // Also poll the URL
    const poll = setInterval(async () => {
      try {
        const { default: http } = await import('node:http');
        const req = http.get(BASE_URL, (res) => {
          if (res.statusCode && res.statusCode < 500) {
            clearInterval(poll);
            clearTimeout(timeout);
            resolve(null);
          }
        });
        req.on('error', () => {
          // Server not yet ready — keep polling
        });
        req.end();
      } catch {
        // Keep polling
      }
    }, 500);
  });

  console.log('Server ready.');
  return server;
}

async function main() {
  let server;
  let browser;

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });

    const consoleErrors = [];

    async function captureScreenshot(name, viewportWidth, viewportHeight, darkMode) {
      const context = await browser.newContext({
        viewport: { width: viewportWidth, height: viewportHeight },
        colorScheme: darkMode ? 'dark' : 'light',
      });
      const page = await context.newPage();
      const errors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text());
      });
      page.on('pageerror', (err) => errors.push(err.message));

      console.log(`Navigating to ${BASE_URL} (${name})...`);
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 });

      // Wait for the home content to render
      await page.waitForSelector('.home-narrative, .home-hero, .home-empty', { timeout: 15_000 });

      // Wait for the graph panel and canvas to appear
      try {
        await page.waitForSelector('.home-graph-panel canvas', { timeout: 12_000 });
        // When no precomputed positions, physics needs time to stabilize (80 iterations).
        // With 1933 nodes the stabilization takes ~5-10 seconds in headless.
        // We poll for the .hg-ready class which is added after afterDrawing fires.
        try {
          await page.waitForSelector('.home-graph-panel.hg-ready', { timeout: 15_000 });
          await page.waitForTimeout(1_200); // let final frame paint
        } catch {
          // Fallback: just wait a generous amount for physics
          await page.waitForTimeout(6_000);
        }
      } catch {
        console.warn(`No graph canvas rendered for ${name} — taking screenshot anyway.`);
        await page.waitForTimeout(1000);
      }

      const t0 = Date.now();
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
      const elapsed = Date.now() - t0;
      console.log(`  Screenshot saved: ${name}.png (page snapshot took ${elapsed}ms)`);

      const filteredErrors = errors.filter(
        (e) =>
          !e.includes('favicon') &&
          !e.includes('net::ERR_') &&
          !e.includes('Failed to load resource'),
      );
      if (filteredErrors.length > 0) {
        console.warn(`  Console errors in ${name}:`, filteredErrors);
        consoleErrors.push(...filteredErrors.map((e) => `[${name}] ${e}`));
      }

      await context.close();
    }

    const captureStart = Date.now();

    // Measure time-to-interactive for dark mode
    const ttiContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'dark',
    });
    const ttiPage = await ttiContext.newPage();
    const ttiStart = Date.now();
    await ttiPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await ttiPage.waitForSelector('.home-graph-panel canvas', { timeout: 15_000 });
    const ttiCanvasReady = Date.now() - ttiStart;
    try {
      await ttiPage.waitForSelector('.home-graph-panel.hg-ready', { timeout: 15_000 });
    } catch { /* fallback */ }
    const ttiInteractive = Date.now() - ttiStart;
    console.log(`Time-to-canvas: ${ttiCanvasReady}ms | Time-to-interactive (hg-ready): ${ttiInteractive}ms`);
    await ttiContext.close();

    // Light theme, 1440x900
    await captureScreenshot('home-graph-v2-light', 1440, 900, false);
    // Dark theme, 1440x900
    await captureScreenshot('home-graph-v2-dark', 1440, 900, true);
    // Mobile, 375x812
    await captureScreenshot('home-graph-v2-mobile', 375, 812, false);
    // Real graph (wiki-tour = 1933 nodes IS the real graph)
    await captureScreenshot('home-graph-v2-real', 1440, 900, true);

    const totalElapsed = Date.now() - captureStart;
    console.log(`\nAll screenshots captured in ${totalElapsed}ms.`);

    if (consoleErrors.length > 0) {
      console.error('\nConsole errors found:');
      for (const e of consoleErrors) console.error(' -', e);
    } else {
      console.log('No console errors detected.');
    }
  } finally {
    if (browser) await browser.close();
    if (server) server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('Screenshot script failed:', err);
  process.exit(1);
});
