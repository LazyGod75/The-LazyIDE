/**
 * TDD tests for Task 5: deterministic conversation→file-neuron enrichment.
 *
 * Covers:
 * 5.1 — evidence/weight construction from data-cerveau-files-modified/read tags
 * 5.2 — section-placement vs concept-placement via canonicalMerge
 * 5.3 — file-neuron renders conditional decisions/bugs sections when enrichment provided
 * 5.4 — file-neuron omits conv sections when enrichment is empty/absent
 * 5.5 — recency superseding (older item gets data-cerveau-valid-until + data-cerveau-superseded)
 * 5.6 — end-to-end production wiring: fixture notes → enriched file-neuron + concept neuron
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  composeFileNeuron,
  normalizeItemText,
} from '../src/annotator/blocks/composers/file-neuron.js';
import type { FileNeuronEnrichment } from '../src/annotator/blocks/composers/file-neuron.js';
import {
  applyRecencySuperseding,
  buildEvidenceFromTags,
  runFileNeuronEnrichment,
} from '../src/commands/conv-file-enrichment.js';
import type { TimestampedItem } from '../src/commands/conv-file-enrichment.js';
import { runInit } from '../src/commands/init.js';
import { canonicalMerge } from '../src/graph/canonical-merge.js';
import type { CodeNode } from '../src/graph/code-scanner.js';
import { closeDb } from '../src/indexer/fts.js';
import { validateNote } from '../src/schema/validator.js';
import { readAllNotes } from '../src/store/reader.js';
import { resetConfigForTests } from '../src/util/config.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MINIMAL_NODE: CodeNode = {
  id: 'file:src/auth.ts',
  title: 'src/auth.ts',
  type: 'file',
  filePath: 'src/auth.ts',
  projectRoot: '/project',
  language: 'typescript',
  lineCount: 80,
  imports: ['./session'],
  exports: ['login'],
};

// ---------------------------------------------------------------------------
// 5.1 — evidence/weight construction from tool-trace tags
// ---------------------------------------------------------------------------

describe('buildEvidenceFromTags', () => {
  it('assigns weight 1.0 to files listed in filesModified', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: ['src/auth.ts'],
      filesRead: [],
      itemText: 'decided to use bcrypt',
    });
    const entry = evidence.find((e) => e.neuronId === 'file:src/auth.ts');
    expect(entry).toBeDefined();
    expect(entry!.weight).toBe(1.0);
  });

  it('assigns weight 0.4 to files listed in filesRead (not in modified)', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: [],
      filesRead: ['src/utils.ts'],
      itemText: 'read the utils file',
    });
    const entry = evidence.find((e) => e.neuronId === 'file:src/utils.ts');
    expect(entry).toBeDefined();
    expect(entry!.weight).toBe(0.4);
  });

  it('assigns weight 0.85 when item text explicitly names a file path that maps to a neuron', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: [],
      filesRead: [],
      itemText: 'The logic in src/auth.ts needs to be refactored',
    });
    const entry = evidence.find((e) => e.neuronId === 'file:src/auth.ts');
    expect(entry).toBeDefined();
    expect(entry!.weight).toBe(0.85);
  });

  it('uses modified weight (1.0) over text-mention weight (0.85) for same file', () => {
    // modified wins: 1.0 > 0.85
    const evidence = buildEvidenceFromTags({
      filesModified: ['src/auth.ts'],
      filesRead: [],
      itemText: 'modified src/auth.ts to add login',
    });
    const entries = evidence.filter((e) => e.neuronId === 'file:src/auth.ts');
    // Only one entry per neuron: the highest weight wins (de-duplication)
    expect(entries).toHaveLength(1);
    expect(entries[0].weight).toBe(1.0);
  });

  it('returns empty array when no files and no file paths in text', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: [],
      filesRead: [],
      itemText: 'generic conversation with no file references',
    });
    expect(evidence).toHaveLength(0);
  });

  it('read file weight does not exceed modified file weight for same file', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: ['src/auth.ts'],
      filesRead: ['src/auth.ts'],
      itemText: 'some change',
    });
    const entries = evidence.filter((e) => e.neuronId === 'file:src/auth.ts');
    expect(entries).toHaveLength(1);
    expect(entries[0].weight).toBe(1.0);
  });

  it('produces separate evidence entries for multiple files', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: ['src/auth.ts', 'src/utils.ts'],
      filesRead: ['src/types.ts'],
      itemText: 'no extra paths here',
    });
    const ids = evidence.map((e) => e.neuronId);
    expect(ids).toContain('file:src/auth.ts');
    expect(ids).toContain('file:src/utils.ts');
    expect(ids).toContain('file:src/types.ts');
  });
});

// ---------------------------------------------------------------------------
// 5.2 — section vs concept placement via canonicalMerge
// ---------------------------------------------------------------------------

describe('buildEvidenceFromTags + canonicalMerge integration', () => {
  it('single modified file → section placement (one dominant neuron)', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: ['src/auth.ts'],
      filesRead: [],
      itemText: 'decided to hash passwords with bcrypt',
    });
    const result = canonicalMerge(evidence);
    expect(result.placement).toBe('section');
    expect(result.neuronId).toBe('file:src/auth.ts');
  });

  it('equal-weight spread across 3 files → concept placement', () => {
    const evidence = buildEvidenceFromTags({
      filesModified: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      filesRead: [],
      itemText: 'no extra file references',
    });
    const result = canonicalMerge(evidence);
    expect(result.placement).toBe('concept');
    expect(result.neuronId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5.3 — composeFileNeuron: conditional enrichment sections when provided
// ---------------------------------------------------------------------------

describe('composeFileNeuron — enrichment sections (5.3)', () => {
  const ENRICHMENT: FileNeuronEnrichment = {
    decisions: [
      {
        text: 'decided to use bcrypt for hashing',
        confidence: 0.9,
        date: '2026-05-28',
        sourceConvLink: '#conv-abc',
      },
    ],
    bugs: [
      {
        text: 'login crashed when email is null',
        confidence: 0.8,
        date: '2026-05-27',
        sourceConvLink: '#conv-def',
      },
    ],
    ideas: [],
    rules: [],
    qa: [],
  };

  it('renders data-section="decisions" when decisions is non-empty', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0, ENRICHMENT);
    expect(html).toContain('data-section="decisions"');
  });

  it('renders the decision text in the decisions section', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0, ENRICHMENT);
    expect(html).toContain('decided to use bcrypt for hashing');
  });

  it('renders data-section="bugs" when bugs is non-empty', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0, ENRICHMENT);
    expect(html).toContain('data-section="bugs"');
  });

  it('renders the bug text in the bugs section', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0, ENRICHMENT);
    expect(html).toContain('login crashed when email is null');
  });

  it('does NOT render data-section="ideas" when ideas is empty', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0, ENRICHMENT);
    expect(html).not.toContain('data-section="ideas"');
  });

  it('includes a source link for the decision item', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0, ENRICHMENT);
    expect(html).toContain('#conv-abc');
  });

  it('output still validates against schema with enrichment', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0, ENRICHMENT);
    const result = validateNote(html);
    const errors = result.issues.filter((i) => i.level === 'error');
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5.4 — composeFileNeuron: no enrichment sections when absent/empty
// ---------------------------------------------------------------------------

describe('composeFileNeuron — no enrichment sections when absent (5.4)', () => {
  it('no enrichment arg → no data-section="decisions"', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    expect(html).not.toContain('data-section="decisions"');
  });

  it('no enrichment arg → no data-section="bugs"', () => {
    const html = composeFileNeuron(MINIMAL_NODE);
    expect(html).not.toContain('data-section="bugs"');
  });

  it('empty enrichment object → no enrichment sections', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0, {});
    expect(html).not.toContain('data-section="decisions"');
    expect(html).not.toContain('data-section="bugs"');
  });

  it('empty arrays in enrichment → no enrichment sections', () => {
    const emptyEnrichment: FileNeuronEnrichment = {
      decisions: [],
      bugs: [],
      ideas: [],
      rules: [],
      qa: [],
    };
    const html = composeFileNeuron(MINIMAL_NODE, 0, emptyEnrichment);
    expect(html).not.toContain('data-section="decisions"');
    expect(html).not.toContain('data-section="bugs"');
  });

  it('existing code sections still rendered regardless of enrichment', () => {
    const html = composeFileNeuron(MINIMAL_NODE, 0, {});
    expect(html).toContain('data-section="architecture"');
    expect(html).toContain('data-section="tldr"');
  });
});

// ---------------------------------------------------------------------------
// 5.5 — recency superseding
// ---------------------------------------------------------------------------

describe('applyRecencySuperseding', () => {
  it('newer item is NOT superseded, older contradicting item IS marked', () => {
    const items: TimestampedItem[] = [
      {
        text: 'decided to use JWT for auth',
        confidence: 0.9,
        date: '2026-05-20',
        sourceConvLink: '#conv-old',
      },
      {
        text: 'decided to use JWT for auth — revised approach',
        confidence: 0.9,
        date: '2026-05-28',
        sourceConvLink: '#conv-new',
      },
    ];
    const result = applyRecencySuperseding(items);
    // Newer item (2026-05-28) should not be superseded
    const newer = result.find((i) => i.date === '2026-05-28');
    expect(newer).toBeDefined();
    expect(newer!.superseded).toBeUndefined();
    expect(newer!.validUntil).toBeUndefined();
  });

  it('older contradicting item gets superseded=true and validUntil=newer date', () => {
    const items: TimestampedItem[] = [
      {
        text: 'decided to use JWT for auth',
        confidence: 0.9,
        date: '2026-05-20',
        sourceConvLink: '#conv-old',
      },
      {
        text: 'decided to use JWT for auth — revised approach',
        confidence: 0.9,
        date: '2026-05-28',
        sourceConvLink: '#conv-new',
      },
    ];
    const result = applyRecencySuperseding(items);
    const older = result.find((i) => i.date === '2026-05-20');
    expect(older).toBeDefined();
    expect(older!.superseded).toBe(true);
    expect(older!.validUntil).toBe('2026-05-28');
  });

  it('non-contradicting items (different kind text) are NOT superseded', () => {
    const items: TimestampedItem[] = [
      {
        text: 'decided to use Redis for caching',
        confidence: 0.8,
        date: '2026-05-20',
        sourceConvLink: '#conv-a',
      },
      {
        text: 'decided to use PostgreSQL for storage',
        confidence: 0.8,
        date: '2026-05-28',
        sourceConvLink: '#conv-b',
      },
    ];
    const result = applyRecencySuperseding(items);
    // Both should survive without superseding
    for (const item of result) {
      expect(item.superseded).toBeUndefined();
    }
  });

  it('single item is never superseded', () => {
    const items: TimestampedItem[] = [
      {
        text: 'decided to use bcrypt',
        confidence: 1.0,
        date: '2026-05-28',
        sourceConvLink: '#conv-x',
      },
    ];
    const result = applyRecencySuperseding(items);
    expect(result[0].superseded).toBeUndefined();
  });

  it('sorted by date ascending: oldest first, newest last in output', () => {
    const items: TimestampedItem[] = [
      { text: 'decided to do X', confidence: 0.7, date: '2026-05-25', sourceConvLink: '#c' },
      { text: 'decided to do X again', confidence: 0.7, date: '2026-05-20', sourceConvLink: '#a' },
      { text: 'decided to do X final', confidence: 0.7, date: '2026-05-28', sourceConvLink: '#b' },
    ];
    const result = applyRecencySuperseding(items);
    // Output is sorted: oldest → newest
    expect(result[0].date <= result[1].date).toBe(true);
    expect(result[1].date <= result[2].date).toBe(true);
  });

  it('superseded item renders data-cerveau-valid-until and data-cerveau-superseded in composeFileNeuron', () => {
    const items: TimestampedItem[] = [
      { text: 'decided to use JWT', confidence: 0.9, date: '2026-05-20', sourceConvLink: '#old' },
      {
        text: 'decided to use JWT — updated',
        confidence: 0.9,
        date: '2026-05-28',
        sourceConvLink: '#new',
      },
    ];
    const processed = applyRecencySuperseding(items);
    const enrichment: FileNeuronEnrichment = {
      decisions: processed,
    };
    const html = composeFileNeuron(MINIMAL_NODE, 0, enrichment);
    expect(html).toContain('data-cerveau-valid-until="2026-05-28"');
    expect(html).toContain('data-cerveau-superseded="true"');
  });
});

// ---------------------------------------------------------------------------
// 5.6 — end-to-end production wiring test
// ---------------------------------------------------------------------------

describe('runFileNeuronEnrichment — end-to-end (5.6)', () => {
  let tmpDir: string;
  const origBrainPath = process.env.LAZYBRAIN_BRAIN_PATH;
  const origCachePath = process.env.LAZYBRAIN_CACHE_PATH;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lazybrain-enrich-e2e-'));
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
    resetConfigForTests();
    await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });
  });

  afterEach(() => {
    // Close the SQLite DB before deleting temp dir to avoid EBUSY on Windows
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.LAZYBRAIN_BRAIN_PATH = origBrainPath;
    process.env.LAZYBRAIN_CACHE_PATH = origCachePath;
    resetConfigForTests();
  });

  it('produces a file-neuron with decisions section when a conv note modifies that file', async () => {
    const report = await runFileNeuronEnrichment({
      projectRoot: '/fixture-project',
      fileNodes: [
        {
          id: 'file:src/auth.ts',
          title: 'src/auth.ts',
          type: 'file' as const,
          filePath: 'src/auth.ts',
          projectRoot: '/fixture-project',
          language: 'typescript',
          lineCount: 40,
          imports: [],
          exports: ['login'],
        },
      ],
      convNotes: [
        {
          id: 'conv-2026-05-28-abc',
          filesModified: ['src/auth.ts'],
          filesRead: [],
          timestamp: '2026-05-28',
          classifiedItems: [
            {
              kind: 'decision' as const,
              text: 'decided to use bcrypt for password hashing',
              sourceId: 'conv-2026-05-28-abc',
            },
          ],
        },
      ],
    });

    expect(report.fileNeuronsEnriched).toBeGreaterThanOrEqual(1);

    // The file-neuron HTML should be written to disk
    const notes = readAllNotes();
    const fileNeuronNote = notes.find(
      (n) => n.html.includes('data-cerveau-type="file-neuron"') && n.html.includes('src/auth.ts'),
    );
    expect(fileNeuronNote).toBeDefined();
    expect(fileNeuronNote!.html).toContain('data-section="decisions"');
    expect(fileNeuronNote!.html).toContain('decided to use bcrypt for password hashing');
  });

  it('produces a CONCEPT neuron when knowledge item evidence is spread across multiple files', async () => {
    const report = await runFileNeuronEnrichment({
      projectRoot: '/fixture-project',
      fileNodes: [
        {
          id: 'file:src/auth.ts',
          title: 'src/auth.ts',
          type: 'file' as const,
          filePath: 'src/auth.ts',
          projectRoot: '/fixture-project',
          language: 'typescript',
          lineCount: 40,
          imports: [],
          exports: ['login'],
        },
        {
          id: 'file:src/utils.ts',
          title: 'src/utils.ts',
          type: 'file' as const,
          filePath: 'src/utils.ts',
          projectRoot: '/fixture-project',
          language: 'typescript',
          lineCount: 20,
          imports: [],
          exports: ['hash'],
        },
        {
          id: 'file:src/config.ts',
          title: 'src/config.ts',
          type: 'file' as const,
          filePath: 'src/config.ts',
          projectRoot: '/fixture-project',
          language: 'typescript',
          lineCount: 15,
          imports: [],
          exports: ['getConfig'],
        },
      ],
      convNotes: [
        {
          id: 'conv-2026-05-28-spread',
          filesModified: ['src/auth.ts', 'src/utils.ts', 'src/config.ts'],
          filesRead: [],
          timestamp: '2026-05-28',
          classifiedItems: [
            {
              kind: 'decision' as const,
              text: 'decided to centralise all config access through a service',
              sourceId: 'conv-2026-05-28-spread',
            },
          ],
        },
      ],
    });

    expect(report.conceptNeuronsCreated).toBeGreaterThanOrEqual(1);

    const notes = readAllNotes();
    const conceptNote = notes.find((n) => n.html.includes('data-cerveau-type="concept"'));
    expect(conceptNote).toBeDefined();
    expect(conceptNote!.html).toContain('decided to centralise all config access');
  });
});

// ---------------------------------------------------------------------------
// 5.7 — normalizeItemText: wiki-link markup stripping
// ---------------------------------------------------------------------------

describe('normalizeItemText — wiki-link cleanup (5.7)', () => {
  it('replaces a complete [Label→#/note/x] wiki-link with just the label', () => {
    const input =
      '[Bug→#/note/acme-conv-db-transaction-bug-2026-05-28] reproduction: under high concurrency';
    const result = normalizeItemText(input);
    expect(result).toBe('Bug reproduction: under high concurrency');
    expect(result).not.toContain('→#');
    expect(result).not.toContain('[');
    expect(result).not.toContain(']');
  });

  it('replaces a complete [Label→#file-x] inline wiki-link mid-sentence', () => {
    const input =
      'Fixed a security issue in the session management [code→#file-acme-src-auth-session-ts] module';
    const result = normalizeItemText(input);
    expect(result).toBe('Fixed a security issue in the session management code module');
    expect(result).not.toContain('→#');
  });

  it('removes a dangling/truncated opening bracket like [src/auth/session', () => {
    const input =
      'Fixed a security issue discovered in the session management [code→#file-acme-src-auth-session-ts] in [src/auth/session';
    const result = normalizeItemText(input);
    expect(result).not.toContain('[');
    expect(result).not.toContain('→#');
    // label from complete wiki-link is preserved
    expect(result).toContain('code');
    // The dangling fragment text is preserved (minus the bracket)
    expect(result).toContain('src/auth/session');
  });

  it('handles both patterns together: complete link + dangling fragment', () => {
    const input =
      '[Bug→#/note/acme-conv-db-2026-05-28] reproduction: under high concurrency, see [code→#file-acme-src-auth-session-ts] in [src/auth/session';
    const result = normalizeItemText(input);
    // No wiki-link artifacts
    expect(result).not.toMatch(/\[.*→#/);
    expect(result).not.toMatch(/\[$/);
    // Labels preserved
    expect(result).toContain('Bug');
    expect(result).toContain('code');
    // Prose preserved
    expect(result).toContain('reproduction: under high concurrency');
  });

  it('leaves plain text unchanged (no wiki-link markup)', () => {
    const plain = 'decided to use bcrypt for password hashing';
    expect(normalizeItemText(plain)).toBe(plain);
  });

  it('leaves a real [source] link text unchanged (no arrow)', () => {
    // The [source] anchor is added by the HTML composer, not present in item.text,
    // but guard against accidental stripping of bracket-only patterns.
    const withSource = 'some decision text [source]';
    // [source] has no →# so it is NOT a wiki-link and must not be stripped
    expect(normalizeItemText(withSource)).toBe('some decision text [source]');
  });
});

// ---------------------------------------------------------------------------
// 5.8 — concept neuron title must never contain [Label→#...] wiki-link markers
// ---------------------------------------------------------------------------

describe('concept neuron title is stripped of wiki-link markers (5.8)', () => {
  let tmpDir: string;
  const origBrainPath = process.env.LAZYBRAIN_BRAIN_PATH;
  const origCachePath = process.env.LAZYBRAIN_CACHE_PATH;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lb-title-strip-'));
    process.env.LAZYBRAIN_BRAIN_PATH = join(tmpDir, '.lazybrain', 'brain');
    process.env.LAZYBRAIN_CACHE_PATH = join(tmpDir, '.lazybrain', '_cache');
    resetConfigForTests();
    await runInit({ path: join(tmpDir, '.lazybrain', 'brain') });
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env.LAZYBRAIN_BRAIN_PATH = origBrainPath;
    process.env.LAZYBRAIN_CACHE_PATH = origCachePath;
    resetConfigForTests();
  });

  it('does not include [Label→#...] markers in the concept neuron <h1> title', async () => {
    // item.text as it arrives from the LLM: the LLM inserts [Label→#/note/id] markers
    // from the plain-text context it received (strip.ts converts <a> to [term→#id]).
    const itemTextWithMarker =
      '[Bug→#/note/acme-conv-db-transaction-bug-2026-05-28] Webhook signature failing';

    const report = await runFileNeuronEnrichment({
      projectRoot: '/fixture-project',
      fileNodes: [
        {
          id: 'file:src/webhooks.ts',
          title: 'src/webhooks.ts',
          type: 'file' as const,
          filePath: 'src/webhooks.ts',
          projectRoot: '/fixture-project',
          language: 'typescript',
          lineCount: 60,
          imports: [],
          exports: ['handleWebhook'],
        },
        {
          id: 'file:src/payments.ts',
          title: 'src/payments.ts',
          type: 'file' as const,
          filePath: 'src/payments.ts',
          projectRoot: '/fixture-project',
          language: 'typescript',
          lineCount: 80,
          imports: [],
          exports: ['processPayment'],
        },
      ],
      convNotes: [
        {
          id: 'conv-2026-05-28-webhook',
          filesModified: ['src/webhooks.ts', 'src/payments.ts'],
          filesRead: [],
          timestamp: '2026-05-28',
          classifiedItems: [
            {
              kind: 'bug' as const,
              text: itemTextWithMarker,
              sourceId: 'conv-2026-05-28-webhook',
            },
          ],
        },
      ],
    });

    expect(report.conceptNeuronsCreated).toBeGreaterThanOrEqual(1);

    const notes = readAllNotes();
    const conceptNote = notes.find((n) => n.html.includes('data-cerveau-type="concept"'));
    expect(conceptNote).toBeDefined();

    // The <h1> title must not contain raw wikilink markers
    expect(conceptNote!.html).not.toContain('→#');
    expect(conceptNote!.html).not.toContain('[Bug→');
    // The label "Bug" must be preserved (normalizeItemText keeps the label)
    expect(conceptNote!.html).toContain('Bug');
    // The clean prose must appear in body
    expect(conceptNote!.html).toContain('Webhook signature failing');
  });

  it('does not include [Label→#...] markers in the concept neuron id slug', async () => {
    const itemTextWithMarker =
      '[Stripe→#/note/stripe-payments] payment provider integration decision';

    const report = await runFileNeuronEnrichment({
      projectRoot: '/fixture-project',
      fileNodes: [
        {
          id: 'file:src/stripe.ts',
          title: 'src/stripe.ts',
          type: 'file' as const,
          filePath: 'src/stripe.ts',
          projectRoot: '/fixture-project',
          language: 'typescript',
          lineCount: 50,
          imports: [],
          exports: ['charge'],
        },
        {
          id: 'file:src/billing.ts',
          title: 'src/billing.ts',
          type: 'file' as const,
          filePath: 'src/billing.ts',
          projectRoot: '/fixture-project',
          language: 'typescript',
          lineCount: 50,
          imports: [],
          exports: ['bill'],
        },
      ],
      convNotes: [
        {
          id: 'conv-2026-05-28-stripe',
          filesModified: ['src/stripe.ts', 'src/billing.ts'],
          filesRead: [],
          timestamp: '2026-05-28',
          classifiedItems: [
            {
              kind: 'decision' as const,
              text: itemTextWithMarker,
              sourceId: 'conv-2026-05-28-stripe',
            },
          ],
        },
      ],
    });

    expect(report.conceptNeuronsCreated).toBeGreaterThanOrEqual(1);

    const notes = readAllNotes();
    const conceptNote = notes.find((n) => n.html.includes('data-cerveau-type="concept"'));
    expect(conceptNote).toBeDefined();

    // The article id attribute must not contain "note-stripe-payments" (slug from the marker)
    // It should contain "stripe" (from the label) or "payment-provider" (from the clean text)
    expect(conceptNote!.html).not.toContain('id="concept-decision-note-stripe-payments');
    // The note id must be slug-clean (no [→# artifacts)
    const idMatch = conceptNote!.html.match(/id="([^"]+)"/);
    expect(idMatch).not.toBeNull();
    const noteId = idMatch![1];
    // id must only contain lowercase letters, digits, and hyphens
    expect(noteId).toMatch(/^[a-z0-9-]+$/);
  });
});
