#!/usr/bin/env node
/**
 * bench-strip-html.mjs
 *
 * Generates HTML-generic format from LazyBrain Wave-1 neurons.
 * Strips all data-cerveau-* attributes and structured metadata, producing
 * plain HTML without schema knowledge — what an unaware system would store.
 * Output: bench/html-generic/*.html
 *
 * CORPUS DESIGN:
 *   Uses the SAME set of required + fill neurons as bench-html-to-md.mjs.
 *   Required neurons are the specific files that carry gold-answer content
 *   for each benchmark query, guaranteeing 1:1 corpus parity across all
 *   three formats (html-lazybrain, html-generic, markdown).
 *
 * Usage:
 *   node scripts/bench-strip-html.mjs [--brain <path>]
 *   LAZYBRAIN_BRAIN_PATH=/path/to/brain node scripts/bench-strip-html.mjs
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
const OUT_DIR = "bench/html-generic";
const MAX_FILES = 60;

// ─── REQUIRED neurons (must match bench-html-to-md.mjs exactly) ───────────
//
// These are the gold-answer carrier neurons for all five benchmark queries.
// Both fixture scripts use the SAME list to guarantee corpus parity.
// Includes both oracle neurons and neurons that retrieval paths actually return,
// so all three formats have equal opportunity on content-based P/R scoring.
//
const REQUIRED_FILENAMES = new Set([
  // Q1 — Acme architecture
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
  // Q5 — AdminPanel structure
  "aggregate-adminpanel-src-components.html",
  "aggregate-adminpanel-src-data.html",
  "aggregate-adminpanel-src-pages-activity.html",
  "aggregate-adminpanel-src-data-queries.html",
  "aggregate-adminpanel-src-pages-notifications.html",
  "aggregate-adminpanel-src-utils.html",
]);

// ─── Attribute stripper ─────────────────────────────────────────────────────

/**
 * Strip all LazyBrain-specific attributes from an HTML neuron.
 * Keeps structural HTML (tags, headings, sections) but removes all queryable
 * metadata (data-cerveau-*, data-code-*, data-section, class, role).
 * This is what a generic HTML retrieval system would store and search.
 */
function stripDataAttributes(html) {
  let result = html;
  // Remove all data-cerveau-* attributes (the queryable schema)
  result = result.replace(/\s+data-cerveau-[a-z-]+="[^"]*"/g, "");
  // Remove data-code-* attributes
  result = result.replace(/\s+data-code-[a-z-]+="[^"]*"/g, "");
  // Remove data-section attributes (keeps <section> tags but removes typed labels)
  result = result.replace(/\s+data-section="[^"]*"/g, "");
  // Remove interaction/ARIA metadata
  result = result.replace(/\s+data-q="[^"]*"/g, "");
  result = result.replace(/\s+data-primary="[^"]*"/g, "");
  result = result.replace(/\s+aria-[a-z-]+="[^"]*"/g, "");
  result = result.replace(/\s+aria-current="[^"]*"/g, "");
  result = result.replace(/\s+aria-expanded="[^"]*"/g, "");
  result = result.replace(/\s+aria-label="[^"]*"/g, "");
  // Remove JSON-LD metadata blocks
  result = result.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>\s*/g, "");
  // Strip class and role attributes
  result = result.replace(/\s+class="[^"]*"/g, "");
  result = result.replace(/\s+role="[^"]*"/g, "");
  // Simplify semantic elements to plain divs
  result = result.replace(/<nav[^>]*>/g, "<div>");
  result = result.replace(/<\/nav>/g, "</div>");
  result = result.replace(/<aside[^>]*>/g, "<div>");
  result = result.replace(/<\/aside>/g, "</div>");
  return result;
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
  const stripped = stripDataAttributes(content);
  await writeFile(join(OUT_DIR, filename), stripped, "utf8");
  processed++;
}

const requiredFound = required.length;
const requiredMissing = [...REQUIRED_FILENAMES].filter(
  (fn) => !neurons.some((n) => n.filename === fn),
);

console.log(`HTML-generic generated from Wave-1 neurons:`);
console.log(`  Required (gold-answer carriers):  ${requiredFound} files`);
if (requiredMissing.length > 0) {
  console.log(`  WARNING — required neurons not found in brain:`);
  for (const fn of requiredMissing) console.log(`    MISSING: ${fn}`);
}
console.log(`  Fill aggregate-neurons:           ${sampledAggregates.length} files`);
console.log(`  Fill concept-neurons:             ${sampledConcepts.length} files`);
console.log(`  Total: ${processed} files → ${OUT_DIR}/`);
console.log(`  Brain: ${BRAIN_DIR}`);
