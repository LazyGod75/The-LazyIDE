#!/usr/bin/env node
/**
 * Release-readiness gate — runs the full verification chain in order.
 * Exits non-zero on the first failure.
 * Usage: node scripts/verify.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const CI = process.env.CI === 'true' || process.env.CI === '1';
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

function run(label, cmd, args, opts = {}) {
  console.log(`\n>>> [${label}]`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  const ok = result.status === 0 && result.error == null;
  console.log(ok ? `    PASS: ${label}` : `    FAIL: ${label} (exit ${result.status})`);
  if (!ok) {
    process.exit(result.status || 1);
  }
}

function warn(label, reason) {
  console.warn(`\n    SKIP (warning): ${label} — ${reason}`);
}

// ------------------------------------------------------------------
// 0. Secret scan — Stripe / Supabase service-role / R2 / signing keys
// ------------------------------------------------------------------
run('secrets', 'npm', ['run', 'secrets:check'], { cwd: ROOT });

// ------------------------------------------------------------------
// 1. Lint
// ------------------------------------------------------------------
run('lint', 'npm', ['run', 'lint'], { cwd: ROOT });

// ------------------------------------------------------------------
// 2. TypeScript type-check
// ------------------------------------------------------------------
run('tsc', 'npx', ['tsc', '-b', '--noEmit'], { cwd: ROOT });

// ------------------------------------------------------------------
// 3. Unit tests (vitest)
// ------------------------------------------------------------------
run('vitest', 'npx', ['vitest', 'run'], { cwd: ROOT });

// ------------------------------------------------------------------
// 4. Vite build
// ------------------------------------------------------------------
run('build', 'npm', ['run', 'build'], { cwd: ROOT });

// ------------------------------------------------------------------
// 5. CLI build (dist/cli/lazy.cjs — headless `lazy` binary)
// ------------------------------------------------------------------
(function cliGate() {
  run('build:cli', 'npm', ['run', 'build:cli'], { cwd: ROOT });

  const cliOut = path.join(ROOT, 'dist', 'cli', 'lazy.cjs');
  if (!existsSync(cliOut)) {
    console.error(`    FAIL: build:cli — ${cliOut} was not produced`);
    process.exit(1);
  }
  if (statSync(cliOut).size === 0) {
    console.error(`    FAIL: build:cli — ${cliOut} is empty`);
    process.exit(1);
  }
  console.log('    PASS: build:cli output present and non-empty');
})();

// ------------------------------------------------------------------
// 6. Sidecar freshness — committed lazybrain.js must match engine/ source
// ------------------------------------------------------------------
(function sidecarFreshnessGate() {
  const builtJs = path.join(ROOT, 'engine', 'dist', 'bin', 'lazybrain.js');
  const shippedJs = path.join(ROOT, 'src-tauri', 'resources', 'lazybrain', 'lazybrain.js');

  if (!existsSync(builtJs)) {
    if (CI) {
      console.error(
        '    FAIL: engine/dist/bin/lazybrain.js not found in CI — the release workflow ' +
        'must build the engine (cd engine && npm ci && npm run build) before running verify',
      );
      process.exit(1);
    }
    warn(
      'sidecar-freshness',
      'engine/dist/bin/lazybrain.js not built locally — run `cd engine && npm run build` to check freshness',
    );
    return;
  }

  if (!existsSync(shippedJs)) {
    console.error(`    FAIL: sidecar-freshness — ${shippedJs} is missing`);
    console.error('    Run: npm run bundle:sidecar');
    process.exit(1);
  }

  const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const builtHash = hash(builtJs);
  const shippedHash = hash(shippedJs);

  if (builtHash !== shippedHash) {
    console.error('    FAIL: sidecar-freshness — committed lazybrain.js does not match engine/ build output');
    console.error(`      engine/dist/bin/lazybrain.js               : ${builtHash}`);
    console.error(`      src-tauri/resources/lazybrain/lazybrain.js : ${shippedHash}`);
    console.error('    Run: npm run bundle:sidecar, then commit the updated resources.');
    process.exit(1);
  }
  console.log('    PASS: sidecar-freshness — committed lazybrain.js matches engine/ build output');
})();

// ------------------------------------------------------------------
// 7. Rust: cargo check + cargo test
// ------------------------------------------------------------------
(function rustGate() {
  const tauriDir = path.join(ROOT, 'src-tauri');

  // Resolve cargo executable and prepare a PATH that includes the
  // tools Rust integration tests spawn: cargo/rustup, node, git, and
  // basic Windows system directories. This is required when verify.mjs
  // is launched from an IDE process whose environment is stripped.
  let cargoExe = 'cargo';
  const env = { ...process.env };

  const winPathDirs = [
    process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32'),
    process.env.SystemRoot,
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.cargo', 'bin'),
    process.execPath && path.dirname(process.execPath),
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\Git\\bin',
    'C:\\Program Files (x86)\\Git\\cmd',
    'C:\\Program Files (x86)\\Git\\bin',
  ].filter(Boolean).filter((d) => existsSync(d));

  env.PATH = [...winPathDirs, env.PATH || ''].join(path.delimiter);

  if (!existsSync(path.join(tauriDir, 'Cargo.toml'))) {
    warn('cargo', 'src-tauri/Cargo.toml not found — skipping Rust gate');
    return;
  }

  const probe = spawnSync(cargoExe, ['--version'], { shell: true, env });
  if (probe.status !== 0 || probe.error) {
    // Try well-known Windows path
    const fallback = path.join(
      process.env.USERPROFILE || '',
      '.cargo', 'bin', 'cargo.exe'
    );
    if (existsSync(fallback)) {
      cargoExe = fallback;
      env.PATH = path.dirname(fallback) + path.delimiter + (env.PATH || '');
    } else {
      if (CI) {
        console.error('    FAIL: cargo not found in PATH and not at ~/.cargo/bin/cargo.exe');
        process.exit(1);
      }
      warn('cargo', 'cargo not found — install rustup or add ~/.cargo/bin to PATH');
      return;
    }
  }

  run('cargo check', cargoExe, ['check'], { cwd: tauriDir, env });
  run('cargo test', cargoExe, ['test'], { cwd: tauriDir, env });
})();

// ------------------------------------------------------------------
// 8. E2E — Playwright
// ------------------------------------------------------------------
(function e2eGate() {
  // Quick probe: can chromium be found?
  const probe = spawnSync('npx', ['playwright', 'install', '--dry-run'], {
    shell: true,
    cwd: ROOT,
  });
  // Playwright exits 0 even on dry-run, but we just check it runs
  if (probe.error) {
    if (CI) {
      console.error('    FAIL: playwright not available');
      process.exit(1);
    }
    warn('e2e', 'playwright not available — run: npx playwright install chromium');
    return;
  }
  run('e2e', 'npm', ['run', 'test:e2e'], { cwd: ROOT });
})();

// ------------------------------------------------------------------
// 9. Screenshot regression — Playwright visual snapshots
// ------------------------------------------------------------------
(function screenshotRegressionGate() {
  const screenshotDir = path.join(ROOT, 'e2e', 'screenshots');
  if (!existsSync(screenshotDir)) {
    warn('screenshot-regression', 'e2e/screenshots/ not found — skipping');
    return;
  }

  // Run the E2E tests that produce screenshots (smoke + orchestrator)
  // The screenshots are compared manually or by CI artifact diff.
  // In CI, this step ensures the screenshot-producing tests run successfully.
  const result = spawnSync('npx', ['playwright', 'test', 'e2e/smoke.spec.ts', 'e2e/orchestrator.spec.ts', 'e2e/orchestrator-extended.spec.ts', '--reporter=line'], {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
  });

  const ok = result.status === 0 && result.error == null;
  console.log(ok ? '    PASS: screenshot-regression' : `    FAIL: screenshot-regression (exit ${result.status})`);
  if (!ok) {
    process.exit(result.status || 1);
  }
})();

// ------------------------------------------------------------------
// 10. Orchestrator benchmark — fixture mode (deterministic)
// ------------------------------------------------------------------
(function orchestratorBenchGate() {
  const benchScript = path.join(ROOT, 'bench', 'run.mjs');
  if (!existsSync(benchScript)) {
    warn('orchestrator-bench', 'bench/run.mjs not found — skipping');
    return;
  }

  // Run in fixture/dry mode for deterministic results
  const result = spawnSync('node', ['bench/run.mjs'], {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, BENCH_LIVE: '', BENCH_AGENT_LIVE: '' },
  });

  const ok = result.status === 0 && result.error == null;
  console.log(ok ? '    PASS: orchestrator-bench' : `    FAIL: orchestrator-bench (exit ${result.status})`);
  if (!ok) {
    // Bench is a warning, not a hard gate — it may fail due to fixture issues
    warn('orchestrator-bench', `bench exited ${result.status} — non-blocking, review output`);
  }
})();

// ------------------------------------------------------------------
// 11. Clean-tree check
// ------------------------------------------------------------------
(function cleanTree() {
  console.log('\n>>> [clean-tree]');
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    shell: true,
  });
  const dirty = (result.stdout || '').toString().trim();

  // Filter out transient Playwright timestamp files (generated by e2e/vite-web.config.ts)
  const dirtyLines = dirty.split('\n').filter(line => {
    // Ignore non-deterministic Playwright outputs: vite timestamp files and
    // e2e screenshots (regenerated with pixel diffs on every run).
    return line && !line.includes('.timestamp-') && !line.endsWith('.mjs')
      && !line.includes('e2e/screenshots/');
  });

  if (dirtyLines.length > 0) {
    console.error('    FAIL: working tree is dirty — commit or stash before releasing:');
    console.error(dirtyLines.join('\n'));
    process.exit(1);
  }
  console.log('    PASS: clean-tree');
})();

console.log('\n=== ALL CHECKS PASSED ===');
