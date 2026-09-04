import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listAll } from '../indexer/fts.js';
import { generateSite } from '../publish/site.js';
import { type PublishProfile, scrubForPublic } from '../schema/scrubber.js';
import { batchesDir, brainRoot, notesDir } from '../store/paths.js';
import { readAllNotes } from '../store/reader.js';

export interface PublishCliOptions {
  outDir?: string;
  dryRun?: boolean;
  confirm?: boolean;
  excludeTier?: 'archival' | 'working';
  pretty?: boolean;
  profile?: PublishProfile;
  /** When true, generate a full static SPA site instead of raw HTML files. */
  site?: boolean;
  /** Base URL used in sitemap.xml and OpenGraph tags (--site mode only). */
  baseUrl?: string;
  /** Site title for OpenGraph (--site mode only). */
  siteTitle?: string;
  /**
   * When set, include ONLY notes whose data-cerveau-topic starts with this
   * prefix (case-insensitive). Notes without a topic are excluded when this
   * option is provided.
   */
  topic?: string;
}

export interface ScrubReport {
  notesPublished: number;
  notesBlocked: number;
  blockedReasons: Array<{ id: string; reason: string }>;
  provenanceAttrsStripped: number;
  pathsScrubbed: number;
  sensitivePatternsDetected: string[];
}

interface AcceptedNote {
  id: string;
  path: string;
  cleaned: string;
  warnings: string[];
  provenanceAttrsStripped: number;
  pathsScrubbed: number;
}

/**
 * Publish a scrubbed copy of the brain.
 *
 * Two modes:
 *   default  — raw HTML files + index; ready for GitHub Pages static hosting
 *   --site   — full SPA (brain-ui copied + data/ files) for wiki experience
 *
 * Profiles (public-strict is the safe-by-default; pass --profile default to opt out):
 *   public-strict — strips session/git/cwd provenance attributes (default)
 *   default       — standard scrubbing, provenance attributes preserved
 *
 * Dry-run by default; pass --confirm to write files.
 * NEVER pushes — that's left to the user.
 */
export function runPublish(opts: PublishCliOptions): string {
  if (opts.site) {
    return runPublishSite(opts);
  }
  return runPublishRaw(opts);
}

// ---------------------------------------------------------------------------
// --site mode
// ---------------------------------------------------------------------------

function runPublishSite(opts: PublishCliOptions): string {
  const profile = opts.profile ?? 'public-strict';
  const isDryRun = opts.dryRun || !opts.confirm;

  const { dryRun, result, wouldPublish, blockedCount } = generateSite({
    outDir: opts.outDir,
    profile,
    excludeTier: opts.excludeTier,
    baseUrl: opts.baseUrl,
    siteTitle: opts.siteTitle,
    dryRun: isDryRun,
    topic: opts.topic,
  });

  if (dryRun) {
    return JSON.stringify({
      status: 'dry-run',
      mode: 'site',
      profile,
      would_publish: wouldPublish,
      blocked: blockedCount,
    });
  }

  if (!result) {
    return JSON.stringify({ status: 'error', message: 'Site generation failed unexpectedly.' });
  }

  if (result.notesBlocked > 0) {
    return JSON.stringify({
      status: 'blocked',
      mode: 'site',
      message: `${result.notesBlocked} note(s) blocked. Fix or exclude them.`,
      failures: result.blockedReasons,
    });
  }

  if (opts.pretty) {
    return buildSitePrettyReport(result);
  }

  return JSON.stringify({
    status: 'ok',
    mode: 'site',
    out_dir: result.outputDir,
    published: result.notesPublished,
  });
}

function buildSitePrettyReport(result: import('../publish/types.js').SiteGenerationResult): string {
  const lines = [
    `Site generated: ${result.notesPublished} notes → ${result.outputDir}`,
    '',
    'SCRUB REPORT',
    `  Notes published          : ${result.notesPublished}`,
    `  Notes blocked            : ${result.notesBlocked}`,
    `  Provenance attrs stripped: ${result.provenanceAttrsStripped}`,
    `  Private paths scrubbed   : ${result.pathsScrubbed}`,
    `  Sensitive patterns found : ${result.sensitivePatternsDetected.length > 0 ? result.sensitivePatternsDetected.join(', ') : 'none'}`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Raw (non-site) mode — original behavior unchanged
// ---------------------------------------------------------------------------

function runPublishRaw(opts: PublishCliOptions): string {
  const target = opts.outDir ?? join(brainRoot(), '..', 'public');
  const profile = opts.profile ?? 'public-strict';
  const notes = readAllNotes();
  const allIndex = listAll({ includeExpired: false });

  const failures: Array<{ id: string; reason: string }> = [];
  const accepted: AcceptedNote[] = [];
  const allDetectedPatterns = new Set<string>();
  let totalProvenanceStripped = 0;
  let totalPathsScrubbed = 0;

  for (const note of notes) {
    if (shouldExclude(note, opts, allIndex)) continue;
    if (shouldExcludeByTopic(note, opts.topic, allIndex)) continue;

    const result = scrubForPublic(note.html, { profile });

    for (const p of result.detectedPatterns) {
      allDetectedPatterns.add(p);
    }

    if (result.blockedReason) {
      failures.push({ id: note.id, reason: result.blockedReason });
      continue;
    }

    totalProvenanceStripped += result.strippedProvenanceAttrs.length;
    totalPathsScrubbed += result.pathsScrubbed;

    accepted.push({
      id: note.id,
      path: note.path,
      cleaned: result.cleaned,
      warnings: result.warnings,
      provenanceAttrsStripped: result.strippedProvenanceAttrs.length,
      pathsScrubbed: result.pathsScrubbed,
    });
  }

  const report: ScrubReport = {
    notesPublished: accepted.length,
    notesBlocked: failures.length,
    blockedReasons: failures,
    provenanceAttrsStripped: totalProvenanceStripped,
    pathsScrubbed: totalPathsScrubbed,
    sensitivePatternsDetected: [...allDetectedPatterns],
  };

  if (failures.length > 0) {
    return JSON.stringify({
      status: 'blocked',
      message: `${failures.length} note(s) blocked. Fix or pass --exclude flags.`,
      failures,
      report,
    });
  }

  if (opts.dryRun || !opts.confirm) {
    return JSON.stringify({
      status: 'dry-run',
      out_dir: target,
      profile,
      would_publish: accepted.length,
      warnings_total: accepted.reduce((s, a) => s + a.warnings.length, 0),
      preview: accepted.slice(0, 3).map((a) => ({ id: a.id, warnings: a.warnings })),
      report,
    });
  }

  // Real publish
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const indexEntries: string[] = [];
  for (const a of accepted) {
    const relPath = resolveRelPath(a.path, a.id);
    const outFile = join(target, relPath);
    mkdirSync(join(outFile, '..'), { recursive: true });
    writeFileSync(outFile, wrapPage(a.id, a.cleaned), 'utf8');
    indexEntries.push(`  <li><a href="${relPath.replace(/\\/g, '/')}">${a.id}</a></li>`);
  }

  const indexHtml = buildIndexHtml(indexEntries);
  writeFileSync(join(target, 'index.html'), indexHtml, 'utf8');
  writeFileSync(join(target, 'style.css'), defaultCss(), 'utf8');

  if (opts.pretty) {
    return buildPrettyReport(accepted.length, target, report);
  }

  return JSON.stringify({ status: 'ok', out_dir: target, published: accepted.length, report });
}

function shouldExclude(
  note: { id: string; path: string },
  opts: PublishCliOptions,
  allIndex: Array<{ id: string; path: string }>,
): boolean {
  if (!opts.excludeTier) return false;
  const indexEntry = allIndex.find((n) => n.id === note.id);
  if (!indexEntry) return false;
  const isArchival = indexEntry.path.includes('batches');
  const isWorking = !isArchival;
  return (
    (opts.excludeTier === 'archival' && isArchival) || (opts.excludeTier === 'working' && isWorking)
  );
}

function shouldExcludeByTopic(
  note: { id: string },
  topicPrefix: string | undefined,
  allIndex: Array<{ id: string; topic?: string | null }>,
): boolean {
  if (!topicPrefix) return false;
  const indexEntry = allIndex.find((n) => n.id === note.id);
  const noteTopic = indexEntry?.topic ?? null;
  if (!noteTopic) return true; // no topic → exclude when filter is active
  return !noteTopic.toLowerCase().startsWith(topicPrefix.toLowerCase());
}

function resolveRelPath(notePath: string, id: string): string {
  if (notePath.startsWith(notesDir())) {
    return notePath.slice(notesDir().length + 1);
  }
  if (notePath.startsWith(batchesDir())) {
    return join('batches', notePath.slice(batchesDir().length + 1));
  }
  return `${id}.html`;
}

function buildPrettyReport(published: number, target: string, report: ScrubReport): string {
  const lines = [
    `Published ${published} notes to ${target}`,
    '',
    'SCRUB REPORT',
    `  Notes published          : ${report.notesPublished}`,
    `  Notes blocked            : ${report.notesBlocked}`,
    `  Provenance attrs stripped: ${report.provenanceAttrsStripped}`,
    `  Private paths scrubbed   : ${report.pathsScrubbed}`,
    `  Sensitive patterns found : ${report.sensitivePatternsDetected.length > 0 ? report.sensitivePatternsDetected.join(', ') : 'none'}`,
  ];
  if (report.blockedReasons.length > 0) {
    lines.push('  Blocked notes:');
    for (const b of report.blockedReasons) {
      lines.push(`    - ${b.id}: ${b.reason}`);
    }
  }
  return lines.join('\n');
}

function wrapPage(id: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${id}</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'self';">
  <link rel="stylesheet" href="../style.css">
</head>
<body>
${body}
</body>
</html>`;
}

function buildIndexHtml(indexEntries: string[]): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Brain — public index</title>
  <meta name="generator" content="LazyBrain">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; object-src 'none'; base-uri 'self';">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Brain — index</h1>
  <ul>
${indexEntries.join('\n')}
  </ul>
</body>
</html>`;
}

function defaultCss(): string {
  return `body { max-width: 760px; margin: 2em auto; padding: 0 1em; font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #222; background: #fafafa; }
h1, h2, h3 { line-height: 1.2; }
a { color: #036; }
[data-cerveau-fact] { padding-left: 1em; border-left: 3px solid #ccc; }
[data-cerveau-fact][data-cerveau-confidence="1.00"] { border-color: #2a2; }
memory-batch { display: block; background: #fff; border: 1px solid #ddd; padding: 1em; }
`;
}
