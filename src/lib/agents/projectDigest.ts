/* projectDigest.ts — Structural project digest for the LazyManager's
 * `scan_project` grounding action.
 *
 * PURPOSE (see qa-manager-2026-07-25/UC-SCORECARD.md, use cases D/E): before
 * this module existed the manager had no way to measure a project's size or
 * shape — it could only guess how many agents a request needed. This module
 * gives it a compact, deterministic, read-only STRUCTURAL fact sheet (stack,
 * scripts, test presence, top-level shape, rough surface/volume counts, git
 * activity) so it can size a plan instead of guessing.
 *
 * HARD RULES (all enforced below, never relaxed by a caller):
 *   - Never calls an LLM, never launches a mission, never reads file CONTENT
 *     beyond a small, fixed set of manifest files (package.json) whose
 *     content is used ONLY to derive structured facts (scripts, deps) — the
 *     digest itself never quotes file bodies.
 *   - Bounded in size: the returned text is hard-capped (900 chars for
 *     'quick', 2500 for 'deep' — see BUDGETS) and any cap that trims real
 *     data says so explicitly rather than silently dropping it.
 *   - Bounded in time and directory count (BUDGETS.deadlineMs / maxDirs):
 *     a pathological tree (huge monorepo, symlink cycle) degrades to
 *     "here is what I found before the budget ran out", never hangs.
 *   - Never walks into artifact/dependency directories (node_modules,
 *     target, dist, .git, ...) — see isIgnoredDir.
 *
 * REUSE, NOT NEW PLUMBING: every filesystem/git/code-index read below goes
 * through the pre-existing Platform primitives (src/lib/platform/types.ts —
 * FileSystem.readDir/readFile, Git.status/log, CodeGraphPlatform.listRepos),
 * the SAME primitives the Code tab, the brain indexer, and the codegraph
 * pipeline already use (see src/lib/platform/tauri.ts's nativeCodeGraph.index,
 * which threads its own readDir/readFile the same DI way this module's
 * `buildProjectDigest(root, platform, opts)` does). No Rust command, no new
 * Tauri invoke, no new IPC surface was added for this feature.
 *
 * `platform` is a narrowed slice of the real `Platform` type (only the 3
 * methods actually used) so callers — and unit tests — can pass either the
 * real `getPlatform()` result or a small hand-written fake, whichever fits.
 */

import type { DirEntry, FileSystem, Git, CodeGraphPlatform } from '../platform/types.js';
import { joinPath, basename, stripVerbatimPrefix } from '../paths.js';

export type ScanDepth = 'quick' | 'deep';

/** Narrowed platform slice this module actually needs — see file header. */
export interface ProjectDigestPlatform {
  fs: Pick<FileSystem, 'readDir' | 'readFile'>;
  git: Pick<Git, 'status' | 'log'>;
  codegraph: Pick<CodeGraphPlatform, 'listRepos'>;
}

export interface ProjectDigestOptions {
  depth?: ScanDepth;
}

export interface ProjectDigest {
  /** The compact, bounded digest text — safe to inject into a prompt as-is. */
  text: string;
  /** True when any real data was omitted/capped to stay within budget
   *  (directory/file walk stopped early, char cap trimmed the tail, or a
   *  sub-probe — git/codegraph — timed out). The digest TEXT itself always
   *  states what was truncated; this flag is a machine-readable summary of
   *  the same fact for callers that want to log/test it without parsing
   *  prose. */
  truncated: boolean;
  charCount: number;
  /** True when `root` could not be scanned at all (empty path, or the
   *  directory does not exist / is not readable) — `text` explains why. */
  notFound: boolean;
}

interface ScanBudget {
  /** Hard cap on the number of directories actually `readDir`'d. This is the
   *  operative limit in practice (wins over maxDepth on any wide tree). */
  maxDirs: number;
  /** Safety-valve recursion cap — guards against a pathological (e.g.
   *  symlink-cycle) tree independently of maxDirs/deadline. */
  maxDepth: number;
  deadlineMs: number;
  maxCharsFinal: number;
  topDirsShown: number;
}

const BUDGETS: Record<ScanDepth, ScanBudget> = {
  quick: { maxDirs: 80, maxDepth: 6, deadlineMs: 2500, maxCharsFinal: 900, topDirsShown: 8 },
  deep: { maxDirs: 600, maxDepth: 12, deadlineMs: 7000, maxCharsFinal: 2500, topDirsShown: 20 },
};

// ── Ignore list — artifact/dependency/VCS directories never walked ───────
// Any dot-prefixed directory is ALSO skipped generically (.git, .lazy,
// .next, .turbo, .cache, .venv, .claude, ...) — these are overwhelmingly
// tooling/output, never a project's own authored surface, and skipping the
// whole category (rather than naming every tool's cache dir individually)
// keeps this list generic across ecosystems instead of hardcoding one
// project's layout.
const IGNORED_DIR_NAMES = new Set([
  'node_modules', 'target', 'dist', 'build', 'out', 'coverage', 'vendor',
  '__pycache__', 'venv', 'env',
]);

function isIgnoredDir(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIR_NAMES.has(name.toLowerCase());
}

// ── Surface / test heuristics (generic — no project-specific names) ──────

const SURFACE_DIR_NAMES = new Set([
  'pages', 'routes', 'route', 'api', 'endpoints', 'migrations', 'commands', 'controllers', 'handlers',
]);
const TEST_DIR_NAMES = new Set(['__tests__', 'tests', 'test', '__test__']);
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const COMPONENT_EXT = new Set(['tsx', 'jsx', 'vue', 'svelte']);

function extname(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '(none)';
  return name.slice(idx + 1).toLowerCase();
}

// ── Bounded BFS walk ───────────────────────────────────────────────────────

interface WalkState {
  filesTotal: number;
  dirsVisited: number;
  /** Per-immediate-child-of-root file/dir counts (for the "top-level shape"
   *  section) — keyed by the first path segment under root. */
  perTopDir: Map<string, { files: number; dirs: number }>;
  extCounts: Map<string, number>;
  surfaceHits: number;
  componentFiles: number;
  testFiles: number;
  /** Bare file names seen directly under `root` (depth 0) — used for
   *  manifest/lockfile detection without a second readDir call. */
  rootFileNames: Set<string>;
  truncated: boolean;
}

function emptyWalkState(): WalkState {
  return {
    filesTotal: 0,
    dirsVisited: 0,
    perTopDir: new Map(),
    extCounts: new Map(),
    surfaceHits: 0,
    componentFiles: 0,
    testFiles: 0,
    rootFileNames: new Set(),
    truncated: false,
  };
}

async function walk(
  readDir: (path: string) => Promise<DirEntry[]>,
  root: string,
  budget: ScanBudget,
  deadlineAtMs: number,
  state: WalkState,
): Promise<void> {
  const queue: Array<{ path: string; depth: number; topDir: string | null }> = [
    { path: root, depth: 0, topDir: null },
  ];

  while (queue.length > 0) {
    if (Date.now() >= deadlineAtMs || state.dirsVisited >= budget.maxDirs) {
      state.truncated = true;
      break;
    }
    const current = queue.shift();
    if (!current) break;
    const { path, depth, topDir } = current;

    let entries: DirEntry[];
    try {
      entries = await readDir(path);
    } catch {
      // Unreadable subdirectory (permissions, race with a delete) — degrade
      // by skipping it, never throw out of the whole scan for one bad dir.
      state.truncated = true;
      continue;
    }
    state.dirsVisited += 1;

    // path is root at depth 0 (typically get_project_root's canonicalize()
    // result, verbatim-\\?\-prefixed on Windows) — strip that prefix before
    // segmenting or the leading "?" segment would sit in segmentsLower
    // without ever matching a real dir name (see paths.ts's header for this
    // bug class's history).
    const segmentsLower = stripVerbatimPrefix(path).split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
    const inSurfaceDir = segmentsLower.some((s) => SURFACE_DIR_NAMES.has(s));
    const inTestDir = segmentsLower.some((s) => TEST_DIR_NAMES.has(s));

    for (const entry of entries) {
      if (entry.isDir) {
        if (isIgnoredDir(entry.name)) continue;
        const nextTopDir = topDir ?? entry.name;
        const bucket = state.perTopDir.get(nextTopDir) ?? { files: 0, dirs: 0 };
        bucket.dirs += 1;
        state.perTopDir.set(nextTopDir, bucket);
        if (depth + 1 <= budget.maxDepth) {
          queue.push({ path: entry.path, depth: depth + 1, topDir: nextTopDir });
        } else {
          state.truncated = true;
        }
      } else {
        if (depth === 0) state.rootFileNames.add(entry.name);
        state.filesTotal += 1;
        const topKey = topDir ?? '(root)';
        const bucket = state.perTopDir.get(topKey) ?? { files: 0, dirs: 0 };
        bucket.files += 1;
        state.perTopDir.set(topKey, bucket);

        const ext = extname(entry.name);
        state.extCounts.set(ext, (state.extCounts.get(ext) ?? 0) + 1);
        if (inTestDir || TEST_FILE_RE.test(entry.name)) state.testFiles += 1;
        if (inSurfaceDir) state.surfaceHits += 1;
        if (COMPONENT_EXT.has(ext)) state.componentFiles += 1;
      }
    }
  }
}

// ── Language summary from extension histogram ─────────────────────────────

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  rs: 'Rust', py: 'Python', go: 'Go', rb: 'Ruby',
  java: 'Java', kt: 'Kotlin', cs: 'C#',
  c: 'C', h: 'C', cpp: 'C++', hpp: 'C++', cc: 'C++',
  swift: 'Swift', php: 'PHP', vue: 'Vue', svelte: 'Svelte',
};

function topLanguages(extCounts: Map<string, number>, limit: number): string[] {
  const byLanguage = new Map<string, number>();
  for (const [ext, count] of extCounts) {
    const lang = EXT_LANGUAGE[ext];
    if (!lang) continue;
    byLanguage.set(lang, (byLanguage.get(lang) ?? 0) + count);
  }
  return [...byLanguage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([lang, count]) => `${lang}(${count})`);
}

// ── Manifest-derived facts (package.json + sibling manifest presence) ────

interface PackageJsonFacts {
  scripts: string[];
  frameworks: string[];
}

const SCRIPT_KEYS_OF_INTEREST = ['dev', 'build', 'test', 'lint', 'typecheck', 'start', 'preview'];

const FRAMEWORK_DEP_MARKERS: Record<string, string> = {
  next: 'Next.js', react: 'React', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte',
  '@sveltejs/kit': 'SvelteKit', '@angular/core': 'Angular',
  express: 'Express', fastify: 'Fastify', '@nestjs/core': 'NestJS',
  '@tauri-apps/api': 'Tauri', electron: 'Electron', vite: 'Vite',
  tailwindcss: 'Tailwind', vitest: 'Vitest', jest: 'Jest', playwright: 'Playwright',
};

async function readPackageJsonFacts(
  readFile: (path: string) => Promise<string>,
  root: string,
): Promise<PackageJsonFacts | null> {
  try {
    const raw = await readFile(joinPath(root, 'package.json'));
    const parsed = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
    const scripts = SCRIPT_KEYS_OF_INTEREST.filter((k) => parsed.scripts && k in parsed.scripts);
    const frameworks = Object.entries(FRAMEWORK_DEP_MARKERS)
      .filter(([dep]) => dep in deps)
      .map(([, label]) => label);
    return { scripts, frameworks };
  } catch {
    return null;
  }
}

function detectPackageManager(rootFileNames: Set<string>): string | undefined {
  if (rootFileNames.has('pnpm-lock.yaml')) return 'pnpm';
  if (rootFileNames.has('yarn.lock')) return 'yarn';
  if (rootFileNames.has('package-lock.json')) return 'npm';
  if (rootFileNames.has('Cargo.lock')) return 'cargo';
  if (rootFileNames.has('poetry.lock')) return 'poetry';
  if (rootFileNames.has('Pipfile.lock')) return 'pipenv';
  if (rootFileNames.has('go.sum')) return 'go modules';
  return undefined;
}

function detectManifestStacks(rootFileNames: Set<string>): string[] {
  const hints: string[] = [];
  if (rootFileNames.has('Cargo.toml')) hints.push('Rust');
  if (rootFileNames.has('go.mod')) hints.push('Go');
  if (rootFileNames.has('pyproject.toml') || rootFileNames.has('requirements.txt')) hints.push('Python');
  if (rootFileNames.has('pom.xml')) hints.push('Java(Maven)');
  if (rootFileNames.has('build.gradle') || rootFileNames.has('build.gradle.kts')) hints.push('Java/Kotlin(Gradle)');
  return hints;
}

// ── Git activity (best-effort, never fatal) ───────────────────────────────

function truncateText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function gitActivityLine(
  git: Pick<Git, 'status' | 'log'>,
  root: string,
  remainingMs: number,
): Promise<string | null> {
  if (remainingMs <= 0) return null;
  try {
    const [status, log] = await withDeadline(
      Promise.all([git.status(root), git.log(root, 3)]),
      remainingMs,
    );
    const dirty = status.files.length;
    const last = log[0];
    const lastLine = last ? `${last.date.slice(0, 10)} "${truncateText(last.subject, 40)}"` : 'no commits found';
    return `branch=${status.branch} dirty=${dirty} last=${lastLine}`;
  } catch {
    return null;
  }
}

// ── Code volume magnitude ──────────────────────────────────────────────────

function magnitudeFromNodeCount(n: number): string {
  if (n < 200) return 'tiny';
  if (n < 2000) return 'small';
  if (n < 10000) return 'medium';
  if (n < 50000) return 'large';
  return 'very large';
}

function magnitudeFromFileCount(n: number): string {
  if (n < 20) return 'tiny';
  if (n < 150) return 'small';
  if (n < 1000) return 'medium';
  if (n < 8000) return 'large';
  return 'very large';
}

/** Normalizes a path for cross-platform/verbatim-prefix-insensitive
 *  comparison against `codegraph.listRepos()` entries — see paths.ts's
 *  header for why a raw string `===` on a Windows path is unsafe (verbatim
 *  `\\?\` prefix, mixed separators, drive-letter case). */
function normalizeForCompare(p: string): string {
  return stripVerbatimPrefix(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

async function codeVolumeLine(
  codegraph: Pick<CodeGraphPlatform, 'listRepos'>,
  root: string,
  filesSeen: number,
  walkTruncated: boolean,
): Promise<string> {
  try {
    const repos = await codegraph.listRepos();
    const norm = normalizeForCompare(root);
    const match = repos.find((r) => normalizeForCompare(r.path) === norm);
    if (match) {
      return `${magnitudeFromNodeCount(match.nodeCount)} (indexed: ${match.nodeCount} symbols / ${match.edgeCount} edges)`;
    }
  } catch {
    // codegraph registry unavailable — fall through to the file-count estimate.
  }
  return `${magnitudeFromFileCount(filesSeen)} (unindexed estimate, ${filesSeen}${walkTruncated ? '+' : ''} files seen)`;
}

// ── Top-level shape formatting ─────────────────────────────────────────────

function topDirLines(perTopDir: Map<string, { files: number; dirs: number }>, limit: number): { lines: string[]; omitted: number } {
  const entries = [...perTopDir.entries()].filter(([name]) => name !== '(root)');
  entries.sort((a, b) => b[1].files + b[1].dirs - (a[1].files + a[1].dirs));
  const shown = entries.slice(0, limit);
  return {
    lines: shown.map(([name, c]) => `${name}(${c.files}f)`),
    omitted: Math.max(0, entries.length - shown.length),
  };
}

// ── Final size enforcement ─────────────────────────────────────────────────

function finalize(text: string, truncated: boolean, notFound: boolean, maxChars: number): ProjectDigest {
  if (text.length <= maxChars) {
    return { text, truncated, charCount: text.length, notFound };
  }
  const marker = '\n…[truncated to fit budget]';
  const cut = text.slice(0, Math.max(0, maxChars - marker.length)).trimEnd();
  const capped = `${cut}${marker}`;
  return { text: capped, truncated: true, charCount: capped.length, notFound };
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Builds a compact, bounded, read-only structural digest of `root` — stack,
 * package manager, scripts, test presence, top-level shape, rough
 * surface/component counts, a code-volume magnitude, and recent git
 * activity. Never throws: every sub-probe degrades to an honest "unknown" /
 * omitted section on failure rather than rejecting the whole scan.
 */
export async function buildProjectDigest(
  root: string,
  platform: ProjectDigestPlatform,
  options: ProjectDigestOptions = {},
): Promise<ProjectDigest> {
  const depth: ScanDepth = options.depth ?? 'quick';
  const budget = BUDGETS[depth];
  const trimmedRoot = root?.trim();

  if (!trimmedRoot || trimmedRoot === '.') {
    return finalize(
      `Project scan (${depth}): no project root resolved — nothing to scan.`,
      false,
      true,
      budget.maxCharsFinal,
    );
  }

  const deadlineAtMs = Date.now() + budget.deadlineMs;
  const state = emptyWalkState();

  try {
    await platform.fs.readDir(trimmedRoot);
  } catch {
    return finalize(
      `Project scan (${depth}): root "${basename(trimmedRoot)}" is not readable (missing, moved, or a permissions error) — nothing to scan.`,
      false,
      true,
      budget.maxCharsFinal,
    );
  }

  await walk(platform.fs.readDir, trimmedRoot, budget, deadlineAtMs, state);

  const pkg = await readPackageJsonFacts(platform.fs.readFile, trimmedRoot);
  const packageManager = detectPackageManager(state.rootFileNames);
  const languages = topLanguages(state.extCounts, 3);
  // Manifest-based hints (Cargo.toml -> "Rust", ...) are dropped when the
  // SAME language already surfaced from the extension histogram above —
  // otherwise a repo with both *.rs files and a Cargo.toml would show
  // "Rust(44), ..., Rust" (redundant, wastes the char budget for nothing new).
  const languageNames = new Set(languages.map((l) => l.replace(/\(\d+\)$/, '')));
  const manifestStacks = detectManifestStacks(state.rootFileNames).filter((m) => !languageNames.has(m));

  const stackParts = [...languages, ...manifestStacks, ...(pkg?.frameworks.slice(0, 6) ?? [])];
  const stackLine = stackParts.length > 0 ? stackParts.join(', ') : 'undetected';
  const pkgMgrLine = packageManager ? ` | pkg: ${packageManager}` : '';
  const scriptsLine = pkg && pkg.scripts.length > 0 ? pkg.scripts.join(',') : 'none detected';

  const testsLine = state.testFiles > 0
    ? `present (~${state.testFiles} test file(s) seen)`
    : 'none detected';

  const { lines: dirLines, omitted } = topDirLines(state.perTopDir, budget.topDirsShown);
  const topLevelLine = dirLines.length > 0 ? dirLines.join(' ') : '(empty)';
  const omittedNote = omitted > 0 ? ` +${omitted} more dir(s) not shown` : '';

  const remainingMs = Math.max(0, deadlineAtMs - Date.now());
  const gitLine = await gitActivityLine(platform.git, trimmedRoot, remainingMs);
  const volumeLine = await codeVolumeLine(platform.codegraph, trimmedRoot, state.filesTotal, state.truncated);

  const surfaceLine = `${state.surfaceHits} route/api/migration-like file(s), ${state.componentFiles} component-like file(s) (.tsx/.jsx/.vue/.svelte)`;

  const sections = [
    `Project scan (${depth}) — root: ${basename(trimmedRoot)}`,
    `Stack: ${stackLine}${pkgMgrLine} | scripts: ${scriptsLine}`,
    `Tests: ${testsLine}`,
    `Top-level (${dirLines.length} dir(s) shown${omittedNote}): ${topLevelLine}`,
    `Surfaces: ${surfaceLine}`,
    `Code volume: ${volumeLine}`,
  ];
  if (gitLine) sections.push(`Git: ${gitLine}`);
  if (state.truncated) {
    sections.push(
      `Note: directory walk capped at ${budget.maxDirs} dir(s) / ${budget.deadlineMs}ms — counts above are a LOWER BOUND, not exhaustive.`,
    );
  }

  return finalize(sections.join('\n'), state.truncated, false, budget.maxCharsFinal);
}
