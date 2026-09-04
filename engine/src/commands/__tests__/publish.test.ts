/**
 * Unit tests for publish command.
 *
 * runPublish reads from the real brain store, so these tests exercise the
 * public API in dry-run mode (no filesystem writes) and stub out the store
 * readers via vi.mock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteFile } from '../../store/reader.js';

// --- Mock store / indexer so no real brain is required ---
vi.mock('../../store/reader.js', () => ({
  readAllNotes: vi.fn(),
}));
vi.mock('../../indexer/fts.js', () => ({
  listAll: vi.fn(),
}));
vi.mock('../../store/paths.js', () => ({
  brainRoot: () => '/fake/brain',
  notesDir: () => '/fake/brain/notes',
  batchesDir: () => '/fake/brain/batches',
}));
vi.mock('../../publish/site.js', () => ({
  generateSite: vi.fn(),
}));

import { listAll } from '../../indexer/fts.js';
import { generateSite } from '../../publish/site.js';
import { readAllNotes } from '../../store/reader.js';
import { runPublish } from '../publish.js';

const mockReadAllNotes = readAllNotes as ReturnType<typeof vi.fn>;
const mockListAll = listAll as ReturnType<typeof vi.fn>;
const mockGenerateSite = generateSite as ReturnType<typeof vi.fn>;

function makeNote(id: string, html?: string): NoteFile {
  const content = html ?? `<article id="${id}" data-cerveau-version="0.2.0"><p>Hello</p></article>`;
  return { id, path: `/fake/brain/notes/${id}.html`, html: content, sizeBytes: 100, mtimeMs: 0 };
}

beforeEach(() => {
  mockListAll.mockReturnValue([]);
});

describe('runPublish — dry-run (default)', () => {
  it('returns dry-run status by default (no --confirm)', () => {
    mockReadAllNotes.mockReturnValue([makeNote('note-abc')]);
    const out = JSON.parse(runPublish({}));
    expect(out.status).toBe('dry-run');
    expect(out.would_publish).toBe(1);
  });

  it('dry-run includes report with counts', () => {
    mockReadAllNotes.mockReturnValue([makeNote('note-001'), makeNote('note-002')]);
    const out = JSON.parse(runPublish({ dryRun: true }));
    expect(out.report).toBeDefined();
    expect(out.report.notesPublished).toBe(2);
    expect(out.report.notesBlocked).toBe(0);
    expect(Array.isArray(out.report.blockedReasons)).toBe(true);
  });

  it('includes profile in dry-run output', () => {
    mockReadAllNotes.mockReturnValue([makeNote('note-001')]);
    const out = JSON.parse(runPublish({ dryRun: true, profile: 'public-strict' }));
    expect(out.profile).toBe('public-strict');
  });
});

describe('runPublish — blocked notes', () => {
  it('returns blocked status when a note has a secret', () => {
    const secretNote = makeNote(
      'note-bad',
      '<article id="note-bad">key sk-1234567890ABCDEFGHIJK leaked</article>',
    );
    mockReadAllNotes.mockReturnValue([secretNote]);
    const out = JSON.parse(runPublish({ dryRun: true }));
    expect(out.status).toBe('blocked');
    expect(out.failures.length).toBe(1);
    expect(out.failures[0].id).toBe('note-bad');
    expect(out.report.notesBlocked).toBe(1);
  });

  it('report includes sensitive patterns detected', () => {
    const secretNote = makeNote(
      'note-aws',
      '<article id="note-aws">AKIAIOSFODNN7EXAMPLE in config</article>',
    );
    mockReadAllNotes.mockReturnValue([secretNote]);
    const out = JSON.parse(runPublish({ dryRun: true }));
    expect(out.report.sensitivePatternsDetected.length).toBeGreaterThan(0);
  });
});

describe('runPublish — public-strict profile', () => {
  it('dry-run with public-strict reports provenanceAttrsStripped > 0 when provenance present', () => {
    const note = makeNote(
      'note-prov',
      `<article id="note-prov"
        data-cerveau-version="0.2.0"
        data-cerveau-cwd="/home/user/project"
        data-cerveau-git-branch="main"
        data-cerveau-session-id="sess-001"
      ><p>Content</p></article>`,
    );
    mockReadAllNotes.mockReturnValue([note]);
    const out = JSON.parse(runPublish({ dryRun: true, profile: 'public-strict' }));
    expect(out.report.provenanceAttrsStripped).toBeGreaterThan(0);
  });

  it('default profile reports 0 provenance attrs stripped', () => {
    const note = makeNote(
      'note-prov2',
      `<article id="note-prov2"
        data-cerveau-version="0.2.0"
        data-cerveau-cwd="/home/user/project"
        data-cerveau-git-branch="main"
      ><p>Content</p></article>`,
    );
    mockReadAllNotes.mockReturnValue([note]);
    const out = JSON.parse(runPublish({ dryRun: true, profile: 'default' }));
    expect(out.report.provenanceAttrsStripped).toBe(0);
  });
});

describe('runPublish — topic filter', () => {
  function makeNoteWithTopic(id: string, topic: string): NoteFile {
    return {
      id,
      path: `/fake/brain/notes/${id}.html`,
      html: `<article id="${id}" data-cerveau-version="0.2.0" data-cerveau-topic="${topic}"><p>Hello</p></article>`,
      sizeBytes: 100,
      mtimeMs: 0,
    };
  }

  function makeNoteNoTopic(id: string): NoteFile {
    return {
      id,
      path: `/fake/brain/notes/${id}.html`,
      html: `<article id="${id}" data-cerveau-version="0.2.0"><p>No topic</p></article>`,
      sizeBytes: 100,
      mtimeMs: 0,
    };
  }

  beforeEach(() => {
    mockListAll.mockReturnValue([
      { id: 'note-lz', path: '/fake/brain/notes/note-lz.html', topic: 'lazybrain/core' },
      { id: 'note-lz2', path: '/fake/brain/notes/note-lz2.html', topic: 'lazybrain/publish' },
      { id: 'note-game', path: '/fake/brain/notes/note-game.html', topic: 'fitapp/app' },
      { id: 'note-notopic', path: '/fake/brain/notes/note-notopic.html', topic: null },
    ]);
  });

  it('no --topic: includes all notes regardless of topic', () => {
    mockReadAllNotes.mockReturnValue([
      makeNoteWithTopic('note-lz', 'lazybrain/core'),
      makeNoteWithTopic('note-game', 'fitapp/app'),
      makeNoteNoTopic('note-notopic'),
    ]);
    const out = JSON.parse(runPublish({ dryRun: true }));
    expect(out.status).toBe('dry-run');
    expect(out.would_publish).toBe(3);
  });

  it('--topic lazybrain: includes only lazybrain/* notes', () => {
    mockReadAllNotes.mockReturnValue([
      makeNoteWithTopic('note-lz', 'lazybrain/core'),
      makeNoteWithTopic('note-lz2', 'lazybrain/publish'),
      makeNoteWithTopic('note-game', 'fitapp/app'),
      makeNoteNoTopic('note-notopic'),
    ]);
    const out = JSON.parse(runPublish({ dryRun: true, topic: 'lazybrain' }));
    expect(out.status).toBe('dry-run');
    expect(out.would_publish).toBe(2);
  });

  it('--topic lazybrain/core: includes only exact-prefix match', () => {
    mockReadAllNotes.mockReturnValue([
      makeNoteWithTopic('note-lz', 'lazybrain/core'),
      makeNoteWithTopic('note-lz2', 'lazybrain/publish'),
    ]);
    mockListAll.mockReturnValue([
      { id: 'note-lz', path: '/fake/brain/notes/note-lz.html', topic: 'lazybrain/core' },
      { id: 'note-lz2', path: '/fake/brain/notes/note-lz2.html', topic: 'lazybrain/publish' },
    ]);
    const out = JSON.parse(runPublish({ dryRun: true, topic: 'lazybrain/core' }));
    expect(out.would_publish).toBe(1);
  });

  it('--topic is case-insensitive', () => {
    mockReadAllNotes.mockReturnValue([
      makeNoteWithTopic('note-lz', 'LazyBrain/Core'),
      makeNoteWithTopic('note-game', 'fitapp/app'),
    ]);
    mockListAll.mockReturnValue([
      { id: 'note-lz', path: '/fake/brain/notes/note-lz.html', topic: 'LazyBrain/Core' },
      { id: 'note-game', path: '/fake/brain/notes/note-game.html', topic: 'fitapp/app' },
    ]);
    const out = JSON.parse(runPublish({ dryRun: true, topic: 'lazybrain' }));
    expect(out.would_publish).toBe(1);
  });

  it('--topic excludes notes with no topic', () => {
    mockReadAllNotes.mockReturnValue([
      makeNoteWithTopic('note-lz', 'lazybrain/core'),
      makeNoteNoTopic('note-notopic'),
    ]);
    mockListAll.mockReturnValue([
      { id: 'note-lz', path: '/fake/brain/notes/note-lz.html', topic: 'lazybrain/core' },
      { id: 'note-notopic', path: '/fake/brain/notes/note-notopic.html', topic: null },
    ]);
    const out = JSON.parse(runPublish({ dryRun: true, topic: 'lazybrain' }));
    expect(out.would_publish).toBe(1);
  });

  it('--topic with no match: publishes 0 notes', () => {
    mockReadAllNotes.mockReturnValue([makeNoteWithTopic('note-game', 'fitapp/app')]);
    mockListAll.mockReturnValue([
      { id: 'note-game', path: '/fake/brain/notes/note-game.html', topic: 'fitapp/app' },
    ]);
    const out = JSON.parse(runPublish({ dryRun: true, topic: 'lazybrain' }));
    expect(out.would_publish).toBe(0);
  });
});

describe('runPublish --site — profile default', () => {
  beforeEach(() => {
    mockGenerateSite.mockReturnValue({
      dryRun: true,
      result: null,
      wouldPublish: 0,
      blockedCount: 0,
    });
  });

  it('defaults to public-strict profile in site mode', () => {
    runPublish({ site: true, dryRun: true });
    expect(mockGenerateSite).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'public-strict' }),
    );
  });

  it('respects explicit profile override in site mode', () => {
    runPublish({ site: true, dryRun: true, profile: 'default' });
    expect(mockGenerateSite).toHaveBeenCalledWith(expect.objectContaining({ profile: 'default' }));
  });

  it('dry-run site output includes mode and profile', () => {
    const out = JSON.parse(runPublish({ site: true, dryRun: true }));
    expect(out.status).toBe('dry-run');
    expect(out.mode).toBe('site');
    expect(out.profile).toBe('public-strict');
  });
});

describe('runPublish — scrub report shape', () => {
  it('report always has all required fields', () => {
    mockReadAllNotes.mockReturnValue([]);
    const out = JSON.parse(runPublish({ dryRun: true }));
    const r = out.report;
    expect(typeof r.notesPublished).toBe('number');
    expect(typeof r.notesBlocked).toBe('number');
    expect(Array.isArray(r.blockedReasons)).toBe(true);
    expect(typeof r.provenanceAttrsStripped).toBe('number');
    expect(typeof r.pathsScrubbed).toBe('number');
    expect(Array.isArray(r.sensitivePatternsDetected)).toBe(true);
  });

  it('pretty mode returns human-readable string', () => {
    mockReadAllNotes.mockReturnValue([makeNote('note-x')]);
    const out = runPublish({ confirm: true, pretty: true });
    expect(typeof out).toBe('string');
    expect(out).toContain('SCRUB REPORT');
    expect(out).toContain('Notes published');
  });
});
