/**
 * enrich-hierarchy: populates hierarchy knowledge-nodes from conversation notes.
 * Uses topic-path prefix matching to aggregate convs into the right node level.
 * Higher nodes (root, project) get broader aggregations.
 * Deeper nodes (modules, features) get specific content only.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type HierarchyNode, extractHierarchy } from '../graph/hierarchy.js';
import { knowledgeNodePath, slug } from '../store/paths.js';
import { readAllNotes } from '../store/reader.js';
import { normalizeCwd } from '../util/cwd-normalizer.js';
import { getLogger } from '../util/logger.js';
import { nowIso } from '../util/telemetry.js';
import { composeHierarchyNode } from './hierarchy-node-composer.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface EnrichHierarchyOptions {
  force?: boolean;
  pretty?: boolean;
  topic?: string;
}

export interface EnrichHierarchyReport {
  nodesEnriched: number;
  sectionsPopulated: number;
  conversationsScanned: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Content classifiers — same patterns as enrich.ts
// ---------------------------------------------------------------------------

interface Classifier {
  kind: 'decision' | 'bug' | 'idea' | 'rule' | 'qa';
  pattern: RegExp;
}

const CLASSIFIERS: Classifier[] = [
  {
    kind: 'decision',
    pattern:
      /(?:decided|decision|chose|chosen|went\s+with|opted|choisi|décidé|on\s+(?:a|va)\s+(?:pris|fait|choisi|utilisé))/i,
  },
  {
    kind: 'bug',
    pattern:
      /(?:bug|error|crash|fix(?:ed)?|broken|cassé|erreur|TypeError|ReferenceError|ENOENT|failed|plantage)/i,
  },
  {
    kind: 'idea',
    pattern:
      /(?:idea|should|could\s+we|todo|improve|enhancement|idée|améliorer|pourrait|faudrait|on\s+devrait)/i,
  },
  {
    kind: 'rule',
    pattern:
      /(?:always|never|must(?:\s+not)?|rule|convention|obligat|interdit|jamais|toujours|ne\s+(?:pas|jamais))/i,
  },
  {
    kind: 'qa',
    pattern: /(?:^|\s)(?:why|how|what|when|pourquoi|comment|quoi|qu['']est)[^.]{5,}\?/i,
  },
];

// ---------------------------------------------------------------------------
// Enrichment bucket types
// ---------------------------------------------------------------------------

interface EnrichmentBucket {
  decisions: Array<{ text: string; sourceId: string }>;
  bugs: Array<{ text: string; sourceId: string }>;
  ideas: Array<{ text: string; sourceId: string }>;
  rules: Array<{ text: string; sourceId: string }>;
  facts: Array<{ text: string; sourceId: string }>;
  qa: Array<{ question: string; sourceId: string }>;
}

function emptyBucket(): EnrichmentBucket {
  return { decisions: [], bugs: [], ideas: [], rules: [], facts: [], qa: [] };
}

function countPopulatedSections(b: EnrichmentBucket): number {
  return [b.decisions, b.bugs, b.ideas, b.rules, b.facts, b.qa].filter((a) => a.length > 0).length;
}

// ---------------------------------------------------------------------------
// Deduplication by text prefix (first 80 chars)
// ---------------------------------------------------------------------------

function dedupeByPrefix<T extends { text?: string; question?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const prefix = (item.text ?? item.question ?? '').slice(0, 80);
    if (seen.has(prefix)) return false;
    seen.add(prefix);
    return true;
  });
}

function deduplicateBucket(b: EnrichmentBucket): EnrichmentBucket {
  return {
    decisions: dedupeByPrefix(b.decisions),
    bugs: dedupeByPrefix(b.bugs),
    ideas: dedupeByPrefix(b.ideas),
    rules: dedupeByPrefix(b.rules),
    facts: dedupeByPrefix(b.facts),
    qa: dedupeByPrefix(b.qa),
  };
}

// ---------------------------------------------------------------------------
// Sentence classification
// ---------------------------------------------------------------------------

function classifyChunk(chunk: string, sourceId: string, bucket: EnrichmentBucket): void {
  const trimmed = chunk.trim();
  if (trimmed.length < 20 || trimmed.length > 500) return;

  for (const { kind, pattern } of CLASSIFIERS) {
    if (!pattern.test(trimmed)) continue;
    const text = trimmed.slice(0, 300);
    switch (kind) {
      case 'decision':
        bucket.decisions.push({ text, sourceId });
        break;
      case 'bug':
        bucket.bugs.push({ text, sourceId });
        break;
      case 'idea':
        bucket.ideas.push({ text, sourceId });
        break;
      case 'rule':
        bucket.rules.push({ text, sourceId });
        break;
      case 'qa':
        bucket.qa.push({ question: text, sourceId });
        break;
    }
    return; // first match wins
  }
}

// ---------------------------------------------------------------------------
// Per-note contribution with its topicPath tag
// ---------------------------------------------------------------------------

interface NoteContribution {
  topicPath: string;
  bucket: EnrichmentBucket;
}

// ---------------------------------------------------------------------------
// Topic-path prefix matching for hierarchy aggregation
// - Root: matches ALL notes
// - Project "acme": notes whose topicPath is "acme" or starts with "acme/"
// - Module "acme/auth": notes whose topicPath is "acme/auth" or starts with "acme/auth/"
// - Feature "acme/auth/login": notes whose topicPath equals "acme/auth/login"
// ---------------------------------------------------------------------------

function matchesNode(notePath: string, node: HierarchyNode): boolean {
  if (node.level === 0) return true; // root aggregates everything
  const nodeId = node.id;
  return notePath === nodeId || notePath.startsWith(`${nodeId}/`);
}

// Cap per section depends on depth: shallower nodes get more items (broad view)
// Deeper nodes get fewer (more focused)
function sectionCapForLevel(level: number): number {
  if (level === 0) return 15;
  if (level === 1) return 12;
  if (level === 2) return 10;
  return 8; // feature level 3+
}

// ---------------------------------------------------------------------------
// Already-enriched check
// ---------------------------------------------------------------------------

function isAlreadyEnriched(html: string): boolean {
  return (
    html.includes('data-section="decisions"') ||
    html.includes('data-section="bugs"') ||
    html.includes('data-section="ideas"') ||
    html.includes('data-section="rules"') ||
    html.includes('data-section="facts"') ||
    html.includes('data-section="qa"')
  );
}

// ---------------------------------------------------------------------------
// Extract cwd from a note's HTML
// ---------------------------------------------------------------------------

function extractCwdFromHtml(html: string): string | null {
  const m = html.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runEnrichHierarchy(
  opts: EnrichHierarchyOptions,
): Promise<EnrichHierarchyReport> {
  const log = getLogger();
  const report: EnrichHierarchyReport = {
    nodesEnriched: 0,
    sectionsPopulated: 0,
    conversationsScanned: 0,
    errors: [],
  };

  // Step 1: Load all conversation notes
  const allNotes = readAllNotes();
  log.debug({ noteCount: allNotes.length }, 'enrich-hierarchy: notes loaded');

  // Step 2: Extract hierarchy tree
  const tree = extractHierarchy(allNotes);
  log.debug(
    { totalNodes: tree.totalNodes, projects: tree.projects.length },
    'enrich-hierarchy: hierarchy extracted',
  );

  // Step 3: Build per-note contributions (topicPath + classified content)
  const contributions: NoteContribution[] = [];

  for (const note of allNotes) {
    // Skip notes that are themselves hierarchy nodes or synthesized nodes
    if (
      note.html.includes('data-cerveau-source="build-hierarchy"') ||
      note.html.includes('data-cerveau-source="synthesize-nodes"') ||
      note.html.includes('data-cerveau-type="hierarchy-node"')
    ) {
      continue;
    }

    const rawCwd = extractCwdFromHtml(note.html);
    if (!rawCwd) continue;

    const normalized = normalizeCwd(rawCwd);
    if (!normalized) continue;

    const { topicPath } = normalized;
    if (!topicPath) continue;

    // Strip HTML and split into chunks
    const plainText = note.html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (plainText.length < 30) continue;

    const chunks = plainText
      .split(/[.!\n]+/)
      .filter((s) => s.trim().length > 20 && s.trim().length < 500);

    const noteId = note.id || note.path;
    const bucket = emptyBucket();

    // Classify chunks
    for (const chunk of chunks.slice(0, 50)) {
      classifyChunk(chunk, noteId, bucket);
    }

    // Add first meaningful chunk as a fact
    const firstChunk = chunks[0]?.trim();
    if (firstChunk && firstChunk.length > 20) {
      bucket.facts.push({ text: firstChunk.slice(0, 200), sourceId: noteId });
    }

    contributions.push({ topicPath, bucket });
    report.conversationsScanned += 1;
  }

  log.debug({ contributions: contributions.length }, 'enrich-hierarchy: contributions classified');

  const created = nowIso();

  // Step 4: For each hierarchy node, aggregate matching contributions and write
  for (const [, node] of tree.byId) {
    // Apply topic filter if provided
    if (opts.topic) {
      const topicFilter = opts.topic;
      if (node.id !== topicFilter && !node.id.startsWith(`${topicFilter}/`) && node.level !== 0) {
        continue;
      }
    }

    const nodeSlugId = slug(node.id);
    const targetPath = knowledgeNodePath(nodeSlugId);

    // Skip already-enriched nodes unless --force
    if (!opts.force && existsSync(targetPath)) {
      try {
        const { readFileSync } = await import('node:fs');
        const existingHtml = readFileSync(targetPath, 'utf8');
        if (isAlreadyEnriched(existingHtml)) {
          log.debug({ nodeId: node.id }, 'enrich-hierarchy: skipped (already enriched)');
          continue;
        }
      } catch {
        // If read fails, proceed to re-enrich
      }
    }

    try {
      // Aggregate contributions matching this node's topic path
      const merged = emptyBucket();

      for (const contrib of contributions) {
        if (!matchesNode(contrib.topicPath, node)) continue;

        for (const d of contrib.bucket.decisions) merged.decisions.push(d);
        for (const b of contrib.bucket.bugs) merged.bugs.push(b);
        for (const i of contrib.bucket.ideas) merged.ideas.push(i);
        for (const r of contrib.bucket.rules) merged.rules.push(r);
        for (const f of contrib.bucket.facts) merged.facts.push(f);
        for (const q of contrib.bucket.qa) merged.qa.push(q);
      }

      const deduped = deduplicateBucket(merged);
      const cap = sectionCapForLevel(node.level);

      const html = composeHierarchyNode({
        node,
        tree,
        decisions: deduped.decisions.slice(0, cap),
        bugs: deduped.bugs.slice(0, cap),
        ideas: deduped.ideas.slice(0, cap),
        rules: deduped.rules.slice(0, cap),
        facts: deduped.facts.slice(0, cap),
        qa: deduped.qa.slice(0, cap),
        codeFiles: [],
        created,
      });

      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, html, 'utf8');

      const populated = countPopulatedSections(deduped);
      report.nodesEnriched += 1;
      report.sectionsPopulated += populated;

      log.debug(
        {
          nodeId: node.id,
          level: node.level,
          sections: populated,
          decisions: deduped.decisions.length,
          bugs: deduped.bugs.length,
          ideas: deduped.ideas.length,
          rules: deduped.rules.length,
          facts: deduped.facts.length,
          qa: deduped.qa.length,
        },
        'enrich-hierarchy: node enriched',
      );
    } catch (err) {
      const msg = (err as Error).message;
      report.errors.push(`${node.id}: ${msg}`);
      log.warn({ nodeId: node.id, err: msg }, 'enrich-hierarchy: node failed');
    }
  }

  log.debug(
    {
      nodesEnriched: report.nodesEnriched,
      sectionsPopulated: report.sectionsPopulated,
      conversationsScanned: report.conversationsScanned,
      errors: report.errors.length,
    },
    'enrich-hierarchy: done',
  );

  return report;
}
