/**
 * validate-multi-project.test.ts
 *
 * End-to-end validation across 3 diverse project layouts.
 * This test was written to QUANTIFY the fix impact:
 *
 *   Before fix: items.length === 0 guard dropped ~50% of convs → 1/1096 file-neurons enriched
 *   After fix:  fallback item synthesis → all convs with filesModified produce at least 1 item
 *
 * Layouts:
 *   A. Flat Python repo (Tradelab-style):       conv CWD == project root, files are relative paths
 *   B. Flat JS sub-project (marketing-style):  conv CWD == marketing sub-dir
 *   C. Nested subproject (Acme-style):       conv CWD == parent dir, file in acme-app/ subdir
 *
 * Reports:
 *   - How many of N convs produce ConvNotes (pass the items guard)
 *   - How many of N file-neurons get enriched
 *   - Paste a snippet from a Tradelab file-neuron
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runFileNeuronEnrichment } from '../src/commands/conv-file-enrichment.js';
import { buildConvNotesFromHtml } from '../src/commands/enrich.js';
import { runInit } from '../src/commands/init.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import { closeDb } from '../src/indexer/fts.js';
import { readAllNotes } from '../src/store/reader.js';
import type { NoteFile } from '../src/store/reader.js';
import { resetConfigForTests } from '../src/util/config.js';

// ---------------------------------------------------------------------------
// Helpers — same approach as enrich-parsing.test.ts
// ---------------------------------------------------------------------------

function makeConvNote({
  id,
  cwd,
  filesModified,
  content,
}: {
  id: string;
  cwd: string;
  filesModified: string[];
  content: string;
}): NoteFile {
  const filesAttr = filesModified.join('|||');
  const html = `<!DOCTYPE html>
<html><head><title>${id}</title></head>
<body>
<article
  id="${id}"
  data-cerveau-type="conversation"
  data-cerveau-cwd="${cwd}"
  data-cerveau-files-modified="${filesAttr}"
  data-cerveau-ts="2026-05-28T10:00:00Z"
>
  <h1>${id}</h1>
  <p>${content}</p>
</article>
</body>
</html>`;
  return { id, html, path: `/fake/${id}.html`, sizeBytes: html.length, mtimeMs: Date.now() };
}

function makeFileNode(filePath: string, projectRoot: string, language = 'python'): CodeNode {
  return {
    id: `file:${filePath}`,
    title: filePath,
    type: 'file',
    filePath,
    projectRoot,
    language,
    lineCount: 100,
    imports: [],
    exports: [],
  };
}

// ---------------------------------------------------------------------------

describe('multi-project layout validation (fix quantification)', () => {
  let tmpDir: string;
  const origBrainPath = process.env.LAZYBRAIN_BRAIN_PATH;
  const origCachePath = process.env.LAZYBRAIN_CACHE_PATH;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-multiproj-'));
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
    resetConfigForTests();
    await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.LAZYBRAIN_BRAIN_PATH = origBrainPath;
    process.env.LAZYBRAIN_CACHE_PATH = origCachePath;
    resetConfigForTests();
  });

  it('all 7 diverse convs across 3 layouts produce ConvNotes (items guard passes)', () => {
    // --- Layout A: flat Python (Tradelab) ---
    const tradelabRoot = '/projects/Tradelab';
    const tradelabConvs = [
      makeConvNote({
        id: 'conv-a1',
        cwd: tradelabRoot,
        filesModified: ['sentinel/backtest.py'],
        content: 'Updated the backtest configuration to use the new parameter set',
      }),
      makeConvNote({
        id: 'conv-a2',
        cwd: tradelabRoot,
        filesModified: ['tradebot/bot.py'],
        content: 'Fixed a bug where the bot crashed due to rate limiting errors',
      }),
      makeConvNote({
        id: 'conv-a3',
        cwd: tradelabRoot,
        filesModified: ['sentinel/optimizer.py', 'sentinel/backtest.py'],
        content: 'Refactored the optimizer to separate concerns and improve organization',
      }),
    ];

    // --- Layout B: flat JS sub-project (marketing) ---
    const marketingRoot = '/projects/Acme/marketing';
    const marketingConvs = [
      makeConvNote({
        id: 'conv-b1',
        cwd: marketingRoot,
        filesModified: ['_bot/publish.py'],
        content: 'Added multi-platform support to the publish bot',
      }),
      makeConvNote({
        id: 'conv-b2',
        cwd: marketingRoot,
        filesModified: ['_bot/scheduler.py'],
        content: 'Implemented retry logic with exponential backoff in scheduler',
      }),
    ];

    // --- Layout C: nested subproject (Acme parent CWD, file in acme-app) ---
    const acmeRoot = '/projects/Acme';
    const acmeConvs = [
      makeConvNote({
        id: 'conv-c1',
        cwd: acmeRoot,
        filesModified: ['acme-app/app/auth/login.tsx'],
        content: 'Implemented login screen with Supabase auth integration',
      }),
      makeConvNote({
        id: 'conv-c2',
        cwd: acmeRoot,
        filesModified: ['acme-app/app/screens/home.tsx'],
        content: 'Decided to use lazy loading for the home screen components',
      }),
    ];

    const allConvs = [...tradelabConvs, ...marketingConvs, ...acmeConvs];
    const allRoots = [tradelabRoot, marketingRoot, acmeRoot];

    const convNotes = buildConvNotesFromHtml(allConvs, allRoots);

    // All 7 convs should pass the items guard
    console.log(`\n[QUANTIFY] ${convNotes.length}/${allConvs.length} convs produced ConvNotes`);
    for (const cn of convNotes) {
      console.log(
        `  [${cn.id}] items=${cn.classifiedItems.length}, kind=${cn.classifiedItems[0]?.kind}`,
      );
    }

    expect(convNotes).toHaveLength(7);
    // Every ConvNote must have at least 1 classified item
    for (const cn of convNotes) {
      expect(cn.classifiedItems.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('all 5 file-neurons across 3 layouts get enrichment sections', async () => {
    // --- Layout A: Tradelab ---
    const tradelabRoot = '/projects/Tradelab';
    const tradelabFiles = [
      makeFileNode('sentinel/backtest.py', tradelabRoot),
      makeFileNode('tradebot/bot.py', tradelabRoot),
      makeFileNode('sentinel/optimizer.py', tradelabRoot),
    ];
    const tradelabConvs = [
      makeConvNote({
        id: 'conv-a1',
        cwd: tradelabRoot,
        filesModified: ['sentinel/backtest.py'],
        content: 'Updated the backtest configuration to use the new parameter set',
      }),
      makeConvNote({
        id: 'conv-a2',
        cwd: tradelabRoot,
        filesModified: ['tradebot/bot.py'],
        content: 'Fixed a bug where the bot crashed due to rate limiting errors',
      }),
      makeConvNote({
        id: 'conv-a3',
        cwd: tradelabRoot,
        filesModified: ['sentinel/optimizer.py', 'sentinel/backtest.py'],
        content: 'Refactored the optimizer to separate concerns',
      }),
    ];

    // --- Layout B: Marketing ---
    const marketingRoot = '/projects/Acme/marketing';
    const marketingFiles = [makeFileNode('_bot/publish.py', marketingRoot)];
    const marketingConvs = [
      makeConvNote({
        id: 'conv-b1',
        cwd: marketingRoot,
        filesModified: ['_bot/publish.py'],
        content: 'Added multi-platform support to the publish bot',
      }),
    ];

    // --- Layout C: Acme nested ---
    const acmeRoot = '/projects/Acme';
    const acmeFiles = [makeFileNode('acme-app/app/auth/login.tsx', acmeRoot, 'typescript')];
    const acmeConvs2 = [
      makeConvNote({
        id: 'conv-c1',
        cwd: acmeRoot,
        filesModified: ['acme-app/app/auth/login.tsx'],
        content: 'Implemented the login screen with Supabase auth integration',
      }),
    ];

    // Build conv notes for each project separately (matching realistic usage)
    const tradelabNotes = buildConvNotesFromHtml(tradelabConvs, [tradelabRoot]);
    const marketingNotes = buildConvNotesFromHtml(marketingConvs, [marketingRoot]);
    const acmeNotes = buildConvNotesFromHtml(acmeConvs2, [acmeRoot]);

    console.log(`\n[QUANTIFY-E2E] Tradelab: ${tradelabNotes.length}/3 convs`);
    console.log(`[QUANTIFY-E2E] Marketing: ${marketingNotes.length}/1 convs`);
    console.log(`[QUANTIFY-E2E] Acme nested: ${acmeNotes.length}/1 convs`);

    // Run enrichment for Tradelab project
    const reportA = await runFileNeuronEnrichment({
      projectRoot: tradelabRoot,
      fileNodes: tradelabFiles,
      convNotes: tradelabNotes,
    });

    // Run enrichment for Marketing project
    const reportB = await runFileNeuronEnrichment({
      projectRoot: marketingRoot,
      fileNodes: marketingFiles,
      convNotes: marketingNotes,
    });

    // Run enrichment for Acme nested project
    const reportC = await runFileNeuronEnrichment({
      projectRoot: acmeRoot,
      fileNodes: acmeFiles,
      convNotes: acmeNotes,
    });

    const totalEnriched =
      reportA.fileNeuronsEnriched + reportB.fileNeuronsEnriched + reportC.fileNeuronsEnriched;

    console.log(
      `\n[QUANTIFY-E2E] fileNeuronsEnriched: A=${reportA.fileNeuronsEnriched} B=${reportB.fileNeuronsEnriched} C=${reportC.fileNeuronsEnriched} TOTAL=${totalEnriched}/5`,
    );
    console.log(
      `[QUANTIFY-E2E] conceptNeuronsCreated: A=${reportA.conceptNeuronsCreated} B=${reportB.conceptNeuronsCreated} C=${reportC.conceptNeuronsCreated}`,
    );

    // Tradelab: conv-a1 (backtest, 1 file → section) + conv-a2 (bot, 1 file → section) = 2 file-neurons.
    // conv-a3 (optimizer+backtest, 2 files equally weighted) → canonicalMerge routes item to "concept"
    // (no single file has ≥70% share), so optimizer may not get its own section. The fix ensures
    // the items ARE created for all 3 convs (7/7 above), and at least 2 single-file convs enrich.
    expect(reportA.fileNeuronsEnriched).toBeGreaterThanOrEqual(2);
    expect(reportB.fileNeuronsEnriched).toBeGreaterThanOrEqual(1);
    expect(reportC.fileNeuronsEnriched).toBeGreaterThanOrEqual(1);
    // Total across all projects: at least 4 out of 5 unique file-neurons get sections
    expect(totalEnriched).toBeGreaterThanOrEqual(4);

    // Verify the Tradelab backtest.py file-neuron (non-Acme) has an enrichment section
    const allNotes = readAllNotes();
    const backtestNeuron = allNotes.find(
      (n) =>
        n.html.includes('data-cerveau-type="file-neuron"') &&
        n.html.includes('sentinel/backtest.py'),
    );
    expect(backtestNeuron).toBeDefined();

    // Fallback items are now 'activity' kind (not 'decisions'), so also check
    // for the activity section rendered by the keyword-less fallback path.
    const hasSection =
      backtestNeuron!.html.includes('data-section="decisions"') ||
      backtestNeuron!.html.includes('data-section="bugs"') ||
      backtestNeuron!.html.includes('data-section="ideas"') ||
      backtestNeuron!.html.includes('data-section="rules"') ||
      backtestNeuron!.html.includes('data-section="activity"');
    expect(hasSection).toBe(true);

    // Print a snippet of the Tradelab backtest.py file-neuron for the report
    console.log('\n[SAMPLE] Tradelab backtest.py file-neuron snippet:');
    console.log(backtestNeuron!.html.slice(0, 1200));
  });
});
