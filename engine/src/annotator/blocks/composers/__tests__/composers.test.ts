import { describe, expect, it } from 'vitest';
import type { CodeNode } from '../../../../graph/code-scanner.js';
import { buildAggregateNeurons } from '../../../../graph/code-scanner.js';
import { composeAggregateNeuron } from '../aggregate-neuron.js';
import { composeBrainIndex } from '../brain-index.js';
import { composeConceptNeuron } from '../concept-neuron.js';
import { composeFileNeuron, normalizeItemText } from '../file-neuron.js';
import { composeProjectSummary } from '../project-summary.js';
import { composeTopicOverview } from '../topic-overview.js';

describe('composeTopicOverview', () => {
  it('generates a Wikipedia-style topic overview article with prose sections', () => {
    const html = composeTopicOverview({
      id: 'topic-tradelab-overview',
      title: 'Tradelab',
      created: '2026-05-26T00:00:00Z',
      leadText: 'Tradelab encompasses algorithmic strategies, backtesting, and live execution.',
      sections:
        '<section><h2 id="tradebot">Tradebot</h2>\n<p>Tradebot is a live tradelab bot for MT5.</p></section>',
      stats: {
        noteCount: 44,
        typeBreakdown: { decision: 5, semantic: 20, architecture: 10, procedural: 9 },
        dateRange: ['2025-01-01', '2026-05-26'],
        avgImportance: 0.78,
      },
      relatedTopics: [{ id: 'topic-acme-overview', title: 'Acme' }],
      tags: ['tradelab', 'ml', 'mt5'],
    });
    expect(html).toContain('<article id="topic-tradelab-overview"');
    expect(html).toContain('data-cerveau-type="topic-overview"');
    expect(html).toContain('data-cerveau-generated="dream-synthesize"');
    expect(html).toContain('data-cerveau-tags="tradelab,ml,mt5"');
    expect(html).toContain('data-section="lead"');
    expect(html).toContain('<b>Tradelab</b>');
    expect(html).toContain('<h2 id="tradebot">Tradebot</h2>');
    expect(html).toContain('Tradebot is a live tradelab bot');
    expect(html).toContain('data-section="see-also"');
    expect(html).toContain('Acme');
    expect(html).toContain('class="categories"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('</article>');
    // Should NOT contain a data table of notes
    expect(html).not.toContain('<table class="wikitable sortable">');
  });
});

describe('composeProjectSummary', () => {
  it('generates a project summary with stack info', () => {
    const html = composeProjectSummary({
      id: 'project-tradebot-summary',
      title: 'Tradebot Bot',
      created: '2026-05-26T00:00:00Z',
      leadText: 'Tradebot is a live tradelab bot for MetaTrader 5.',
      stack: 'TypeScript, MT5, MQL5',
      status: 'Active',
      stats: {
        noteCount: 6,
        typeBreakdown: { architecture: 2, decision: 2, semantic: 2 },
        dateRange: ['2025-06-01', '2026-05-20'],
        avgImportance: 0.82,
      },
      notes: [
        {
          title: 'Tradebot Architecture',
          date: '2026-05-01',
          type: 'architecture',
          importance: '0.90',
        },
      ],
      relatedTopics: [{ id: 'project-sentinel-summary', title: 'SENTINEL' }],
      tags: ['tradelab', 'tradebot', 'live'],
    });
    expect(html).toContain('data-cerveau-type="project-summary"');
    expect(html).toContain('data-cerveau-tags="tradelab,tradebot,live"');
    expect(html).toContain('TypeScript, MT5, MQL5');
    expect(html).toContain('Active');
  });
});

describe('composeBrainIndex', () => {
  it('generates a Wikipedia-style brain index page with prose topic descriptions', () => {
    const html = composeBrainIndex({
      id: 'brain-index',
      title: 'LazyBrain Index',
      created: '2026-05-26T00:00:00Z',
      leadText: 'This brain covers 2 main topics: Tradelab, Acme. It contains 94 notes.',
      stats: { totalNotes: 94, totalTopics: 2, dateRange: ['2025-01-01', '2026-05-26'] },
      topics: [
        {
          name: 'Tradelab',
          id: 'topic-overview-tradelab',
          noteCount: 44,
          lastActivity: '2026-05-26',
          description: 'Algorithmic tradelab strategies and live execution.',
        },
        {
          name: 'Acme',
          id: 'topic-overview-acme',
          noteCount: 50,
          lastActivity: '2026-05-20',
          description: 'Sports and fitness mobile application.',
        },
      ],
      tags: ['brain', 'index'],
    });
    expect(html).toContain('data-cerveau-type="brain-index"');
    expect(html).toContain('data-cerveau-tags="brain,index"');
    expect(html).toContain('Tradelab');
    expect(html).toContain('44');
    expect(html).toContain('Algorithmic tradelab strategies');
    // Should NOT contain a data table
    expect(html).not.toContain('<table class="wikitable');
  });
});

// ---------------------------------------------------------------------------
// Task 2: confidence display rounded to 2 decimals in concept-neuron infobox
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — confidence display', () => {
  it('shows confidence rounded to 2 decimals in the infobox', () => {
    const html = composeConceptNeuron({
      id: 'concept:use-idempotency-keys',
      title: 'Use idempotency keys for Stripe',
      kind: 'rule',
      body: 'Always pass an idempotency key when creating charges.',
      confidence: 0.2777777777777778,
      date: '2026-05-29',
      related: [],
    });
    // Rendered infobox dd must show exactly "0.28" — not the raw float
    expect(html).toContain('<dd>0.28</dd>');
    // The raw precision must be preserved in the data attribute for computation
    expect(html).toContain('data-cerveau-confidence="0.2777777777777778"');
  });

  it('shows confidence 1.0 as "1.00"', () => {
    const html = composeConceptNeuron({
      id: 'concept:always-valid',
      title: 'Always valid rule',
      kind: 'rule',
      body: 'This rule is always valid.',
      confidence: 1,
      date: '2026-05-29',
      related: [],
    });
    expect(html).toContain('<dd>1.00</dd>');
  });

  it('shows confidence 0.5 as "0.50"', () => {
    const html = composeConceptNeuron({
      id: 'concept:medium-confidence',
      title: 'Medium confidence concept',
      kind: 'idea',
      body: 'Some idea with medium confidence.',
      confidence: 0.5,
      date: '2026-05-29',
      related: [],
    });
    expect(html).toContain('<dd>0.50</dd>');
    expect(html).not.toContain('<dd>0.5</dd>');
  });

  it('confidence with many decimals does not appear raw in the infobox dd', () => {
    const raw = 5 / 18; // 0.2777... repeating
    const html = composeConceptNeuron({
      id: 'concept:low-confidence',
      title: 'Low confidence',
      kind: 'fact',
      body: 'Uncertain fact.',
      confidence: raw,
      date: '2026-05-29',
      related: [],
    });
    // Raw float string must NOT appear inside a <dd> element
    expect(html).not.toContain(`<dd>${raw}</dd>`);
    // Must contain the rounded 2-decimal version
    expect(html).toContain(`<dd>${raw.toFixed(2)}</dd>`);
  });
});

// ---------------------------------------------------------------------------
// Wave 4: concept-neuron topic canonicalization
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — canonical topic segment', () => {
  it('produces a lowercase first segment in data-cerveau-topic when projectName has mixed case', () => {
    const html = composeConceptNeuron({
      id: 'concept:canonical-topic-test',
      title: 'Canonical topic test',
      projectName: 'Acme',
      kind: 'fact',
      body: 'Topic canonicalization check.',
      confidence: 0.9,
      date: '2026-05-29',
      related: [],
    });
    // The grouping topic must use the canonical (lowercase) first segment
    expect(html).toContain('data-cerveau-topic="acme/concepts"');
    // The human-readable display label is still visible in the breadcrumb
    expect(html).toContain('>Acme<');
  });

  it('produces "concepts" as topic when no projectName is given', () => {
    const html = composeConceptNeuron({
      id: 'concept:no-project',
      title: 'No project concept',
      kind: 'idea',
      body: 'No project.',
      confidence: 0.5,
      date: '2026-05-29',
      related: [],
    });
    expect(html).toContain('data-cerveau-topic="concepts"');
  });
});

// ---------------------------------------------------------------------------
// Task 3: aggregate-neuron see-also from real module relationships
// ---------------------------------------------------------------------------

describe('composeAggregateNeuron — see-also section', () => {
  it('renders see-also when seeAlso is provided', () => {
    const html = composeAggregateNeuron({
      id: 'module:src/auth',
      kind: 'module',
      title: 'src/auth',
      path: 'src/auth',
      projectName: 'myproject',
      children: [],
      stats: { fileCount: 3, totalLines: 300, languages: ['typescript'] },
      seeAlso: [
        { id: 'module:src/payments', title: 'payments' },
        { id: 'module:src/users', title: 'users' },
      ],
    });
    expect(html).toContain('data-section="see-also"');
    expect(html).toContain('module:src/payments');
    expect(html).toContain('payments');
  });

  it('omits see-also section when seeAlso is absent', () => {
    const html = composeAggregateNeuron({
      id: 'module:src/utils',
      kind: 'module',
      title: 'src/utils',
      path: 'src/utils',
      projectName: 'myproject',
      children: [],
      stats: { fileCount: 1, totalLines: 50, languages: ['typescript'] },
    });
    expect(html).not.toContain('data-section="see-also"');
  });
});

// ---------------------------------------------------------------------------
// composeFileNeuron — breadcrumb must link to REAL aggregate-neuron ids
// ---------------------------------------------------------------------------

describe('composeFileNeuron — breadcrumb links to real aggregate-neuron ids', () => {
  function makeFileNode(overrides: Partial<CodeNode> = {}): CodeNode {
    return {
      id: 'file:src/auth/index.ts',
      title: 'src/auth/index.ts',
      type: 'file',
      filePath: 'src/auth/index.ts',
      projectRoot: '/fake/myproject',
      language: 'typescript',
      lineCount: 100,
      imports: [],
      exports: ['authenticate'],
      ...overrides,
    };
  }

  it('breadcrumb href for a module segment equals the id composeAggregateNeuron actually assigns', () => {
    // Build the REAL aggregate descriptor + rendered id through the same
    // pipeline buildAggregateNeurons/composeAggregateNeuron production code
    // uses — the test must not hardcode the expected slug string.
    const mockResult = {
      projectRoot: '/fake/myproject',
      projectName: 'myproject',
      nodes: [makeFileNode()],
      edges: [],
      stats: { files: 1, modules: 1, languages: { typescript: 1 } },
    };
    const aggregates = buildAggregateNeurons(mockResult);
    const authModule = aggregates.find((d) => d.path === 'src/auth');
    expect(authModule).toBeDefined();
    const aggregateHtml = composeAggregateNeuron(authModule!);
    const idMatch = aggregateHtml.match(/<article\s+id="([^"]+)"/);
    expect(idMatch).not.toBeNull();
    const realAggregateModuleId = idMatch![1];

    const rootModule = aggregates.find((d) => d.kind === 'project');
    const rootAggregateHtml = composeAggregateNeuron(rootModule!);
    const rootIdMatch = rootAggregateHtml.match(/<article\s+id="([^"]+)"/);
    const realAggregateRootId = rootIdMatch![1];

    // The file-neuron for src/auth/index.ts must breadcrumb-link to both.
    const fileHtml = composeFileNeuron(makeFileNode(), 0);
    const breadcrumbMatch = fileHtml.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/);
    expect(breadcrumbMatch).not.toBeNull();
    const breadcrumbHtml = breadcrumbMatch![0];
    expect(breadcrumbHtml).toContain(`href="#${realAggregateRootId}"`);
    expect(breadcrumbHtml).toContain(`href="#${realAggregateModuleId}"`);
  });

  it('renders a breadcrumb segment as plain text (not a dead link) when its id is missing from knownAggregateIds', () => {
    const mockResult = {
      projectRoot: '/fake/myproject',
      projectName: 'myproject',
      nodes: [makeFileNode()],
      edges: [],
      stats: { files: 1, modules: 1, languages: { typescript: 1 } },
    };
    const aggregates = buildAggregateNeurons(mockResult);
    const rootModule = aggregates.find((d) => d.kind === 'project');
    const rootAggregateHtml = composeAggregateNeuron(rootModule!);
    const realAggregateRootId = rootAggregateHtml.match(/<article\s+id="([^"]+)"/)![1];

    // Only the root aggregate is "known" — the "src/auth" module note is
    // pretended missing, simulating a file-neuron re-rendered standalone
    // before a full graph rebuild created its ancestor module aggregate.
    const knownAggregateIds = new Set([realAggregateRootId]);
    const fileHtml = composeFileNeuron(makeFileNode(), 0, undefined, undefined, knownAggregateIds);
    const breadcrumbHtml = fileHtml.match(/<nav class="breadcrumb"[\s\S]*?<\/nav>/)![0];

    expect(breadcrumbHtml).toContain(`href="#${realAggregateRootId}"`);
    // "src" and "src/auth" levels have no known aggregate — must render as
    // plain, unlinked text (" / src / auth / ") rather than a dead <a> link.
    expect(breadcrumbHtml).not.toContain('href="#aggregate-myproject-src"');
    expect(breadcrumbHtml).not.toContain('href="#aggregate-myproject-src-auth"');
    expect(breadcrumbHtml).toContain(' / src / auth / ');
  });
});

describe('buildAggregateNeurons — see-also from real relationships', () => {
  it('assigns sibling-module see-also when modules share a parent directory', () => {
    // Fake CodeScanResult with two sibling directories: src/auth and src/payments
    const mockResult = {
      projectRoot: '/fake/project',
      projectName: 'myproject',
      nodes: [
        {
          id: 'file:src/auth/index.ts',
          title: 'src/auth/index.ts',
          type: 'file' as const,
          filePath: 'src/auth/index.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 100,
          imports: [],
          exports: ['authenticate'],
        },
        {
          id: 'file:src/payments/index.ts',
          title: 'src/payments/index.ts',
          type: 'file' as const,
          filePath: 'src/payments/index.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 80,
          imports: [],
          exports: ['charge'],
        },
        {
          id: 'file:src/users/index.ts',
          title: 'src/users/index.ts',
          type: 'file' as const,
          filePath: 'src/users/index.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 60,
          imports: [],
          exports: ['getUser'],
        },
      ],
      edges: [],
      stats: { files: 3, modules: 3, languages: { typescript: 3 } },
    };

    const aggregates = buildAggregateNeurons(mockResult);

    // Find the src/auth module descriptor
    const authModule = aggregates.find((d) => d.path === 'src/auth');
    expect(authModule).toBeDefined();

    // src/auth should have see-also pointing at its siblings (src/payments, src/users)
    const seeAlsoIds = (authModule?.seeAlso ?? []).map((s) => s.id);
    expect(seeAlsoIds.length).toBeGreaterThan(0);
    // At least one sibling module should be present
    const hasSibling =
      seeAlsoIds.includes('module:src/payments') || seeAlsoIds.includes('module:src/users');
    expect(hasSibling).toBe(true);
  });

  it('assigns cross-module import connections to see-also', () => {
    // src/auth imports from src/utils — the two modules should link to each other
    const mockResult = {
      projectRoot: '/fake/project',
      projectName: 'myproject',
      nodes: [
        {
          id: 'file:src/auth/index.ts',
          title: 'src/auth/index.ts',
          type: 'file' as const,
          filePath: 'src/auth/index.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 100,
          imports: ['../utils/helpers.ts'],
          exports: ['authenticate'],
        },
        {
          id: 'file:src/utils/helpers.ts',
          title: 'src/utils/helpers.ts',
          type: 'file' as const,
          filePath: 'src/utils/helpers.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 40,
          imports: [],
          exports: ['formatDate'],
        },
      ],
      edges: [
        {
          source: 'file:src/auth/index.ts',
          target: 'file:src/utils/helpers.ts',
          type: 'imports' as const,
          confidence: 'extracted' as const,
          confidenceScore: 1.0 as const,
        },
      ],
      stats: { files: 2, modules: 2, languages: { typescript: 2 } },
    };

    const aggregates = buildAggregateNeurons(mockResult);

    // src/auth should link to src/utils via the import edge
    const authModule = aggregates.find((d) => d.path === 'src/auth');
    expect(authModule).toBeDefined();
    const seeAlsoIds = (authModule?.seeAlso ?? []).map((s) => s.id);
    expect(seeAlsoIds).toContain('module:src/utils');

    // src/utils should link back to src/auth (imported by)
    const utilsModule = aggregates.find((d) => d.path === 'src/utils');
    expect(utilsModule).toBeDefined();
    const utilsSeeAlsoIds = (utilsModule?.seeAlso ?? []).map((s) => s.id);
    expect(utilsSeeAlsoIds).toContain('module:src/auth');
  });

  it('project root aggregate has no see-also (its sub-modules are children)', () => {
    const mockResult = {
      projectRoot: '/fake/project',
      projectName: 'myproject',
      nodes: [
        {
          id: 'file:src/auth/index.ts',
          title: 'src/auth/index.ts',
          type: 'file' as const,
          filePath: 'src/auth/index.ts',
          projectRoot: '/fake/project',
          language: 'typescript',
          lineCount: 50,
          imports: [],
          exports: [],
        },
      ],
      edges: [],
      stats: { files: 1, modules: 1, languages: { typescript: 1 } },
    };

    const aggregates = buildAggregateNeurons(mockResult);
    const rootAggregate = aggregates.find((d) => d.kind === 'project');
    expect(rootAggregate).toBeDefined();
    // Root should have no see-also
    expect(rootAggregate?.seeAlso ?? []).toHaveLength(0);
  });

  it('see-also is capped at 5 entries per module', () => {
    // Create 7 sibling directories — each module's see-also should be capped at 5
    const nodes = Array.from({ length: 7 }, (_, i) => ({
      id: `file:src/mod${i}/index.ts`,
      title: `src/mod${i}/index.ts`,
      type: 'file' as const,
      filePath: `src/mod${i}/index.ts`,
      projectRoot: '/fake/project',
      language: 'typescript',
      lineCount: 20,
      imports: [],
      exports: [],
    }));

    const mockResult = {
      projectRoot: '/fake/project',
      projectName: 'myproject',
      nodes,
      edges: [],
      stats: { files: 7, modules: 7, languages: { typescript: 7 } },
    };

    const aggregates = buildAggregateNeurons(mockResult);
    for (const agg of aggregates) {
      if (agg.kind === 'module') {
        expect((agg.seeAlso ?? []).length).toBeLessThanOrEqual(5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeItemText — Pass 3: orphan →# fragments (no opening bracket)
// ---------------------------------------------------------------------------

describe('normalizeItemText — orphan →# fragment (Pass 3)', () => {
  it('strips a bare orphan token like "ts→#file-acme-src-config-ts]:" from a real item', () => {
    const input = 'ts→#file-acme-src-config-ts]: all secrets stored in env vars';
    const result = normalizeItemText(input);
    expect(result).not.toContain('→#');
    expect(result).not.toContain(']');
    expect(result).toContain('all secrets stored in env vars');
  });

  it('strips an orphan at the start of the string leaving the rest clean', () => {
    const result = normalizeItemText('config.ts→#file-acme-config-ts] uses dotenv');
    expect(result).not.toContain('→#');
    expect(result).not.toContain(']');
    expect(result).toContain('uses dotenv');
  });

  it('strips an orphan in the middle of a sentence', () => {
    const result = normalizeItemText('All secrets in auth.ts→#file-auth-ts] are loaded at startup');
    expect(result).not.toContain('→#');
    expect(result).toContain('All secrets in');
    expect(result).toContain('are loaded at startup');
  });

  it('does NOT touch normal prose without →# sequences', () => {
    const prose = 'Supabase RLS policies enforce row-level security for all tables';
    expect(normalizeItemText(prose)).toBe(prose);
  });

  it('does NOT touch a complete wiki-link that pass 1 already handles', () => {
    // Pass 1 converts [Label→#target] → Label; Pass 3 must not interfere
    const result = normalizeItemText('[config.ts→#file-acme-config-ts] manages env vars');
    expect(result).toBe('config.ts manages env vars');
  });

  it('handles multiple orphan fragments in one string', () => {
    const result = normalizeItemText('foo.ts→#foo-ts] and bar.ts→#bar-ts] are siblings');
    expect(result).not.toContain('→#');
    expect(result).not.toContain(']');
    expect(result).toContain('are siblings');
  });
});

// ---------------------------------------------------------------------------
// composeConceptNeuron — wiki-link markup must not appear in rendered output
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — body wiki-link normalization', () => {
  it('removes complete [Label→#target] markup from the body section', () => {
    const html = composeConceptNeuron({
      id: 'concept:wiki-link-test',
      title: 'Wiki link test',
      kind: 'rule',
      body: 'Always use [config.ts→#file-acme-config-ts] for environment configuration.',
      confidence: 0.8,
      date: '2026-06-08',
      related: [],
    });
    expect(html).not.toContain('→#');
    expect(html).not.toContain('[config.ts→#');
    // The label must remain visible
    expect(html).toContain('config.ts');
    expect(html).toContain('for environment configuration');
  });

  it('removes orphan →# fragment from the body section', () => {
    const html = composeConceptNeuron({
      id: 'concept:orphan-test',
      title: 'Orphan fragment test',
      kind: 'fact',
      body: 'ts→#file-acme-src-config-ts]: all secrets stored in environment variables.',
      confidence: 0.75,
      date: '2026-06-08',
      related: [],
    });
    expect(html).not.toContain('→#');
    expect(html).not.toContain(']');
    expect(html).toContain('all secrets stored in environment variables');
  });

  it('does not alter plain prose with no wiki-link markup', () => {
    const plainBody = 'Supabase RLS policies enforce row-level security for all tables.';
    const html = composeConceptNeuron({
      id: 'concept:plain-body',
      title: 'Plain body',
      kind: 'fact',
      body: plainBody,
      confidence: 0.9,
      date: '2026-06-08',
      related: [],
    });
    // The body content (HTML-escaped) must be present verbatim
    expect(html).toContain(plainBody);
  });
});

// ---------------------------------------------------------------------------
// composeConceptNeuron — wiki-link markup must not appear in title / tldr
// ---------------------------------------------------------------------------

describe('composeConceptNeuron — title and tldr wiki-link normalization', () => {
  it('removes complete [Label→#target] markup from h1 title', () => {
    const html = composeConceptNeuron({
      id: 'concept:title-wikilink-test',
      title: '[Bug→#/note/acme-conv-db-transaction-bug-2026-05-28] in DB transaction',
      kind: 'bug',
      body: 'Transaction rollback not triggered on partial failure.',
      confidence: 0.9,
      date: '2026-06-08',
      related: [],
    });
    // h1 must not contain →# or [Label→
    expect(html).not.toContain('→#');
    expect(html).not.toContain('[Bug→');
    // The label text must remain
    expect(html).toContain('Bug');
    expect(html).toContain('in DB transaction');
  });

  it('removes complete [Label→#target] markup from tldr section', () => {
    const html = composeConceptNeuron({
      id: 'concept:tldr-wikilink-test',
      title: '[Stripe→#/note/file-acme-src-payments-stripe-ts] payment rule',
      kind: 'rule',
      body: 'Always use idempotency keys.',
      confidence: 0.8,
      date: '2026-06-08',
      related: [],
    });
    // tldr section must not contain →# or [Label→
    const tldrMatch = html.match(/<section data-section="tldr">[\s\S]*?<\/section>/);
    expect(tldrMatch).not.toBeNull();
    const tldrHtml = tldrMatch![0];
    expect(tldrHtml).not.toContain('→#');
    expect(tldrHtml).not.toContain('[Stripe→');
    expect(tldrHtml).toContain('Stripe');
    expect(tldrHtml).toContain('payment rule');
  });

  it('removes wikilink markup from related neuron display titles', () => {
    const html = composeConceptNeuron({
      id: 'concept:related-title-test',
      title: 'Related title normalization',
      kind: 'decision',
      body: 'Related titles must be clean.',
      confidence: 0.7,
      date: '2026-06-08',
      related: [
        {
          id: 'file:src/payments/stripe.ts',
          title: '[Stripe→#/note/file-acme-src-payments-stripe-ts]',
        },
        { id: 'file:src/db/transaction.ts', title: 'src/db/transaction.ts' },
      ],
    });
    // related section must not contain →# or [Label→
    const relatedMatch = html.match(/<section data-section="related">[\s\S]*?<\/section>/);
    expect(relatedMatch).not.toBeNull();
    const relatedHtml = relatedMatch![0];
    expect(relatedHtml).not.toContain('→#');
    expect(relatedHtml).not.toContain('[Stripe→');
    // hrefs must be preserved
    expect(relatedHtml).toContain('href="#/file:src/payments/stripe.ts"');
    expect(relatedHtml).toContain('href="#/file:src/db/transaction.ts"');
  });

  it('removes wikilink markup from seeAlso display titles', () => {
    const html = composeConceptNeuron({
      id: 'concept:seealso-title-test',
      title: 'SeeAlso title normalization',
      kind: 'fact',
      body: 'SeeAlso titles must be clean.',
      confidence: 0.6,
      date: '2026-06-08',
      related: [],
      seeAlso: [
        {
          id: 'concept:auth-decision',
          title: '[Auth decision→#/note/concept-auth-decision]',
        },
      ],
    });
    // see-also section must not contain →# or [Label→
    const seeAlsoMatch = html.match(/<section data-section="see-also">[\s\S]*?<\/section>/);
    expect(seeAlsoMatch).not.toBeNull();
    const seeAlsoHtml = seeAlsoMatch![0];
    expect(seeAlsoHtml).not.toContain('→#');
    expect(seeAlsoHtml).not.toContain('[Auth decision→');
    // href must be preserved
    expect(seeAlsoHtml).toContain('href="#/concept:auth-decision"');
    // label text must remain
    expect(seeAlsoHtml).toContain('Auth decision');
  });

  it('title with no wiki-link markup passes through unchanged', () => {
    const cleanTitle = 'Use idempotency keys for all Stripe charges';
    const html = composeConceptNeuron({
      id: 'concept:clean-title-passthrough',
      title: cleanTitle,
      kind: 'rule',
      body: 'Always pass an idempotency key.',
      confidence: 0.9,
      date: '2026-06-08',
      related: [],
    });
    expect(html).toContain(cleanTitle);
    expect(html).not.toContain('→#');
  });
});

// composeKnowledgeNode tests removed — knowledge-node.ts deleted (zero production imports).
