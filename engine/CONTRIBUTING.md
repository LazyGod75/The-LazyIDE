# Contributing to LazyBrain

Thank you for your interest in contributing. This document covers everything you need to go from zero to a passing pull request.

---

## Table of Contents

- [Development environment](#development-environment)
- [Build](#build)
- [Test](#test)
- [Typecheck](#typecheck)
- [Lint and format](#lint-and-format)
- [Running a local brain](#running-a-local-brain)
- [Branching and commits](#branching-and-commits)
- [Pull request expectations](#pull-request-expectations)
- [Code style](#code-style)

---

## Development environment

**Requirements:**

| Tool | Minimum version |
|------|----------------|
| Node.js | 20 |
| npm | bundled with Node 20 |
| git | any recent version |

**Setup:**

```bash
git clone https://github.com/LazyGod75/LazyBrain.git
cd LazyBrain
npm ci          # reproducible install from package-lock.json
```

`npm ci` is preferred over `npm install` for contributors because it never updates `package-lock.json` silently.

---

## Build

```bash
npm run build
```

This runs esbuild and writes the CLI entry point to `dist/bin/lazybrain.js`. The build must succeed with zero errors before any PR can be merged.

To test the built binary directly without linking globally:

```bash
node dist/bin/lazybrain.js --version
```

---

## Test

```bash
npm test              # run the full suite once (vitest run)
npm run test:watch    # watch mode during development
```

All tests live under `tests/`. New code must include tests. The project targets 80% line coverage minimum; do not submit a PR that drops coverage below that threshold.

When adding a feature or fixing a bug, follow the red-green-refactor cycle:

1. Write the test first — it must fail.
2. Write the minimal implementation to make it pass.
3. Refactor, keeping tests green.
4. Verify coverage.

---

## Typecheck

```bash
npm run typecheck   # tsc --noEmit, must report 0 errors
```

TypeScript strict mode is enabled. All new code must type-check cleanly before submission.

---

## Lint and format

```bash
npm run lint        # biome check src bin tests
npm run format      # biome format --write src bin tests
```

Biome is the single tool for both linting and formatting. Run `npm run format` before committing; the CI check will fail on formatting drift.

---

## Running a local brain

The full pipeline, following the Quick Start in README.md:

```bash
# 1. Initialize a new brain in your working directory
lazybrain init

# 2. Point commands at it
export LAZYBRAIN_BRAIN_PATH="$PWD/.lazybrain/brain"

# 3. Build
lazybrain dream --pretty        # ingest conversation history (tool-trace, no LLM)
lazybrain index-rebuild         # build the SQLite FTS5 index
lazybrain graph --pretty        # scan source code → file/module/project neurons
lazybrain enrich --pretty       # wire conversation knowledge onto file-neurons
lazybrain index-rebuild         # re-index the enriched brain

# 4. Use
lazybrain serve                 # wiki at http://127.0.0.1:4242
lazybrain search "topic" --top 5
lazybrain query 'article[data-cerveau-type="decision"]'
```

First run is slow (all conversations and files). Subsequent runs are incremental — SHA-256 fingerprints skip everything unchanged.

---

## Branching and commits

**Branch naming:**

```
feat/<short-description>
fix/<short-description>
refactor/<short-description>
docs/<short-description>
test/<short-description>
chore/<short-description>
perf/<short-description>
ci/<short-description>
```

**Commit message format (Conventional Commits):**

```
<type>: <imperative description in present tense>

<optional body — explain *why*, not *what*>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Examples:

```
feat: add incremental Vibe capture with per-transcript cursor
fix: guard out-of-order AGENTS.md markers
docs: add benchmark methodology and honest caveats
test: end-to-end dream ingestion over Vibe fixtures
```

Keep the subject line under 72 characters. Use the body to explain motivation and tradeoffs, not to restate the diff.

---

## Pull request expectations

Before opening a PR:

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm run lint` — 0 errors
- [ ] `npm test` — all tests pass
- [ ] `npm run build` — builds cleanly
- [ ] New behavior has tests
- [ ] No secrets, API keys, or private paths in any committed file
- [ ] Commit messages follow Conventional Commits

PR description should include:

1. **What** changed and **why**.
2. **How to test** — exact commands a reviewer can run.
3. **Breaking changes**, if any, called out explicitly.

Small, focused PRs are preferred over large ones. A PR that does one thing well is easier to review and faster to merge.

---

## Code style

**Language:** TypeScript with strict mode (`"strict": true`). No `any` without a comment explaining why it is unavoidable.

**File size:** 200–400 lines typical, 800 lines maximum. Extract cohesive units into separate files rather than growing a single file.

**Function size:** Under 50 lines. If a function is longer, split it.

**Nesting:** No more than 4 levels deep. Use early returns and extracted helpers to flatten logic.

**Immutability:** Never mutate input arguments or shared state. Always return new objects:

```typescript
// Wrong
function addTag(note: Note, tag: string): void {
  note.tags.push(tag);
}

// Correct
function addTag(note: Note, tag: string): Note {
  return { ...note, tags: [...note.tags, tag] };
}
```

**Error handling:** Handle errors explicitly at every level. Never silently swallow an error. Provide context in error messages (which file, which step, which input caused the failure).

**Input validation:** Validate at system boundaries — CLI flags, file contents, API responses. Fail fast with a clear message. Never trust external data.

**No hardcoded values:** Use constants, configuration, or environment variables. No hardcoded paths, no hardcoded secrets.

**Comments:** Explain *why*, not *what*. The code shows what; comments explain non-obvious reasoning, tradeoffs, or constraints.
