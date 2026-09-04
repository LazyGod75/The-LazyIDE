import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { annotateSession } from '../src/annotator/heuristic.js';
import {
  LB_BEGIN_MARKER,
  LB_END_MARKER,
  runExportAgentsMd,
} from '../src/commands/export-agents-md.js';
import { closeDb, indexNote } from '../src/indexer/fts.js';
import { readNote } from '../src/store/reader.js';
import { writeNote } from '../src/store/writer.js';
import { resetConfigForTests } from '../src/util/config.js';

describe('runExportAgentsMd', () => {
  let brain: string;
  let outDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    brain = mkdtempSync(join(tmpdir(), 'lb-brain-'));
    outDir = mkdtempSync(join(tmpdir(), 'lb-proj-'));
    process.env.LAZYBRAIN_BRAIN_PATH = brain;
    process.env.LAZYBRAIN_CACHE_PATH = join(brain, '_cache');
    resetConfigForTests();
    // Seed: one active decision in the target project + one foreign.
    // IMPORTANT: writeNote alone does not index — listAll() reads the FTS
    // index, so each seeded note must be indexed (mirrors capture.ts).
    const seed = (text: string, cwd: string) => {
      const result = writeNote(
        annotateSession({
          sessionId: `dream-${Math.random().toString(16).slice(2, 10)}`,
          text,
          cwd,
        }).html,
      );
      indexNote(readNote(result.path));
    };
    seed('We decided to use parameterized queries for the payments module.', 'C:/proj/acme');
    seed('We decided to use tailwind v4 for the marketing site.', 'C:/proj/other');
  });

  afterEach(() => {
    closeDb();
    process.env = { ...savedEnv };
    resetConfigForTests();
  });

  it('writes a fenced, idempotent project section scoped to the cwd', async () => {
    const target = join(outDir, 'AGENTS.md');
    const r1 = await runExportAgentsMd({
      target: 'project',
      cwd: 'C:/proj/acme',
      outFile: target,
    });
    expect(r1.written).toBe(true);
    const content = readFileSync(target, 'utf8');
    expect(content).toContain(LB_BEGIN_MARKER);
    expect(content).toContain(LB_END_MARKER);
    expect(content).toContain('parameterized queries');
    expect(content).not.toContain('tailwind v4'); // other project excluded

    await runExportAgentsMd({ target: 'project', cwd: 'C:/proj/acme', outFile: target });
    expect(readFileSync(target, 'utf8')).toBe(content); // idempotent
  });

  it('preserves human prose outside the markers', async () => {
    const target = join(outDir, 'AGENTS.md');
    writeFileSync(target, '# My project\n\nHuman-written instructions here.\n', 'utf8');
    await runExportAgentsMd({ target: 'project', cwd: 'C:/proj/acme', outFile: target });
    const content = readFileSync(target, 'utf8');
    expect(content).toContain('Human-written instructions here.');
    expect(content).toContain('parameterized queries');
  });

  it('refuses to write when markers are unbalanced', async () => {
    const target = join(outDir, 'AGENTS.md');
    writeFileSync(target, `intro\n${LB_BEGIN_MARKER}\nno end marker`, 'utf8');
    const report = await runExportAgentsMd({
      target: 'project',
      cwd: 'C:/proj/acme',
      outFile: target,
    });
    expect(report.written).toBe(false);
    expect(report.reason).toMatch(/unbalanced/i);
    expect(readFileSync(target, 'utf8')).toContain('no end marker'); // untouched
  });

  it('refuses to write when markers are out of order', async () => {
    const target = join(outDir, 'AGENTS.md');
    writeFileSync(target, `intro\n${LB_END_MARKER}\nmiddle\n${LB_BEGIN_MARKER}\ntail`, 'utf8');
    const report = await runExportAgentsMd({
      target: 'project',
      cwd: 'C:/proj/acme',
      outFile: target,
    });
    expect(report.written).toBe(false);
    expect(report.reason).toMatch(/out of order/i);
    expect(readFileSync(target, 'utf8')).toContain('middle'); // untouched
  });
});
