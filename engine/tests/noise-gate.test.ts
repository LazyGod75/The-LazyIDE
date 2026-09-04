/**
 * noise-gate.test.ts
 *
 * Unit tests for the strengthened noise gate, covering the 5 concrete bad patterns
 * identified in real generated brain output, plus substantive positive cases that
 * must not be filtered.
 *
 * Negative cases  → detectNoise / isAgentMetaText must return true  (content is dropped)
 * Positive cases  → detectNoise / isAgentMetaText must return false (content is kept)
 */

import { describe, expect, it } from 'vitest';
import { detectNoise } from '../src/commands/dream.js';
import {
  countAlphanumericWords,
  hasMeaningfulContent,
  isAgentMetaText,
  isDominatedByRepetition,
  isMostlyPunctuation,
} from '../src/sources/noise.js';

// ===========================================================================
// Pattern 1 — Garbage / mostly-punctuation content
// ===========================================================================

describe('noise gate — Pattern 1: garbage / mostly-punctuation content', () => {
  it('drops a note whose title/tldr is essentially just `",.`', () => {
    // This is the exact shape of the first bad example reported
    expect(detectNoise('",.')).toBe(true);
    expect(isAgentMetaText('",.')).toBe(false); // not caught by meta — caught by word count
    expect(hasMeaningfulContent('",.')).toBe(false);
  });

  it('drops a very short punctuation string even when padded to > 60 chars', () => {
    // 70 chars but all punctuation / symbols
    const padded = '",. .,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,.,';
    expect(detectNoise(padded)).toBe(true);
  });

  it('drops content with fewer than 8 real words', () => {
    expect(detectNoise('hello world foo')).toBe(true); // 3 words, also < 60 chars
    // 7 distinct words, > 60 chars — still under the minimum 8-word threshold
    const sevenWords = 'apple banana cherry date elderberry fig grape .... .... .... ....';
    expect(countAlphanumericWords(sevenWords)).toBe(7);
    expect(detectNoise(sevenWords)).toBe(true);
  });

  it('keeps content that has 8+ real words', () => {
    const eightWords =
      'apple banana cherry date elderberry fig grape honeydew ice cream is good here now end';
    expect(countAlphanumericWords(eightWords)).toBeGreaterThanOrEqual(8);
    // (detectNoise may still drop for other reasons if < 60 chars total, so use longer text)
    const substantive =
      'We decided to migrate the authentication layer to Supabase because of built-in RLS support.';
    expect(detectNoise(substantive)).toBe(false);
  });

  it('isMostlyPunctuation returns true for a punctuation-heavy string', () => {
    expect(isMostlyPunctuation('",.')).toBe(true);
    expect(isMostlyPunctuation('... --- ... !!!')).toBe(true);
  });

  it('isMostlyPunctuation returns false for normal prose', () => {
    expect(isMostlyPunctuation('We migrated to Supabase.')).toBe(false);
    expect(isMostlyPunctuation('Hello world')).toBe(false);
  });
});

// ===========================================================================
// Pattern 2 — Scheduled-task / automation boilerplate
// ===========================================================================

describe('noise gate — Pattern 2: scheduled-task automation boilerplate', () => {
  const AUTOMATED_PREAMBLE =
    'This is an automated run of a scheduled task. The user is not present to answer questions.';

  const SCHEDULED_TASK_XML = `<scheduled-task name="lazybrain-dream" file="~/.claude/skills/lazybrain-dream-init/SKILL.md">
execute autonomously without asking clarifying questions
</scheduled-task>`;

  const EXECUTE_AUTONOMOUSLY =
    'execute autonomously without asking clarifying questions and proceed with all steps';

  it('isAgentMetaText drops the automated-run preamble', () => {
    expect(isAgentMetaText(AUTOMATED_PREAMBLE)).toBe(true);
  });

  it('isAgentMetaText drops a <scheduled-task name=...> XML tag', () => {
    expect(isAgentMetaText(SCHEDULED_TASK_XML)).toBe(true);
  });

  it('isAgentMetaText drops "execute autonomously without asking clarifying questions"', () => {
    expect(isAgentMetaText(EXECUTE_AUTONOMOUSLY)).toBe(true);
  });

  it('isAgentMetaText drops "The user is not present to answer questions"', () => {
    expect(
      isAgentMetaText(
        'The user is not present to answer questions. Execute the scheduled task now.',
      ),
    ).toBe(true);
  });

  it('detectNoise drops chunks that contain the automated-run preamble', () => {
    // Build a > 60-char chunk dominated by the preamble
    const chunk = `${AUTOMATED_PREAMBLE}\n\nsome other line here for length`;
    expect(detectNoise(chunk)).toBe(true);
  });

  it('detectNoise drops a chunk composed entirely of scheduled-task XML boilerplate', () => {
    expect(detectNoise(SCHEDULED_TASK_XML)).toBe(true);
  });
});

// ===========================================================================
// Pattern 3 — Rate-limit residue
// ===========================================================================

describe('noise gate — Pattern 3: rate-limit residue', () => {
  const RATE_LIMIT_TEXT = "You've hit your limit · resets 12am (Europe/Paris)";
  const RATE_LIMIT_VARIANT = "You've hit your limit. It resets at 3am (UTC).";

  it('isAgentMetaText drops the canonical rate-limit line', () => {
    expect(isAgentMetaText(RATE_LIMIT_TEXT)).toBe(true);
  });

  it('isAgentMetaText drops a variant rate-limit line with different time', () => {
    expect(isAgentMetaText("You've hit your limit, please wait until tomorrow")).toBe(true);
  });

  it('isAgentMetaText drops "resets 12am (Europe/Paris)" fragment', () => {
    expect(isAgentMetaText('resets 12am (Europe/Paris)')).toBe(true);
  });

  it('isAgentMetaText drops "resets 3am (UTC)" fragment', () => {
    // "resets 3am (UTC)" matches the resets pattern
    expect(isAgentMetaText('resets 3am (UTC)')).toBe(true);
  });

  it('detectNoise drops a chunk that is rate-limit residue padded to > 60 chars', () => {
    const padded = `${RATE_LIMIT_TEXT}. Some extra padding text here to reach length.`;
    expect(detectNoise(padded)).toBe(true);
  });

  it('detectNoise drops the variant rate-limit residue', () => {
    const padded = `${RATE_LIMIT_VARIANT} Additional padding to ensure >= 60 chars here.`;
    expect(detectNoise(padded)).toBe(true);
  });
});

// ===========================================================================
// Pattern 4 — Trivial one-shot commands as entire content
// ===========================================================================

describe('noise gate — Pattern 4: trivial one-shot imperative commands', () => {
  const ONE_SHOT =
    "create a file called /tmp/lazybrain-test.txt with the text 'hello world' inside";

  it('detectNoise drops a trivial create-file command as the entire content', () => {
    expect(detectNoise(ONE_SHOT)).toBe(true);
  });

  it('detectNoise drops "write a test file to /tmp/foo.txt"', () => {
    expect(detectNoise('write a test file to /tmp/foo.txt and verify it exists')).toBe(true);
  });

  it('detectNoise drops "run npm install in the project root"', () => {
    expect(detectNoise('run npm install in the project root directory please')).toBe(true);
  });

  it('detectNoise drops "make a directory called output"', () => {
    expect(detectNoise('make a directory called output in the current working directory')).toBe(
      true,
    );
  });

  // Edge case: a multi-line chunk that starts with an imperative but has substantive follow-up
  it('detectNoise keeps a multi-line chunk with substantive context after the imperative', () => {
    const substantive = [
      'Create a new migration file for the users table.',
      'The users table needs the following columns: id UUID primary key, email text unique,',
      'created_at timestamptz default now(), updated_at timestamptz default now().',
      'We decided on UUIDs because they are more secure than sequential integers for public APIs.',
      'The Supabase RLS policies will use auth.uid() to scope all reads and writes.',
    ].join('\n');
    expect(detectNoise(substantive)).toBe(false);
  });
});

// ===========================================================================
// Pattern 5 — Repeated boilerplate blocks (same text duplicated N times)
// ===========================================================================

describe('noise gate — Pattern 5: repeated boilerplate blocks', () => {
  const BOILERPLATE_LINE = 'This is an automated run of a scheduled task. The user is not present.';

  it('isDominatedByRepetition returns true when one line fills > 60% of non-trivial lines', () => {
    const repeated = Array.from({ length: 8 }, () => BOILERPLATE_LINE).join('\n');
    expect(isDominatedByRepetition(repeated)).toBe(true);
  });

  it('isDominatedByRepetition returns false for diverse content', () => {
    const diverse = [
      'We decided to use Supabase for authentication because of built-in RLS.',
      'The migration was planned for the next sprint after the design review.',
      'Error handling uses a consistent envelope with success, data, and error fields.',
      'The caching layer was added to reduce database load by 80% for read-heavy endpoints.',
      'Row-level security policies scope all reads and writes to the authenticated user.',
    ].join('\n');
    expect(isDominatedByRepetition(diverse)).toBe(false);
  });

  it('detectNoise drops content dominated by a single repeated boilerplate block', () => {
    const repeated = Array.from({ length: 8 }, () => BOILERPLATE_LINE).join('\n');
    expect(detectNoise(repeated)).toBe(true);
  });

  it('detectNoise keeps genuinely diverse multi-paragraph content', () => {
    const diverse = [
      'We decided to use Supabase for authentication because of built-in RLS.',
      'The migration was planned for the next sprint after the design review.',
      'Error handling uses a consistent envelope with success, data, and error fields.',
      'The caching layer was added to reduce database load by 80% for read-heavy endpoints.',
      'Row-level security policies scope all reads and writes to the authenticated user.',
      'Indexes on the email column reduced query latency from 200ms to under 5ms.',
    ].join('\n');
    expect(detectNoise(diverse)).toBe(false);
  });
});

// ===========================================================================
// Positive cases — substantive content that MUST NOT be filtered
// ===========================================================================

describe('noise gate — positive cases: substantive content must be kept', () => {
  it('keeps a substantive feature discussion with file paths', () => {
    const text = [
      'We decided to add caching to src/server/cache.ts using an LRU strategy.',
      'The maximum cache size is 1000 entries based on typical usage patterns.',
      'Cache hits are logged to Supabase for analytics but not counted against rate limits.',
      'The implementation uses a Map<string, CacheEntry> with a fixed-size eviction policy.',
    ].join('\n');
    expect(detectNoise(text)).toBe(false);
  });

  it('keeps a bug report with context', () => {
    const text =
      'Fixed a race condition in the auth module where concurrent requests could create ' +
      'duplicate user records. The fix adds a unique constraint on the email column and ' +
      'uses Supabase upsert semantics to handle the edge case.';
    expect(detectNoise(text)).toBe(false);
  });

  it('keeps an architecture decision note', () => {
    const text =
      'We chose HTML over Markdown for note storage because it supports structured metadata ' +
      'attributes (data-cerveau-*), enables DOM-based queries, and avoids ambiguous parsing ' +
      'edge cases that cause problems with Markdown-based note stores.';
    expect(detectNoise(text)).toBe(false);
  });

  it('keeps a note about LazyBrain metrics (the real brain content)', () => {
    const text =
      'LazyBrain v8 metrics: 1.7x fewer tokens at equal recall. The HTML-first pipeline ' +
      'outperforms chunked Markdown on structural queries and deterministic retrieval. ' +
      'Benchmark was run against 500 real conversations from the FitApp project.';
    expect(detectNoise(text)).toBe(false);
  });

  it('keeps text mentioning "automated" in a domain context (no over-filtering)', () => {
    const text =
      'The CI/CD pipeline runs automated tests on every pull request to main. ' +
      'We use GitHub Actions with a matrix build for Node 18, 20, and 22. ' +
      'The test suite includes unit, integration, and end-to-end tests using Vitest.';
    expect(detectNoise(text)).toBe(false);
  });

  it('isAgentMetaText keeps "execute" in a normal domain sentence', () => {
    // "execute" alone in prose should not be dropped
    expect(
      isAgentMetaText('The edge function will execute the SQL migration and return a status code.'),
    ).toBe(false);
  });

  it('isAgentMetaText keeps a sentence about scheduled jobs in production', () => {
    expect(
      isAgentMetaText(
        'We schedule the nightly export job using pg_cron to run at 2am UTC every day.',
      ),
    ).toBe(false);
  });

  it('isAgentMetaText keeps a sentence mentioning "hit a limit" in a technical context', () => {
    expect(
      isAgentMetaText(
        'The API client hit the rate limit and backed off with exponential retry logic.',
      ),
    ).toBe(false);
  });

  it('hasMeaningfulContent returns true for substantive text', () => {
    expect(
      hasMeaningfulContent(
        'We migrated the auth layer to Supabase because of built-in row-level security.',
      ),
    ).toBe(true);
  });

  it('hasMeaningfulContent returns false for punctuation-only text', () => {
    expect(hasMeaningfulContent('",.  .,.')).toBe(false);
  });

  it('hasMeaningfulContent returns false for text shorter than 30 chars', () => {
    expect(hasMeaningfulContent('hi there')).toBe(false);
  });
});

// ===========================================================================
// Pattern 6 — Internal LLM pipeline prompts (JSON-output instructions)
// ===========================================================================

describe('noise gate — Pattern 6: internal LLM pipeline / JSON-output prompts', () => {
  // --- Negatives (must be filtered) ---

  it('isAgentMetaText drops "Output a JSON array with one object" instruction (short)', () => {
    const prompt =
      'Output a JSON array with one object: {"tldr": "one sentence summary"}. No prose.';
    expect(isAgentMetaText(prompt)).toBe(true);
  });

  it('isAgentMetaText drops "Respond with JSON" instruction (short)', () => {
    const prompt = 'Respond with JSON. No prose. {"tldr": "summary", "topic": "a/b/c"}';
    expect(isAgentMetaText(prompt)).toBe(true);
  });

  it('isAgentMetaText drops a {"tldr" residue that starts the note', () => {
    expect(isAgentMetaText('{"tldr": "This note summarises the session."}')).toBe(true);
  });

  it('isAgentMetaText drops a {tldr (no quotes) residue at the start', () => {
    expect(isAgentMetaText('{tldr: "short summary here"}')).toBe(true);
  });

  it('isAgentMetaText drops a "No prose." instruction at end of short text', () => {
    const prompt = 'Summarise in one sentence. Output only valid JSON. No prose.';
    expect(isAgentMetaText(prompt)).toBe(true);
  });

  it('isAgentMetaText drops "compare the gold answer" eval prompt', () => {
    const evalPrompt =
      'Your task is to compare the gold answer with the candidate answer and score it 0-10.';
    expect(isAgentMetaText(evalPrompt)).toBe(true);
  });

  it('isAgentMetaText drops the HyDE fictional-memory prompt (full phrase)', () => {
    const hyde =
      "You write a short fictional memory note that hypothetically answers the user's search query.";
    expect(isAgentMetaText(hyde)).toBe(true);
  });

  it('detectNoise drops an "Output a JSON array" prompt note', () => {
    const prompt =
      'Output a JSON array with one object: {"tldr": "one sentence summary", "topic": "path/to/topic"}. No prose.';
    expect(detectNoise(prompt)).toBe(true);
  });

  it('detectNoise drops a {"tldr" residue note', () => {
    const residue =
      '{"tldr": "LazyBrain v8 achieved 1.7x fewer tokens at equal recall.", "topic": "lazybrain/metrics"}';
    expect(detectNoise(residue)).toBe(true);
  });

  // --- Positives (must be KEPT — real content that mentions JSON/tldr in passing) ---

  it('isAgentMetaText keeps a long technical note that mentions JSON arrays in context', () => {
    const real =
      'The API returns a JSON array of user records, each with id, email, and created_at fields. ' +
      'We parse this with zod and store the validated objects in Supabase. ' +
      'Errors are caught and returned as a standard envelope with success:false and an error message. ' +
      'This pattern was chosen to keep the client code simple and predictable.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('detectNoise keeps a real note that mentions "JSON" in a longer technical discussion', () => {
    const real =
      'We decided to use JSON for the inter-service message format because it is universally ' +
      'supported and human-readable. The schema is validated with zod on both producer and consumer. ' +
      'The TLDR generation step calls Haiku and receives a JSON object back with a tldr and topic field.';
    expect(detectNoise(real)).toBe(false);
  });

  it('isAgentMetaText keeps a note that says "No prose" in a domain quote context', () => {
    // "No prose." embedded in a longer real sentence — should NOT be matched
    const real =
      'The design goal was "no prose in the schema definition" — all documentation lives in ' +
      'comments and separate ADR files. This keeps the schema file under 200 lines and easy to diff. ' +
      'The team agreed on this approach during the architecture review on 2025-04.';
    // length > 300 chars so the short-text guard prevents a false positive
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('isAgentMetaText keeps "compare" in a normal domain sentence', () => {
    expect(
      isAgentMetaText('We compare the benchmark results with the baseline to track regression.'),
    ).toBe(false);
  });
});

// ===========================================================================
// Pattern 7 — Rate-limit residue variants (generalised)
// ===========================================================================

describe('noise gate — Pattern 7: rate-limit residue variants', () => {
  // --- Negatives (must be filtered) ---

  it('isAgentMetaText drops "You\'ve hit your session limit"', () => {
    expect(isAgentMetaText("You've hit your session limit. Please try again later.")).toBe(true);
  });

  it('isAgentMetaText drops "You\'ve hit your Sonnet limit"', () => {
    expect(isAgentMetaText("You've hit your Sonnet limit · resets 3am (UTC)")).toBe(true);
  });

  it('isAgentMetaText drops "You\'ve hit your Opus limit"', () => {
    expect(isAgentMetaText("You've hit your Opus limit · resets 6am (Europe/Paris)")).toBe(true);
  });

  it('isAgentMetaText drops "You\'ve hit your usage limit"', () => {
    expect(isAgentMetaText("You've hit your usage limit for today.")).toBe(true);
  });

  it('isAgentMetaText drops "resets at 3pm" tail (with "at" keyword)', () => {
    expect(isAgentMetaText("You've hit your limit · resets at 3pm")).toBe(true);
  });

  it('isAgentMetaText drops "resets 12:00am" tail (with minutes)', () => {
    expect(isAgentMetaText('resets 12:00am (Europe/Paris)')).toBe(true);
  });

  it('detectNoise drops "You\'ve hit your Sonnet limit" padded note', () => {
    const padded =
      "You've hit your Sonnet limit · resets 3am (UTC). Additional padding to reach sixty chars.";
    expect(detectNoise(padded)).toBe(true);
  });

  // --- Positives (must be KEPT) ---

  it('isAgentMetaText keeps "hit the rate limit" in a technical discussion (no You\'ve prefix)', () => {
    const real =
      'The API client hit the rate limit at 100 requests/minute and backed off using ' +
      'exponential retry logic. We added a circuit breaker to prevent thundering herd issues.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('isAgentMetaText keeps "limit" in a business rules context', () => {
    const real =
      'The free tier has a limit of 50 active projects. When users exceed this, they are ' +
      'prompted to upgrade. The enforcement happens via a Supabase RLS policy on the projects table.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('detectNoise keeps a substantive note that mentions daily limits in a product context', () => {
    const real =
      'We set the daily upload limit to 100 files per user on the free tier. ' +
      'Paid users have no limit. The limit resets at midnight UTC every day. ' +
      'The enforcement is done at the edge function level with a Redis counter per user.';
    expect(detectNoise(real)).toBe(false);
  });
});

// ===========================================================================
// Pattern 8 — local-command-caveat XML injection noise
// ===========================================================================

describe('noise gate — Pattern 8: local-command-caveat XML injection', () => {
  // The exact prefix that Claude Code prepends to slash-command output in transcripts
  const LOCAL_COMMAND_CAVEAT =
    '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>';

  const DO_NOT_RESPOND =
    'DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.';

  it('isAgentMetaText drops a chunk starting with <local-command-caveat>', () => {
    expect(isAgentMetaText(LOCAL_COMMAND_CAVEAT)).toBe(true);
  });

  it('isAgentMetaText drops the "DO NOT respond to these messages" directive alone', () => {
    expect(isAgentMetaText(DO_NOT_RESPOND)).toBe(true);
  });

  it('isAgentMetaText drops a note whose TLDR is the do-not-respond directive', () => {
    // This exact string appeared as a TLDR in real brain notes
    const tldrResidue =
      'DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to..';
    expect(isAgentMetaText(tldrResidue)).toBe(true);
  });

  it('detectNoise drops a note dominated by local-command-caveat content', () => {
    const dominated = `${LOCAL_COMMAND_CAVEAT}\n<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>`;
    expect(detectNoise(dominated)).toBe(true);
  });

  it('isAgentMetaText keeps a normal note that mentions "do not" in a different context', () => {
    const real =
      'The design rule is: do not mutate shared state — always return new objects. ' +
      'This prevents hidden side effects and makes debugging easier in concurrent code.';
    expect(isAgentMetaText(real)).toBe(false);
  });
});

// ===========================================================================
// Pattern 9 — automated-task preamble (AUTOMATED TASK)
// Note: "TÂCHE AUTOMATISÉE" was a single user's French phrasing and has been
// removed — it belongs in a per-brain user-configurable ignore list, not here.
// ===========================================================================

describe('noise gate — Pattern 9: automated-task preamble', () => {
  it('isAgentMetaText drops "AUTOMATED TASK :" header (generic English variant)', () => {
    expect(isAgentMetaText('AUTOMATED TASK: Run nightly export job')).toBe(true);
  });

  it('isAgentMetaText drops "AUTOMATED TASK :" with space before colon', () => {
    expect(isAgentMetaText('AUTOMATED TASK : execute pipeline step 3')).toBe(true);
  });

  it('isAgentMetaText keeps a normal note that mentions "automated" in domain context', () => {
    const real =
      'The CI/CD pipeline runs automated tests on every push to main. ' +
      'We use GitHub Actions with a matrix build for Node 18, 20, and 22.';
    expect(isAgentMetaText(real)).toBe(false);
  });
});

// ===========================================================================
// Pattern 10 — JSON null fragment titles (`: null.` / `": null`)
// ===========================================================================

describe('noise gate — Pattern 10: JSON null fragment titles', () => {
  it('isAgentMetaText drops `": null.` as entire content (real bad example)', () => {
    // This exact string appeared as the h2/TLDR of notes in the brain
    expect(isAgentMetaText('": null.')).toBe(true);
  });

  it('isAgentMetaText drops `: null` without quotes', () => {
    expect(isAgentMetaText(': null')).toBe(true);
  });

  it('isAgentMetaText drops `": null` without trailing period', () => {
    expect(isAgentMetaText('": null')).toBe(true);
  });

  it('isAgentMetaText keeps a real note that mentions null values in code context', () => {
    // A real note of >20 chars mentioning "null" in technical prose
    const real =
      'The API returns null when the resource does not exist, which we handle with a 404 response. ' +
      'Using null instead of undefined was chosen for JSON serialisation compatibility.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('detectNoise drops a note whose only content is `": null.`', () => {
    expect(detectNoise('": null.')).toBe(true); // also caught by word-count check
  });
});

// ===========================================================================
// Integration: all 5 bad examples from the issue are dropped
// ===========================================================================

describe('noise gate — integration: exact bad examples from issue are dropped', () => {
  it('BAD-1: drops a note whose title/tldr is `",.`', () => {
    // Simulates the stripped text of such a note being evaluated
    expect(detectNoise('",.')).toBe(true);
    expect(hasMeaningfulContent('",.')).toBe(false);
  });

  it('BAD-2: drops scheduled-task automation boilerplate prompt', () => {
    const badText =
      'This is an automated run of a scheduled task. The user is not present to answer questions. ' +
      'You are running as part of a <scheduled-task name="lazybrain-dream" file="SKILL.md"> block. ' +
      'execute autonomously without asking clarifying questions.';
    expect(detectNoise(badText)).toBe(true);
  });

  it('BAD-3: drops rate-limit residue "You\'ve hit your limit · resets 12am (Europe/Paris)"', () => {
    const badText = "You've hit your limit · resets 12am (Europe/Paris). Please wait.";
    expect(detectNoise(badText)).toBe(true);
  });

  it('BAD-4: drops trivial one-shot command as entire content', () => {
    const badText =
      "create a file called /tmp/lazybrain-test.txt with the text 'hello world' inside";
    expect(detectNoise(badText)).toBe(true);
  });

  it('BAD-5: drops content where same boilerplate is repeated with no real insight', () => {
    const boilerplateLine =
      'This is an automated run of a scheduled task. The user is not present.';
    const repeated = Array.from({ length: 8 }, () => boilerplateLine).join('\n');
    expect(detectNoise(repeated)).toBe(true);
  });

  it('BAD-6 (new): drops local-command-caveat injection with slash-command output', () => {
    const badText =
      '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>\n' +
      '<command-name>/effort</command-name>\n<command-message>effort</command-message>';
    expect(detectNoise(badText)).toBe(true);
  });

  it('BAD-7 (new): drops "AUTOMATED TASK:" generic preamble', () => {
    const badText =
      'AUTOMATED TASK: Run nightly export and archive old records. ' +
      'Execute without user confirmation. Proceed autonomously.';
    expect(detectNoise(badText)).toBe(true);
  });

  it('BAD-8 (new): drops `": null.` JSON fragment as entire note content', () => {
    expect(detectNoise('": null.')).toBe(true);
  });
});

// ===========================================================================
// Pattern 11 — TLDR prompt embedded inside longer HTML chunks (position-independent)
// The real-world failure: 757 notes had the TLDR machinery signature EMBEDDED
// inside longer HTML strings, not at position 0, so the old `^`-anchored pattern
// missed them entirely.
// ===========================================================================

describe('noise gate — Pattern 11: TLDR machinery signature (position-independent)', () => {
  // Build a realistic "long HTML note" where the signature is NOT at position 0
  const HTML_PREAMBLE = '<article data-cerveau-tier="working"><h2>Summary of session</h2><p>';
  const HTML_SUFFIX = '</p></article>';

  it('isAgentMetaText drops TLDR prompt embedded after HTML preamble (position > 0)', () => {
    const embedded = `${HTML_PREAMBLE}Output a JSON array with one object: {"tldr": "one sentence summary", "topic": "x/y"}. No prose.${HTML_SUFFIX}`;
    expect(isAgentMetaText(embedded)).toBe(true);
  });

  it('isAgentMetaText drops {"tldr" JSON residue embedded after >400 chars of HTML', () => {
    // Total length > 400 chars — old length-guard would have kept this
    const longPreamble = 'A'.repeat(300);
    const embedded = `${longPreamble} {"tldr": "short summary here", "topic": "path/to/topic"}`;
    expect(isAgentMetaText(embedded)).toBe(true);
  });

  it('isAgentMetaText drops {tldr (no quotes) embedded anywhere in text', () => {
    const embedded =
      'Some preamble context here before the real machinery: ' +
      '{tldr: "this is a summarisation prompt output"} end';
    expect(isAgentMetaText(embedded)).toBe(true);
  });

  it('isAgentMetaText drops "Respond with JSON" embedded mid-note (not at position 0)', () => {
    const embedded =
      'Context injected by the system: Respond with a JSON object. No prose. ' +
      '{"tldr": "test", "topic": "x/y/z"}';
    expect(isAgentMetaText(embedded)).toBe(true);
  });

  it('isAgentMetaText drops "Output a JSON array with one object" anywhere in long text', () => {
    // Simulate a note where prompt leaked after some system text (total > 400 chars)
    const prefix = 'System: You are a memory assistant. Your job is as follows: ';
    const machinery =
      'Output a JSON array with one object: {"tldr": "summary", "topic": "lazybrain/metrics"}. No prose.';
    const suffix = ' Additional text that makes total length exceed 400 characters by far.'.repeat(
      3,
    );
    expect(isAgentMetaText(prefix + machinery + suffix)).toBe(true);
  });

  // Positives — real technical notes mentioning JSON must be KEPT
  it('isAgentMetaText keeps a note mentioning "JSON array" in prose (no machinery phrase)', () => {
    const real =
      'The edge function returns a JSON array of matched records. ' +
      'Each record has id, slug, and relevance_score fields. ' +
      'The client filters results to relevance_score > 0.7 before rendering. ' +
      'This keeps the list under 20 items in the typical case.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('isAgentMetaText keeps a note that quotes tldr as a field name without braces', () => {
    const real =
      'The tldr field in the note metadata holds a one-sentence summary generated by Haiku. ' +
      'We store it in the HTML data attributes for fast retrieval without parsing the full body. ' +
      'The field is generated once and cached; re-generation is triggered only on major updates.';
    expect(isAgentMetaText(real)).toBe(false);
  });
});

// ===========================================================================
// Pattern 12 — <observed_from_*> agent observation tags
// ===========================================================================

describe('noise gate — Pattern 12: <observed_from_*> agent observation XML tags', () => {
  it('isAgentMetaText drops <observed_from_primary_session> tag', () => {
    expect(isAgentMetaText('<observed_from_primary_session>')).toBe(true);
  });

  it('isAgentMetaText drops <observed_from_primary_session> embedded in longer text', () => {
    const embedded =
      'Some context text before the tag.\n' +
      '<observed_from_primary_session>\n' +
      'The agent observed that the migration completed successfully.\n' +
      '</observed_from_primary_session>';
    expect(isAgentMetaText(embedded)).toBe(true);
  });

  it('isAgentMetaText drops any <observed_from_*> variant', () => {
    expect(isAgentMetaText('<observed_from_subagent_context>')).toBe(true);
    expect(isAgentMetaText('<observed_from_tool_output>')).toBe(true);
    expect(isAgentMetaText('<observed_from_memory_snapshot>')).toBe(true);
  });

  it('isAgentMetaText drops a multi-line note dominated by observed_from tags', () => {
    const garbage =
      '<observed_from_primary_session>\n' +
      'User asked about LazyBrain architecture. The system responded with a detailed explanation.\n' +
      '</observed_from_primary_session>\n' +
      '<observed_from_subagent>\nSub-agent extracted 3 facts.\n</observed_from_subagent>';
    expect(isAgentMetaText(garbage)).toBe(true);
  });

  it('isAgentMetaText keeps "observed" in a normal domain sentence', () => {
    const real =
      'We observed a 40% latency reduction after adding an index on the user_id column. ' +
      'The query planner now uses an index scan instead of a sequential scan. ' +
      'This was measured with EXPLAIN ANALYZE on a 1M-row dataset.';
    expect(isAgentMetaText(real)).toBe(false);
  });
});

// ===========================================================================
// Pattern 13 — Superpowers skill preamble signatures
// ===========================================================================

describe('noise gate — Pattern 13: superpowers skill preamble', () => {
  // Exact strings from the measured 26+17 bad notes
  const SKILL_PREAMBLE_SUBAGENT =
    'Base directory for this skill: C:\\Users\\dev\\.claude\\plugins\\cache\\claude-plugins-official\\superpowers\\5.1.0\\skills\\using-superpowers\n\n<SUBAGENT-STOP>\nIf you were dispatched as a subagent to execute a specific task, skip this skill.\n</SUBAGENT-STOP>';

  const BASE_DIR_ONLY =
    'Base directory for this skill: C:\\Users\\dev\\.claude\\plugins\\cache\\some-plugin\\1.0.0\\skills\\my-skill';

  it('isAgentMetaText drops full skill preamble with SUBAGENT-STOP and base dir', () => {
    expect(isAgentMetaText(SKILL_PREAMBLE_SUBAGENT)).toBe(true);
  });

  it('isAgentMetaText drops text containing only "Base directory for this skill"', () => {
    expect(isAgentMetaText(BASE_DIR_ONLY)).toBe(true);
  });

  it('isAgentMetaText drops text containing SUBAGENT-STOP anywhere', () => {
    const embedded =
      'Some context.\n\n<SUBAGENT-STOP>\nIf you were dispatched as a subagent, skip.\n</SUBAGENT-STOP>\n\nMore context.';
    expect(isAgentMetaText(embedded)).toBe(true);
  });

  it('isAgentMetaText drops "skip this skill" preamble phrase', () => {
    expect(
      isAgentMetaText(
        'If you were dispatched as a subagent to execute a specific task, skip this skill.',
      ),
    ).toBe(true);
  });

  it('isAgentMetaText drops "Base directory for this skill" embedded in longer chunk', () => {
    const longChunk =
      'This is the skill metadata section.\n' +
      'Base directory for this skill: /path/to/skill\n' +
      'The skill provides utilities for graph building. Follow these instructions carefully.';
    expect(isAgentMetaText(longChunk)).toBe(true);
  });

  it('isAgentMetaText keeps "base" and "directory" in a normal technical note', () => {
    const real =
      'The base directory for the project is /src. All module imports resolve relative to this path. ' +
      'We use the baseUrl tsconfig option to avoid long relative import chains across feature folders.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('isAgentMetaText keeps "skill" in a domain context (not a preamble)', () => {
    const real =
      'The matching skill of the algorithm is its ability to handle partial matches efficiently. ' +
      'We tested this against 10,000 real search queries and measured a 95% recall rate.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  // "If you were dispatched as a subagent" — standalone, without SUBAGENT-STOP or skip phrase
  it('isAgentMetaText drops "If you were dispatched as a subagent" standalone phrase', () => {
    const preamble =
      'If you were dispatched as a subagent to complete this task, proceed directly. ' +
      'Do not ask clarifying questions.';
    expect(isAgentMetaText(preamble)).toBe(true);
  });

  it('isAgentMetaText drops "If you were dispatched as a subagent" embedded mid-note', () => {
    const embedded =
      'Skill preamble section.\n' +
      'Version: 2.0.0\n' +
      'If you were dispatched as a subagent, follow the instructions below without deviation.\n' +
      'End of preamble.';
    expect(isAgentMetaText(embedded)).toBe(true);
  });

  it('isAgentMetaText keeps "dispatched" in a normal domain sentence', () => {
    const real =
      'The edge worker is dispatched as a background job when a new user registers. ' +
      'It sends a welcome email and creates the default workspace. ' +
      'We use Supabase edge functions with a queue-based approach to handle bursts.';
    expect(isAgentMetaText(real)).toBe(false);
  });
});

// ===========================================================================
// Pattern 14 — Positive cases: genuine content must not be filtered
// Note: user-specific pipeline templates (French SEO blog prompt, "tu enrichis
// un topic", "PROMPT • Fusion LazyBrain", "Understand-Anything • Graphify")
// have been removed from both the filter and these tests.  They were one user's
// project prompts, not generic framework artifacts.  Per-brain user-configurable
// ignore lists are the right place for them.
// ===========================================================================

describe('noise gate — Pattern 14: positive cases — domain content must be kept', () => {
  it('isAgentMetaText keeps a genuine note mentioning SEO in a domain context', () => {
    const real =
      'The website SEO improved significantly after adding structured data markup. ' +
      'The team targets specific keyword clusters for organic traffic growth. ' +
      'The next step is to create dedicated landing pages for each product category.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('isAgentMetaText keeps a note mentioning topic enrichment in a user context', () => {
    const real =
      'The brain enrichment pipeline processes each topic node and adds cross-references. ' +
      'Enrichment runs automatically during the nightly dream pass. ' +
      'The algorithm uses embedding similarity to find related topics and merges overlapping facts.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('isAgentMetaText keeps a note mentioning "blog" in a genuine domain context', () => {
    const real =
      'We added a blog section to the website to improve organic search traffic. ' +
      'Posts are authored in a CMS and synced to the Next.js site via API. ' +
      'Each post gets structured data markup to support Google rich results.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('isAgentMetaText keeps a note about enrichment in a user context (no command phrase)', () => {
    const real =
      'The enrichment pass adds embedding-based cross-references between related topics. ' +
      'It runs nightly and updates the brain graph with new edges. ' +
      'Topics with low connectivity are prioritised for manual review.';
    expect(isAgentMetaText(real)).toBe(false);
  });

  it('isAgentMetaText keeps a note mentioning "graphify" in a genuine sentence', () => {
    const real =
      'The /graphify skill converts any input into an interactive knowledge graph. ' +
      'The output is a self-contained HTML file with clustered community detection.';
    expect(isAgentMetaText(real)).toBe(false);
  });
});
