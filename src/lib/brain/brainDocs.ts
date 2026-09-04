/* brainDocs.ts — Brain Docs: a curated knowledge base of internet resources
   (URLs, blogs, docs, tutorials) tagged by topic and linked to brain nodes.

   Core concept:
   1. Users add URLs with tags (e.g. "html", "css", "rust", "auth")
   2. Tags are linked to brain nodes — if a brain node has topic "html",
      docs tagged "html" are associated with it
   3. When the brain does a recall, it also searches brain docs for matching tags
   4. If brain docs have relevant URLs, they're included in the context
   5. If the brain searches the web and finds useful info, it captures it back
      as a new brain doc entry — continuous learning loop

   This works for everyone — docs are stored in localStorage and optionally
   synced to the brain as captured neurons.
*/

import { getPlatform } from '../platform/index.js';
import type { BrainSearchResult, CaptureEvent } from '../platform/types.js';

// ── Types ─────────────────────────────────────────────────────────

export interface BrainDocEntry {
  id: string;
  url: string;
  title: string;
  description?: string;
  /** Tags linking this doc to brain topics (e.g. "html", "css", "auth") */
  tags: string[];
  /** Brain node IDs this doc is linked to (populated by linking logic) */
  linkedNodeIds?: string[];
  /** When the doc was added */
  addedAt: string;
  /** Last time the doc content was fetched/refreshed */
  lastFetched?: string;
  /** Cached snippet of the page content (first ~500 chars) */
  snippet?: string;
  /** Source: "manual" (user added), "auto" (brain discovered), "import" (from continue config) */
  source: 'manual' | 'auto' | 'import';
  /** Domain extracted from URL for quick filtering */
  domain: string;
}

export interface BrainDocSearchResult {
  doc: BrainDocEntry;
  score: number;
  matchedTags: string[];
}

// ── Storage ───────────────────────────────────────────────────────

const DOCS_KEY = 'lazy.brainDocs';
const MAX_DOCS = 500;

function loadDocs(): BrainDocEntry[] {
  try {
    const raw = localStorage.getItem(DOCS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as BrainDocEntry[];
  } catch {
    return [];
  }
}

function saveDocs(docs: BrainDocEntry[]): void {
  try {
    localStorage.setItem(DOCS_KEY, JSON.stringify(docs.slice(0, MAX_DOCS)));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function generateId(): string {
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalize a tag: lowercase, trim, remove non-alphanumeric except hyphens */
function normalizeTag(tag: string): string {
  return tag.toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
}

/** Extract tags from a brain search result's cluster and topic */
function extractTagsFromBrainResult(result: BrainSearchResult): string[] {
  const tags: string[] = [];
  if (result.cluster) tags.push(normalizeTag(result.cluster));
  if (result.sourceProject) tags.push(normalizeTag(result.sourceProject));
  return tags;
}

// ── Public API ────────────────────────────────────────────────────

/** Get all brain docs */
export function getBrainDocs(): BrainDocEntry[] {
  return loadDocs();
}

/** Add a new brain doc entry */
export function addBrainDoc(opts: {
  url: string;
  title: string;
  description?: string;
  tags: string[];
  source?: 'manual' | 'auto' | 'import';
  snippet?: string;
}): BrainDocEntry {
  const docs = loadDocs();
  const normalizedTags = opts.tags.map(normalizeTag).filter(Boolean);

  // Deduplicate by URL — update existing entry instead of adding a duplicate
  const existing = docs.find(d => d.url === opts.url);
  if (existing) {
    const mergedTags = [...new Set([...existing.tags, ...normalizedTags])];
    const updated: BrainDocEntry = {
      ...existing,
      title: opts.title || existing.title,
      description: opts.description || existing.description,
      tags: mergedTags,
      snippet: opts.snippet || existing.snippet,
      lastFetched: opts.snippet ? new Date().toISOString() : existing.lastFetched,
    };
    saveDocs(docs.map(d => d.id === existing.id ? updated : d));
    return updated;
  }

  const entry: BrainDocEntry = {
    id: generateId(),
    url: opts.url,
    title: opts.title,
    description: opts.description,
    tags: normalizedTags,
    addedAt: new Date().toISOString(),
    lastFetched: opts.snippet ? new Date().toISOString() : undefined,
    snippet: opts.snippet,
    source: opts.source ?? 'manual',
    domain: extractDomain(opts.url),
  };

  saveDocs([entry, ...docs]);
  return entry;
}

/** Remove a brain doc entry by ID */
export function removeBrainDoc(id: string): void {
  const docs = loadDocs();
  saveDocs(docs.filter(d => d.id !== id));
}

/** Update a brain doc entry */
export function updateBrainDoc(id: string, patch: Partial<BrainDocEntry>): void {
  const docs = loadDocs();
  saveDocs(docs.map(d => d.id === id ? { ...d, ...patch } : d));
}

/** Get all unique tags across all docs */
export function getBrainDocTags(): string[] {
  const docs = loadDocs();
  const tagSet = new Set<string>();
  for (const doc of docs) {
    for (const tag of doc.tags) tagSet.add(tag);
  }
  return [...tagSet].sort();
}

// ── Search ────────────────────────────────────────────────────────

/**
 * Search brain docs by query string and/or tags.
 * Returns results sorted by relevance score (tag matches > text matches).
 */
export function searchBrainDocs(query: string, tags?: string[]): BrainDocSearchResult[] {
  const docs = loadDocs();
  if (docs.length === 0) return [];

  const normalizedQuery = query.toLowerCase().trim();
  const normalizedTags = (tags ?? []).map(normalizeTag).filter(Boolean);
  const results: BrainDocSearchResult[] = [];

  for (const doc of docs) {
    let score = 0;
    const matchedTags: string[] = [];

    // Tag matching — highest weight
    if (normalizedTags.length > 0) {
      for (const tag of normalizedTags) {
        if (doc.tags.includes(tag)) {
          score += 10;
          matchedTags.push(tag);
        }
      }
    }

    // Text matching — title, description, domain
    if (normalizedQuery) {
      const titleMatch = doc.title.toLowerCase().includes(normalizedQuery);
      const descMatch = doc.description?.toLowerCase().includes(normalizedQuery) ?? false;
      const domainMatch = doc.domain.toLowerCase().includes(normalizedQuery);
      const urlMatch = doc.url.toLowerCase().includes(normalizedQuery);

      if (titleMatch) score += 5;
      if (descMatch) score += 3;
      if (domainMatch) score += 2;
      if (urlMatch) score += 1;

      // Tag text match
      for (const tag of doc.tags) {
        if (tag.includes(normalizedQuery)) {
          score += 4;
          matchedTags.push(tag);
        }
      }
    }

    if (score > 0) {
      results.push({ doc, score, matchedTags: [...new Set(matchedTags)] });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Find brain docs relevant to a set of brain search results.
 * Uses the clusters/topics from brain results to find matching docs.
 */
export function findDocsForBrainResults(results: BrainSearchResult[]): BrainDocSearchResult[] {
  if (results.length === 0) return [];

  // Extract all tags from brain results
  const brainTags = new Set<string>();
  for (const result of results) {
    const tags = extractTagsFromBrainResult(result);
    for (const tag of tags) brainTags.add(tag);
    // Also use the result title words as potential tag matches
    const titleWords = result.title.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    for (const word of titleWords) brainTags.add(word);
  }

  return searchBrainDocs('', [...brainTags]);
}

// ── Brain integration ─────────────────────────────────────────────

/**
 * Build a context string from brain docs to inject into the assistant prompt.
 * Called alongside brain recall — docs are appended to the brain context.
 */
export function buildBrainDocsContext(
  results: BrainDocSearchResult[],
  maxDocs: number = 5,
): string {
  if (results.length === 0) return '';

  const lines: string[] = [];
  for (const { doc, matchedTags } of results.slice(0, maxDocs)) {
    const tagStr = matchedTags.length > 0 ? ` [tags: ${matchedTags.join(', ')}]` : '';
    const desc = doc.description ? ` — ${doc.description}` : '';
    const snippet = doc.snippet ? `\n  Snippet: ${doc.snippet.slice(0, 200)}` : '';
    lines.push(`📖 ${doc.title}${tagStr}${desc}\n  URL: ${doc.url}${snippet}`);
  }

  return lines.join('\n');
}

/**
 * Capture a brain doc entry as a brain neuron so it becomes part of
 * the persistent brain graph. Fire-and-forget — never throws.
 */
export async function captureDocToBrain(doc: BrainDocEntry): Promise<void> {
  try {
    const platform = getPlatform();
    const event: CaptureEvent = {
      kind: 'learning',
      title: `📖 Doc: ${doc.title}`,
      text: `URL: ${doc.url}\nTags: ${doc.tags.join(', ')}\n${doc.description ?? ''}\n${doc.snippet ?? ''}`,
      tags: ['doc', 'resource', ...doc.tags],
      source: 'brain-docs',
      topic: doc.tags[0],
      space: 'topical',
    };
    await platform.brain.capture(event);
  } catch {
    // fire-and-forget — never blocks
  }
}

/**
 * Auto-discovery: when the brain searches the web and finds useful content,
 * capture it as a new brain doc entry. This creates the continuous learning loop:
 * docs → brain → web → docs
 */
export async function autoDiscoverDoc(opts: {
  url: string;
  title: string;
  snippet?: string;
  tags: string[];
}): Promise<BrainDocEntry | null> {
  if (!opts.url || !opts.title) return null;

  const entry = addBrainDoc({
    url: opts.url,
    title: opts.title,
    description: opts.snippet?.slice(0, 200),
    tags: opts.tags,
    source: 'auto',
    snippet: opts.snippet,
  });

  // Also capture to brain for persistence
  await captureDocToBrain(entry);

  return entry;
}

/**
 * Link brain docs to brain nodes by matching tags to node clusters/topics.
 * Returns updated docs with linkedNodeIds populated.
 */
export function linkDocsToBrainNodes(
  docs: BrainDocEntry[],
  brainResults: BrainSearchResult[],
): BrainDocEntry[] {
  const updated = docs.map(doc => ({ ...doc, linkedNodeIds: [] as string[] }));

  for (const result of brainResults) {
    const resultTags = new Set(extractTagsFromBrainResult(result));
    for (const doc of updated) {
      const hasMatch = doc.tags.some(tag => resultTags.has(tag));
      if (hasMatch) {
        doc.linkedNodeIds!.push(result.id);
      }
    }
  }

  // Persist the links
  const allDocs = loadDocs();
  for (const doc of updated) {
    if (doc.linkedNodeIds!.length > 0) {
      const existing = allDocs.find(d => d.id === doc.id);
      if (existing) {
        existing.linkedNodeIds = [...new Set([...(existing.linkedNodeIds ?? []), ...doc.linkedNodeIds!])];
      }
    }
  }
  saveDocs(allDocs);

  return updated;
}

// ── Import from config ────────────────────────────────────────────

/**
 * Import docs from a Continue-style config (docs section).
 * Allows migrating from Continue or importing a curated list.
 */
export function importDocsFromConfig(docs: Array<{
  name: string;
  startUrl: string;
  favicon?: string;
}>): BrainDocEntry[] {
  const imported: BrainDocEntry[] = [];
  for (const doc of docs) {
    const entry = addBrainDoc({
      url: doc.startUrl,
      title: doc.name,
      tags: [extractDomain(doc.startUrl).split('.')[0]],
      source: 'import',
    });
    imported.push(entry);
  }
  return imported;
}
