/**
 * register-core.ts — Core note management commands.
 *
 * Registers: search, query, store, link, invalidate, capture, compress,
 *            neighbours, extract, inject-context, stats, prune, profile-update.
 */

import type { Command } from 'commander';
import { runCapture } from '../commands/capture.js';
import { runCompress } from '../commands/compress.js';
import { runExtract } from '../commands/extract.js';
import { runInjectContext } from '../commands/inject-context.js';
import { parseNudgeStyle } from '../commands/inject-context/markers.js';
import { runInvalidate } from '../commands/invalidate.js';
import { runLink } from '../commands/link.js';
import { runNeighbours } from '../commands/neighbours.js';
import { runProfileUpdate } from '../commands/profile-update.js';
import { runPrune } from '../commands/prune.js';
import { runQuery } from '../commands/query.js';
import { runRecomposeAll } from '../commands/recompose-all.js';
import { runRecompose } from '../commands/recompose.js';
import { runRepairUnInvalidateNoise } from '../commands/repair.js';
import { runSearch } from '../commands/search.js';
import { runStats } from '../commands/stats.js';
import { runStore } from '../commands/store.js';

function handle(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lazybrain: ${msg}\n`);
  if (process.env.LAZYBRAIN_LOG_LEVEL === 'debug' && err instanceof Error) {
    process.stderr.write(`${err.stack}\n`);
  }
  const code = msg.includes('Schema validation') ? 4 : msg.includes('not found') ? 5 : 1;
  process.exit(code);
}

export function registerCore(program: Command): void {
  program
    .command('search <query>')
    .description('Adaptive retrieval (router L1-L4). Default mode is auto.')
    .option('-t, --top <n>', 'top K results', (v) => Number.parseInt(v, 10), 5)
    .option('-m, --mode <mode>', 'l1|l2|l3|l4|auto', 'auto')
    .option('--strip', 'output stripped text only (for LLM injection)')
    .option('--pretty', 'human-readable output')
    .option('--diversity <lambda>', 'MMR lambda [0..1]', Number.parseFloat)
    .option('--include-expired', 'include invalidated notes')
    .option('--type <type>', 'filter by data-cerveau-type')
    .option('--tag <tag>', 'filter by tag')
    .option('--cwd <path>', 'bias PageRank toward notes captured in this working directory')
    .option('--page-rank-weight <w>', 'blend factor for PageRank in [0..1]', Number.parseFloat)
    .action(async (query, opts) => {
      try {
        const out = await runSearch({ query, ...opts });
        process.stdout.write(`${out}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('query <selector>')
    .description('CSS selector query (L1, deterministic, < 5ms).')
    .option('-a, --attribute <name>', 'extract a specific attribute')
    .option('-l, --limit <n>', 'limit results', (v) => Number.parseInt(v, 10), 50)
    .option('--strip', 'output stripped text only')
    .option('--pretty', 'human-readable output')
    .action((selector, opts) => {
      try {
        process.stdout.write(`${runQuery({ selector, ...opts })}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('store')
    .description('Store a new HTML note. Reads from stdin or --from-file.')
    .option('--from-file <path>')
    .option('--from-stdin', 'read HTML from stdin (default)')
    .option('--overwrite')
    .option(
      '--upsert-if-richer',
      'if a note with the same id exists, replace it only when the new body is richer (preserves created, refreshes updated)',
    )
    .option('--pretty')
    .action(async (opts) => {
      try {
        const out = await runStore(opts);
        process.stdout.write(`${out}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('link <fromId> <toId>')
    .description('Create a bidirectional link with optional type and strength.')
    .option('-t, --type <type>', 'refines|contradicts|generalizes|cites|replaces|follows-from')
    .option('-s, --strength <value>', 'link strength 0..1', Number.parseFloat)
    .option('--pretty')
    .action((fromId, toId, opts) => {
      try {
        process.stdout.write(`${runLink({ fromId, toId, ...opts })}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('recompose <noteId>')
    .description(
      'Patch enrichment sections of a file-neuron from a JSON items list (no code rescan).',
    )
    .option('--items-file <path>', 'read items JSON from file (default: stdin)')
    .option('--items-stdin', 'read items JSON from stdin')
    .action(async (noteId, opts) => {
      try {
        const out = await runRecompose({ noteId, ...opts });
        process.stdout.write(`${out}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('recompose-all')
    .description('Patch authored items into every file-neuron that has them (no code rescan).')
    .action(async () => {
      try {
        const report = await runRecomposeAll();
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('invalidate <id>')
    .description('Mark a note as invalidated (sets data-cerveau-valid-until).')
    .option('--replaced-by <id>')
    .option('--reason <text>')
    .option('--pretty')
    .action((id, opts) => {
      try {
        process.stdout.write(`${runInvalidate({ id, ...opts })}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('capture')
    .description('Capture a session transcript into the brain.')
    .option('--from-file <path>')
    .option('--from-stdin')
    .option('--session <id>')
    .option('--cwd <path>')
    .option('--async', 'queue without processing (PostToolUse)')
    .option('--flush-sync', 'flush queued captures synchronously (PreCompact)')
    .option('--use-llm', 'use LLM augmentation when heuristic confidence is low')
    .option('--pretty')
    .action(async (opts) => {
      try {
        const out = await runCapture(opts);
        process.stdout.write(`${out}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('compress')
    .description('Consolidate working-tier notes into a <memory-batch>.')
    .option('--session <id>')
    .option(
      '--older-than-days <n>',
      'compress notes older than N days',
      (v) => Number.parseInt(v, 10),
      7,
    )
    .option('--dry-run')
    .option('--purge-noise', 'retroactively invalidate notes that fail the capture validator')
    .option(
      '--purge-source <prefix>',
      'hard-delete notes whose data-cerveau-source starts with prefix (e.g. "bench:locomo")',
    )
    .option('--pretty')
    .action((opts) => {
      try {
        process.stdout.write(`${runCompress(opts)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('neighbours')
    .description('1-hop graph neighbours for a note id (supersession, triples, shared entities).')
    .argument('<id>', 'note id (with or without leading #)')
    .option('--pretty')
    .action((id, opts) => {
      try {
        process.stdout.write(`${runNeighbours({ id, ...opts })}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('extract')
    .description(
      'Batch LLM extraction (Haiku) for low-quality notes. Opt-in via LAZYBRAIN_EXTRACTOR=haiku.',
    )
    .option('--batch-size <n>', 'max notes per call', (v) => Number.parseInt(v, 10), 10)
    .option('--dry-run')
    .option('--pretty')
    .action(async (opts) => {
      try {
        const out = await runExtract(opts);
        process.stdout.write(`${out}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('inject-context')
    .description('Generate stripped context for SessionStart / UserPromptSubmit injection.')
    .option('--max-tokens <n>', 'token budget', (v) => Number.parseInt(v, 10), 3000)
    .option('--prefer-recent')
    .option('--prefer-important')
    .option('--mode <mode>', 'session | turn | marker | highlights', 'session')
    .option('--format <fmt>', 'full (default) or compact (headline+index)', 'full')
    .option('--query <q>', 'query (required when --mode=turn)')
    .option('--min-score <n>', 'relevance threshold for turn mode', (v) => Number.parseFloat(v))
    .option('--cwd <path>', 'working directory hint')
    .option(
      '--session-id <id>',
      'Q3 differential injection: skip notes already shown to this session (turn mode)',
    )
    .option(
      '--nudge <style>',
      'skill|tool|none — how to tell the model to search memory further (default: skill)',
    )
    .option('--pretty')
    .action(async (opts) => {
      try {
        const out = await runInjectContext({ ...opts, nudge: parseNudgeStyle(opts.nudge) });
        process.stdout.write(`${out}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('stats')
    .description('Show live telemetry stats.')
    .option('--window-hours <n>', 'window size in hours', (v) => Number.parseInt(v, 10), 24)
    .option('--pretty')
    .action((opts) => {
      try {
        process.stdout.write(`${runStats(opts)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('profile-update')
    .description('Rebuild the auto-generated user profile note from recent activity.')
    .option(
      '--min-occurrences <n>',
      'min note count for a tag to be considered stable',
      (v) => Number.parseInt(v, 10),
      3,
    )
    .option('--force')
    .option('--pretty')
    .action((opts) => {
      try {
        process.stdout.write(`${runProfileUpdate(opts)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('prune')
    .description(
      'Remove noise notes and backup directories from the brain. Dry-run by default — use --apply to actually delete.',
    )
    .option(
      '--policy <policies>',
      'comma-separated list of policies: claude-mem-observer,session-dream,empty-tldr,backup-dirs (default: all)',
    )
    .option('--dry-run', 'preview candidates without deleting (default)')
    .option('--apply', 'actually delete the matched files and directories')
    .option('--pretty', 'human-readable output')
    .action((opts: { policy?: string; dryRun?: boolean; apply?: boolean; pretty?: boolean }) => {
      try {
        const dryRun = !opts.apply;
        const report = runPrune({ policy: opts.policy, dryRun });
        if (opts.pretty) {
          printPruneReport(report);
        } else {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        }
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('repair')
    .description(
      'Targeted, tag-scoped undo for notes damaged by a known bug (see engine/src/commands/repair.ts). Applies immediately unless --dry-run is passed.',
    )
    .option(
      '--un-invalidate-noise',
      'remove dream-noise-cleanup invalidation stamps from notes carrying --tags',
    )
    .option(
      '--tags <tags>',
      'comma-separated tags to scope the repair (default: mission,agent,skill)',
    )
    .option('--dry-run', 'preview candidates without modifying anything')
    .option('--pretty', 'human-readable output')
    .action(
      (opts: {
        unInvalidateNoise?: boolean;
        tags?: string;
        dryRun?: boolean;
        pretty?: boolean;
      }) => {
        try {
          if (!opts.unInvalidateNoise) {
            throw new Error('repair: specify an action, e.g. --un-invalidate-noise');
          }
          const tags = opts.tags
            ? opts.tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : undefined;
          const report = runRepairUnInvalidateNoise({ tags, dryRun: Boolean(opts.dryRun) });
          if (opts.pretty) {
            printRepairReport(report);
          } else {
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          }
        } catch (err) {
          handle(err);
        }
      },
    );
}

function printRepairReport(report: ReturnType<typeof runRepairUnInvalidateNoise>): void {
  const w = (s: string) => process.stdout.write(s);
  w('\n');
  w('  Repair report\n');
  w('  ════════════════════════════════════════════\n');
  w(`  Action:            ${report.action}\n`);
  w(`  Mode:              ${report.dryRun ? 'dry-run (nothing modified)' : 'APPLIED'}\n`);
  w(`  Tags:              ${report.tags.join(', ')}\n`);
  w(`  Candidates:        ${report.candidates.length}\n`);
  if (!report.dryRun) {
    w(`  Repaired:          ${report.repaired}\n`);
  }
  w('  ════════════════════════════════════════════\n');
  if (report.candidates.length > 0) {
    w(report.dryRun ? '\n  Candidates (dry-run — nothing modified):\n' : '\n  Repaired:\n');
    for (const c of report.candidates.slice(0, 50)) {
      w(`    ${c.id} [${c.tags.join(',')}]\n`);
    }
    if (report.candidates.length > 50) {
      w(`    ... and ${report.candidates.length - 50} more\n`);
    }
  }
  w('\n');
}

function printPruneReport(report: ReturnType<typeof runPrune>): void {
  const w = (s: string) => process.stdout.write(s);
  w('\n');
  w('  Prune report\n');
  w('  ════════════════════════════════════════════\n');
  w(
    `  Mode:              ${report.dryRun ? 'dry-run (no files deleted)' : 'APPLY (files deleted)'}\n`,
  );
  w(`  Policies:          ${report.policies.join(', ')}\n`);
  w('\n  Candidates by policy:\n');
  for (const policy of report.policies) {
    w(`    ${policy.padEnd(24)} ${report.counts[policy]}\n`);
  }
  w('\n');
  w(`  Total file candidates: ${report.totalFiles}\n`);
  w(`  Total dir candidates:  ${report.totalDirs}\n`);
  if (!report.dryRun) {
    w(`  Deleted:               ${report.deleted}\n`);
  }
  w('  ════════════════════════════════════════════\n');

  if (report.candidates.length > 0 && report.dryRun) {
    w('\n  Candidates (dry-run — nothing deleted):\n');
    for (const c of report.candidates.slice(0, 50)) {
      w(`    [${c.policy}] ${c.path}\n`);
      w(`      Reason: ${c.reason}\n`);
    }
    if (report.candidates.length > 50) {
      w(`    ... and ${report.candidates.length - 50} more\n`);
    }
    w('\n  Run with --apply to delete these files.\n');
  }
  w('\n');
}
