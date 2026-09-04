/**
 * prune.test.ts — unit tests for src/commands/prune.ts
 *
 * Verifies that:
 *  1. Each policy selects the correct HTML fixtures.
 *  2. Dry-run (default) deletes nothing.
 *  3. Composable policy list restricts matching to the requested policies only.
 *  4. The ingestion denoise gate (isAgentMetaText in capture.ts) rejects observer text.
 *
 * Uses temp directories instead of the live brain so no real files are touched.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAgentMetaText } from '../src/commands/dream.js';
import { runPrune } from '../src/commands/prune.js';

// ---------------------------------------------------------------------------
// Fixture HTML builders
// ---------------------------------------------------------------------------

function makeNote(
  id: string,
  opts: {
    source?: string;
    tldr?: string;
    hasTldrSection?: boolean;
    bodyText?: string;
  } = {},
): string {
  const source = opts.source ?? 'session:test-abc123';
  const tldrSection =
    opts.hasTldrSection === false
      ? ''
      : opts.tldr !== undefined
        ? `<section data-section="tldr"><p>${opts.tldr}</p></section>`
        : '<section data-section="tldr"><p>A real one-sentence summary here.</p></section>';

  return `<!doctype html>
<html>
<body>
<article id="${id}"
         data-cerveau-type="episodic"
         data-cerveau-version="0.2.0"
         data-cerveau-created="2026-01-15T10:00:00Z"
         data-cerveau-source="${source}"
         data-cerveau-topic="test/fixture">
  <h2>${id}</h2>
  ${tldrSection}
  <ul>
    <li data-cerveau-fact>${opts.bodyText ?? 'We decided to use Supabase for authentication.'}</li>
  </ul>
</article>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Temp-brain fixture helper
// ---------------------------------------------------------------------------

interface TempBrain {
  root: string;
  notesDir: string;
  knDir: string;
  backupDir: string;
}

function makeTempBrain(): TempBrain {
  const root = join(
    tmpdir(),
    `lazybrain-prune-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const notesDir = join(root, 'notes', '2026-01');
  const knDir = join(root, 'knowledge-nodes');
  const backupDir = join(root, 'notes_backup_20260115');
  mkdirSync(notesDir, { recursive: true });
  mkdirSync(knDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  return { root, notesDir, knDir, backupDir };
}

function writeTempNote(dir: string, name: string, html: string): string {
  const path = join(dir, name);
  writeFileSync(path, html, 'utf-8');
  return path;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('prune — claude-mem-observer policy', () => {
  let brain: TempBrain;

  beforeEach(() => {
    brain = makeTempBrain();
  });

  afterEach(() => {
    rmSync(brain.root, { recursive: true, force: true });
  });

  it('selects a note whose data-cerveau-source contains "observer"', () => {
    writeTempNote(
      brain.notesDir,
      'observer-note.html',
      makeNote('obs-1', { source: 'observer:session-abc' }),
    );
    writeTempNote(
      brain.notesDir,
      'clean-note.html',
      makeNote('clean-1', { source: 'session:dream-a1b2c3d4' }),
    );

    const report = runPrune({
      policy: 'claude-mem-observer',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.dryRun).toBe(true);
    expect(report.counts['claude-mem-observer']).toBe(1);
    const paths = report.candidates.map((c) => c.path);
    expect(paths.some((p) => p.endsWith('observer-note.html'))).toBe(true);
    expect(paths.every((p) => !p.endsWith('clean-note.html'))).toBe(true);
  });

  it('selects a note containing observed_from_primary_session', () => {
    writeTempNote(
      brain.notesDir,
      'obs-content.html',
      makeNote('obs-2', {
        bodyText: 'observed_from_primary_session — memory agent active',
      }),
    );

    const report = runPrune({
      policy: 'claude-mem-observer',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['claude-mem-observer']).toBe(1);
  });

  it('selects a note matching hello.*memory.*agent pattern', () => {
    writeTempNote(
      brain.notesDir,
      'hello-mem.html',
      makeNote('obs-3', {
        bodyText: 'hello memory agent, observing the primary session',
      }),
    );

    const report = runPrune({
      policy: 'claude-mem-observer',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['claude-mem-observer']).toBe(1);
  });

  it('selects a note matching Record.*what.*was.*LEARNED pattern', () => {
    writeTempNote(
      brain.notesDir,
      'record-learned.html',
      makeNote('obs-4', {
        bodyText: 'CRITICAL: Record what was LEARNED, BUILT, or FIXED in this session.',
      }),
    );

    const report = runPrune({
      policy: 'claude-mem-observer',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['claude-mem-observer']).toBe(1);
  });

  it('does NOT select clean notes that happen to mention memory in prose', () => {
    writeTempNote(
      brain.notesDir,
      'prose-memory.html',
      makeNote('prose-1', {
        bodyText: 'We improved memory usage by switching to a streaming parser.',
      }),
    );

    const report = runPrune({
      policy: 'claude-mem-observer',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['claude-mem-observer']).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('prune — session-dream policy', () => {
  let brain: TempBrain;

  beforeEach(() => {
    brain = makeTempBrain();
  });

  afterEach(() => {
    rmSync(brain.root, { recursive: true, force: true });
  });

  it('selects a note with data-cerveau-source matching session:dream- prefix', () => {
    writeTempNote(
      brain.notesDir,
      'dream-note.html',
      makeNote('dream-1', { source: 'session:dream-a1b2c3d4' }),
    );

    const report = runPrune({
      policy: 'session-dream',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['session-dream']).toBe(1);
    expect(report.candidates[0].reason).toContain('session:dream-');
  });

  it('does NOT select notes with other source prefixes', () => {
    writeTempNote(
      brain.notesDir,
      'capture-note.html',
      makeNote('capture-1', { source: 'session:capture-abcd1234' }),
    );

    const report = runPrune({
      policy: 'session-dream',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['session-dream']).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('prune — empty-tldr policy', () => {
  let brain: TempBrain;

  beforeEach(() => {
    brain = makeTempBrain();
  });

  afterEach(() => {
    rmSync(brain.root, { recursive: true, force: true });
  });

  it('selects a note with no TLDR section at all', () => {
    writeTempNote(brain.notesDir, 'no-tldr.html', makeNote('no-tldr-1', { hasTldrSection: false }));

    const report = runPrune({
      policy: 'empty-tldr',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['empty-tldr']).toBe(1);
  });

  it('selects a note with a bare timestamp as TLDR', () => {
    writeTempNote(brain.notesDir, 'ts-tldr.html', makeNote('ts-tldr-1', { tldr: '2026-05-15' }));

    const report = runPrune({
      policy: 'empty-tldr',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['empty-tldr']).toBe(1);
  });

  it('selects a note with a filename echo as TLDR', () => {
    writeTempNote(
      brain.notesDir,
      'fn-tldr.html',
      makeNote('fn-tldr-1', { tldr: 'src/commands/capture.ts' }),
    );

    const report = runPrune({
      policy: 'empty-tldr',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['empty-tldr']).toBe(1);
  });

  it('does NOT select a note with a proper prose TLDR', () => {
    writeTempNote(
      brain.notesDir,
      'good-tldr.html',
      makeNote('good-1', {
        tldr: 'We migrated the auth service to Supabase RLS for better security.',
      }),
    );

    const report = runPrune({
      policy: 'empty-tldr',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['empty-tldr']).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('prune — backup-dirs policy', () => {
  let brain: TempBrain;

  beforeEach(() => {
    brain = makeTempBrain();
  });

  afterEach(() => {
    rmSync(brain.root, { recursive: true, force: true });
  });

  it('selects directories matching notes_backup_* pattern', () => {
    // brain.backupDir already exists from makeTempBrain()
    const report = runPrune({
      policy: 'backup-dirs',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['backup-dirs']).toBe(1);
    const paths = report.candidates.map((c) => c.path);
    expect(paths.some((p) => p.endsWith('notes_backup_20260115'))).toBe(true);
  });

  it('does NOT select directories that do not match notes_backup_*', () => {
    // Only the notes/ and knowledge-nodes/ dirs exist (from makeTempBrain)
    // plus backupDir — let's test without the backup dir
    rmSync(brain.backupDir, { recursive: true, force: true });

    const report = runPrune({
      policy: 'backup-dirs',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.counts['backup-dirs']).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('prune — dry-run never deletes files', () => {
  let brain: TempBrain;

  beforeEach(() => {
    brain = makeTempBrain();
  });

  afterEach(() => {
    rmSync(brain.root, { recursive: true, force: true });
  });

  it('dry-run leaves all files intact regardless of policy', () => {
    const notePath = writeTempNote(
      brain.notesDir,
      'obs.html',
      makeNote('obs-dry', { source: 'observer:primary' }),
    );
    const dreamPath = writeTempNote(
      brain.notesDir,
      'dream.html',
      makeNote('dream-dry', { source: 'session:dream-deadbeef' }),
    );

    const report = runPrune({
      dryRun: true, // explicit
      brainPath: brain.root,
    });

    expect(report.dryRun).toBe(true);
    expect(report.deleted).toBe(0);
    expect(existsSync(notePath)).toBe(true);
    expect(existsSync(dreamPath)).toBe(true);
    expect(existsSync(brain.backupDir)).toBe(true);
  });

  it('default (no dryRun option) behaves as dry-run', () => {
    const notePath = writeTempNote(
      brain.notesDir,
      'obs2.html',
      makeNote('obs-default', { source: 'observer:primary' }),
    );

    // Call without specifying dryRun at all
    const report = runPrune({ brainPath: brain.root });

    expect(report.dryRun).toBe(true);
    expect(report.deleted).toBe(0);
    expect(existsSync(notePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('prune — apply mode actually deletes', () => {
  let brain: TempBrain;

  beforeEach(() => {
    brain = makeTempBrain();
  });

  afterEach(() => {
    rmSync(brain.root, { recursive: true, force: true });
  });

  it('deletes observer notes when dryRun === false', () => {
    const obsPath = writeTempNote(
      brain.notesDir,
      'obs-apply.html',
      makeNote('obs-apply', { source: 'observer:session-abc' }),
    );
    const cleanPath = writeTempNote(
      brain.notesDir,
      'clean-apply.html',
      makeNote('clean-apply', { source: 'session:capture-clean' }),
    );

    const report = runPrune({
      policy: 'claude-mem-observer',
      dryRun: false,
      brainPath: brain.root,
    });

    expect(report.dryRun).toBe(false);
    expect(report.deleted).toBe(1);
    expect(existsSync(obsPath)).toBe(false);
    expect(existsSync(cleanPath)).toBe(true);
  });

  it('deletes backup directories when dryRun === false', () => {
    expect(existsSync(brain.backupDir)).toBe(true);

    const report = runPrune({
      policy: 'backup-dirs',
      dryRun: false,
      brainPath: brain.root,
    });

    expect(report.dryRun).toBe(false);
    expect(report.deleted).toBe(1);
    expect(existsSync(brain.backupDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('prune — policy composition', () => {
  let brain: TempBrain;

  beforeEach(() => {
    brain = makeTempBrain();
  });

  afterEach(() => {
    rmSync(brain.root, { recursive: true, force: true });
  });

  it('applies only the specified policies when given a comma-separated list', () => {
    writeTempNote(
      brain.notesDir,
      'obs.html',
      makeNote('obs-comp', { source: 'observer:session-xyz' }),
    );
    writeTempNote(
      brain.notesDir,
      'dream.html',
      makeNote('dream-comp', { source: 'session:dream-feedcafe' }),
    );
    // backup dir already exists in brain

    // Apply only session-dream + backup-dirs — observer note should NOT be selected
    const report = runPrune({
      policy: 'session-dream,backup-dirs',
      dryRun: true,
      brainPath: brain.root,
    });

    expect(report.policies).toEqual(['session-dream', 'backup-dirs']);
    expect(report.counts['claude-mem-observer']).toBe(0);
    expect(report.counts['session-dream']).toBe(1);
    expect(report.counts['backup-dirs']).toBe(1);
  });

  it('applies all policies when policy is omitted', () => {
    writeTempNote(brain.notesDir, 'obs2.html', makeNote('obs-all', { source: 'observer:multi' }));

    const report = runPrune({
      dryRun: true,
      brainPath: brain.root,
    });

    // All four policies should be present
    expect(report.policies).toContain('claude-mem-observer');
    expect(report.policies).toContain('session-dream');
    expect(report.policies).toContain('empty-tldr');
    expect(report.policies).toContain('backup-dirs');
  });
});

// ---------------------------------------------------------------------------

describe('capture denoise gate — isAgentMetaText rejects observer text', () => {
  it('rejects "hello memory agent" observer intro', () => {
    expect(isAgentMetaText('hello memory agent, observing the primary session')).toBe(true);
  });

  it('rejects "Record what was LEARNED" observer instruction', () => {
    expect(isAgentMetaText('CRITICAL: Record what was LEARNED in this session')).toBe(true);
  });

  it('rejects "observing the primary" observer header', () => {
    expect(isAgentMetaText('observing the primary conversation for context')).toBe(true);
  });

  it('does NOT reject legitimate capture text', () => {
    expect(
      isAgentMetaText(
        'We migrated the auth service to use Supabase Row Level Security for better multi-tenant isolation.',
      ),
    ).toBe(false);
  });

  it('does NOT reject text that mentions "agent" in normal engineering prose', () => {
    expect(
      isAgentMetaText(
        'The agent system dispatches tasks to specialized sub-agents via the Task tool.',
      ),
    ).toBe(false);
  });

  it('rejects XML observation block that would enter capture path', () => {
    expect(
      isAgentMetaText(
        '<observation>The primary agent modified src/auth.ts to add PKCE flow.</observation>',
      ),
    ).toBe(true);
  });
});
