/**
 * register-serve.ts — Server and daemon commands.
 *
 * Registers: serve, daemon (start/status/stop), init, wipe,
 *            fingerprints (stats/clean).
 */

import type { Command } from 'commander';
import { runDaemonStatus, runDaemonStop, startDaemonForeground } from '../commands/daemon.js';
import { runServe, stopServe } from '../commands/serve.js';

function handle(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lazybrain: ${msg}\n`);
  if (process.env.LAZYBRAIN_LOG_LEVEL === 'debug' && err instanceof Error) {
    process.stderr.write(`${err.stack}\n`);
  }
  const code = msg.includes('Schema validation') ? 4 : msg.includes('not found') ? 5 : 1;
  process.exit(code);
}

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description(
      'Local HTTP server for the brain (read-only). Use --stop to stop a running server.',
    )
    .option('-p, --port <n>', 'port', (v) => Number.parseInt(v, 10), 4242)
    .option('--bind <host>', 'bind address', '127.0.0.1')
    .option('--token <token>', 'require Bearer auth')
    .option('--stop', 'stop a running lazybrain serve instance and exit')
    .action(async (opts: { port?: number; bind?: string; token?: string; stop?: boolean }) => {
      try {
        if (opts.stop) {
          const result = await stopServe();
          if (result === 'no-server') {
            process.stdout.write('lazybrain serve: no running server found (no serve.port file)\n');
          } else if (result === 'stopped') {
            process.stdout.write('lazybrain serve: server stopped\n');
          } else {
            process.stderr.write(`lazybrain serve --stop: ${result}\n`);
            process.exit(1);
          }
          return;
        }
        await runServe(opts);
      } catch (err) {
        handle(err);
      }
    });

  // Daemon subcommand group
  const daemon = program
    .command('daemon')
    .description('Long-running HTTP daemon for ultra-fast hook calls (claude-mem-style).');

  daemon
    .command('start')
    .description('Start the daemon (foreground by default; auto-spawned from hooks).')
    .option('--foreground', 'block until shutdown (default for hook-spawned daemons)')
    .option('-p, --port <n>', 'port', (v) => Number.parseInt(v, 10), 37788)
    .option(
      '--idle-timeout-ms <ms>',
      'auto-shutdown after this many ms idle',
      (v) => Number.parseInt(v, 10),
      30 * 60 * 1000,
    )
    .action(async (opts) => {
      try {
        await startDaemonForeground(opts);
      } catch (err) {
        handle(err);
      }
    });

  daemon
    .command('status')
    .description('Show daemon status (pid, port, alive).')
    .option('--pretty')
    .action((opts) => {
      try {
        process.stdout.write(`${runDaemonStatus(opts)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  daemon
    .command('stop')
    .description('Stop the daemon.')
    .option('--pretty')
    .action(async (opts) => {
      try {
        process.stdout.write(`${await runDaemonStop(opts)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  // init command
  program
    .command('init')
    .description(
      'Bootstrap a new LazyBrain brain, or install an agent integration with --agent.\n\n' +
        'Brain target resolution order (highest priority first):\n' +
        '  1. --brain <path>         explicit path (e.g. --brain /my/project/brain)\n' +
        '  2. LAZYBRAIN_BRAIN_PATH   environment variable\n' +
        '  3. $CWD/.lazybrain/brain  local project default\n\n' +
        'Prints "Initialized brain at <path>" on stdout so you always know where it landed.',
    )
    .option('--brain <path>', 'explicit brain directory path (overrides env var and cwd default)')
    .option('--agent <name>', 'install integration for an agent: vibe')
    .option('--enable-hooks', '(vibe) set enable_experimental_hooks=true in config.toml')
    .option('--tools', '(vibe) install the LazybrainRead spatial-recall tool')
    .option('--explore', '(vibe) install the brain-aware explore subagent override')
    .option('--force', 'Overwrite if already initialized')
    .option('--pretty', 'Human-readable output')
    .action(async (opts: Record<string, unknown>) => {
      try {
        if (opts.agent === 'vibe') {
          const { runInitVibe } = await import('../commands/init-vibe.js');
          const report = await runInitVibe({
            enableHooks: !!opts.enableHooks,
            tools: !!opts.tools,
            explore: !!opts.explore,
            pretty: !!opts.pretty,
          });
          if (opts.pretty) {
            console.log(`Vibe integration installed at ${report.vibeHome}`);
            console.log(
              `  hook: ${report.hookInstalled} | experimental flag: ${report.experimentalHooksEnabled}`,
            );
            console.log(`  skills: ${report.skillsInstalled.join(', ') || 'none'}`);
            for (const w of report.warnings) console.log(`  WARNING: ${w}`);
          } else {
            console.log(JSON.stringify(report));
          }
          return;
        }
        if (opts.agent && opts.agent !== 'vibe') {
          throw new Error(`Unknown agent "${opts.agent}". Supported: vibe`);
        }
        const { runInit } = await import('../commands/init.js');
        // opts.brain comes from --brain flag; takes priority over LAZYBRAIN_BRAIN_PATH
        const path = typeof opts.brain === 'string' ? opts.brain : undefined;
        const report = await runInit({ force: !!opts.force, pretty: !!opts.pretty, path });
        if (opts.pretty) {
          // "Initialized brain at <path>" is already printed by runInit.
          console.log('Next steps:');
          console.log('  npx lazybrain dream --enrich');
          console.log('  npx lazybrain index-rebuild');
          console.log('  npx lazybrain graph --format both');
          console.log(
            '  npx lazybrain enrich --pretty          # attach conversation decisions/bugs/ideas to each file page',
          );
          console.log('  npx lazybrain build-hierarchy --force');
          console.log('  npx lazybrain enrich-hierarchy --force');
          console.log('  npx lazybrain index-rebuild');
          console.log('  npx lazybrain serve');
        } else {
          console.log(JSON.stringify(report));
        }
      } catch (err) {
        handle(err);
      }
    });

  // wipe command
  program
    .command('wipe')
    .description(
      'Delete all brain notes, artifacts and cache.\n' +
        '  Without --yes: prints what WOULD be deleted and exits (no deletion).\n' +
        '  With --yes: performs the deletion after verifying no daemon is running.\n' +
        '  After wipe the next `dream` reprocesses all conversations from scratch.',
    )
    .option('-y, --yes', 'Confirm deletion (required to actually delete anything)')
    .option('--pretty', 'Pretty output')
    .action(async (opts: { yes?: boolean; pretty?: boolean }) => {
      try {
        const { runWipe } = await import('../commands/wipe.js');
        const report = await runWipe(opts);
        if (opts.pretty) {
          console.log(
            `Wiped: ${report.notesDeleted} notes, ${report.knowledgeNodesDeleted} hierarchy nodes, ${report.artifactsDeleted} artifacts, ${report.cacheDeleted} cache files`,
          );
          console.log(
            'Conversation fingerprints reset — the next `dream` will reprocess all conversations.',
          );
          if (report.errors.length > 0) console.log(`Errors: ${report.errors.join('; ')}`);
        } else {
          console.log(JSON.stringify(report));
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'WIPE_NO_CONFIRM') {
          process.exit(1);
        }
        handle(err);
      }
    });

  // fingerprints subcommand group
  const fingerprintsCmd = program
    .command('fingerprints')
    .description('Manage the fingerprint store used for incremental dream processing.');

  fingerprintsCmd
    .command('stats')
    .description('Show fingerprint store statistics.')
    .option('--pretty', 'human-readable output')
    .action(async (opts: { pretty?: boolean }) => {
      try {
        await printFingerprintStats(opts);
      } catch (err) {
        handle(err);
      }
    });

  fingerprintsCmd
    .command('clean')
    .description('Remove orphaned fingerprints (for files that no longer exist).')
    .option('--pretty', 'human-readable output')
    .option('--dry-run', 'show what would be removed without writing')
    .action(async (opts: { pretty?: boolean; dryRun?: boolean }) => {
      try {
        await cleanFingerprints(opts);
      } catch (err) {
        handle(err);
      }
    });
}

async function printFingerprintStats(opts: { pretty?: boolean }): Promise<void> {
  const { loadFingerprints, getOrphanedFingerprints } = await import('../util/fingerprints.js');
  const { statSync, existsSync } = await import('node:fs');
  const store = loadFingerprints();
  const tracked = Object.keys(store.files).length;
  const orphaned = getOrphanedFingerprints(store).length;

  let storeSize = 0;
  try {
    const { getConfig } = await import('../util/config.js');
    const { join } = await import('node:path');
    const { cachePath } = getConfig();
    const storePath = join(cachePath, '.fingerprints.json');
    if (existsSync(storePath)) {
      storeSize = statSync(storePath).size;
    }
  } catch {
    /* best-effort */
  }

  const sizeFmt = storeSize >= 1024 ? `${(storeSize / 1024).toFixed(1)} KB` : `${storeSize} B`;

  if (opts.pretty) {
    const w = (s: string) => process.stdout.write(s);
    w('\n  Fingerprint Store\n');
    w('  ══════════════════════════════════\n');
    w(`  Tracked files:  ${tracked}\n`);
    w(`  Orphaned:       ${orphaned}\n`);
    w(`  Last updated:   ${store.generatedAt}\n`);
    w(`  Store size:     ${sizeFmt}\n`);
    w('  ══════════════════════════════════\n\n');
  } else {
    process.stdout.write(
      `${JSON.stringify({
        tracked,
        orphaned,
        generatedAt: store.generatedAt,
        storeSizeBytes: storeSize,
      })}\n`,
    );
  }
}

async function cleanFingerprints(opts: { pretty?: boolean; dryRun?: boolean }): Promise<void> {
  const { loadFingerprints, saveFingerprints, getOrphanedFingerprints } = await import(
    '../util/fingerprints.js'
  );
  const store = loadFingerprints();
  const orphans = getOrphanedFingerprints(store);
  if (!opts.dryRun && orphans.length > 0) {
    const cleaned: typeof store = {
      ...store,
      files: Object.fromEntries(Object.entries(store.files).filter(([k]) => !orphans.includes(k))),
    };
    saveFingerprints(cleaned);
  }
  if (opts.pretty) {
    process.stdout.write(
      `  ${opts.dryRun ? '[dry-run] Would remove' : 'Removed'} ${orphans.length} orphaned fingerprints.\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify({ removed: orphans.length, dryRun: !!opts.dryRun })}\n`);
  }
}
