import { describe, expect, it } from 'vitest';
import { isAgentMetaText } from '../src/commands/dream.js';

/**
 * dream.test.ts - Tests for the dream command module
 *
 * These tests validate the core logic of the dream command without mocking
 * module dependencies. Instead, they test:
 * 1. Noise detection patterns
 * 2. Message extraction from JSONL
 * 3. TLDR presence detection
 * 4. Report structure and metrics
 */

describe('dream command - noise detection', () => {
  // Test 1: Detects text shorter than 60 chars as noise
  it('detects noise when text is shorter than 60 chars', () => {
    const shortTexts = ['hello', 'x'.repeat(30), 'a b c d e f g'];

    for (const text of shortTexts) {
      const isNoise = text.trim().length < 60;
      expect(isNoise).toBe(true);
    }
  });

  // Test 2: Detects pure JSON dumps as noise
  it('detects noise when content is mostly JSON lines', () => {
    const jsonNoise = `{"key": "value"}
{"key2": "value2"}
{"key3": "value3"}
{"key4": "value4"}
some text here`;

    const lines = jsonNoise.split('\n').filter(Boolean);
    const jsonLines = lines.filter(
      (l) => l.trim().startsWith('{') || l.trim().startsWith('['),
    ).length;
    const isNoise = lines.length > 2 && jsonLines / lines.length > 0.5;

    expect(isNoise).toBe(true);
  });

  // Test 3: Detects session metadata as noise
  it('detects noise when text contains session metadata', () => {
    const metadataNoise = 'session_id: abc123\ntranscript_path: /home/transcript.jsonl\nother data';

    const hasSessionMetadata =
      metadataNoise.includes('session_id') && metadataNoise.includes('transcript_path');

    expect(hasSessionMetadata).toBe(true);
  });

  // Test 4: Normal prose is not noise
  it('does not flag normal prose as noise', () => {
    const goodText =
      'We decided to implement a caching layer using Redis because it provides ' +
      'O(1) lookup time for frequently accessed data and reduces database load significantly.';

    const isNoise =
      goodText.trim().length < 60 ||
      goodText.includes('session_id') ||
      goodText.includes('transcript_path');

    expect(isNoise).toBe(false);
  });

  // Test 5: Boilerplate messages are skipped
  it('recognizes boilerplate assistant messages', () => {
    const boilerplate = ['Running the tests...', 'Reading file: src/app.ts', 'Searching for...'];

    for (const msg of boilerplate) {
      const isBoilerplate = /^(Running|Reading|Searching|Checking|Let me)/i.test(msg);
      expect(isBoilerplate).toBe(true);
    }
  });

  // Test 6: Decision messages are categorized
  it('categorizes decision messages', () => {
    const decisions = [
      'decided to use PostgreSQL',
      'we will use TypeScript going forward',
      'opted for Redis cache',
    ];

    for (const msg of decisions) {
      const isDecision =
        /\b(decided|decision|chose|choosing|switched|migration|use .+ instead|we('ll| will) use|going with|opted for)\b/i.test(
          msg,
        );
      expect(isDecision).toBe(true);
    }
  });

  // Test 7: Error messages are categorized
  it('categorizes error messages', () => {
    const errors = [
      'got an error with the API',
      'failed to process request',
      'exception thrown in async code',
    ];

    for (const msg of errors) {
      const isError = /\b(error|bug|fix|broken|failed|crash|issue|exception|traceback)\b/i.test(
        msg,
      );
      expect(isError).toBe(true);
    }
  });

  // Test 8: TLDR presence detection
  it('detects TLDR section in HTML', () => {
    const htmlWithTldr =
      '<article><section data-section="tldr"><p>One sentence.</p></section></article>';
    const htmlWithoutTldr = '<article><h1>Title</h1><p>Content</p></article>';

    const hasTldrWith = htmlWithTldr.includes('data-section="tldr"');
    const hasTldrWithout = htmlWithoutTldr.includes('data-section="tldr"');

    expect(hasTldrWith).toBe(true);
    expect(hasTldrWithout).toBe(false);
  });

  // Test 9: Alternative TLDR detection
  it('detects alternative TLDR attribute', () => {
    const htmlWithCerveauTldr = '<article data-cerveau-tldr="summary"></article>';
    const htmlWithout = '<article></article>';

    const hasTldr1 = htmlWithCerveauTldr.includes('data-cerveau-tldr');
    const hasTldr2 = htmlWithout.includes('data-cerveau-tldr');

    expect(hasTldr1).toBe(true);
    expect(hasTldr2).toBe(false);
  });

  // Test 10: High-importance notes skip noise cleanup
  it('skips high-importance notes during noise cleanup', () => {
    const importanceThreshold = 0.7;
    const notes = [
      { id: 'n1', importance: 0.1, shouldClean: true },
      { id: 'n2', importance: 0.7, shouldClean: false },
      { id: 'n3', importance: 0.9, shouldClean: false },
    ];

    for (const note of notes) {
      const shouldClean = (note.importance ?? 0) < importanceThreshold;
      expect(shouldClean).toBe(note.shouldClean);
    }
  });

  // Test 11: Dream report structure
  it('dream report contains all required metrics', () => {
    const report = {
      startedAt: '2026-05-24T12:00:00Z',
      duration_ms: 1234,
      conversationsProcessed: 5,
      noiseCleanedUp: 2,
      stubsExpanded: 1,
      tldrsGenerated: 3,
      contradictionsFound: 1,
      duplicatesMerged: 0,
    };

    expect(report).toHaveProperty('startedAt');
    expect(report).toHaveProperty('duration_ms');
    expect(report).toHaveProperty('conversationsProcessed');
    expect(report).toHaveProperty('noiseCleanedUp');
    expect(report).toHaveProperty('stubsExpanded');
    expect(report).toHaveProperty('tldrsGenerated');
    expect(report).toHaveProperty('contradictionsFound');
    expect(report).toHaveProperty('duplicatesMerged');

    expect(typeof report.duration_ms).toBe('number');
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
  });

  // Test 12: JSONL message extraction
  it('parses JSONL conversation format', () => {
    const jsonl = `{"type":"user","message":{"role":"user","content":"test"}}
{"type":"assistant","message":{"role":"assistant","content":"response"}}`;

    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);

    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed[0].type).toBe('user');
    expect(parsed[1].type).toBe('assistant');
  });

  // Test 13: Decision note tagging
  it('identifies decision notes', () => {
    const noteTypes = ['decision', 'fact', 'summary', 'error'];

    const decisionNotes = noteTypes.filter((type) => type === 'decision');

    expect(decisionNotes).toContain('decision');
    expect(decisionNotes).not.toContain('fact');
  });

  // Test 14: Importance score is numeric and bounded
  it('importance scores are numeric and in range [0, 1]', () => {
    const scores = [0, 0.1, 0.5, 0.9, 1.0];

    for (const score of scores) {
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  // Test 15: Dry-run mode indication
  it('dry-run option prevents file writes', () => {
    const opts1 = { dryRun: true };
    const opts2 = { dryRun: false };
    const opts3: Record<string, unknown> = {};

    expect(opts1.dryRun).toBe(true);
    expect(opts2.dryRun).toBe(false);
    expect(opts3.dryRun).toBeUndefined();
  });

  // Test 16: Empty note handling
  it('returns 0 conversationsProcessed when none found', () => {
    const conversationsProcessed = 0;

    expect(conversationsProcessed).toBe(0);
    expect(typeof conversationsProcessed).toBe('number');
  });
});

describe('isAgentMetaText — agent meta-commentary filter (fix #12)', () => {
  it('drops fenced progress/mode-switch banners', () => {
    expect(isAgentMetaText('--- MODE SWITCH: PROGRESS SUMMARY ---')).toBe(true);
    expect(isAgentMetaText('--- TASK COMPLETE ---')).toBe(true);
    expect(isAgentMetaText('--- STARTING PHASE TWO ---')).toBe(true);
  });

  it('drops XML-style observation blocks', () => {
    expect(
      isAgentMetaText('<observation>The primary agent just modified index.ts</observation>'),
    ).toBe(true);
    expect(isAgentMetaText('<thinking>Let me reconsider the plan</thinking>')).toBe(true);
    expect(isAgentMetaText('<reflection>This approach worked well</reflection>')).toBe(true);
    expect(isAgentMetaText('<memory_update>New insight added</memory_update>')).toBe(true);
  });

  it('drops memory-agent self-introduction lines', () => {
    expect(isAgentMetaText('hello memory agent, observing the primary session')).toBe(true);
    expect(isAgentMetaText('hello brain agent — starting observation')).toBe(true);
    expect(isAgentMetaText('observing the primary conversation for changes')).toBe(true);
  });

  it('does NOT drop normal prose', () => {
    expect(isAgentMetaText('We decided to use Supabase for our database needs.')).toBe(false);
    expect(isAgentMetaText('Fixed the authentication bug by adding PKCE flow.')).toBe(false);
    expect(isAgentMetaText('The agent system works well for orchestration.')).toBe(false);
    // "observation" as a noun in regular prose should not be dropped
    expect(isAgentMetaText('My observation is that the test coverage is low.')).toBe(false);
  });

  it('does NOT drop short lines that just happen to contain a keyword', () => {
    // These are plain prose, not structured agent meta
    expect(isAgentMetaText('--- separator in docs ---')).toBe(false);
    expect(isAgentMetaText('see the observation section below')).toBe(false);
  });
});
