#!/usr/bin/env node
/**
 * bench-determinism.mjs
 *
 * Verifies that a CSS-attribute structural query against the brain returns
 * byte-for-byte identical results on every run (proving determinism).
 *
 * Runs the same query N times, hashes each result, and asserts all hashes
 * match. Exits 0 on PASS, 1 on FAIL.
 *
 * Usage:
 *   node scripts/bench-determinism.mjs [--brain <path>] [--n <runs>] [--query <selector>]
 *
 * Brain path resolution:
 *   1. --brain <path>  explicit flag
 *   2. bundled examples/sample-brain (default — LAZYBRAIN_BRAIN_PATH is ignored)
 *
 * LAZYBRAIN_BRAIN_PATH and LAZYBRAIN_CACHE_PATH are intentionally IGNORED
 * so the benchmark always uses the bundled sample-brain and never accidentally
 * measures a user's private brain.
 *
 * Dependencies: Node >= 20 built-ins only (fs, crypto, path).
 * No external packages. node --check must pass.
 */

import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

// ─── Env leakage prevention ───────────────────────────────────────────────
delete process.env.LAZYBRAIN_BRAIN_PATH;
delete process.env.LAZYBRAIN_CACHE_PATH;

// ─── Brain path resolution ─────────────────────────────────────────────────

function resolveBrainDir() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const sampleBrain = resolve(join(scriptDir, "..", "examples", "sample-brain"));

  // Only the --brain flag can override (env vars are cleared above)
  const brainArgIdx = process.argv.indexOf("--brain");
  if (brainArgIdx !== -1 && process.argv[brainArgIdx + 1]) {
    return resolve(process.argv[brainArgIdx + 1]);
  }
  return sampleBrain;
}

function parseArg(flag, defaultValue) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return defaultValue;
}

const BRAIN_DIR = resolveBrainDir();
const NOTES_DIR = join(BRAIN_DIR, "notes");
const N_RUNS = parseInt(parseArg("--n", "10"), 10);
// Default query: all active (non-expired) concept-neurons — the canonical
// typed+temporal query that exercises data-cerveau-* attributes.
const DEFAULT_QUERY = '[data-cerveau-type="concept"]:not([data-cerveau-valid-until])';
const QUERY_SELECTOR = parseArg("--query", DEFAULT_QUERY);

// ─── Minimal CSS-attribute scanner ────────────────────────────────────────
// A dependency-free structural scan over raw HTML text.
// Implements a strict subset of CSS attribute selectors used by LazyBrain L1:
//   [attr="val"]          exact match on data-cerveau-* attributes
//   :not([attr])          attribute absent
//   [attr~="val"]         space-separated token match (for tags)
//
// Returns an array of plain-text representations of matching <article> blocks,
// sorted by the article's id attribute (deterministic order).

/**
 * Parse key=value attribute pairs from an opening <article ...> tag string.
 * Returns a Map of { attrName -> attrValue }.
 */
function parseAttrs(tag) {
  const attrs = new Map();
  const re = /(\w[\w-]*)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    attrs.set(name, value);
  }
  return attrs;
}

/**
 * Evaluate a single simple predicate against an attribute map.
 * Handles: [attr="val"], [attr~="val"], [attr] (presence), :not([attr]).
 */
function evalPredicate(pred, attrs) {
  // :not([attr]) — attribute must be absent
  const notAbsentRe = /^:not\(\[([^\]]+)\]\)$/;
  const notAbsentMatch = pred.match(notAbsentRe);
  if (notAbsentMatch) {
    return !attrs.has(notAbsentMatch[1].toLowerCase());
  }

  // [attr="val"] — exact match
  const exactRe = /^\[([^\]~=]+)="([^"]*)"\]$/;
  const exactMatch = pred.match(exactRe);
  if (exactMatch) {
    const [, attr, val] = exactMatch;
    return attrs.get(attr.toLowerCase()) === val;
  }

  // [attr~="val"] — space-separated token match
  const tokenRe = /^\[([^\]~=]+)~="([^"]*)"\]$/;
  const tokenMatch = pred.match(tokenRe);
  if (tokenMatch) {
    const [, attr, val] = tokenMatch;
    const stored = attrs.get(attr.toLowerCase()) ?? "";
    return stored.split(/\s+/).includes(val);
  }

  // [attr] — attribute presence
  const presenceRe = /^\[([^\]~=]+)\]$/;
  const presenceMatch = pred.match(presenceRe);
  if (presenceMatch) {
    return attrs.has(presenceMatch[1].toLowerCase());
  }

  // Unknown predicate — do not filter out (pass-through)
  return true;
}

/**
 * Split a compound selector string into individual predicates.
 * e.g. '[data-cerveau-type="concept"]:not([data-cerveau-valid-until])'
 *   -> ['[data-cerveau-type="concept"]', ':not([data-cerveau-valid-until])']
 */
function splitPredicates(selector) {
  const preds = [];
  // Match bracketed groups [...]  or :not([...])
  const re = /(:not\(\[[^\]]*\]\)|\[[^\]]*\])/g;
  let m;
  while ((m = re.exec(selector)) !== null) {
    preds.push(m[1]);
  }
  return preds;
}

/**
 * Scan all HTML note files in the brain and return matching article elements
 * as plain text, sorted by article id for deterministic output.
 */
async function runQuery(notesDir, selector) {
  const predicates = splitPredicates(selector);

  // Collect all .html files under notesDir recursively
  const htmlFiles = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".html")) {
        htmlFiles.push(full);
      }
    }
  }

  await walk(notesDir);
  htmlFiles.sort(); // sort file paths for deterministic file-level order

  const matches = [];

  for (const file of htmlFiles) {
    const content = await readFile(file, "utf8");

    // Extract all <article ...> opening tags
    const articleOpenRe = /<article([^>]*)>/g;
    let tagMatch;

    while ((tagMatch = articleOpenRe.exec(content)) !== null) {
      const tagStr = tagMatch[1];
      const attrs = parseAttrs(tagStr);

      const passes = predicates.every((pred) => evalPredicate(pred, attrs));
      if (!passes) continue;

      // Extract the full <article>...</article> block
      const startIdx = tagMatch.index;
      const endTag = "</article>";
      const endIdx = content.indexOf(endTag, startIdx);
      const block =
        endIdx === -1
          ? content.slice(startIdx)
          : content.slice(startIdx, endIdx + endTag.length);

      // Strip tags to plain text for the hash (normalise whitespace)
      const text = block
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const id = attrs.get("id") ?? file;
      matches.push({ id, text });
    }
  }

  // Sort by article id for byte-stable output regardless of file-scan order
  matches.sort((a, b) => a.id.localeCompare(b.id));
  return matches.map((m) => `[${m.id}] ${m.text}`).join("\n---\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const brainSource = process.argv.includes("--brain") ? "(--brain flag)" : "(bundled sample-brain)";
  console.log(`bench-determinism.mjs`);
  console.log(`  Brain : ${BRAIN_DIR} ${brainSource}`);
  console.log(`  Query : ${QUERY_SELECTOR}`);
  console.log(`  Runs  : ${N_RUNS}`);
  console.log();

  const hashes = [];
  const timings = [];

  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now();
    const result = await runQuery(NOTES_DIR, QUERY_SELECTOR);
    const elapsed = performance.now() - t0;
    timings.push(elapsed);

    const hash = createHash("sha256").update(result).digest("hex");
    hashes.push(hash);
    console.log(`  run ${String(i + 1).padStart(2, "0")}: ${hash}  (${elapsed.toFixed(1)} ms)`);
  }

  console.log();

  const allMatch = hashes.every((h) => h === hashes[0]);
  const avgMs = timings.reduce((a, b) => a + b, 0) / timings.length;

  if (allMatch) {
    console.log(`PASS — all ${N_RUNS} runs returned byte-identical results.`);
    console.log(`  SHA-256 : ${hashes[0]}`);
    console.log(`  avg     : ${avgMs.toFixed(1)} ms`);
    process.exit(0);
  } else {
    console.error(`FAIL — hashes diverged across ${N_RUNS} runs.`);
    const uniqueHashes = [...new Set(hashes)];
    uniqueHashes.forEach((h) => {
      const indices = hashes
        .map((x, i) => (x === h ? i + 1 : null))
        .filter(Boolean);
      console.error(`  ${h}  runs: ${indices.join(", ")}`);
    });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
