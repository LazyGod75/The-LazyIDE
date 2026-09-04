/**
 * Tests for the backlinks graph builder.
 *
 * A1 audit fix (kept green):
 * - In-page navigation anchors (bare heading/TOC #fragments, #fn-* / #cls-*)
 *   must NOT become graph nodes.
 * - Edges whose target id is not in the known note set are dropped (ghost-note guard).
 *
 * Bare-link fix (backlinks_total was always 0 in production):
 * - parseTargetId must ALSO accept the bare "#<id>" format — the DOMINANT
 *   real link format (~97% of notes), emitted by the auto-linker
 *   (entities.ts applyAutoLinks) and by enrichment "[source]" links
 *   (file-neuron.ts EnrichmentItem.sourceConvLink) — plus "#/wiki/<id>".
 * - "#/file:<path>" (file-open pseudo-link) must still be rejected.
 */

import { describe, expect, it } from 'vitest';
import type { NoteFile } from '../../store/reader.js';
import { buildBacklinks } from '../backlinks.js';

// ---------------------------------------------------------------------------
// Helper: minimal NoteFile stub
// ---------------------------------------------------------------------------
function makeNote(id: string, html: string): NoteFile {
  return { id, html, path: `/fake/${id}.html`, sizeBytes: html.length, mtimeMs: 0 };
}

// ---------------------------------------------------------------------------
// A1.1 — In-page nav anchors must not create graph edges
// ---------------------------------------------------------------------------

describe('A1 — parseTargetId: in-page anchors are rejected regardless of format', () => {
  it('bare fragment #see-also does NOT create a backlink edge', () => {
    const source = makeNote('my-note', '<a href="#see-also">2 See also</a>');
    const target = makeNote('real-note-id', '<p>Real content</p>');
    const idx = buildBacklinks([source, target]);
    // "see-also" should NOT appear as a known target
    expect(idx.incoming['see-also']).toBeUndefined();
    expect(idx.total_edges).toBe(0);
  });

  it('bare fragment #children does NOT create a backlink edge', () => {
    const source = makeNote('my-note', '<a href="#children">Children</a>');
    const idx = buildBacklinks([source]);
    expect(idx.incoming.children).toBeUndefined();
    expect(idx.total_edges).toBe(0);
  });

  it('bare fragment #architecture does NOT create a backlink edge', () => {
    const source = makeNote('my-note', '<a href="#architecture">Architecture</a>');
    const idx = buildBacklinks([source]);
    expect(idx.incoming.architecture).toBeUndefined();
    expect(idx.total_edges).toBe(0);
  });

  it('bare fragment #fn-1 (footnote) does NOT create a backlink edge', () => {
    const source = makeNote('my-note', '<a href="#fn-1">[1]</a>');
    const idx = buildBacklinks([source]);
    expect(idx.incoming['fn-1']).toBeUndefined();
    expect(idx.total_edges).toBe(0);
  });

  it('bare fragment #cls-MyClass (symbol anchor) does NOT create a backlink edge', () => {
    const source = makeNote('my-note', '<a href="#cls-MyClass">MyClass</a>');
    const idx = buildBacklinks([source]);
    expect(idx.incoming['cls-MyClass']).toBeUndefined();
    expect(idx.total_edges).toBe(0);
  });

  it('#/file:<path> href does NOT create a backlink edge', () => {
    // renderArchitectureSection emits these for internal imports — the path
    // never matches a real note id and must not be treated as one.
    const source = makeNote('my-note', '<a href="#/file:./helpers.ts">helpers.ts</a>');
    const idx = buildBacklinks([source]);
    expect(idx.total_edges).toBe(0);
  });

  it('relative path with fragment does NOT create a backlink edge', () => {
    const source = makeNote('my-note', '<a href="../other.html#see-also">link</a>');
    const idx = buildBacklinks([source]);
    expect(idx.incoming['see-also']).toBeUndefined();
    expect(idx.total_edges).toBe(0);
  });

  it('#/note/<id> href DOES create exactly one backlink edge', () => {
    const source = makeNote('my-note', '<a href="#/note/real-note-id">Real</a>');
    const target = makeNote('real-note-id', '<p>Real content</p>');
    const idx = buildBacklinks([source, target]);
    expect(idx.incoming['real-note-id']).toHaveLength(1);
    expect(idx.incoming['real-note-id'][0].from).toBe('my-note');
    expect(idx.total_edges).toBe(1);
  });

  it('note with both a bare fragment AND a valid #/note/<id> produces exactly one edge', () => {
    const source = makeNote(
      'my-note',
      '<a href="#see-also">2 See also</a><a href="#/note/real-note-id">Real</a>',
    );
    const target = makeNote('real-note-id', '<p>Real content</p>');
    const idx = buildBacklinks([source, target]);
    // Only the valid inter-note link survives
    expect(idx.incoming['see-also']).toBeUndefined();
    expect(idx.incoming['real-note-id']).toHaveLength(1);
    expect(idx.total_edges).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bare "#<id>" and "#/wiki/<id>" — the REAL formats notes carry in production
// ---------------------------------------------------------------------------

describe('parseTargetId: bare "#<id>" (auto-linker format) is accepted', () => {
  it('a bare #<id> mentions link (entities.ts applyAutoLinks format) creates a backlink edge', () => {
    // Exact shape applyAutoLinks() writes: href="#<id>", data-cerveau-link-type
    // set from detectEdgeType, data-cerveau-link-auto="1".
    const source = makeNote(
      'my-note',
      '<a href="#real-note-id" data-cerveau-link-type="mentions" data-cerveau-link-confidence="inferred" data-cerveau-link-auto="1">Real</a>',
    );
    const target = makeNote('real-note-id', '<p>Real content</p>');
    const idx = buildBacklinks([source, target]);
    expect(idx.incoming['real-note-id']).toHaveLength(1);
    expect(idx.incoming['real-note-id'][0]).toMatchObject({
      from: 'my-note',
      to: 'real-note-id',
      type: 'mentions',
      auto: true,
      confidence: 'inferred',
    });
    expect(idx.total_edges).toBe(1);
  });

  it('a bare #<id> "[source]" provenance link (file-neuron enrichment format) creates a backlink edge', () => {
    // Exact shape EnrichmentItem.sourceConvLink produces, e.g. "#conv-abc".
    const source = makeNote('file-acme-src-config-ts', '<a href="#conv-abc123">[source]</a>');
    const target = makeNote('conv-abc123', '<p>Conversation</p>');
    const idx = buildBacklinks([source, target]);
    expect(idx.incoming['conv-abc123']).toHaveLength(1);
    expect(idx.total_edges).toBe(1);
  });

  it('#/wiki/<id> href creates exactly one backlink edge', () => {
    const source = makeNote('my-note', '<a href="#/wiki/real-note-id">Real</a>');
    const target = makeNote('real-note-id', '<p>Real content</p>');
    const idx = buildBacklinks([source, target]);
    expect(idx.incoming['real-note-id']).toHaveLength(1);
    expect(idx.total_edges).toBe(1);
  });

  it('percent-encoded bare #<id> is url-decoded before matching', () => {
    const target = makeNote('note with spaces', '<p>Real content</p>');
    const source = makeNote('my-note', '<a href="#note%20with%20spaces">Real</a>');
    const idx = buildBacklinks([source, target]);
    expect(idx.incoming['note with spaces']).toHaveLength(1);
    expect(idx.total_edges).toBe(1);
  });

  it('a note carrying only bare-format mentions links (the real-world shape) produces non-zero backlinks_total', () => {
    // Regression guard for the exact production symptom: backlinks_total: 0
    // even though every note is full of auto-linker mentions links.
    const a = makeNote('note-a', '<a href="#note-b" data-cerveau-link-type="mentions">B</a>');
    const b = makeNote('note-b', '<a href="#note-c" data-cerveau-link-type="mentions">C</a>');
    const c = makeNote('note-c', '<p>Leaf note</p>');
    const idx = buildBacklinks([a, b, c]);
    expect(idx.total_edges).toBeGreaterThan(0);
    expect(idx.incoming['note-b']).toHaveLength(1);
    expect(idx.incoming['note-c']).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A1.2 — Ghost-note (non-existent target) edges must be dropped
// ---------------------------------------------------------------------------

describe('A1 — ghost-note defensive validation', () => {
  it('edge to #/note/ghost-id is dropped when ghost-id is not in the note set', () => {
    const source = makeNote('my-note', '<a href="#/note/ghost-id">Ghost</a>');
    // ghost-id does NOT exist as a note
    const idx = buildBacklinks([source]);
    expect(idx.incoming['ghost-id']).toBeUndefined();
    expect(idx.total_edges).toBe(0);
  });

  it('edge to #/note/real-note-id is kept when the note exists', () => {
    const source = makeNote('my-note', '<a href="#/note/real-note-id">Real</a>');
    const target = makeNote('real-note-id', '<p>Real content</p>');
    const idx = buildBacklinks([source, target]);
    expect(idx.incoming['real-note-id']).toHaveLength(1);
  });

  it('mix of existing and ghost targets: only existing kept', () => {
    const source = makeNote(
      'source',
      '<a href="#/note/exists">Exists</a><a href="#/note/ghost">Ghost</a>',
    );
    const target = makeNote('exists', '<p>Real</p>');
    const idx = buildBacklinks([source, target]);
    expect(idx.total_edges).toBe(1);
    expect(idx.incoming.exists).toHaveLength(1);
    expect(idx.incoming.ghost).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A1.3 — Self-links are still dropped
// ---------------------------------------------------------------------------

describe('A1 — self-links are dropped', () => {
  it('a note that links to itself does not produce a backlink', () => {
    const note = makeNote('self-note', '<a href="#/note/self-note">Self</a>');
    const idx = buildBacklinks([note]);
    expect(idx.incoming['self-note']).toBeUndefined();
    expect(idx.total_edges).toBe(0);
  });
});
