/**
 * Tests for agent-meta and note-metadata noise filtering in extractNoteContent.
 *
 * Covers:
 *   1. Noisy fact elements are dropped from the facts array.
 *   2. Clean fact elements are kept.
 *   3. A noisy aside[role="doc-note"] yields decisionOutcome === ''.
 *   4. A clean decision aside is preserved.
 *   5. Negative: real prose mentioning "session type" or "status active" is kept.
 */

import { describe, expect, it } from 'vitest';
import { extractNoteContent } from '../synthesize.js';

// Minimal NoteFile builder — only html and id are used by extractNoteContent.
function makeNote(
  html: string,
  id = 'test-note',
): { html: string; id: string; path: string; sizeBytes: number; mtimeMs: number } {
  return { html, id, path: `${id}.html`, sizeBytes: html.length, mtimeMs: 1000 };
}

// ---------------------------------------------------------------------------
// 1. Noisy fact element is dropped
// ---------------------------------------------------------------------------
describe('extractNoteContent — facts denoising', () => {
  it('drops a fact element whose text is LazyBrain note-metadata residue', () => {
    const note = makeNote(`
      <html><body>
        <article id="note-abc123" data-cerveau-topic="lazybrain/test" data-cerveau-type="episodic"
                 data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test">
          <h2>Test note</h2>
          <ul>
            <li data-cerveau-fact>Type episodic Status active Tags llm Source session:dream-9063cff5 Confidence 0</li>
            <li data-cerveau-fact>We migrated auth to Supabase row-level security</li>
          </ul>
        </article>
      </body></html>
    `);

    const result = extractNoteContent(note);

    // Noise must be absent
    expect(result.facts).not.toContain(
      'Type episodic Status active Tags llm Source session:dream-9063cff5 Confidence 0',
    );
    // Real fact must be present
    expect(result.facts).toContain('We migrated auth to Supabase row-level security');
  });

  it('drops a fact element that is an agent-meta observer instruction', () => {
    const note = makeNote(`
      <html><body>
        <article id="note-abc124" data-cerveau-topic="lazybrain/test" data-cerveau-type="episodic"
                 data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test">
          <h2>Another note</h2>
          <ul>
            <li data-cerveau-fact>Hello memory agent, observing the primary session</li>
            <li data-cerveau-fact>We deployed the auth service to Supabase Edge Functions</li>
          </ul>
        </article>
      </body></html>
    `);

    const result = extractNoteContent(note);

    expect(result.facts).not.toContain('Hello memory agent, observing the primary session');
    expect(result.facts).toContain('We deployed the auth service to Supabase Edge Functions');
  });
});

// ---------------------------------------------------------------------------
// 2. Noisy decisionOutcome yields empty string
// ---------------------------------------------------------------------------
describe('extractNoteContent — decisionOutcome denoising', () => {
  it('blanks decisionOutcome when the aside text is an agent-meta intro', () => {
    const note = makeNote(`
      <html><body>
        <article id="note-abc125" data-cerveau-topic="lazybrain/test" data-cerveau-type="decision"
                 data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test">
          <h2>Decision note</h2>
          <aside role="doc-note">
            <p>Hello memory agent, observing the primary session</p>
          </aside>
        </article>
      </body></html>
    `);

    const result = extractNoteContent(note);

    expect(result.decisionOutcome).toBe('');
  });

  it('preserves a clean decisionOutcome', () => {
    const note = makeNote(`
      <html><body>
        <article id="note-abc126" data-cerveau-topic="lazybrain/test" data-cerveau-type="decision"
                 data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test">
          <h2>Real decision</h2>
          <aside role="doc-note">
            <p>We chose Supabase RLS over application-level checks for performance and security.</p>
          </aside>
        </article>
      </body></html>
    `);

    const result = extractNoteContent(note);

    expect(result.decisionOutcome).toContain('Supabase RLS');
    expect(result.decisionOutcome).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// 3. Negative cases — real prose mentioning common words is KEPT
// ---------------------------------------------------------------------------
describe('extractNoteContent — negative: real prose is not over-filtered', () => {
  it('keeps a fact mentioning "session type" in normal prose', () => {
    const note = makeNote(`
      <html><body>
        <article id="note-abc127" data-cerveau-topic="lazybrain/test" data-cerveau-type="reference"
                 data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test">
          <h2>Prose note</h2>
          <ul>
            <li data-cerveau-fact>We track the session type in the database for each user</li>
          </ul>
        </article>
      </body></html>
    `);

    const result = extractNoteContent(note);

    expect(result.facts).toContain('We track the session type in the database for each user');
  });

  it('keeps a fact mentioning "status active" in real domain prose', () => {
    const note = makeNote(`
      <html><body>
        <article id="note-abc128" data-cerveau-topic="lazybrain/test" data-cerveau-type="reference"
                 data-cerveau-version="0.2.0" data-cerveau-created="2026-01-01" data-cerveau-source="test">
          <h2>Status prose note</h2>
          <ul>
            <li data-cerveau-fact>The build status is active and all tests pass in CI</li>
          </ul>
        </article>
      </body></html>
    `);

    const result = extractNoteContent(note);

    expect(result.facts).toContain('The build status is active and all tests pass in CI');
  });
});
