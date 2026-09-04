/**
 * Tests for placeholder/template noise detection:
 *   1. isPlaceholderNoise — positive (must drop) and negative (must keep) cases.
 *   2. isAgentMetaText — delegates to isPlaceholderNoise for new patterns.
 *   3. prune 'placeholder-noise' policy — self-contained temp-fixture tests.
 *   4. capture denoise gate — isAgentMetaText rejects placeholder text.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAgentMetaText, isPlaceholderNoise } from '../dream.js';
import { runPrune } from '../prune.js';

// ---------------------------------------------------------------------------
// 1. isPlaceholderNoise — positive cases (must return true → text is dropped)
// ---------------------------------------------------------------------------
describe('isPlaceholderNoise — positive (noise that must be dropped)', () => {
  it('catches the canonical placeholder ending phrase', () => {
    expect(
      isPlaceholderNoise('strings, decisions that a real note on this topic would mention.'),
    ).toBe(true);
  });

  it('catches the truncated "ment" variant (as it appears in note titles)', () => {
    expect(isPlaceholderNoise('a real note on this topic would ment something important')).toBe(
      true,
    );
  });

  it('catches "strings, decisions that" as the distinctive preamble', () => {
    expect(isPlaceholderNoise('strings, decisions that matter for this project')).toBe(true);
  });

  it('catches "strings, decisions that" with one or more spaces after comma', () => {
    // Actual pattern in residual notes always has a space; "strings,  decisions" also matches
    expect(isPlaceholderNoise('strings,  decisions that a real note would mention')).toBe(true);
  });

  it('catches the fictional-note instruction line (lowercase)', () => {
    expect(
      isPlaceholderNoise(
        'you write a short fictional memory note that hypothetically answers the query',
      ),
    ).toBe(true);
  });

  it('catches the fictional-note instruction line (mixed case)', () => {
    expect(isPlaceholderNoise('You write a short fictional note about the topic')).toBe(true);
  });

  it('catches "output only the note body"', () => {
    expect(isPlaceholderNoise('Output ONLY the note body. No prose, no preamble, no quotes.')).toBe(
      true,
    );
  });

  it('catches "output only the note body" lowercase', () => {
    expect(isPlaceholderNoise('output only the note body')).toBe(true);
  });

  it('catches "hypothetically answers the user\'s search query"', () => {
    expect(isPlaceholderNoise("note that hypothetically answers the user's search query")).toBe(
      true,
    );
  });

  it('catches "concrete vocabulary: include the named entities"', () => {
    expect(
      isPlaceholderNoise(
        'Concrete vocabulary: include the named entities, library names, error strings',
      ),
    ).toBe(true);
  });

  it('catches multi-line text that contains a placeholder phrase', () => {
    const multi = [
      'Some intro sentence that looks real.',
      'strings, decisions that a real note on this topic would mention.',
      'Another sentence that seems fine.',
    ].join('\n');
    expect(isPlaceholderNoise(multi)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. isPlaceholderNoise — negative cases (real notes must NOT be dropped)
// ---------------------------------------------------------------------------
describe('isPlaceholderNoise — negative (real prose that must NOT be dropped)', () => {
  it('keeps a sentence mentioning "decision" without the placeholder phrasing', () => {
    expect(isPlaceholderNoise('We made the decision to migrate to Supabase for auth')).toBe(false);
  });

  it('keeps a sentence mentioning "note" in a normal context', () => {
    expect(isPlaceholderNoise('Note that the API rate limit is 100 req/s per IP')).toBe(false);
  });

  it('keeps a sentence mentioning "topic" in a normal context', () => {
    expect(
      isPlaceholderNoise('The topic of database indexing came up during the architecture review'),
    ).toBe(false);
  });

  it('keeps a sentence mentioning "strings" as a data type', () => {
    expect(
      isPlaceholderNoise('We store all IDs as strings in the database for compatibility'),
    ).toBe(false);
  });

  it('keeps "real" used as an adjective in regular prose', () => {
    expect(isPlaceholderNoise('This is a real problem with the current approach to caching')).toBe(
      false,
    );
  });

  it('keeps a sentence about writing code', () => {
    expect(isPlaceholderNoise('You write the handler function and export it from the module')).toBe(
      false,
    );
  });

  it('keeps prose mentioning "body" in HTTP context', () => {
    expect(isPlaceholderNoise('The request body must include the userId and the timestamp')).toBe(
      false,
    );
  });

  it('keeps prose mentioning "fictional" in a creative writing context', () => {
    // "fictional" alone is fine; only the combination "fictional memory note" is noise
    expect(isPlaceholderNoise('We used fictional data in the demo to avoid PII issues')).toBe(
      false,
    );
  });

  it('keeps prose mentioning output formatting without the exact phrase', () => {
    expect(isPlaceholderNoise('The API outputs JSON; only the body field is required')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. isAgentMetaText — placeholder patterns are caught via delegation
// ---------------------------------------------------------------------------
describe('isAgentMetaText — placeholder patterns are caught via isPlaceholderNoise', () => {
  it('isAgentMetaText returns true for the canonical placeholder title', () => {
    expect(
      isAgentMetaText('strings, decisions that a real note on this topic would mention.'),
    ).toBe(true);
  });

  it('isAgentMetaText returns true for the fictional-note instruction', () => {
    expect(
      isAgentMetaText(
        "You write a short fictional memory note that hypothetically answers the user's search query.",
      ),
    ).toBe(true);
  });

  it('isAgentMetaText returns false for real decision prose', () => {
    expect(
      isAgentMetaText(
        'We decided to use Supabase RLS over application-level checks for performance',
      ),
    ).toBe(false);
  });

  it('isAgentMetaText returns false for a normal note about topics', () => {
    expect(
      isAgentMetaText('The topic of database schema migrations was discussed in the last sprint'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. isPlaceholderNoise — raw HTML from real residual notes is caught
// ---------------------------------------------------------------------------
describe('isPlaceholderNoise — raw HTML snippets that match real residual notes', () => {
  it('catches the HTML title pattern verbatim', () => {
    const htmlTitle =
      '<h2><time datetime="2026-05-26T10:06:51.465Z">2026-05-26</time> strings, decisions that a real note on this topic would mention.</h2>';
    expect(isPlaceholderNoise(htmlTitle)).toBe(true);
  });

  it('catches the TLDR section with placeholder text', () => {
    const tldr =
      '<section data-section="tldr"><p>strings, decisions that a real note on this topic would mention.</p></section>';
    expect(isPlaceholderNoise(tldr)).toBe(true);
  });

  it('catches the system-prompt instruction line that leaked into the note', () => {
    const instruction =
      "You write a short fictional memory note that hypothetically answers the user's search query.\nWrite 3-5 sentences. Concrete vocabulary: include the named entities, library names, error strings, decisions that a real note on this topic would mention.\nDo NOT speculate or invent facts that aren't strongly implied by the query.\nOutput ONLY the note body. No prose, no preamble, no quotes.";
    expect(isPlaceholderNoise(instruction)).toBe(true);
  });

  it('does NOT catch a real note about the LazyBrain recall skill design', () => {
    const realNote =
      "LazyBrain's recall skill injects a system prompt to make Claude generate a synthetic memory note. The note is stored and indexed for future retrieval. Decision: use HTML over Markdown for storage efficiency.";
    expect(isPlaceholderNoise(realNote)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. runPrune 'placeholder-noise' policy — self-contained temp-fixture tests
//
// Fixture layout under os.tmpdir():
//   <tmpBrain>/
//     notes/
//       2026-05/
//         genuine-supabase-rls.html   ← real knowledge, must NOT be pruned
//         genuine-indexing-strategy.html ← real knowledge, must NOT be pruned
//         placeholder-recall-leaked.html ← leaked system prompt, MUST be pruned
//         placeholder-fictional-note.html ← fictional-note instruction, MUST be pruned
// ---------------------------------------------------------------------------

function makeNoteHtml(title: string, tldr: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${title}</title></head>
<body>
<article data-cerveau-source="test" data-cerveau-quality="standard">
  <h2>${title}</h2>
  <section data-section="tldr"><p>${tldr}</p></section>
  <section data-section="body"><p>${body}</p></section>
</article>
</body>
</html>`;
}

const GENUINE_SUPABASE = makeNoteHtml(
  'Supabase RLS policy design — 2026-05',
  'We chose Row Level Security over application-level checks for better data isolation.',
  'After evaluating three approaches, the team settled on Supabase RLS policies. ' +
    'The auth.uid() function is used in every policy to scope rows to the authenticated user. ' +
    'Service-role keys bypass RLS only in trusted edge functions with explicit justification.',
);

const GENUINE_INDEXING = makeNoteHtml(
  'Full-text search index strategy — 2026-05',
  'LazyBrain uses a trigram FTS index with BM25 ranking for sub-50ms recall latency.',
  'The indexer strips HTML, normalises whitespace, and tokenises on word boundaries. ' +
    'Stop-words are removed before insertion into the SQLite FTS5 virtual table. ' +
    'Index rebuilds are incremental using SHA-256 fingerprints to skip unchanged notes.',
);

const PLACEHOLDER_LEAKED_PROMPT = makeNoteHtml(
  'strings, decisions that a real note on this topic would mention.',
  'strings, decisions that a real note on this topic would mention.',
  "You write a short fictional memory note that hypothetically answers the user's search query. " +
    'Write 3-5 sentences. Concrete vocabulary: include the named entities, library names, error ' +
    'strings, decisions that a real note on this topic would mention. ' +
    'Output ONLY the note body. No prose, no preamble, no quotes.',
);

const PLACEHOLDER_FICTIONAL_NOTE = makeNoteHtml(
  'output only the note body',
  'output only the note body. No prose, no preamble, no quotes.',
  'You write a short fictional memory note that hypothetically answers the query. ' +
    'Concrete vocabulary: include the named entities, library names, error strings, decisions that ' +
    'a real note on this topic would mention.',
);

const NOISE_COUNT = 2;
const GENUINE_COUNT = 2;

let tmpBrain: string;

beforeAll(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), 'lazybrain-prune-test-'));
  const notesDir = join(tmpBrain, 'notes', '2026-05');
  mkdirSync(notesDir, { recursive: true });

  writeFileSync(join(notesDir, 'genuine-supabase-rls.html'), GENUINE_SUPABASE, 'utf-8');
  writeFileSync(join(notesDir, 'genuine-indexing-strategy.html'), GENUINE_INDEXING, 'utf-8');
  writeFileSync(
    join(notesDir, 'placeholder-recall-leaked.html'),
    PLACEHOLDER_LEAKED_PROMPT,
    'utf-8',
  );
  writeFileSync(
    join(notesDir, 'placeholder-fictional-note.html'),
    PLACEHOLDER_FICTIONAL_NOTE,
    'utf-8',
  );
});

afterAll(() => {
  if (tmpBrain && existsSync(tmpBrain)) {
    rmSync(tmpBrain, { recursive: true, force: true });
  }
});

describe('runPrune placeholder-noise policy — self-contained temp-fixture', () => {
  it('dry-run: identifies exactly the noise notes and deletes nothing', () => {
    const report = runPrune({
      policy: ['placeholder-noise'],
      dryRun: true,
      brainPath: tmpBrain,
    });

    expect(report.dryRun).toBe(true);
    expect(report.policies).toEqual(['placeholder-noise']);
    expect(report.counts['placeholder-noise']).toBe(NOISE_COUNT);
    expect(report.candidates).toHaveLength(NOISE_COUNT);
    expect(report.deleted).toBe(0);

    // Candidates must point only to the two noise files
    const candidateNames = report.candidates.map((c) =>
      c.path.replace(/\\/g, '/').split('/').at(-1),
    );
    expect(candidateNames).toContain('placeholder-recall-leaked.html');
    expect(candidateNames).toContain('placeholder-fictional-note.html');

    // Genuine notes must NOT appear in candidates
    expect(candidateNames).not.toContain('genuine-supabase-rls.html');
    expect(candidateNames).not.toContain('genuine-indexing-strategy.html');
  });

  it('dry-run: report shape is correct (totalFiles, totalDirs, Array candidates)', () => {
    const report = runPrune({
      policy: ['placeholder-noise'],
      dryRun: true,
      brainPath: tmpBrain,
    });

    expect(typeof report.totalFiles).toBe('number');
    expect(typeof report.totalDirs).toBe('number');
    expect(Array.isArray(report.candidates)).toBe(true);
    expect(report.totalFiles).toBe(NOISE_COUNT);
    expect(report.totalDirs).toBe(0);
  });

  it('apply (dryRun=false): deletes noise notes and leaves genuine notes intact', () => {
    // Use a fresh temp brain so this test is independent of the dry-run tests
    const applyBrain = mkdtempSync(join(tmpdir(), 'lazybrain-prune-apply-'));
    const notesDir = join(applyBrain, 'notes', '2026-05');
    mkdirSync(notesDir, { recursive: true });

    writeFileSync(join(notesDir, 'genuine-supabase-rls.html'), GENUINE_SUPABASE, 'utf-8');
    writeFileSync(join(notesDir, 'genuine-indexing-strategy.html'), GENUINE_INDEXING, 'utf-8');
    writeFileSync(
      join(notesDir, 'placeholder-recall-leaked.html'),
      PLACEHOLDER_LEAKED_PROMPT,
      'utf-8',
    );
    writeFileSync(
      join(notesDir, 'placeholder-fictional-note.html'),
      PLACEHOLDER_FICTIONAL_NOTE,
      'utf-8',
    );

    try {
      const report = runPrune({
        policy: ['placeholder-noise'],
        dryRun: false,
        brainPath: applyBrain,
      });

      expect(report.dryRun).toBe(false);
      expect(report.deleted).toBe(NOISE_COUNT);

      // Noise files must be gone
      expect(existsSync(join(notesDir, 'placeholder-recall-leaked.html'))).toBe(false);
      expect(existsSync(join(notesDir, 'placeholder-fictional-note.html'))).toBe(false);

      // Genuine files must still exist
      expect(existsSync(join(notesDir, 'genuine-supabase-rls.html'))).toBe(true);
      expect(existsSync(join(notesDir, 'genuine-indexing-strategy.html'))).toBe(true);

      // Second run on the cleaned brain: 0 candidates
      const second = runPrune({
        policy: ['placeholder-noise'],
        dryRun: true,
        brainPath: applyBrain,
      });
      expect(second.candidates).toHaveLength(0);
      expect(second.counts['placeholder-noise']).toBe(GENUINE_COUNT - GENUINE_COUNT); // 0
    } finally {
      rmSync(applyBrain, { recursive: true, force: true });
    }
  });
});
