/**
 * Fixture-brain tests for the `repair --un-invalidate-noise` command
 * (repair.ts). Builds a temp brain with:
 *   - a mission note wrongly invalidated by dream-noise-cleanup (MUST repair)
 *   - a skill note wrongly invalidated by dream-noise-cleanup (MUST repair)
 *   - an untagged note invalidated by dream-noise-cleanup (must NOT repair —
 *     no protected tag)
 *   - a mission note invalidated by the EXPLICIT `invalidate` command, i.e a
 *     DIFFERENT invalidated-by value (must NOT repair — not a noise-cleanup
 *     stamp, a real supersession)
 * and asserting the report + on-disk attributes + idempotency + --dry-run.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRepairUnInvalidateNoise } from '../repair.js';

function invalidatedNote(id: string, tags: string, invalidatedBy: string): string {
  return `<article id="${id}" data-cerveau-created="2026-01-01T00:00:00Z" data-cerveau-updated="2026-01-01T00:00:00Z" data-cerveau-type="episodic" data-cerveau-source="test" data-cerveau-tier="working" data-cerveau-importance="0.6" data-cerveau-tags="${tags}" data-cerveau-valid-until="2026-01-02" data-cerveau-invalidated-by="${invalidatedBy}">
  <h2>${id}</h2>
  <p data-cerveau-fact data-cerveau-confidence="1.0" data-cerveau-extracted-by="human">body text for ${id}</p>
</article>`;
}

describe('runRepairUnInvalidateNoise', () => {
  let brainDir: string;
  let notesDir: string;

  beforeEach(() => {
    brainDir = mkdtempSync(join(tmpdir(), 'lazybrain-repair-test-'));
    notesDir = join(brainDir, 'notes', '2026-01');
    mkdirSync(notesDir, { recursive: true });

    writeFileSync(
      join(notesDir, 'mission-noise.html'),
      invalidatedNote('mission-noise', 'agent mission', 'dream-noise-cleanup'),
      'utf-8',
    );
    writeFileSync(
      join(notesDir, 'skill-noise.html'),
      invalidatedNote('skill-noise', 'skill confidence:high', 'dream-noise-cleanup'),
      'utf-8',
    );
    writeFileSync(
      join(notesDir, 'untagged-noise.html'),
      invalidatedNote('untagged-noise', 'edit code', 'dream-noise-cleanup'),
      'utf-8',
    );
    writeFileSync(
      join(notesDir, 'mission-superseded.html'),
      invalidatedNote('mission-superseded', 'agent mission', '#some-other-note'),
      'utf-8',
    );
  });

  afterEach(() => {
    if (existsSync(brainDir)) rmSync(brainDir, { recursive: true, force: true });
  });

  it('--dry-run lists exactly the tagged noise-cleanup candidates and touches nothing', () => {
    const report = runRepairUnInvalidateNoise({ brainPath: brainDir, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.repaired).toBe(0);
    const ids = report.candidates.map((c) => c.id).sort();
    expect(ids).toEqual(['mission-noise', 'skill-noise']);

    // Nothing on disk changed
    for (const file of [
      'mission-noise.html',
      'skill-noise.html',
      'untagged-noise.html',
      'mission-superseded.html',
    ]) {
      const html = readFileSync(join(notesDir, file), 'utf-8');
      expect(html).toContain('data-cerveau-invalidated-by');
    }
  });

  it('applies (no --dry-run): strips the stamp only from tagged noise-cleanup notes', () => {
    const report = runRepairUnInvalidateNoise({ brainPath: brainDir });

    expect(report.dryRun).toBe(false);
    expect(report.repaired).toBe(2);

    const missionHtml = readFileSync(join(notesDir, 'mission-noise.html'), 'utf-8');
    expect(missionHtml).not.toContain('data-cerveau-invalidated-by');
    expect(missionHtml).not.toContain('data-cerveau-valid-until');
    expect(missionHtml).toContain('data-cerveau-tags="agent mission"'); // untouched otherwise

    const skillHtml = readFileSync(join(notesDir, 'skill-noise.html'), 'utf-8');
    expect(skillHtml).not.toContain('data-cerveau-invalidated-by');

    // Untagged note: left invalidated (no protected tag)
    const untaggedHtml = readFileSync(join(notesDir, 'untagged-noise.html'), 'utf-8');
    expect(untaggedHtml).toContain('data-cerveau-invalidated-by="dream-noise-cleanup"');

    // Explicitly-superseded mission note: left invalidated (different invalidated-by value)
    const supersededHtml = readFileSync(join(notesDir, 'mission-superseded.html'), 'utf-8');
    expect(supersededHtml).toContain('data-cerveau-invalidated-by="#some-other-note"');
  });

  it('is idempotent: a second run after applying finds zero candidates', () => {
    runRepairUnInvalidateNoise({ brainPath: brainDir });
    const second = runRepairUnInvalidateNoise({ brainPath: brainDir });

    expect(second.candidates).toHaveLength(0);
    expect(second.repaired).toBe(0);
  });

  it('respects a custom --tags scope', () => {
    const report = runRepairUnInvalidateNoise({
      brainPath: brainDir,
      tags: ['skill'],
      dryRun: true,
    });
    expect(report.candidates.map((c) => c.id)).toEqual(['skill-noise']);
  });
});
