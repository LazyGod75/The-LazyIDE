#!/usr/bin/env node
/**
 * bench-html-to-md.mjs
 *
 * Converts LazyBrain Wave-1 neurons to Obsidian-style Markdown.
 * Source: brain/notes/2026-05/*.html
 * Output: bench/markdown/*.md
 *
 * CORPUS DESIGN:
 *   The bench corpus is built in two passes:
 *     1. REQUIRED neurons — the specific files that contain the gold-answer content
 *        for each benchmark query. These are always included to guarantee the
 *        sampling-artifact is eliminated: every format contains the answer.
 *     2. FILL neurons — a diverse sample of additional aggregate-neurons and
 *        concept neurons up to MAX_FILES, to give each format a realistic
 *        volume (40-60 files).
 *
 *   Both bench-html-to-md.mjs and bench-strip-html.mjs use the SAME list
 *   of required + fill neurons, so all three comparison corpora (html-lazybrain,
 *   html-generic, markdown) are 1:1 conversions of identical source knowledge.
 *
 * Usage:
 *   node scripts/bench-html-to-md.mjs [--brain <path>]
 *   LAZYBRAIN_BRAIN_PATH=/path/to/brain node scripts/bench-html-to-md.mjs
 */

import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Brain path resolution ─────────────────────────────────────────────────

function resolveBrainDir() {
  // --brain CLI flag takes priority over env var (allows override in tests)
  const brainArgIdx = process.argv.indexOf("--brain");
  if (brainArgIdx !== -1 && process.argv[brainArgIdx + 1]) {
    return resolve(process.argv[brainArgIdx + 1]);
  }
  if (process.env.LAZYBRAIN_BRAIN_PATH) {
    return resolve(process.env.LAZYBRAIN_BRAIN_PATH);
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(join(scriptDir, "..", "examples", "sample-brain"));
}

const BRAIN_DIR = resolveBrainDir();
const NOTES_DIR = join(BRAIN_DIR, "notes");
const OUT_DIR = "bench/markdown";
const MAX_FILES = 60;

// ─── REQUIRED neurons (gold-answer carriers for each benchmark query) ──────
//
// These filenames MUST be in the bench corpus so the gold-answer content
// exists in all three formats and content-based P/R is meaningful.
//
// The list includes BOTH the oracle neurons (explicit answer sources) AND
// the additional neurons that each format's retrieval is expected to return,
// so all three corpora (html-lazybrain, html-generic, markdown) have equal
// opportunity to score on content-based gold phrase matching.
//
// Q1  Acme architecture      (aggregate-acme-root, aggregate-acme-acme, ...)
// Q2  Auth bugs              (concept-bug-*-auth-*)
// Q3  Build/cal bugs         (concept-bug-799-*, concept-bug-851-*, concept-bug-bug-critique-*)
// Q4  Stripe integration     (aggregate-acme-acme-app-stripe, aggregate-acme-acme-app)
// Q5  AdminPanel structure   (aggregate-adminpanel-src-*)
//
const REQUIRED_FILENAMES = new Set([
  // Q1 — Acme architecture
  // aggregate-acme-root is the project-level overview; all three formats must have it
  "aggregate-acme-root.html",
  "aggregate-acme-acme.html",
  "aggregate-acme-adminpanel-scripts.html",
  "aggregate-acme-content-pipeline-site-web-src-lib.html",
  // Q2 — Auth bugs and decisions
  "concept-bug-type-episodic-status-active-tags-auth-bug-frontend.html",
  "concept-bug-type-episodic-status-active-tags-auth-bug-performan.html",
  "concept-bug-type-episodic-status-active-tags-auth-database-test.html",
  // Q3 — Build and cal feature bugs
  "concept-bug-799-build-error-occurred.html",
  "concept-bug-851-error-command-npm-run-build-exited-with-1.html",
  "concept-bug-bug-critique-le-template-a-invent-un-url-scheduler-cal.html",
  // Q4 — Stripe integration
  "aggregate-acme-acme-app-stripe.html",
  "aggregate-acme-acme-app.html",
  // Q5 — AdminPanel structure (includes files LB actually returns for this query)
  "aggregate-adminpanel-src-components.html",
  "aggregate-adminpanel-src-data.html",
  "aggregate-adminpanel-src-pages-activity.html",
  "aggregate-adminpanel-src-data-queries.html",
  "aggregate-adminpanel-src-pages-notifications.html",
  "aggregate-adminpanel-src-utils.html",
]);

// ─── HTML helpers (pure regex — no DOM dependency) ─────────────────────────

function extractAttr(html, attrSuffix) {
  const m = html.match(new RegExp(`data-cerveau-${attrSuffix}="([^"]*)"`));
  return m ? m[1] : "";
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  return m ? stripTags(m[1]) : "";
}

function extractAllSections(html) {
  const re = /<section[^>]*data-section="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g;
  const sections = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const content = stripTags(m[2]).trim();
    if (content) sections.push({ name: m[1], content });
  }
  return sections;
}

// ─── Converter: HTML neuron → Obsidian Markdown ────────────────────────────

/**
 * Convert a Wave-1 HTML neuron to Obsidian-style whole-note Markdown.
 * Preserves ALL section content so the same knowledge is present in every
 * format — enabling content-based precision/recall measurement.
 */
function neuronToMarkdown(html, filename) {
  const id = extractAttr(html, "topic") || basename(filename, ".html");
  const type = extractAttr(html, "type");
  const tags = extractAttr(html, "tags");
  const created = extractAttr(html, "created");
  const confidence = extractAttr(html, "confidence");
  const topic = extractAttr(html, "topic");
  const title = extractH1(html);

  const tagList = tags
    ? tags
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  const sections = extractAllSections(html);
  const sectionsMd = sections
    .map(
      ({ name, content }) =>
        `## ${name.charAt(0).toUpperCase() + name.slice(1)}\n\n${content}`,
    )
    .join("\n\n");

  return `---
id: ${id}
type: ${type}
topic: ${topic}
created: ${created}
${confidence ? `confidence: ${confidence}` : ""}
tags: [${tagList.join(", ")}]
---

# ${title}

${sectionsMd}
`.trim();
}

// ─── Recursive directory walker ─────────────────────────────────────────────

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

// ─── Main ───────────────────────────────────────────────────────────────────

// Clear previous output (prevents stale files from old runs mixing with new ones)
await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const allHtml = await walkDir(NOTES_DIR, ".html");

const ACCEPTED_TYPES = new Set(["aggregate-neuron", "concept"]);

const neurons = [];
for (const filePath of allHtml) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    continue;
  }
  const typeMatch = content.match(/data-cerveau-type="([^"]*)"/);
  const nodeType = typeMatch ? typeMatch[1] : "";
  if (ACCEPTED_TYPES.has(nodeType)) {
    neurons.push({ filePath, content, nodeType, filename: basename(filePath) });
  }
}

// Pass 1: Required neurons (always included — gold-answer carriers)
const required = neurons.filter((n) => REQUIRED_FILENAMES.has(n.filename));
const requiredFilenames = new Set(required.map((n) => n.filename));

// Pass 2: Fill neurons — stable lexicographic selection, fully deterministic.
// Sort by filename so the result is identical regardless of filesystem order.
// Take the first N by lexicographic order (no Math.random, no step-sampling).
const fillNeurons = neurons.filter((n) => !requiredFilenames.has(n.filename));
const aggregates = fillNeurons
  .filter((n) => n.nodeType === "aggregate-neuron")
  .sort((a, b) => a.filename.localeCompare(b));
const concepts = fillNeurons
  .filter((n) => n.nodeType === "concept")
  .sort((a, b) => a.filename.localeCompare(b));

const fillSlots = MAX_FILES - required.length;
const aggSlots = Math.ceil(fillSlots * 0.6);
const conSlots = fillSlots - aggSlots;

const sampledAggregates = aggregates.slice(0, aggSlots);
const sampledConcepts = concepts.slice(0, conSlots);

const sample = [...required, ...sampledAggregates, ...sampledConcepts].slice(0, MAX_FILES);

let processed = 0;
for (const { filePath, content } of sample) {
  const filename = basename(filePath);
  const md = neuronToMarkdown(content, filename);
  const outName = filename.replace(".html", ".md");
  await writeFile(join(OUT_DIR, outName), md, "utf8");
  processed++;
}

const requiredFound = required.length;
const requiredMissing = [...REQUIRED_FILENAMES].filter(
  (fn) => !neurons.some((n) => n.filename === fn),
);

console.log(`Markdown (Obsidian-style) generated from Wave-1 neurons:`);
console.log(`  Required (gold-answer carriers):  ${requiredFound} files`);
if (requiredMissing.length > 0) {
  console.log(`  WARNING — required neurons not found in brain:`);
  for (const fn of requiredMissing) console.log(`    MISSING: ${fn}`);
}
console.log(`  Fill aggregate-neurons:           ${sampledAggregates.length} files`);
console.log(`  Fill concept-neurons:             ${sampledConcepts.length} files`);
console.log(`  Total: ${processed} files → ${OUT_DIR}/`);
console.log(`  Brain: ${BRAIN_DIR}`);
