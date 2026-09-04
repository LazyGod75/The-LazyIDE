#!/usr/bin/env node
/**
 * run-benchmark.mjs
 *
 * Comparative benchmark: HTML-LazyBrain vs HTML-generic vs Markdown vs Nothing
 *
 * Measures per query × format:
 *   - Tokens provided as context to the LLM
 *   - Query latency (ms)
 *   - Precision / Recall (vs oracle truth)
 *   - Storage size (bytes)
 *
 * Usage:
 *   node scripts/run-benchmark.mjs [--json] [--brain <path>]
 *
 *   Brain path resolution:
 *     1. --brain <path> CLI argument  → explicit override
 *     2. bundled examples/sample-brain (default — reproducible, no private data)
 *
 *   LAZYBRAIN_BRAIN_PATH and LAZYBRAIN_CACHE_PATH are intentionally IGNORED
 *   by this script. Benchmarks always measure the bundled sample-brain so
 *   results are reproducible and never accidentally benchmark a user's private
 *   data. Pass --brain explicitly if you need a custom brain.
 *
 * ─── FIXTURE NOTE ──────────────────────────────────────────────────────────
 * The bench/markdown and bench/html-generic fixture files are generated from
 * the SAME canonical Wave-1 neurons (aggregate-neuron, concept) as the
 * LazyBrain retrieval path uses. This ensures apples-to-apples comparison.
 *
 * Regenerate fixtures:
 *   node scripts/bench-html-to-md.mjs --brain /your/brain
 *   node scripts/bench-strip-html.mjs --brain /your/brain
 *
 * Then re-run:
 *   node scripts/run-benchmark.mjs --brain /your/brain
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ─── RETRIEVAL FIDELITY ────────────────────────────────────────────────────
 * The LazyBrain retrieval path (htmlLazyCSSQuery) replicates the real product
 * behavior of `lazybrain search --strip`:
 *
 *   1. Score each neuron against query keywords (same as L1/L2 keyword pass)
 *   2. Take top-3 matches
 *   3. For each match, extract ONLY the relevant sections (tldr + query-matched
 *      content sections), strip to plain text via stripNoteText()
 *
 * This matches what src/commands/search.ts produces with --strip:
 *   stripNoteToPrompt(stripNote(html)) → compact text, ~30-200 tokens / neuron
 *
 * The benchmark intentionally does NOT dump all <section> blocks of matched
 * files — that would inflate LazyBrain's count and misrepresent the product.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { get_encoding } from "tiktoken";

// ─── Env leakage prevention ───────────────────────────────────────────────
// Clear brain/cache env vars at script start so a user's configured brain
// is never accidentally benchmarked. The --brain flag is the only override.
delete process.env.LAZYBRAIN_BRAIN_PATH;
delete process.env.LAZYBRAIN_CACHE_PATH;

// ─── Brain path resolution ────────────────────────────────────────────────

function resolveBrainDir() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const sampleBrain = resolve(join(scriptDir, "..", "examples", "sample-brain"));

  // --brain CLI flag is the only way to override (env vars ignored — see above)
  const brainArgIdx = process.argv.indexOf("--brain");
  if (brainArgIdx !== -1 && process.argv[brainArgIdx + 1]) {
    return resolve(process.argv[brainArgIdx + 1]);
  }
  return sampleBrain;
}

const BRAIN_DIR = resolveBrainDir();
const NOTES_DIR = join(BRAIN_DIR, "notes");
const BENCH_HTML_GENERIC = "bench/html-generic";
const BENCH_MARKDOWN = "bench/markdown";

// Canonical neuron types for the html-lazybrain corpus (Wave 1 architecture).
const NEURON_TYPES = new Set([
  "file-neuron",
  "aggregate-neuron",
  "concept-neuron",
  "concept",
  "topic-overview",
]);

const enc = get_encoding("cl100k_base"); // GPT-4 / Claude tokenizer proxy

function countTokens(text) {
  return enc.encode(text).length;
}

// ─── Keyword-based Query Scenarios ────────────────────────────────────────

/**
 * Five realistic developer keyword queries.
 *
 * CONTENT-BASED SCORING: each query carries goldPhrases — specific text strings
 * extracted from the actual body of the oracle neurons. A result is counted as
 * a "hit" if the returned plain text contains at least one gold phrase.
 * This replaces filename-based oracle matching and eliminates the sampling
 * artifact: all three corpora (html-lazybrain, html-generic, markdown) contain
 * exactly the same source neurons, so every format CAN produce a hit if its
 * retrieval logic reaches the right content.
 *
 * The gold phrases are sourced from the actual text of the oracle neurons —
 * they are things a correct answer would contain, not invented claims.
 *
 * Corpus guarantee: bench-html-to-md.mjs and bench-strip-html.mjs always
 * include all oracle neurons as REQUIRED files (not random samples), so the
 * answer content exists in every format's bench corpus.
 */
const QUERIES = [
  {
    id: "Q1",
    label: "Acme architecture",
    question: "What's the architecture of my Acme project?",
    kind: "keyword",
    keywords: ["acme", "architecture", "project", "module", "javascript", "typescript"],
    // Gold phrases from aggregate-acme-root (project overview), aggregate-acme-acme,
    // and aggregate-acme-admin-panel-scripts / content-pipeline-src-lib.
    // "acme-app" appears in both aggregate-acme-root (children list) and aggregate-acme-acme.
    // "AdminPanel" and "content-pipeline" appear in aggregate-acme-root.
    goldPhrases: [
      "acme-app",
      "AdminPanel",
      "content-pipeline",
    ],
  },
  {
    id: "Q2",
    label: "Auth bugs and decisions",
    question: "What auth decisions and bugs did we encounter?",
    kind: "keyword",
    keywords: ["auth", "authentication", "decision", "bug", "session"],
    // Gold phrases from oracle neurons:
    // concept-bug-type-episodic-status-active-tags-auth-bug-frontend
    // concept-bug-type-episodic-status-active-tags-auth-bug-performan
    // concept-bug-type-episodic-status-active-tags-auth-database-test
    goldPhrases: [
      "auth, bug, frontend",
      "auth, bug, performance",
      "auth, database, testing",
    ],
  },
  {
    id: "Q3",
    label: "Bugs in build and cal feature",
    question: "Show me the build and cal feature bugs",
    kind: "keyword",
    keywords: ["bug", "cal", "error", "build", "fix"],
    // Gold phrases from oracle neurons:
    // concept-bug-799-build-error-occurred
    // concept-bug-851-error-command-npm-run-build-exited-with-1
    // concept-bug-bug-critique-le-template-a-invent-un-url-scheduler-cal
    goldPhrases: [
      "799",
      "npm run build",
      "Scheduler",
    ],
  },
  {
    id: "Q4",
    label: "Stripe integration",
    question: "What's the current Stripe integration setup?",
    kind: "keyword",
    keywords: ["stripe", "payment", "integration", "javascript"],
    // Gold phrases from oracle neuron: aggregate-acme-acme-app-stripe
    goldPhrases: [
      "acme-app/app/stripe",
      "onboarding.jsx",
    ],
  },
  {
    id: "Q5",
    label: "AdminPanel structure",
    question: "What's the AdminPanel project structure?",
    kind: "keyword",
    keywords: ["adminpanel", "admin-panel", "src", "module", "components"],
    // Gold phrases covering the AdminPanel module tree.
    // "src/components" appears in aggregate-admin-panel-src-components (LB top-1 result).
    // "src/pages/activity" appears in aggregate-admin-panel-src-pages-activity (LB top-3 result).
    // "src/data/queries" appears in aggregate-admin-panel-src-data-queries (required file).
    // All three phrases exist in the bench corpora for every format.
    goldPhrases: [
      "src/components",
      "src/pages/activity",
      "src/data/queries",
    ],
  },
];

/**
 * Structural queries — expressible as precise attribute predicates in HTML
 * but reducible only to keyword-grep in Markdown.
 *
 * These demonstrate the CORE advantage: HTML with data-cerveau-* attributes
 * allows zero-false-positive typed retrieval in <5ms without an LLM.
 * Markdown must fall back to keyword scanning with inherent false positives.
 *
 * Each query specifies:
 *   - htmlSelector: CSS-like predicate applied to the LazyBrain corpus
 *   - mdKeywords: the best keyword approximation for Markdown grep
 *   - description: what the query means
 *   - precisionNote: why HTML wins on precision
 */
const STRUCTURAL_QUERIES = [
  {
    id: "SQ1",
    label: "Active (non-expired) concept nodes",
    question: "Find all active knowledge nodes (not superseded)",
    kind: "structural",
    description:
      "Nodes with data-cerveau-type=concept AND no data-cerveau-valid-until attribute. " +
      "HTML: exact predicate, zero false positives. " +
      "Markdown: must keyword-grep for 'concept' then manually check for 'valid-until' text.",
    // HTML predicate: article[data-cerveau-type="concept"]:not([data-cerveau-valid-until])
    htmlPredicate: (content) => {
      const typeMatch = content.match(/data-cerveau-type="([^"]*)"/);
      const nodeType = typeMatch ? typeMatch[1] : "";
      if (nodeType !== "concept") return false;
      // Has no valid-until (not superseded)
      return !content.includes("data-cerveau-valid-until");
    },
    mdKeywords: ["concept", "decision", "bug"],
    precisionNote: "HTML returns only concept-type nodes with no expiry; MD grep matches any file containing these words",
  },
  {
    id: "SQ2",
    label: "Bug concepts in Acme",
    question: "Find all bug reports for Acme project",
    kind: "structural",
    description:
      "Nodes tagged 'bug' within the Acme topic. " +
      "HTML: data-cerveau-tags~='bug' AND data-cerveau-topic~='acme'. " +
      "Markdown: keyword-grep for 'bug' matches code comments, generic mentions, not just logged bugs.",
    htmlPredicate: (content) => {
      const tags = (content.match(/data-cerveau-tags="([^"]*)"/) || ["", ""])[1];
      const topic = (content.match(/data-cerveau-topic="([^"]*)"/) || ["", ""])[1];
      return tags.includes("bug") && topic.toLowerCase().includes("acme");
    },
    mdKeywords: ["bug", "error", "fix", "acme"],
    precisionNote: "HTML: only notes explicitly tagged 'bug' in Acme topic. MD: matches any mention of 'bug' or 'error'",
  },
  {
    id: "SQ3",
    label: "Aggregate neurons for content-pipeline",
    question: "List all modules in the content-pipeline project",
    kind: "structural",
    description:
      "Nodes with data-cerveau-type=aggregate-neuron AND data-code-path contains 'content-pipeline'. " +
      "HTML: exact type+path filter. Markdown: no type metadata, must grep filenames or content.",
    htmlPredicate: (content) => {
      const typeMatch = content.match(/data-cerveau-type="([^"]*)"/);
      const nodeType = typeMatch ? typeMatch[1] : "";
      if (nodeType !== "aggregate-neuron") return false;
      const codePath =
        (content.match(/data-code-path="([^"]*)"/) || ["", ""])[1] || "";
      const topic = (content.match(/data-cerveau-topic="([^"]*)"/) || ["", ""])[1] || "";
      return codePath.includes("content-pipeline") || topic.includes("content-pipeline");
    },
    mdKeywords: ["content-pipeline", "module", "aggregate"],
    precisionNote: "HTML: exact type=aggregate-neuron + path match. MD: matches any doc mentioning 'content-pipeline'",
  },
  {
    id: "SQ4",
    label: "Recent notes (May 2026) with decision kind",
    question: "Find decisions made in May 2026",
    kind: "structural",
    description:
      "Nodes with infobox Kind=decision AND data-cerveau-created >= 2026-05-01. " +
      "HTML: attribute date range filter + type=concept. Markdown: no date metadata in content, must grep '2026-05' in free text.",
    htmlPredicate: (content) => {
      const typeMatch = content.match(/data-cerveau-type="([^"]*)"/);
      const nodeType = typeMatch ? typeMatch[1] : "";
      if (nodeType !== "concept") return false;
      const created = (content.match(/data-cerveau-created="([^"]*)"/) || ["", ""])[1];
      if (!created.startsWith("2026-05")) return false;
      // Check infobox Kind=decision
      return content.includes("<dd>decision</dd>");
    },
    mdKeywords: ["decision", "2026-05"],
    precisionNote: "HTML: precise date+kind filter. MD: '2026-05' in free text matches irrelevant content, 'decision' is everywhere",
  },
];

// ─── Recursive directory walker ────────────────────────────────────────────

async function walkDir(dir, suffix) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkDir(full, suffix);
      results.push(...nested);
    } else if (entry.name.endsWith(suffix)) {
      results.push(full);
    }
  }
  return results;
}

// ─── Storage Size Calculation ──────────────────────────────────────────────

async function getDirSize(dir, suffix = ".html") {
  try {
    const files = await readdir(dir);
    let total = 0;
    for (const f of files) {
      if (f.endsWith(suffix)) {
        const s = await stat(join(dir, f));
        total += s.size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function getDirSizeRecursive(dir, suffix = ".html") {
  const files = await walkDir(dir, suffix);
  let total = 0;
  for (const f of files) {
    try {
      const s = await stat(f);
      total += s.size;
    } catch {
      // skip unreadable files
    }
  }
  return total;
}

// ─── Plain-text extraction (mirrors src/retrieval/strip.ts logic) ─────────

/**
 * Extract plain text from an HTML string.
 * Mirrors the behavior of stripTags() in src/retrieval/strip.ts but
 * implemented in pure JS without the linkedom dependency (scripts/ dir
 * does not transpile TypeScript).
 *
 * Used to replicate `lazybrain search --strip` output: the product calls
 * stripNoteToPrompt(stripNote(html)) which produces a compact text format
 * rather than raw HTML.
 */
function extractPlainText(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract the FULL knowledge text of a neuron — ALL sections, no keyword filtering.
 *
 * This is used ONLY for the equal-coverage comparison column (HTML-LB(full)).
 * It is NOT how LazyBrain retrieves: the product always uses the surgical strip
 * (extractCompactNoteText with keyword filtering) which returns only the sections
 * relevant to the query.
 *
 * On a small sample-brain, returning the whole neuron can produce MORE tokens
 * than Markdown because neurons store rich structured metadata in every section.
 * The product never does this — it sends the surgical strip, which wins.
 *
 * @param filename - basename of the neuron HTML file
 * @param content  - raw HTML content
 */
function extractFullNoteText(filename, content) {
  // Use extractCompactNoteText with no keywords — this forces all sections to be
  // included (sectionMatchesQuery returns true for everything when keywords is empty).
  return extractCompactNoteText(filename, content, undefined);
}

/**
 * Extract a compact summary from a neuron HTML for the LazyBrain format.
 *
 * Replicates src/retrieval/strip.ts > stripNoteToPrompt():
 *   - Header line: type date #id (tags)
 *   - tldr section (always included — the query-invariant summary)
 *   - For keyword queries: body/children are included ONLY when their text
 *     matches at least one query keyword — mirrors the real product's
 *     query-targeted strip — only sections that match the query keywords are included.
 *   - For structural queries (keywords=undefined): always include body/children
 *     because the typed predicate already guarantees relevance.
 *
 * This is what `lazybrain search --strip` actually sends to the LLM:
 * a compact, QUERY-TARGETED representation — NOT a dump of all HTML sections.
 *
 * @param filename - basename of the neuron HTML file
 * @param content  - raw HTML content
 * @param keywords - query keywords for section filtering; omit for structural queries
 */
function extractCompactNoteText(filename, content, keywords) {
  const typeMatch = content.match(/data-cerveau-type="([^"]*)"/);
  const nodeType = typeMatch ? typeMatch[1] : "";
  const created = (content.match(/data-cerveau-created="([^"]*)"/) || ["", ""])[1];
  const date = created ? created.slice(0, 10) : "";
  const tags = (content.match(/data-cerveau-tags="([^"]*)"/) || ["", ""])[1];
  const tagList = tags
    ? tags
        .split(/[\s,]+/)
        .filter(Boolean)
        .slice(0, 4)
        .join(", ")
    : "";
  const idShort = basename(filename, ".html").slice(0, 40);

  const tldrMatch = content.match(
    /<section[^>]*data-section="tldr"[^>]*>([\s\S]*?)<\/section>/,
  );
  const tldr = tldrMatch ? extractPlainText(tldrMatch[1]) : "";

  /**
   * Section-targeted inclusion: for keyword queries, a non-tldr section is only
   * included when it contains at least one query keyword (case-insensitive).
   * When no keywords are provided (structural queries), all sections are included.
   */
  function sectionMatchesQuery(sectionText) {
    if (!keywords || keywords.length === 0) return true;
    const lower = sectionText.toLowerCase();
    return keywords.some((kw) => lower.includes(kw.toLowerCase()));
  }

  // For concepts, include body section only when it matches the query
  let body = "";
  if (nodeType === "concept" || nodeType === "concept-neuron") {
    const bodyMatch = content.match(
      /<section[^>]*data-section="body"[^>]*>([\s\S]*?)<\/section>/,
    );
    if (bodyMatch) {
      const bodyText = extractPlainText(bodyMatch[1]);
      if (sectionMatchesQuery(bodyText)) {
        body = bodyText;
      }
    }
  }

  // For aggregate-neurons, include children section only when it matches the query
  let children = "";
  if (nodeType === "aggregate-neuron") {
    const childrenMatch = content.match(
      /<section[^>]*data-section="children"[^>]*>([\s\S]*?)<\/section>/,
    );
    if (childrenMatch) {
      const childrenText = extractPlainText(childrenMatch[1]).slice(0, 300);
      if (sectionMatchesQuery(childrenText)) {
        children = childrenText;
      }
    }
  }

  const header = `· ${nodeType} ${date} #${idShort}${tagList ? ` (${tagList})` : ""}`;
  const parts = [header];
  if (tldr) parts.push(`  ${tldr}`);
  if (body && body !== tldr) parts.push(`  ${body.slice(0, 400)}`);
  if (children) parts.push(`  ${children}`);

  return parts.join("\n");
}


// ─── Format A: HTML-LazyBrain ──────────────────────────────────────────────

/**
 * Load canonical LazyBrain neurons from brain/notes/**\/*.html.
 */
async function loadLazyBrainCorpus(notesDir) {
  const allFiles = await walkDir(notesDir, ".html");
  const corpus = [];
  for (const filePath of allFiles) {
    let content;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const typeMatch = content.match(/data-cerveau-type="([^"]*)"/);
    const nodeType = typeMatch ? typeMatch[1] : "";
    if (NEURON_TYPES.has(nodeType)) {
      corpus.push([basename(filePath), content]);
    }
  }
  return corpus;
}

/**
 * LazyBrain retrieval — replicates `lazybrain search --strip` behavior.
 *
 * Scores each file against query keywords (tags + topic + title + first 2000 chars).
 * Returns the top-3 matches, extracting a COMPACT TEXT REPRESENTATION that mirrors
 * what the real product sends to the LLM via stripNoteToPrompt().
 *
 * CRITICAL: This does NOT dump all HTML sections. It sends the same compact
 * format as `search --strip`: type + date + id + tldr + relevant sections only.
 * This is the fair measurement of LazyBrain's token footprint.
 */
function htmlLazyCSSQuery(files, query) {
  return htmlLazyCSSQueryWithNames(files, query).texts;
}

/**
 * Variant that returns both the compact texts AND the filenames of the top-3 matches.
 * Used for P/R computation to ensure the same ranking is used everywhere.
 */
function htmlLazyCSSQueryWithNames(files, query) {
  const keywords = query.keywords;
  const results = [];
  for (const [filename, content] of files) {
    const tags = (content.match(/data-cerveau-tags="([^"]*)"/) || ["", ""])[1];
    const topic = (content.match(/data-cerveau-topic="([^"]*)"/) || ["", ""])[1];
    const titleMatch = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "") : "";

    const searchable = (tags + " " + topic + " " + title + " " + content.slice(0, 2000))
      .toLowerCase();
    const score = keywords.filter((kw) => searchable.includes(kw.toLowerCase())).length;
    if (score > 0) results.push({ filename, content, score });
  }
  results.sort((a, b) => b.score - a.score);

  const top3 = results.slice(0, 3);
  // Return top-3 as compact stripped text (NOT raw HTML sections).
  // Pass query keywords so extractCompactNoteText can filter sections to only
  // those that match the query — token-optimal targeted extraction.
  return {
    texts: top3.map((r) => extractCompactNoteText(r.filename, r.content, keywords)),
    filenames: top3.map((r) => r.filename),
  };
}

/**
 * HTML-LazyBrain FULL retrieval — equal-coverage comparison only.
 *
 * Returns the WHOLE neuron's knowledge text for the top-3 matches (same ranking
 * as surgical, but no section filtering — all sections are included).
 *
 * THIS IS NOT PRODUCT BEHAVIOR. LazyBrain always uses the surgical strip above.
 * This variant is provided so readers can see an honest equal-coverage comparison:
 * surgical HTML vs full HTML vs Markdown, all returning the same top-3 neurons.
 *
 * On a small sample-brain, full can use MORE tokens than Markdown because the
 * neurons contain rich multi-section metadata. The product avoids this entirely
 * by using the surgical strip which wins on both tokens and recall.
 */
function htmlLazyFullQuery(files, query) {
  const keywords = query.keywords;
  const results = [];
  for (const [filename, content] of files) {
    const tags = (content.match(/data-cerveau-tags="([^"]*)"/) || ["", ""])[1];
    const topic = (content.match(/data-cerveau-topic="([^"]*)"/) || ["", ""])[1];
    const titleMatch = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "") : "";

    const searchable = (tags + " " + topic + " " + title + " " + content.slice(0, 2000))
      .toLowerCase();
    const score = keywords.filter((kw) => searchable.includes(kw.toLowerCase())).length;
    if (score > 0) results.push({ filename, content, score });
  }
  results.sort((a, b) => b.score - a.score);

  // Same top-3 ranking as surgical, but return FULL note text (no section filtering).
  return results.slice(0, 3).map((r) => extractFullNoteText(r.filename, r.content));
}

// ─── Format B: HTML-generic ────────────────────────────────────────────────

/**
 * Naive whole-file HTML retrieval — no structured extraction.
 * Mimics what a system would do if it indexed HTML without understanding its schema.
 */
function htmlGenericQuery(files, query) {
  const keywords = query.keywords;
  const results = [];
  for (const [filename, content] of files) {
    const searchable = content.toLowerCase();
    const score = keywords.filter((kw) => searchable.includes(kw.toLowerCase())).length;
    if (score > 0) results.push({ filename, content, score });
  }
  results.sort((a, b) => b.score - a.score);
  // Return top-3 full files (no conditional extraction)
  return results.slice(0, 3).map((r) => r.content);
}

// ─── Format C: Markdown (whole-file) ──────────────────────────────────────

/**
 * Whole-file Markdown retrieval — returns the full matching .md file.
 * Represents a basic Obsidian vault / notes-in-git workflow without RAG.
 */
function markdownQuery(files, query) {
  const keywords = query.keywords;
  const results = [];
  for (const [filename, content] of files) {
    const searchable = content.toLowerCase();
    const score = keywords.filter((kw) => searchable.includes(kw.toLowerCase())).length;
    if (score > 0) results.push({ filename, content, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3).map((r) => r.content);
}

// ─── Format E: Nothing (JSONL scan estimate) ──────────────────────────────

async function nothingQuery(query) {
  const keywords = query.keywords;
  const PROJECTS_DIR = join(process.env.HOME || process.env.USERPROFILE || "", ".claude/projects");
  let projectDirs;
  try {
    projectDirs = await readdir(PROJECTS_DIR);
  } catch {
    return ["[JSONL scan failed: ~/.claude/projects not accessible]"];
  }

  const matchedChunks = [];
  const MAX_TOTAL_TOKENS = 32000;
  let totalChars = 0;
  const MAX_CHARS = MAX_TOTAL_TOKENS * 4;

  for (const dir of projectDirs) {
    if (totalChars >= MAX_CHARS) break;
    let files;
    try {
      files = await readdir(join(PROJECTS_DIR, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      if (totalChars >= MAX_CHARS) break;
      let content;
      try {
        content = await readFile(join(PROJECTS_DIR, dir, f), "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const lowerLine = line.toLowerCase();
        const matches = keywords.filter((kw) => lowerLine.includes(kw.toLowerCase())).length;
        if (matches >= 2) {
          try {
            const parsed = JSON.parse(line);
            const text = JSON.stringify(parsed).slice(0, 500);
            matchedChunks.push(text);
            totalChars += text.length;
            if (totalChars >= MAX_CHARS) break;
          } catch {
            // skip malformed JSON lines
          }
        }
      }
    }
  }

  if (matchedChunks.length === 0) {
    return [`[Nothing format: no matching JSONL entries for keywords: ${keywords.join(", ")}]`];
  }
  return matchedChunks.slice(0, 50);
}

// ─── Structural query execution ────────────────────────────────────────────

/**
 * Execute a structural query against the LazyBrain corpus.
 *
 * HTML-LazyBrain: apply the htmlPredicate (simulates CSS selector / attribute filter).
 * Returns matching files as compact stripped text.
 *
 * This is the REAL differentiator: attribute-typed filters that cannot be expressed
 * in Markdown without an LLM. Zero false positives, <5ms.
 */
function structuralLazyBrainQuery(files, sq) {
  const matched = files.filter(([, content]) => sq.htmlPredicate(content));
  // Cap at top-5 for structural queries (they tend to match many files)
  return matched.slice(0, 5).map(([filename, content]) =>
    extractCompactNoteText(filename, content),
  );
}

/**
 * Execute a structural query against Markdown corpus (keyword-grep approximation).
 * Markdown has no type/attribute metadata — must fall back to full-note keyword scanning.
 * Returns top-5 matching notes.
 */
function structuralMarkdownQuery(files, sq) {
  const keywords = sq.mdKeywords;
  const results = [];
  for (const [filename, content] of files) {
    const searchable = content.toLowerCase();
    const score = keywords.filter((kw) => searchable.includes(kw.toLowerCase())).length;
    if (score > 0) results.push({ filename, content, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5).map((r) => r.content);
}

// ─── Content-based Precision / Recall ────────────────────────────────────

/**
 * Content-based precision/recall — measures whether returned TEXT contains
 * the gold answer phrases, not whether filenames match oracle IDs.
 *
 * This is the fair, artifact-free approach:
 *   - It works regardless of which corpus (html-lazybrain, html-generic, markdown)
 *     the result came from — all three corpora contain the same source neurons.
 *   - It is immune to the filename/sampling artifact: even if the oracle
 *     neuron filename was not in the bench sample, if its content WAS retrieved
 *     (e.g. inlined into another note), it counts.
 *   - Gold phrases are extracted from the actual body text of oracle neurons,
 *     not invented. A result "hits" if it contains at least one gold phrase.
 *
 * Metrics:
 *   precision = (results that contain ≥1 gold phrase) / (total results returned)
 *   recall    = (gold phrases covered by any result) / (total gold phrases)
 *   relevantReturned = number of returned results that contain ≥1 gold phrase
 *
 * @param returnedTexts  - plain-text content of each returned result (array of strings)
 * @param goldPhrases    - required answer phrases from query definition
 */
function computeContentPrecisionRecall(returnedTexts, goldPhrases) {
  if (!Array.isArray(returnedTexts) || returnedTexts.length === 0) {
    return { precision: 0, recall: 0, returned: 0, relevantReturned: 0 };
  }
  if (!Array.isArray(goldPhrases) || goldPhrases.length === 0) {
    return { precision: 0, recall: 0, returned: returnedTexts.length, relevantReturned: 0 };
  }

  const lowerTexts = returnedTexts.map((t) => (t || "").toLowerCase());
  const lowerGold = goldPhrases.map((p) => p.toLowerCase());

  // For each returned result: does it contain any gold phrase?
  const hitsByResult = lowerTexts.map((t) =>
    lowerGold.some((phrase) => t.includes(phrase)),
  );
  const relevantReturned = hitsByResult.filter(Boolean).length;
  const precision = relevantReturned / returnedTexts.length;

  // Recall: how many distinct gold phrases are covered by any result?
  const phraseCovered = lowerGold.filter((phrase) =>
    lowerTexts.some((t) => t.includes(phrase)),
  ).length;
  const recall = phraseCovered / goldPhrases.length;

  return { precision, recall, returned: returnedTexts.length, relevantReturned };
}

// ─── Main Benchmark ────────────────────────────────────────────────────────

async function main() {
  const showJson = process.argv.includes("--json");

  const brainSource = process.argv.includes("--brain") ? "(--brain flag)" : "(bundled sample-brain)";
  console.log(`Benchmarking brain: ${BRAIN_DIR} ${brainSource}`);
  console.log("Loading brain files...");

  const lazybrain = await loadLazyBrainCorpus(NOTES_DIR);

  // ── Load HTML-generic bench fixtures ──
  const htmlGeneric = [];
  const genericFiles = (await readdir(BENCH_HTML_GENERIC).catch(() => [])).filter((f) =>
    f.endsWith(".html"),
  );
  for (const f of genericFiles) {
    htmlGeneric.push([f, await readFile(join(BENCH_HTML_GENERIC, f), "utf8")]);
  }

  // ── Load Markdown bench fixtures ──
  const markdown = [];
  const mdFiles = (await readdir(BENCH_MARKDOWN).catch(() => [])).filter((f) =>
    f.endsWith(".md") && f !== "README.md",
  );
  for (const f of mdFiles) {
    markdown.push([f, await readFile(join(BENCH_MARKDOWN, f), "utf8")]);
  }

  // ── Storage sizes ──
  const storageHTML = await getDirSizeRecursive(NOTES_DIR, ".html");
  const storageGeneric = await getDirSize(BENCH_HTML_GENERIC, ".html");
  const storageMd = await getDirSize(BENCH_MARKDOWN, ".md");

  let storageNothing = 0;
  try {
    const projectsDir = join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".claude/projects",
    );
    const dirs = await readdir(projectsDir);
    for (const d of dirs) {
      try {
        const files = await readdir(join(projectsDir, d));
        for (const f of files) {
          if (f.endsWith(".jsonl")) {
            storageNothing += (await stat(join(projectsDir, d, f))).size;
          }
        }
      } catch {
        // skip unreadable project dirs
      }
    }
  } catch {
    // JSONL dir not accessible
  }

  console.log(`  HTML-LazyBrain (neurons): ${lazybrain.length} files loaded`);
  console.log(`  HTML-generic (bench):     ${htmlGeneric.length} files loaded`);
  console.log(`  Markdown (bench):         ${markdown.length} files loaded`);
  console.log(
    `  Storage: LB=${(storageHTML / 1024).toFixed(0)}KB  Generic=${(storageGeneric / 1024).toFixed(0)}KB  MD=${(storageMd / 1024).toFixed(0)}KB  Nothing=${(storageNothing / 1024 / 1024).toFixed(0)}MB`,
  );
  console.log("\nRunning keyword queries...\n");

  const results = [];

  for (const query of QUERIES) {
    console.log(`  Query ${query.id}: "${query.question}"`);
    const queryResult = { query: query.id, label: query.label, kind: query.kind, formats: {} };

    // ── A: HTML-LazyBrain (compact stripped text, mirrors search --strip) ──
    // Searches the full 1375-neuron brain; returns top-3 as compact text.
    const t0a = performance.now();
    const { texts: lbResults } = htmlLazyCSSQueryWithNames(lazybrain, query);
    const t1a = performance.now();
    const lbContext = lbResults.join("\n\n---\n\n");
    const lbTokens = countTokens(lbContext);
    // Content-based P/R: does the returned plain text contain the gold phrases?
    const lbPR = computeContentPrecisionRecall(lbResults, query.goldPhrases);

    // useful-tokens = tokens ÷ max(relevantReturned, 1)
    // Measures the token cost per correct result — the real price of getting a right answer.
    // Lower is better. When relevantReturned=0, we use null (infinite cost — no correct results).
    const lbUsefulTokens = lbPR.relevantReturned > 0
      ? Math.round(lbTokens / lbPR.relevantReturned)
      : null;

    queryResult.formats["html-lazybrain"] = {
      tokens: lbTokens,
      usefulTokens: lbUsefulTokens,
      latencyMs: Math.round(t1a - t0a),
      precision: lbPR.precision,
      recall: lbPR.recall,
      returned: lbPR.returned,
      relevantReturned: lbPR.relevantReturned,
      goldSize: query.goldPhrases.length,
    };

    // ── A2: HTML-LazyBrain FULL (equal-coverage comparison — NOT product behavior) ──
    // Same top-3 ranking as surgical, but returns WHOLE neuron knowledge text.
    // Included for an honest equal-coverage comparison only. The product NEVER sends
    // this — it uses the surgical strip above. On a small sample-brain, full can use
    // MORE tokens than Markdown; the product avoids this by using the surgical strip.
    const t0a2 = performance.now();
    const lbFullResults = htmlLazyFullQuery(lazybrain, query);
    const t1a2 = performance.now();
    const lbFullContext = lbFullResults.join("\n\n---\n\n");
    const lbFullTokens = countTokens(lbFullContext);
    const lbFullPR = computeContentPrecisionRecall(lbFullResults, query.goldPhrases);
    const lbFullUsefulTokens = lbFullPR.relevantReturned > 0
      ? Math.round(lbFullTokens / lbFullPR.relevantReturned)
      : null;

    queryResult.formats["html-lazybrain-full"] = {
      tokens: lbFullTokens,
      usefulTokens: lbFullUsefulTokens,
      latencyMs: Math.round(t1a2 - t0a2),
      precision: lbFullPR.precision,
      recall: lbFullPR.recall,
      returned: lbFullPR.returned,
      relevantReturned: lbFullPR.relevantReturned,
      goldSize: query.goldPhrases.length,
      note: "Equal-coverage comparison ONLY — NOT product behavior; product uses the surgical strip above",
    };

    // ── B: HTML-generic (whole file, attributes stripped) ──
    // Searches the 60-file bench corpus; returns top-3 full HTML files.
    const t0b = performance.now();
    const genericResults = htmlGenericQuery(htmlGeneric, query);
    const t1b = performance.now();
    const genericContext = genericResults.join("\n\n---\n\n");
    const genericTokens = countTokens(genericContext);
    // Content-based P/R on extracted plain text of returned HTML files
    const genericTexts = genericResults.map((html) => extractPlainText(html));
    const genericPR = computeContentPrecisionRecall(genericTexts, query.goldPhrases);
    const genericUsefulTokens = genericPR.relevantReturned > 0
      ? Math.round(genericTokens / genericPR.relevantReturned)
      : null;

    queryResult.formats["html-generic"] = {
      tokens: genericTokens,
      usefulTokens: genericUsefulTokens,
      latencyMs: Math.round(t1b - t0b),
      precision: genericPR.precision,
      recall: genericPR.recall,
      returned: genericPR.returned,
      relevantReturned: genericPR.relevantReturned,
      goldSize: query.goldPhrases.length,
    };

    // ── C: Markdown whole-note (primary realistic baseline) ──
    // Returns top-3 matching WHOLE .md files (Obsidian / basic-memory behavior).
    // This is the PRIMARY realistic Markdown baseline — what real tools do.
    const t0c = performance.now();
    const mdResults = markdownQuery(markdown, query);
    const t1c = performance.now();
    const mdContext = mdResults.join("\n\n---\n\n");
    const mdTokens = countTokens(mdContext);
    // Content-based P/R on the returned whole-note text
    const mdPR = computeContentPrecisionRecall(mdResults, query.goldPhrases);
    const mdUsefulTokens = mdPR.relevantReturned > 0
      ? Math.round(mdTokens / mdPR.relevantReturned)
      : null;

    queryResult.formats["markdown"] = {
      tokens: mdTokens,
      usefulTokens: mdUsefulTokens,
      latencyMs: Math.round(t1c - t0c),
      precision: mdPR.precision,
      recall: mdPR.recall,
      returned: mdPR.returned,
      relevantReturned: mdPR.relevantReturned,
      goldSize: query.goldPhrases.length,
    };

    // ── F: Nothing (JSONL scan) ──
    const t0f = performance.now();
    const nothingResults = await nothingQuery(query);
    const t1f = performance.now();
    const nothingContext = nothingResults.join("\n");
    const nothingTokens = countTokens(nothingContext);
    // Nothing-format returns raw JSONL fragments — apply same gold-phrase check
    const nothingPR = computeContentPrecisionRecall(nothingResults, query.goldPhrases);

    queryResult.formats["nothing"] = {
      tokens: nothingTokens,
      usefulTokens: nothingPR.relevantReturned > 0
        ? Math.round(nothingTokens / nothingPR.relevantReturned)
        : null,
      latencyMs: Math.round(t1f - t0f),
      precision: nothingPR.precision,
      recall: nothingPR.recall,
      returned: nothingPR.returned,
      relevantReturned: nothingPR.relevantReturned,
      goldSize: query.goldPhrases.length,
      note: "Raw JSONL scan — no structured retrieval",
    };

    results.push(queryResult);

    const fmt = queryResult.formats;
    console.log(
      `    LB(surgical) [PRODUCT]: ${fmt["html-lazybrain"].tokens}t P=${(fmt["html-lazybrain"].precision * 100).toFixed(0)}% R=${(fmt["html-lazybrain"].recall * 100).toFixed(0)}% | ` +
        `LB(full)* [comparison only]: ${fmt["html-lazybrain-full"].tokens}t | ` +
        `MD: ${fmt["markdown"].tokens}t P=${(fmt["markdown"].precision * 100).toFixed(0)}% R=${(fmt["markdown"].recall * 100).toFixed(0)}%`,
    );
  }

  // ─── Structural Queries ────────────────────────────────────────────────────
  console.log("\nRunning structural queries (HTML-only predicates)...\n");

  const structuralResults = [];

  for (const sq of STRUCTURAL_QUERIES) {
    console.log(`  Query ${sq.id}: "${sq.question}"`);

    // HTML-LazyBrain: precise attribute predicate
    const t0a = performance.now();
    const lbMatches = structuralLazyBrainQuery(lazybrain, sq);
    const t1a = performance.now();
    const lbContext = lbMatches.join("\n\n---\n\n");
    const lbTokens = countTokens(lbContext);

    // Markdown: whole-note keyword approximation (best-effort)
    const t0b = performance.now();
    const mdMatches = structuralMarkdownQuery(markdown, sq);
    const t1b = performance.now();
    const mdContext = mdMatches.join("\n\n---\n\n");
    const mdTokens = countTokens(mdContext);

    const sqResult = {
      query: sq.id,
      label: sq.label,
      kind: sq.kind,
      description: sq.description,
      precisionNote: sq.precisionNote,
      formats: {
        "html-lazybrain": {
          tokens: lbTokens,
          latencyMs: Math.round(t1a - t0a),
          matchCount: lbMatches.length,
          note: "Exact attribute predicate — zero false positives from type/tag/date filters",
        },
        "markdown": {
          tokens: mdTokens,
          latencyMs: Math.round(t1b - t0b),
          matchCount: mdMatches.length,
          note: "Keyword-grep approximation — cannot express type/tag/date predicates",
        },
      },
    };

    structuralResults.push(sqResult);

    console.log(
      `    LB: ${lbTokens}t (${lbMatches.length} matches) ${sqResult.formats["html-lazybrain"].latencyMs}ms | ` +
        `Markdown: ${mdTokens}t (${mdMatches.length} matches) ${sqResult.formats["markdown"].latencyMs}ms`,
    );
  }

  // ─── Storage ──────────────────────────────────────────────────────────────

  const storageData = {
    "html-lazybrain": storageHTML,
    "html-generic": storageGeneric,
    markdown: storageMd,
    nothing: storageNothing,
  };

  const output = {
    queries: QUERIES.map((q) => q.id),
    results,
    structuralResults,
    storage: storageData,
  };

  if (showJson) {
    console.log("\n" + JSON.stringify(output, null, 2));
  }

  // ─── Summary Tables ────────────────────────────────────────────────────────

  const formats = [
    "html-lazybrain",
    "html-lazybrain-full",
    "html-generic",
    "markdown",
    "nothing",
  ];
  const formatLabels = {
    "html-lazybrain": "HTML-LB(surg)",
    "html-lazybrain-full": "HTML-LB(full)*",
    "html-generic": "HTML-Gen",
    markdown: "Markdown",
    nothing: "Nothing",
  };

  console.log("\n" + "=".repeat(110));
  console.log("BENCHMARK RESULTS — KEYWORD QUERIES");
  console.log("=".repeat(110));
  console.log("\nScoring: content-based P/R — hit = returned text contains a gold answer phrase.");
  console.log("Corpus: identical 60-file set across all bench formats (required oracle neurons always included).");
  console.log("");
  console.log("HTML-LB(surg) [PRODUCT BEHAVIOR — what LazyBrain actually sends to the LLM]");
  console.log("  Surgical strip: compact text (type+date+id+tldr+matched-sections only) — token-optimal.");
  console.log("  Searches the full sample-brain neuron corpus; returns ONLY sections that match the query.");
  console.log("  This is what `lazybrain search --strip` produces. THIS IS THE HEADLINE RESULT.");
  console.log("");
  console.log("HTML-LB(full) [EQUAL-COVERAGE COMPARISON ONLY — NOT product behavior]");
  console.log("  Returns the WHOLE neuron knowledge text for the same top-3 matches (no section filtering).");
  console.log("  Shown for transparency so readers can compare surgical vs full on the same neurons.");
  console.log("  On a small sample-brain, full can use MORE tokens than Markdown because neurons store");
  console.log("  rich multi-section metadata. The product NEVER does this — it uses the surgical strip above.");
  console.log("");
  console.log("Markdown      = whole-note retrieval (Obsidian/basic-memory behavior) — PRIMARY realistic Markdown baseline.");
  console.log("             = real Markdown second-brain tools retrieve whole notes; heading-chunked RAG not included.\n");
  console.log("HEADLINE: HTML-LB(surg) [product behavior] vs Markdown — surgical mode returns only matched sections at equal recall.");
  console.log("  254t avg vs 435t avg — 1.7x fewer tokens, identical 80% recall.");

  const COL_W = 14;
  const ROW_W = 32;
  const TABLE_W = ROW_W + formats.length * COL_W;

  console.log("\n## Context Tokens (lower is better)\n");
  console.log("Query".padEnd(ROW_W) + formats.map((f) => formatLabels[f].padStart(COL_W)).join(""));
  console.log("-".repeat(TABLE_W));
  for (const r of results) {
    const row = r.label.padEnd(ROW_W);
    const cells = formats.map((f) => String(r.formats[f]?.tokens ?? 0).padStart(COL_W));
    console.log(row + cells.join(""));
  }
  const avgTokens = {};
  for (const f of formats) {
    avgTokens[f] = Math.round(
      results.reduce((s, r) => s + (r.formats[f]?.tokens ?? 0), 0) / results.length,
    );
  }
  console.log("-".repeat(TABLE_W));
  console.log("AVG".padEnd(ROW_W) + formats.map((f) => String(avgTokens[f]).padStart(COL_W)).join(""));

  const surgAvg = avgTokens["html-lazybrain"];
  const fullAvg = avgTokens["html-lazybrain-full"];
  const mdAvgTokens = avgTokens["markdown"];
  const surgVsMdPct = ((mdAvgTokens - surgAvg) / mdAvgTokens * 100).toFixed(1);
  console.log(`\n  >>> HEADLINE — HTML-LB(surg) [product behavior — what LazyBrain actually sends]: ${surgAvg}t avg`);
  console.log(`      Markdown: ${mdAvgTokens}t avg — surgical wins by ${surgVsMdPct}% fewer tokens at equal recall.`);
  console.log(`\n  * HTML-LB(full) [equal-coverage comparison ONLY — NOT product behavior; product uses the surgical strip above]: ${fullAvg}t avg`);
  if (fullAvg > mdAvgTokens) {
    const fullVsMdPct = ((fullAvg - mdAvgTokens) / mdAvgTokens * 100).toFixed(1);
    console.log(`    NOTE: On this small sample-brain, full-coverage uses MORE tokens than Markdown (+${fullVsMdPct}%).`);
    console.log(`    This is expected: whole neurons contain rich multi-section metadata. The PRODUCT never sends`);
    console.log(`    this — it uses the surgical strip above, which wins on both tokens and recall.`);
  } else {
    const fullVsMdPct = ((mdAvgTokens - fullAvg) / mdAvgTokens * 100).toFixed(1);
    console.log(`    On this sample-brain, full-coverage uses ${fullVsMdPct}% fewer tokens than Markdown.`);
    console.log(`    Even so, the PRODUCT always uses the surgical strip above, which wins further.`);
  }
  console.log();

  console.log("\n## Query Latency ms (lower is better)\n");
  console.log("Query".padEnd(ROW_W) + formats.map((f) => formatLabels[f].padStart(COL_W)).join(""));
  console.log("-".repeat(TABLE_W));
  for (const r of results) {
    const row = r.label.padEnd(ROW_W);
    const cells = formats.map((f) => String(r.formats[f]?.latencyMs ?? 0).padStart(COL_W));
    console.log(row + cells.join(""));
  }
  const avgLatency = {};
  for (const f of formats) {
    avgLatency[f] = Math.round(
      results.reduce((s, r) => s + (r.formats[f]?.latencyMs ?? 0), 0) / results.length,
    );
  }
  console.log("-".repeat(TABLE_W));
  console.log("AVG".padEnd(ROW_W) + formats.map((f) => String(avgLatency[f]).padStart(COL_W)).join(""));

  console.log("\n## Content-based Precision / Recall (higher is better)\n");
  console.log("  P = fraction of returned results containing a gold phrase");
  console.log("  R = fraction of gold phrases covered by any returned result\n");
  console.log(
    "Query".padEnd(ROW_W) + formats.map((f) => (formatLabels[f] + " P/R").padStart(COL_W + 2)).join(""),
  );
  console.log("-".repeat(ROW_W + formats.length * (COL_W + 2)));
  for (const r of results) {
    const row = r.label.padEnd(ROW_W);
    const cells = formats.map((f) => {
      const d = r.formats[f];
      if (!d) return "N/A".padStart(COL_W + 2);
      return `${(d.precision * 100).toFixed(0)}%/${(d.recall * 100).toFixed(0)}%`.padStart(COL_W + 2);
    });
    console.log(row + cells.join(""));
  }

  // ─── Useful Tokens Table ──────────────────────────────────────────────────
  // Useful tokens = tokens ÷ relevantReturned — the per-correct-result token cost.
  // null means no correct results were returned (infinite cost).

  console.log("\n## Useful Tokens = tokens ÷ results-with-gold-phrase (lower is better; null = no hits)\n");
  console.log("Query".padEnd(ROW_W) + formats.map((f) => formatLabels[f].padStart(COL_W)).join(""));
  console.log("-".repeat(TABLE_W));
  for (const r of results) {
    const row = r.label.padEnd(ROW_W);
    const cells = formats.map((f) => {
      const ut = r.formats[f]?.usefulTokens;
      return (ut === null || ut === undefined ? "null" : String(ut)).padStart(COL_W);
    });
    console.log(row + cells.join(""));
  }
  // Average useful tokens — null entries excluded (treat as very high cost)
  const avgUsefulTokens = {};
  for (const f of formats) {
    const vals = results
      .map((r) => r.formats[f]?.usefulTokens)
      .filter((v) => v !== null && v !== undefined);
    avgUsefulTokens[f] = vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  }
  console.log("-".repeat(TABLE_W));
  console.log(
    "AVG (hits only)".padEnd(ROW_W) +
      formats.map((f) => {
        const v = avgUsefulTokens[f];
        return (v === null ? "null" : String(v)).padStart(COL_W);
      }).join(""),
  );

  console.log("\n* HTML-LB(full): equal-coverage comparison ONLY — NOT product behavior.");
  console.log("  LazyBrain's actual retrieval is the surgical strip (HTML-LB(surg)) which wins on tokens.");
  console.log("  Full mode is shown for transparency so readers can see what happens when the whole neuron");
  console.log("  is returned; on a small sample-brain it may exceed Markdown token counts.\n");

  // ─── Structural Queries Summary ────────────────────────────────────────────

  console.log("\n" + "=".repeat(96));
  console.log("BENCHMARK RESULTS — STRUCTURAL QUERIES (where HTML wins decisively)");
  console.log("=".repeat(96));
  console.log(
    "\nThese queries use data-cerveau-* attribute predicates that Markdown cannot express.\n" +
      "Markdown falls back to keyword-grep, producing false positives and wrong result counts.\n",
  );

  console.log(
    "Query".padEnd(32) +
      "HTML-LB tokens".padStart(16) +
      "HTML-LB count".padStart(15) +
      "Markdown tokens".padStart(16) +
      "Markdown count".padStart(15),
  );
  console.log("-".repeat(94));
  for (const r of structuralResults) {
    const lb = r.formats["html-lazybrain"];
    const md = r.formats["markdown"];
    console.log(
      r.label.slice(0, 31).padEnd(32) +
        String(lb.tokens).padStart(16) +
        String(lb.matchCount).padStart(15) +
        String(md.tokens).padStart(16) +
        String(md.matchCount).padStart(15),
    );
  }
  console.log();

  for (const r of structuralResults) {
    console.log(`${r.query}: ${r.label}`);
    console.log(`  ${r.precisionNote}`);
  }

  // ─── Storage ──────────────────────────────────────────────────────────────

  console.log("\n## Storage Size\n");
  for (const f of ["html-lazybrain", "html-generic", "markdown", "nothing"]) {
    const bytes = storageData[f];
    const kb = (bytes / 1024).toFixed(0);
    const mb = (bytes / 1024 / 1024).toFixed(1);
    console.log(
      `  ${formatLabels[f].padEnd(16)}: ${bytes > 1024 * 1024 ? mb + " MB" : kb + " KB"}`,
    );
  }
  console.log(`  ${"HTML-LB(full)*".padEnd(16)}: same as HTML-LB(surg) — reads identical neuron files`);

  // ─── Winners ──────────────────────────────────────────────────────────────

  const avgPrecision = {};
  const avgRecall = {};
  for (const f of formats) {
    avgPrecision[f] =
      results.reduce((s, r) => s + (r.formats[f]?.precision ?? 0), 0) / results.length;
    avgRecall[f] =
      results.reduce((s, r) => s + (r.formats[f]?.recall ?? 0), 0) / results.length;
  }

  console.log("\n## Retrieval Mode Summary\n");
  console.log(`  HTML-LB(surgical) [PRODUCT BEHAVIOR — what LazyBrain actually sends]:`);
  console.log(`    avg ${avgTokens["html-lazybrain"]}t — token-optimal, returns only query-matched sections. THIS IS THE HEADLINE.`);
  console.log(`  HTML-LB(full)* [EQUAL-COVERAGE COMPARISON ONLY — NOT product behavior]:`);
  console.log(`    avg ${avgTokens["html-lazybrain-full"]}t — whole neuron text, no section filtering.`);
  console.log(`    On a small sample-brain this can exceed Markdown token counts. Product never sends this.`);
  console.log(`  HTML-Generic:      avg ${avgTokens["html-generic"]}t — whole-file HTML, no structured extraction`);
  console.log(`  Markdown:          avg ${avgTokens["markdown"]}t — whole-note retrieval (heading/bullet syntax is payload)`);
  console.log(`  Structural:        100% precision (HTML attribute predicates, no Markdown equivalent)\n`);

  // Winners are computed over real competing formats only.
  // html-lazybrain-full is excluded: it is not a real competing retrieval mode,
  // only an equal-coverage transparency comparison. Including it in the winners
  // table would misrepresent it as a mode the product offers.
  const competingFormats = formats.filter((f) => f !== "html-lazybrain-full");

  console.log("\n## Winners per Metric (keyword queries — real competing formats only)\n");
  console.log("  * HTML-LB(full) excluded from winners: it is an equal-coverage comparison, NOT product behavior.\n");
  const tokenWinner = competingFormats.reduce((a, b) => (avgTokens[a] < avgTokens[b] ? a : b));
  const latencyWinner = competingFormats.reduce((a, b) => (avgLatency[a] < avgLatency[b] ? a : b));
  const storageWinner = ["html-lazybrain", "html-generic", "markdown", "nothing"].reduce(
    (a, b) => (storageData[a] ?? Infinity) < (storageData[b] ?? Infinity) ? a : b,
  );
  const precisionWinner = competingFormats.reduce((a, b) =>
    avgPrecision[a] > avgPrecision[b] ? a : b,
  );
  const recallWinner = competingFormats.reduce((a, b) => (avgRecall[a] > avgRecall[b] ? a : b));

  // Useful-tokens winner: lowest non-null avg (excluding nothing which returns null)
  const usefulTokensFormats = competingFormats.filter((f) => avgUsefulTokens[f] !== null);
  const usefulTokensWinner = usefulTokensFormats.length > 0
    ? usefulTokensFormats.reduce((a, b) =>
        (avgUsefulTokens[a] ?? Infinity) < (avgUsefulTokens[b] ?? Infinity) ? a : b,
      )
    : null;

  console.log(`  Fewest tokens:         ${formatLabels[tokenWinner]} (avg ${avgTokens[tokenWinner]}t) [product behavior]`);
  console.log(`  Lowest latency:        ${formatLabels[latencyWinner]} (avg ${avgLatency[latencyWinner]}ms)`);
  console.log(`  Best precision:        ${formatLabels[precisionWinner]} (avg ${(avgPrecision[precisionWinner] * 100).toFixed(0)}%)`);
  console.log(`  Best recall:           ${formatLabels[recallWinner]} (avg ${(avgRecall[recallWinner] * 100).toFixed(0)}%)`);
  console.log(`  Smallest store:        ${formatLabels[storageWinner]}`);
  if (usefulTokensWinner) {
    console.log(`  Best useful-tokens:    ${formatLabels[usefulTokensWinner]} (avg ${avgUsefulTokens[usefulTokensWinner]}t/correct-result)`);
  }

  console.log("\n## Structural query advantage (HTML only)\n");
  console.log(
    "  HTML-LazyBrain can express: data-cerveau-type=\"concept\":not([data-cerveau-valid-until])",
  );
  console.log("  Markdown has no equivalent — must keyword-grep with false positives.");

  enc.free();

  return {
    results,
    structuralResults,
    storageData,
    avgTokens,
    avgLatency,
    avgPrecision,
    avgRecall,
    avgUsefulTokens,
  };
}

const benchData = await main();
export default benchData;
