/**
 * Lightweight entity registry. Names → canonical keys with a type prefix.
 * Persisted as `_cache/entities.json`. New entities are auto-registered when
 * they appear in a recognisable shape (CamelCase, PascalCase, all-caps, or
 * snake_case ≥ 3 chars). Type is inferred from regex hints.
 *
 * The annotator wraps occurrences of registered names in
 * `<dfn data-cerveau-entity="<type>:<key>">name</dfn>` so retrieval can
 * traverse "everything mentioning entity X" via CSS, free.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig } from '../util/config.js';

export interface EntityEntry {
  key: string; // canonical lower-kebab id, e.g. "postgres-prod"
  type: string; // "db" | "lib" | "tool" | "person" | "file" | "concept" | "other"
  surfaces: string[]; // surface forms seen ("Postgres", "postgresql", "pg")
  firstSeen: string; // ISO date
}

const ENTITY_FILE = 'entities.json';

const KNOWN_TYPES: Array<[RegExp, string]> = [
  [
    /^(?:postgres|postgresql|mysql|sqlite|mariadb|redis|mongodb|cassandra|dynamodb|neo4j|qdrant|chroma|elasticsearch|chromadb)$/i,
    'db',
  ],
  [
    /^(?:react|next\.?js|vue|svelte|angular|express|fastify|hono|django|flask|fastapi|rails|spring|nest\.?js)$/i,
    'lib',
  ],
  [/^(?:claude|gpt|haiku|sonnet|opus|gemini|llama|mistral|anthropic|openai)/i, 'llm'],
  [/^(?:docker|kubernetes|k8s|nginx|traefik|terraform|ansible|helm)$/i, 'infra'],
  [/^(?:lazybrain|claude-mem|mem0|letta|graphiti|memgpt)$/i, 'project'],
  [/^(?:typescript|javascript|python|rust|go|java|kotlin|swift|ruby|php)$/i, 'lang'],
  [/^(?:vitest|jest|playwright|cypress|pytest)$/i, 'tool'],
  [/^(?:[A-Z][a-z]+\.?[a-z]+)$/, 'concept'],
];

function entitiesPath(): string {
  return join(getConfig().cachePath, ENTITY_FILE);
}

let cache: Record<string, EntityEntry> | null = null;
let cacheLoadedAt = 0;

function load(): Record<string, EntityEntry> {
  const now = Date.now();
  if (cache && now - cacheLoadedAt < 5000) return cache;
  const path = entitiesPath();
  if (!existsSync(path)) {
    cache = {};
    cacheLoadedAt = now;
    return cache;
  }
  try {
    cache = JSON.parse(readFileSync(path, 'utf8')) as Record<string, EntityEntry>;
  } catch {
    cache = {};
  }
  cacheLoadedAt = now;
  return cache;
}

function save(entries: Record<string, EntityEntry>): void {
  const path = entitiesPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(entries, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}

function inferType(name: string): string {
  for (const [re, type] of KNOWN_TYPES) {
    if (re.test(name)) return type;
  }
  return 'other';
}

function canonical(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const CANDIDATE_RE =
  /\b((?:[A-Z][a-z]+){2,}|[A-Z][a-z]+[A-Z]\w+|[A-Z]{2,}[a-z]+|[a-z]+(?:-[a-z]+){1,}|[a-z][a-z0-9_]{4,}\.[a-z]{2,4})\b/g;

/**
 * Extract candidate entity surfaces from text. Conservative — prefers misses
 * over false positives.
 */
export function extractEntityCandidates(text: string): string[] {
  const seen = new Set<string>();
  CANDIDATE_RE.lastIndex = 0;
  for (let m = CANDIDATE_RE.exec(text); m !== null; m = CANDIDATE_RE.exec(text)) {
    const tok = m[1];
    if (tok.length < 3 || tok.length > 40) continue;
    seen.add(tok);
  }
  return [...seen].slice(0, 24);
}

/**
 * Register a candidate (or look up the existing key). Returns the canonical
 * `<type>:<key>` identifier.
 */
export function registerEntity(name: string, ts: string): string | null {
  const key = canonical(name);
  if (key.length < 3) return null;
  const entries = load();
  const existing = entries[key];
  if (existing) {
    if (!existing.surfaces.includes(name)) {
      existing.surfaces.push(name);
      save(entries);
    }
    return `${existing.type}:${existing.key}`;
  }
  const type = inferType(name);
  if (type === 'other' && !/[-_.]/.test(name) && !/[A-Z][a-z]+[A-Z]/.test(name)) {
    // Skip plain words without internal structure to avoid registering noise.
    return null;
  }
  entries[key] = {
    key,
    type,
    surfaces: [name],
    firstSeen: ts,
  };
  save(entries);
  return `${type}:${key}`;
}

export function lookupEntity(name: string): string | null {
  const key = canonical(name);
  const entries = load();
  const hit = entries[key];
  return hit ? `${hit.type}:${hit.key}` : null;
}

export function listEntities(): EntityEntry[] {
  return Object.values(load());
}

/**
 * Used by retrieval: given a free-text query, return the set of entity keys
 * referenced. Powers `data-cerveau-entity` CSS-selector expansion.
 */
export function resolveEntityKeysInQuery(query: string): string[] {
  const candidates = extractEntityCandidates(query);
  const out = new Set<string>();
  for (const c of candidates) {
    const key = lookupEntity(c);
    if (key) out.add(key);
  }
  // Also try the whole query as a single entity (handles short queries like "Postgres")
  const direct = lookupEntity(query.trim());
  if (direct) out.add(direct);
  return [...out];
}

/**
 * Build the HTML-attribute fragment listing all entities discovered in `text`.
 * Format: `data-cerveau-entities="db:postgres-prod,lib:react"`.
 * Side-effect: each new candidate is added to the persistent registry.
 */
export function discoverAndAnnotateEntities(
  text: string,
  ts: string,
): {
  attribute: string;
  keys: string[];
} {
  const candidates = extractEntityCandidates(text);
  const keys = new Set<string>();
  for (const c of candidates) {
    const k = registerEntity(c, ts);
    if (k) keys.add(k);
  }
  if (keys.size === 0) return { attribute: '', keys: [] };
  const sorted = [...keys].sort();
  const escaped = sorted
    .join(',')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return {
    attribute: ` data-cerveau-entities="${escaped}"`,
    keys: sorted,
  };
}

export function resetEntityCacheForTests(): void {
  cache = null;
  cacheLoadedAt = 0;
}
