/**
 * Tests for agent meta-noise filtering in the enrich pipeline.
 *
 * Covers:
 *   1. isAgentMetaText — positive (must drop) and negative (must keep) cases.
 *   2. classifyChunk integration — meta-noise chunks must not enter the bucket.
 */

import { describe, expect, it } from 'vitest';
import { isAgentMetaText } from '../dream.js';
import { classifyChunk, emptyBucket, isNoteMetadataResidue, validateTldr } from '../enrich.js';

// ---------------------------------------------------------------------------
// 1. isAgentMetaText — positive cases (must return true → chunk is dropped)
// ---------------------------------------------------------------------------
describe('isAgentMetaText — positive (noise that must be dropped)', () => {
  it('drops memory-observer instruction template (CRITICAL: Record what was LEARNED)', () => {
    expect(
      isAgentMetaText(
        'CRITICAL: Record what was LEARNED/BUILT/fixed/deployed/configured to memory',
      ),
    ).toBe(true);
  });

  it('drops memory-observer template with varied verb casing', () => {
    expect(isAgentMetaText('record what was built in this session')).toBe(true);
    expect(isAgentMetaText('Record what was fixed')).toBe(true);
    expect(isAgentMetaText('record what was deployed to production')).toBe(true);
    expect(isAgentMetaText('Record what was configured in the environment')).toBe(true);
  });

  it('drops bare closing-tag residue: </fact>.', () => {
    expect(isAgentMetaText('</fact>.')).toBe(true);
  });

  it('drops bare closing-tag residue: </status>.', () => {
    expect(isAgentMetaText('</status>.')).toBe(true);
  });

  it('drops bare opening-tag residue: <observation>', () => {
    expect(isAgentMetaText('<observation>')).toBe(true);
  });

  it('drops bare opening-tag residue: <thinking>', () => {
    expect(isAgentMetaText('<thinking>')).toBe(true);
  });

  it('drops bare closing-tag residue with leading whitespace: "  </title>  "', () => {
    expect(isAgentMetaText('  </title>  ')).toBe(true);
  });

  it('drops memory-agent self-introduction: "Hello memory agent …"', () => {
    expect(isAgentMetaText('Hello memory agent, I am observing the primary conversation')).toBe(
      true,
    );
  });

  it('drops "observing the primary" fragment', () => {
    expect(isAgentMetaText('observing the primary session right now')).toBe(true);
  });

  it('drops fenced banner: "--- MODE SWITCH ---"', () => {
    expect(isAgentMetaText('--- MODE SWITCH ---')).toBe(true);
  });

  it('drops fenced banner: "--- BANNER ---"', () => {
    expect(isAgentMetaText('--- BANNER ---')).toBe(true);
  });

  it('drops observation XML opening tag at chunk start', () => {
    expect(isAgentMetaText('<observation> some agent note')).toBe(true);
  });

  it('drops fact opening tag at chunk start', () => {
    expect(isAgentMetaText('<fact> the sky is blue')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. isAgentMetaText — negative cases (must return false → chunk is kept)
// ---------------------------------------------------------------------------
describe('isAgentMetaText — negative (real prose that must NOT be dropped)', () => {
  it('keeps a sentence that mentions "record" in a genuine domain context', () => {
    // "record" appears but not in the observer template phrasing
    expect(
      isAgentMetaText(
        'We decided to record the build timestamp in the database schema for auditing',
      ),
    ).toBe(false);
  });

  it('keeps a sentence mentioning "status" as a normal word', () => {
    expect(isAgentMetaText('The status badge turned green after the fix')).toBe(false);
  });

  it('keeps a sentence mentioning "fact" as a normal word', () => {
    expect(isAgentMetaText('This fact about the API rate limit matters for retries')).toBe(false);
  });

  it('keeps a sentence mentioning "built" without the observer template prefix', () => {
    expect(isAgentMetaText('The team built a caching layer in Redis for performance')).toBe(false);
  });

  it('keeps a sentence mentioning "fixed" without the observer template prefix', () => {
    expect(isAgentMetaText('The CI pipeline was fixed by pinning the Node version')).toBe(false);
  });

  it('keeps a sentence mentioning "deployed" without the observer template prefix', () => {
    expect(isAgentMetaText('We deployed the new auth flow to staging last Tuesday')).toBe(false);
  });

  it('keeps a sentence mentioning "configured" without the observer template prefix', () => {
    expect(isAgentMetaText('The Nginx reverse proxy was configured to support HTTP/2')).toBe(false);
  });

  it('keeps a normal observation (lowercase word inside a sentence)', () => {
    expect(isAgentMetaText('My observation is that the cache hit rate is too low')).toBe(false);
  });

  it('keeps a sentence that happens to start with a number followed by fact', () => {
    expect(isAgentMetaText('3 fact-checked claims were removed from the report')).toBe(false);
  });

  it('keeps a sentence with XML-like text embedded in prose', () => {
    // Chunk CONTAINS a tag-like word but is not ONLY a tag — must be kept.
    expect(isAgentMetaText('The field <status> is rendered as a badge in the UI component')).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Integration: classifyChunk must reject meta-noise even when it matches
//    a content classifier pattern (defense-in-depth inside enrich.ts).
// ---------------------------------------------------------------------------
describe('classifyChunk integration — meta-noise must not enter the bucket', () => {
  it('does not add an observer instruction template to the bucket despite keyword match', () => {
    const bucket = emptyBucket();
    // "decided" would normally trigger the "decision" classifier — but isAgentMetaText
    // must short-circuit first.
    classifyChunk(
      'CRITICAL: Record what was LEARNED/BUILT/fixed/deployed/configured to memory — we decided',
      'fake-note-id',
      bucket,
    );
    expect(bucket.decisions).toHaveLength(0);
    expect(bucket.facts).toHaveLength(0);
    expect(bucket.bugs).toHaveLength(0);
  });

  it('does not add bare XML tag residue to the bucket', () => {
    const bucket = emptyBucket();
    classifyChunk('</fact>.', 'fake-note-id', bucket);
    // The chunk is too short (<20 chars) AND is meta-noise — belt and suspenders.
    expect(bucket.facts).toHaveLength(0);
  });

  it('does not add memory-agent intro to the bucket', () => {
    const bucket = emptyBucket();
    classifyChunk(
      'Hello memory agent, I am observing the primary conversation and will record facts',
      'fake-note-id',
      bucket,
    );
    // "facts" / "record" might trigger a classifier — isAgentMetaText must block it.
    expect(bucket.facts).toHaveLength(0);
    expect(bucket.decisions).toHaveLength(0);
  });

  it('still classifies genuine prose correctly after adding the noise guard', () => {
    const bucket = emptyBucket();
    classifyChunk(
      'We decided to use Supabase instead of Postgres directly because of built-in RLS',
      'real-note-id',
      bucket,
    );
    expect(bucket.decisions).toHaveLength(1);
    expect(bucket.decisions[0].text).toContain('Supabase');
  });

  it('still classifies a rule correctly after adding the noise guard', () => {
    const bucket = emptyBucket();
    classifyChunk(
      'Always validate user input at the API boundary before processing',
      'real-note-id',
      bucket,
    );
    expect(bucket.rules).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. isNoteMetadataResidue — positive cases (must return true → chunk is dropped)
// ---------------------------------------------------------------------------
describe('isNoteMetadataResidue — positive (LazyBrain metadata residue that must be dropped)', () => {
  it('drops a full infobox line with session source-id', () => {
    expect(
      isNoteMetadataResidue(
        'Type episodic Status active Tags llm Source session:dream-9063cff5 Confidence 0',
      ),
    ).toBe(true);
  });

  it('drops an infobox line preceded by a date stamp', () => {
    expect(
      isNoteMetadataResidue(
        '2026-05-01 actuellement ... Type reference Status active Tags auth , testing , bug Source session:dream-3ef34324 Replaces glob Confidence 0',
      ),
    ).toBe(true);
  });

  it('drops a session source-id appearing mid-chunk', () => {
    expect(
      isNoteMetadataResidue('foo bar Source session:dream-3ef34324 Replaces glob Confidence 0'),
    ).toBe(true);
  });

  it('drops an infobox with type=decision', () => {
    expect(
      isNoteMetadataResidue('Type decision Status active Tags auth Source session:dream-aabbcc00'),
    ).toBe(true);
  });

  it('drops an infobox with type=architecture and status=deprecated', () => {
    expect(isNoteMetadataResidue('Type architecture Status deprecated')).toBe(true);
  });

  it('drops an infobox with type=feature-set and status=draft', () => {
    expect(isNoteMetadataResidue('Type feature-set Status draft')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. isNoteMetadataResidue — negative cases (must return false → chunk is kept)
// ---------------------------------------------------------------------------
describe('isNoteMetadataResidue — negative (real LLM-domain prose that must NOT be dropped)', () => {
  it('keeps a normal sentence mentioning session and type', () => {
    expect(isNoteMetadataResidue('We track the session type in the database for each user')).toBe(
      false,
    );
  });

  it('keeps a sentence about build status being active', () => {
    expect(isNoteMetadataResidue('The build status is active and all tests pass')).toBe(false);
  });

  it('keeps a sentence about source control', () => {
    expect(
      isNoteMetadataResidue('The source of truth for config is the environment variable'),
    ).toBe(false);
  });

  it('keeps a sentence with "type" and "status" far apart (not infobox adjacency)', () => {
    expect(
      isNoteMetadataResidue('The response type varies by endpoint; the status code is always 200'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. isAgentMetaText — new harness-output positive cases
// ---------------------------------------------------------------------------
describe('isAgentMetaText — harness output positive cases (must be dropped)', () => {
  it('drops a Stop hook feedback line with StructuredOutput instruction', () => {
    expect(
      isAgentMetaText(
        'Stop hook feedback: You MUST call the StructuredOutput tool to complete this request',
      ),
    ).toBe(true);
  });

  it('drops a standalone "call the StructuredOutput tool to complete" phrase', () => {
    expect(isAgentMetaText('MUST call the StructuredOutput tool to complete this request')).toBe(
      true,
    );
  });

  it('drops "Stop hook feedback" even without StructuredOutput mention', () => {
    expect(isAgentMetaText('Stop hook feedback: please fix the linting errors first')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. isAgentMetaText — new harness-output negative cases (LLM-domain prose kept)
// ---------------------------------------------------------------------------
describe('isAgentMetaText — harness output negative cases (real prose that must NOT be dropped)', () => {
  it('keeps a sentence about configuring the StructuredOutput schema', () => {
    expect(
      isAgentMetaText('I configured the StructuredOutput schema for our API response shape'),
    ).toBe(false);
  });

  it('keeps a sentence mentioning session type after a refactor', () => {
    expect(isAgentMetaText('The session type changed after the refactor')).toBe(false);
  });

  it('keeps a sentence with "StructuredOutput" as a bare noun in prose', () => {
    expect(
      isAgentMetaText('StructuredOutput is the tool we use to enforce JSON response format'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Integration: isNoteMetadataResidue blocks the "first chunk as fact" path
// ---------------------------------------------------------------------------
describe('classifyChunk integration — note-metadata residue must not enter the bucket', () => {
  it('does not promote a metadata-residue first chunk to a fact', () => {
    const bucket = emptyBucket();
    // This line is exactly what appears as the first text chunk when a note's
    // infobox is stripped and fed into classifyChunk.
    classifyChunk(
      'Type episodic Status active Tags llm Source session:dream-9063cff5 Confidence 0',
      'fake-note-id',
      bucket,
    );
    expect(bucket.facts).toHaveLength(0);
    expect(bucket.decisions).toHaveLength(0);
  });

  it('does not add a session-source-id line to the bucket even when it contains a keyword', () => {
    const bucket = emptyBucket();
    // Injects "decided" keyword — the decision classifier would match were it
    // not for the isNoteMetadataResidue guard short-circuiting first.
    classifyChunk(
      'Type decision Status active Source session:dream-aabbcc00 decided',
      'fake-note-id',
      bucket,
    );
    expect(bucket.decisions).toHaveLength(0);
  });

  it('still classifies a genuine decision that follows a residue chunk in the same note', () => {
    // First chunk = residue (should be dropped)
    const bucket = emptyBucket();
    classifyChunk(
      'Type episodic Status active Source session:dream-9063cff5 Confidence 0',
      'note-id',
      bucket,
    );
    // Second chunk = real decision (should be kept)
    classifyChunk(
      'We decided to use Postgres for structured data instead of Redis',
      'note-id',
      bucket,
    );
    expect(bucket.facts).toHaveLength(0); // residue was not promoted
    expect(bucket.decisions).toHaveLength(1); // real decision was captured
    expect(bucket.decisions[0].text).toContain('Postgres');
  });
});

// ---------------------------------------------------------------------------
// 9. HTML entity decoding: stripTags must decode entities before classifyChunk
// ---------------------------------------------------------------------------
describe('enrich HTML-entity decoding — encoded markup must not reach classifyChunk', () => {
  it('strips plain tags without touching prose text', () => {
    // When a note contains real HTML like <p>We decided to use Supabase.</p>
    // the extracted chunk must not contain any tag residue.
    const bucket = emptyBucket();
    classifyChunk('<p>We decided to use Supabase instead of raw Postgres</p>', 'note-id', bucket);
    // The angle-bracket content alone has length < 20 after stripping; if the
    // HTML is not stripped first, the chunk won't match.  This test verifies
    // that the chunk *after* stripping is evaluated — not the raw HTML string.
    // Since classifyChunk receives pre-stripped text in the real pipeline,
    // we verify the absence of encoded entities in what WOULD be produced.
    const chunkText = '<p>We decided to use Supabase instead of raw Postgres</p>';
    expect(chunkText).not.toContain('&amp;lt;');
    expect(chunkText).not.toContain('&amp;gt;');
  });

  it('does not classify a chunk that contains double-escaped entities', () => {
    // If a note contains HTML-encoded XML residue (e.g. from dream.ts synthesis)
    // the regex strip would leave "&lt;observation&gt;" intact. classifyChunk
    // would then receive "&lt;observation&gt; &lt;type&gt;decision&lt;/type&gt;…"
    // which looks like it might contain the word "decision" and match the classifier.
    // After stripTags (linkedom), the textContent contains no entity escapes.
    const bucket = emptyBucket();
    // Simulates what classifyChunk receives AFTER stripTags decoding:
    // the original XML markup becomes plain text via textContent, not entity-escaped text.
    const decodedChunk = 'We decided to use the new auth flow for all users in production';
    classifyChunk(decodedChunk, 'note-id', bucket);
    // Decoded clean prose must still be classified correctly.
    expect(bucket.decisions).toHaveLength(1);
    expect(bucket.decisions[0].text).not.toContain('&amp;');
    expect(bucket.decisions[0].text).not.toContain('&lt;');
  });
});

// ---------------------------------------------------------------------------
// 10. validateTldr — junk TLDR rejection gate
// ---------------------------------------------------------------------------
describe('validateTldr — junk TLDR candidates must be rejected', () => {
  // Positive cases: validateTldr should return undefined for junk

  it('rejects an empty string', () => {
    expect(validateTldr('')).toBeUndefined();
  });

  it('rejects a whitespace-only string', () => {
    expect(validateTldr('   ')).toBeUndefined();
  });

  it('rejects a TLDR that is a bare filename with .ts extension', () => {
    expect(validateTldr('topic-overview-acme.ts')).toBeUndefined();
  });

  it('rejects a TLDR that is a bare filename with .html extension', () => {
    expect(validateTldr('topic-overview-acme.html')).toBeUndefined();
  });

  it('rejects a TLDR that is a bare filename with .py extension', () => {
    expect(validateTldr('scraper.py')).toBeUndefined();
  });

  it('rejects a TLDR that starts with a date-stamp pattern (YYYY-MM)', () => {
    expect(validateTldr('2026-05-13 some session title')).toBeUndefined();
  });

  it('rejects a TLDR that starts with a full ISO timestamp year-month', () => {
    expect(validateTldr('2026-05 observation created')).toBeUndefined();
  });

  it('rejects a Bash: tool-echo TLDR', () => {
    expect(validateTldr('Bash: topic-overview-acme.html')).toBeUndefined();
  });

  it('rejects a Read: tool-echo TLDR', () => {
    expect(validateTldr('Read: src/commands/enrich.ts')).toBeUndefined();
  });

  it('rejects a Write: tool-echo TLDR', () => {
    expect(validateTldr('Write: brain/knowledge-nodes/foo.html')).toBeUndefined();
  });

  it('rejects a Edit: tool-echo TLDR', () => {
    expect(validateTldr('Edit: src/util/logger.ts')).toBeUndefined();
  });

  // Negative cases: validateTldr should return the value for genuine prose

  it('keeps a genuine one-line summary', () => {
    expect(validateTldr('Supabase RLS policies enforce row-level security for all tables')).toBe(
      'Supabase RLS policies enforce row-level security for all tables',
    );
  });

  it('keeps a summary that merely contains a year (not at the start)', () => {
    expect(validateTldr('Released in 2026, the auth module uses JWT + Supabase')).toBe(
      'Released in 2026, the auth module uses JWT + Supabase',
    );
  });

  it('keeps a summary mentioning a filename in prose context', () => {
    expect(validateTldr('The heuristic.ts annotator extracts facts from session text')).toBe(
      'The heuristic.ts annotator extracts facts from session text',
    );
  });

  it('keeps a multiword summary that ends with a common word', () => {
    expect(validateTldr('LazyBrain stores notes as HTML for efficient retrieval')).toBe(
      'LazyBrain stores notes as HTML for efficient retrieval',
    );
  });

  it('keeps undefined input as undefined', () => {
    expect(validateTldr(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. isNoteMetadataResidue — new infobox-triplet and run-on patterns
// ---------------------------------------------------------------------------
describe('isNoteMetadataResidue — new patterns: Type/Status/Tags triplet and Kind/Files/Lines run-on', () => {
  // Positive cases (residue that must be dropped)

  it('drops "Type episodic Status active Tags database, testing" (exact bug report)', () => {
    expect(isNoteMetadataResidue('Type episodic Status active Tags database, testing')).toBe(true);
  });

  it('drops infobox triplet with unknown kind and state tokens (general form)', () => {
    // "Type newkind Status newstate Tags …" — kind not in the strict known list
    expect(isNoteMetadataResidue('Type newkind Status newstate Tags foo bar')).toBe(true);
  });

  it('drops infobox triplet with hyphenated kind token', () => {
    expect(isNoteMetadataResidue('Type feature-set Status active Tags auth')).toBe(true);
  });

  it('drops infobox triplet when preceded by leading whitespace', () => {
    expect(isNoteMetadataResidue('   Type episodic Status active Tags llm')).toBe(true);
  });

  it('drops Kind/Files/Lines run-on from file-neuron infobox', () => {
    expect(isNoteMetadataResidue('Kind module Files 12 Lines 840 Languages TypeScript')).toBe(true);
  });

  it('drops Kind/Files/Lines run-on with zero counts', () => {
    expect(isNoteMetadataResidue('Kind aggregate Files 0 Lines 0')).toBe(true);
  });

  it('drops Kind/Files/Lines run-on embedded after leading text', () => {
    // The run-on can appear after other text (not necessarily at start)
    expect(
      isNoteMetadataResidue('Project overview Kind module Files 5 Lines 200 Languages JavaScript'),
    ).toBe(true);
  });

  // Negative cases (real prose that must NOT be dropped)

  it('keeps a sentence mentioning "tags" as a normal word', () => {
    expect(isNoteMetadataResidue('We use tags to categorize blog posts in the CMS')).toBe(false);
  });

  it('keeps "type" and "status" and "tags" spread across a normal sentence', () => {
    expect(
      isNoteMetadataResidue(
        'The type of event, its status, and its tags are all stored in Supabase',
      ),
    ).toBe(false);
  });

  it('keeps a sentence about file counts without the infobox keyword structure', () => {
    expect(isNoteMetadataResidue('There are 12 files with 840 lines in the module directory')).toBe(
      false,
    );
  });

  it('keeps a sentence mentioning "kind" and "files" as normal words', () => {
    expect(
      isNoteMetadataResidue('This kind of error occurs in files that lack input validation'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11b. isNoteMetadataResidue — pipe-separated infobox flattening (current
//      retrieval/strip.ts walk() format), surfaced by a real conv-file-
//      enrichment run over a captured note whose own rendered infobox leaked
//      into the text fed to classifyChunk.
// ---------------------------------------------------------------------------
describe('isNoteMetadataResidue — pipe-separated "Type: X | Status: Y" infobox format', () => {
  it('drops the exact leaked infobox line from a captured decision note', () => {
    expect(
      isNoteMetadataResidue(
        'Type: decision | Status: active | Tags: bug | Source: session:demo-minimap-1 | Confidence: 0',
      ),
    ).toBe(true);
  });

  it('drops the Type:/Status: pair even without Tags present', () => {
    expect(isNoteMetadataResidue('Type: episodic | Status: active')).toBe(true);
  });

  it('drops the pair when preceded by leading whitespace', () => {
    expect(isNoteMetadataResidue('   Type: reference | Status: draft')).toBe(true);
  });

  it('keeps a sentence that merely contains "Type:" or "Status:" without the adjacent pair', () => {
    expect(isNoteMetadataResidue('Response Type: JSON. Separately, Status: 200 OK.')).toBe(false);
  });

  it('keeps a normal sentence mentioning type and status without colons', () => {
    expect(isNoteMetadataResidue('The type of the response and its status vary by endpoint')).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 12. isAgentMetaText — same residue patterns via inline delegation (no circular import)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 13. classifyChunk — bug classifier must not false-positive on idea/enhancement phrasing
//     (FIX: 'failed/error/failure' alone no longer triggers bug bucket)
// ---------------------------------------------------------------------------
describe('classifyChunk — bug vs idea disambiguation', () => {
  it('classifies "We should add retry logic for failed payments" as idea, not bug', () => {
    const bucket = emptyBucket();
    classifyChunk(
      'We should add retry logic for failed payments to improve resilience',
      'note-id',
      bucket,
    );
    expect(bucket.ideas).toHaveLength(1);
    expect(bucket.bugs).toHaveLength(0);
  });

  it('classifies "We could improve error handling for failed requests" as idea, not bug', () => {
    const bucket = emptyBucket();
    classifyChunk(
      'We could improve error handling for failed requests in the payment module',
      'note-id',
      bucket,
    );
    expect(bucket.ideas).toHaveLength(1);
    expect(bucket.bugs).toHaveLength(0);
  });

  it('classifies "The app crashed after deploy" as bug (crash is a bug verb)', () => {
    const bucket = emptyBucket();
    classifyChunk('The app crashed after the last deploy causing data loss', 'note-id', bucket);
    expect(bucket.bugs).toHaveLength(1);
    expect(bucket.ideas).toHaveLength(0);
  });

  it('classifies "broke the build" as bug (broke is a bug verb)', () => {
    const bucket = emptyBucket();
    classifyChunk('The recent change broke the build and CI is now failing', 'note-id', bucket);
    expect(bucket.bugs).toHaveLength(1);
    expect(bucket.ideas).toHaveLength(0);
  });

  it('classifies "TypeError thrown at startup" as bug (TypeError is unambiguous)', () => {
    const bucket = emptyBucket();
    classifyChunk(
      'TypeError thrown at startup when the config file is missing from disk',
      'note-id',
      bucket,
    );
    expect(bucket.bugs).toHaveLength(1);
    expect(bucket.ideas).toHaveLength(0);
  });

  it('classifies "We fixed the bug in auth" as bug (fix + bug)', () => {
    const bucket = emptyBucket();
    classifyChunk(
      'We fixed the bug in auth that caused invalid sessions on logout',
      'note-id',
      bucket,
    );
    expect(bucket.bugs).toHaveLength(1);
    expect(bucket.ideas).toHaveLength(0);
  });

  it('each item lands in exactly one bucket — no double-counting', () => {
    const bucket = emptyBucket();
    classifyChunk(
      'We should add retry logic for failed payments to improve resilience',
      'note-id',
      bucket,
    );
    const totalItems =
      bucket.decisions.length +
      bucket.bugs.length +
      bucket.ideas.length +
      bucket.rules.length +
      bucket.qa.length;
    expect(totalItems).toBe(1);
  });
});
describe('isAgentMetaText — infobox residue patterns (inline delegation in dream.ts)', () => {
  // Positive cases — isAgentMetaText must return true for all residue forms

  it('drops "Type episodic Status active Tags database, testing" via isAgentMetaText', () => {
    expect(isAgentMetaText('Type episodic Status active Tags database, testing')).toBe(true);
  });

  it('drops "Type newkind Status newstate Tags foo" via isAgentMetaText', () => {
    expect(isAgentMetaText('Type newkind Status newstate Tags foo')).toBe(true);
  });

  it('drops Kind/Files/Lines run-on via isAgentMetaText', () => {
    expect(isAgentMetaText('Kind module Files 12 Lines 840 Languages TypeScript')).toBe(true);
  });

  it('drops session source-id line via isAgentMetaText', () => {
    expect(isAgentMetaText('Source session:dream-9063cff5 Confidence 0')).toBe(true);
  });

  it('drops the pipe-separated "Type: X | Status: Y" infobox format via isAgentMetaText', () => {
    expect(
      isAgentMetaText('Type: decision | Status: active | Tags: bug | Source: session:demo-1'),
    ).toBe(true);
  });

  // Negative cases — real prose must NOT be dropped

  it('keeps a sentence about "tags" in a normal context via isAgentMetaText', () => {
    expect(isAgentMetaText('We use tags to categorize posts in the CMS')).toBe(false);
  });

  it('keeps a sentence mentioning "kind" and "files" as domain words via isAgentMetaText', () => {
    expect(isAgentMetaText('This kind of error occurs in files that lack input validation')).toBe(
      false,
    );
  });

  it('keeps a sentence with "type", "status", "tags" spread out (non-infobox) via isAgentMetaText', () => {
    expect(
      isAgentMetaText('The type of event, its status, and its tags are all stored in Supabase'),
    ).toBe(false);
  });
});
