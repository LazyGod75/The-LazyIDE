/**
 * register-pipeline.ts — Brain-building pipeline commands.
 *
 * Registers: index-rebuild, interlink, dream, graph, build-index,
 *            build-clusters, build-hierarchy, enrich-hierarchy, enrich,
 *            export-agents-md, health-score, import, synthesize-nodes (stub),
 *            publish.
 */

import type { Command } from 'commander';
import { runBuildClusters } from '../commands/build-clusters.js';
import { runBuildIndex } from '../commands/build-index.js';
import { runDream } from '../commands/dream.js';
import { runGraph } from '../commands/graph.js';
import { type HealthDetailCategory, computeHealthDetail } from '../commands/health-detail.js';
import { computeHealthScore } from '../commands/health-score.js';
import { runImport } from '../commands/import.js';
import { runIndexRebuild } from '../commands/index-rebuild.js';
import { runInterlink } from '../commands/interlink.js';
import { runPublish } from '../commands/publish.js';
import { runReindex } from '../commands/reindex-missing.js';
import { getConfig } from '../util/config.js';

function handle(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lazybrain: ${msg}\n`);
  if (process.env.LAZYBRAIN_LOG_LEVEL === 'debug' && err instanceof Error) {
    process.stderr.write(`${err.stack}\n`);
  }
  const code = msg.includes('Schema validation') ? 4 : msg.includes('not found') ? 5 : 1;
  process.exit(code);
}

export function registerPipeline(program: Command): void {
  program
    .command('index-rebuild')
    .description('Rebuild FTS5 index from the HTML files.')
    .option('--pretty')
    .action(async (opts) => {
      try {
        process.stdout.write(`${await runIndexRebuild(opts)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('reindex')
    .description(
      'Diff-based reconciliation between note files on disk and the SQLite index ' +
        '(see commands/reindex-missing.ts). Dry-run by default.',
    )
    .option('--missing', 'index disk files with no index row, backfill missing embeddings, report ghost rows')
    .option('--dry-run', 'preview counts without writing (default: true)', true)
    .option('--no-dry-run', 'actually apply the reconciliation')
    .option('--delete-ghosts', 'also delete index rows whose file no longer exists on disk (requires --no-dry-run)')
    .option('--batch-size <n>', 'notes indexed/embedded per batch', (v) => Number.parseInt(v, 10), 200)
    .option('--pretty', 'human-readable output')
    .action(async (opts) => {
      try {
        const out = await runReindex(opts);
        process.stdout.write(`${out}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('interlink')
    .description('Wikipedia layer: inject wikilinks + see-also into all notes (sleep-time job).')
    .option('--dry-run', 'preview changes without writing')
    .option('--limit <n>', 'max notes to process per run', (v) => Number.parseInt(v, 10), 200)
    .option('--pretty', 'human-readable output')
    .action(async (opts) => {
      try {
        const out = await runInterlink(opts);
        process.stdout.write(`${out}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('dream')
    .description(
      'Offline brain maintenance: read conversations, expand stubs, enrich with Haiku, detect contradictions.',
    )
    .option('--dry-run', 'preview what would be done without writing', false)
    .option(
      '--enrich',
      'use Haiku to generate better TLDRs and topics (uses your Claude subscription)',
      false,
    )
    .option(
      '--max-notes <n>',
      'max notes to process per enrichment phase',
      (v) => Number.parseInt(v, 10),
      200,
    )
    .option('--pretty', 'human-readable output with progress bars', false)
    .option('--synthesize', 'Only run the synthesize phase (generate wiki overview pages)')
    .option('--topic <name>', 'Synthesize only this topic')
    .option('--force', 'ignore fingerprints and reprocess all conversations', false)
    .option('--agent <name>', 'restrict ingestion to one source: claude-code | vibe')
    .option(
      '--include-cwd-project',
      "include the engine's own project (cerveau/lazybrain) — disabled by default to avoid self-referential noise. Useful to demo code+conversation fusion on the engine itself.",
      false,
    )
    .action(async (opts) => {
      try {
        if (opts.includeCwdProject) {
          process.env.LAZYBRAIN_DREAM_INCLUDE_SELF = '1';
        }
        const report = await runDream({
          dryRun: opts.dryRun,
          enrich: opts.enrich,
          maxNotes: opts.maxNotes,
          pretty: opts.pretty,
          synthesizeOnly: !!opts.synthesize,
          topic: opts.topic,
          force: opts.force,
          agent: opts.agent,
        });
        if (!opts.pretty) {
          process.stdout.write(`${JSON.stringify(report)}\n`);
        }
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('synthesize-nodes')
    .description('[REMOVED] use `graph` + `build-hierarchy`')
    .action(() => {
      console.log('synthesize-nodes was removed; use `graph` + `build-hierarchy`.');
    });

  program
    .command('graph')
    .description(
      'Build the brain graph: auto-link mentions, backlinks index, clusters, view HTML + text.',
    )
    .option('--skip-autolink')
    .option('--skip-clusters')
    .option('--skip-view')
    .option('--format <fmt>', 'html|text|both (default: both)', 'both')
    .option('--topic <name>', 'filter sub-graph generation to this topic')
    .option(
      '--cwd <path>',
      'explicit project directory to code-scan (works even with no pre-existing notes)',
    )
    .option('--pretty')
    .action(async (opts) => {
      try {
        process.stdout.write(`${await runGraph(opts)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('build-index')
    .description('Regenerate brain/_index.html (atlas, metadata, JSON-LD global graph).')
    .option('--pretty')
    .action(async (opts) => {
      try {
        const out = await runBuildIndex(opts);
        process.stdout.write(`${JSON.stringify(out, null, opts.pretty ? 2 : 0)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('build-clusters')
    .description('Generate brain/clusters/<slug>/_cluster.html for each cwd.')
    .option('--pretty')
    .action(async (opts) => {
      try {
        const out = await runBuildClusters(opts);
        process.stdout.write(`${JSON.stringify(out, null, opts.pretty ? 2 : 0)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('build-hierarchy')
    .description('Build hierarchical knowledge-nodes (root → projects → modules → features)')
    .option('--force', 'Overwrite existing nodes')
    .option('--pretty', 'Pretty output')
    .action(async (opts) => {
      try {
        const { runBuildHierarchy } = await import('../commands/build-hierarchy.js');
        const report = await runBuildHierarchy(opts);
        if (opts.pretty) {
          console.log(
            `Built hierarchy: 1 root + ${report.projectsCreated} projects + ${report.modulesCreated} modules + ${report.featuresCreated} features = ${report.totalCreated} nodes`,
          );
          if (report.errors.length > 0)
            console.log(`Errors: ${report.errors.slice(0, 5).join('; ')}`);
        } else {
          console.log(JSON.stringify(report));
        }
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('enrich-hierarchy')
    .description('Aggregate conversation content into hierarchy knowledge-nodes')
    .option('--force', 'Re-enrich all nodes')
    .option('--topic <name>', 'Only enrich nodes under this topic')
    .option('--pretty', 'Pretty output')
    .action(async (opts) => {
      try {
        const { runEnrichHierarchy } = await import('../commands/enrich-hierarchy.js');
        const report = await runEnrichHierarchy(opts);
        if (opts.pretty) {
          console.log(
            `Enriched ${report.nodesEnriched} hierarchy nodes, ${report.sectionsPopulated} sections from ${report.conversationsScanned} convs`,
          );
          if (report.errors.length > 0)
            console.log(`Errors: ${report.errors.slice(0, 5).join('; ')}`);
        } else {
          console.log(JSON.stringify(report));
        }
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('enrich')
    .description(
      'Enrich canonical code-first neurons (file-neuron, concept-neuron) from conversation tool-traces',
    )
    .option(
      '--topic <name>',
      'Only enrich neurons for this topic (no-op: enrichment is file-trace driven)',
    )
    .option('--force', 'Re-enrich already populated neurons')
    .option('--pretty', 'Pretty output')
    .action(async (opts) => {
      try {
        const { runEnrich } = await import('../commands/enrich.js');
        const report = await runEnrich(opts);
        if (opts.pretty) {
          console.log(
            `File-neurons enriched: ${report.fileNeuronsEnriched ?? 0}, concept neurons created: ${report.conceptNeuronsCreated ?? 0}`,
          );
          if (report.errors.length > 0)
            console.log(`Errors: ${report.errors.slice(0, 5).join('; ')}`);
        } else {
          console.log(JSON.stringify(report));
        }
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('export-agents-md')
    .description('Project the brain into an AGENTS.md section (Vibe auto-loads it).')
    .option('--target <t>', 'user | project', 'project')
    .option('--cwd <path>', 'project root (project target)')
    .option('--out-file <path>', 'override output file')
    .option(
      '--max-tokens <n>',
      'token budget for the generated block',
      (v) => Number.parseInt(v, 10),
      1200,
    )
    .option('--pretty')
    .action(async (opts) => {
      try {
        const { runExportAgentsMd } = await import('../commands/export-agents-md.js');
        const report = await runExportAgentsMd({
          target: opts.target === 'user' ? 'user' : 'project',
          cwd: opts.cwd,
          outFile: opts.outFile,
          maxTokens: opts.maxTokens,
          pretty: opts.pretty,
        });
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('health-score')
    .description(
      'Compute brain health score [0..100]: orphans, broken links, stale notes, duplicates. Writes cerveau-health meta to _index.html.',
    )
    .option('--pretty', 'human-readable output')
    .action(async (opts) => {
      try {
        const result = await computeHealthScore(getConfig().brainPath);
        if (opts.pretty) {
          process.stdout.write(
            `Health score: ${result.score}/100\n` +
              `  Orphans:      ${result.orphans}\n` +
              `  Broken links: ${result.brokenLinks}\n` +
              `  Stale:        ${result.stale}\n` +
              `  Dupes:        ${result.dupes}\n`,
          );
        } else {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        }
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('health-detail')
    .description(
      'Read-only breakdown for one health-score category (orphans, brokenLinks, duplicates) — ' +
        'the dry-run list behind Settings > Memory\'s "view details" action. Never writes to the brain.',
    )
    .requiredOption('--category <category>', 'orphans | brokenLinks | duplicates')
    .action((opts: { category: string }) => {
      try {
        const category = opts.category as HealthDetailCategory;
        if (category !== 'orphans' && category !== 'brokenLinks' && category !== 'duplicates') {
          throw new Error(
            `invalid --category: ${opts.category} (expected orphans | brokenLinks | duplicates)`,
          );
        }
        const result = computeHealthDetail(category);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('import')
    .description(
      'Batch-import conversation history from Claude Code, Cursor, ChatGPT, or Claude.ai exports.',
    )
    .requiredOption(
      '--source <source>',
      'claude-code | cursor | chatgpt-export | claude-export | auto',
    )
    .option('--input <path>', 'path to export file (required for chatgpt-export and claude-export)')
    .option('--dry-run', 'count and estimate without writing', false)
    .option('--use-llm', 'use LLM augmentation for enrichment (ignored in dry-run)', false)
    .option('--since <iso>', 'only import conversations updated after this ISO timestamp')
    .option('--limit <n>', 'max conversations to import per run', (v: string) =>
      Number.parseInt(v, 10),
    )
    .action(async (opts) => {
      try {
        const result = await runImport({
          source: opts.source as string,
          input: opts.input as string | undefined,
          dryRun: !!opts.dryRun,
          useLlm: !!opts.useLlm,
          since: opts.since as string | undefined,
          limit: opts.limit as number | undefined,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } catch (err) {
        handle(err);
      }
    });

  program
    .command('publish')
    .description('Publish a scrubbed copy of the brain (dry-run by default).')
    .option(
      '--out-dir <path>',
      'output directory (default: ../public or ../public-site for --site)',
    )
    .option('--out <path>', 'alias for --out-dir')
    .option('--dry-run', 'report what would be generated without writing (default)')
    .option('--confirm', 'actually write the output folder')
    .option('--exclude-tier <tier>', 'archival|working')
    .option('--pretty', 'human-readable output')
    .option(
      '--profile <profile>',
      'scrub profile: public-strict (default, strips provenance) | default (keeps provenance)',
      'public-strict',
    )
    .option('--site', 'generate a self-contained static SPA site (GitHub Pages ready)')
    .option('--base-url <url>', 'site base URL for sitemap.xml and OpenGraph (--site mode)')
    .option('--site-title <title>', 'site <title> and og:title (--site mode)')
    .option(
      '--topic <prefix>',
      'include ONLY notes whose data-cerveau-topic starts with this prefix (case-insensitive)',
    )
    .action((opts) => {
      try {
        const validProfiles = ['default', 'public-strict'];
        if (opts.profile && !validProfiles.includes(opts.profile)) {
          throw new Error(
            `Invalid --profile "${opts.profile}". Accepted values: ${validProfiles.join(', ')}`,
          );
        }
        const mergedOpts = { ...opts, outDir: opts.outDir ?? opts.out };
        process.stdout.write(`${runPublish(mergedOpts)}\n`);
      } catch (err) {
        handle(err);
      }
    });
}
