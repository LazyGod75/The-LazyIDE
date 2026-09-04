/* proposals.ts — real empty-state mission proposals (spec §9, plan T2.6).

   Replaces the old hardcoded PROPOSALS array that used to live in
   EmptyStateProposals.tsx (4 generic prompts like "review the codebase") —
   a no-mocks violation: a fresh cockpit always showed the SAME 4 cards
   regardless of the actual project. generateProposals() instead runs a
   bounded, defensive scan of the open project and only proposes missions
   backed by something real it actually found (a real TODO, a real
   uncovered file), each carrying a real pre-launch quote (estimator.ts).

   Sources (each independent and defensive — see generateProposals()'s
   Promise.allSettled fan-out: one source failing never blocks the others,
   and a source finding nothing legitimately contributes no proposal, which
   is not an error):

     1. todoFixme      — regex-scans a bounded sample of source files for
                          TODO/FIXME markers.
     2. missingTests    — lists source files with no same-basename test file
                          under src/__tests__.

   "Outdated dependencies" (a 3rd source considered for this task) is
   INTENTIONALLY NOT implemented: it requires actually running
   `npm outdated --json` to know which declared versions are stale, and
   src/lib/platform's Terminal only exposes a raw PTY-style
   spawn(command, args) -> { onData, onExit, ... } process (platform/types.ts)
   — there is no promise-based "run a command, capture stdout" convenience
   anywhere under src/lib/platform (grepped the directory; the one existing
   caller, ReviewSpace.tsx's `gh --version` probe, hand-rolls the
   onData/onExit buffering itself, one-off, per call site). Building that
   convenience would require either a new Tauri/Rust command (out of scope
   here) or duplicating fragile stream-buffering logic for a single call
   site. Faking "outdated" data instead would reintroduce exactly the
   no-mocks violation this task exists to fix — so the source is skipped
   rather than approximated.

   Bounds (deliberately small — this runs synchronously with the cockpit's
   empty state, not a background indexer):
     - scan root: <projectRoot>/src when present, else projectRoot itself.
     - MAX_SCAN_FILES enumerated across the whole walk (300).
     - MAX_READ_FILES actually read for the content-based TODO/FIXME scan (50).
     - MAX_TODO_HITS collected (20).
*/

import { getPlatform, type Platform, type DirEntry } from '../platform/index.js';
import { getModelPickerOptions } from '../models/modelPickerOptions.js';
import { quote, sizeClassOf, type MissionQuote, type SizeClass } from './estimator.js';

// ── Public types ─────────────────────────────────────────────────────

export type ProposalSource = 'todoFixme' | 'missingTests';

export interface MissionProposal {
  /** Stable per-source id — also used as the React key / data-testid. */
  id: ProposalSource;
  source: ProposalSource;
  icon: string;
  accent: string;
  /** i18n key + interpolation params for the card title (see EmptyStateProposals.tsx). */
  titleKey: string;
  titleParams: Record<string, string | number>;
  /** i18n key + interpolation params for the card description. */
  descKey: string;
  descParams: Record<string, string | number>;
  /** Self-contained English mission prompt with concrete file references —
      sent as-is to onLaunch/addMission, independent of the active UI locale
      (mirrors the rest of this app's agent-task prompts, always English). */
  taskText: string;
  quote: MissionQuote;
  sizeClass: SizeClass;
}

// ── Bounds & scan config ─────────────────────────────────────────────

const MAX_SCAN_FILES = 300;
const MAX_READ_FILES = 50;
const MAX_TODO_HITS = 20;
const MAX_DEPTH = 6;
const TOP_FILES_SHOWN = 5;
const MAX_PROPOSALS = 3;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '__pycache__',
  '.next', '.nuxt', '.cache', '.lazy', '.windsurf', '.claude',
  'vendor', '.venv', 'venv', 'env', 'coverage', '__tests__',
]);

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java',
  'rb', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'kt', 'swift',
]);

const TODO_PATTERN = /\b(TODO|FIXME)\b/;
const TEST_FILENAME_PATTERN = /^(.*)\.test\.(ts|tsx|js|jsx)$/;
const TESTABLE_FILENAME_PATTERN = /\.(ts|tsx|js|jsx)$/;
const NON_TESTABLE_FILENAME_PATTERN = /\.(test|spec)\.|\.d\.ts$/;

interface CandidateFile {
  path: string;
  filename: string;
}

function extOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx + 1).toLowerCase();
}

function basenameNoExt(filename: string): string {
  const idx = filename.indexOf('.');
  return idx === -1 ? filename : filename.slice(0, idx);
}

function stripTrailingSlash(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

function sortedByPath(files: CandidateFile[]): CandidateFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

// ── Bounded directory walk ───────────────────────────────────────────

/**
 * Bounded, defensive directory walk — mirrors codebaseIndex.ts's
 * collectFiles bounds/skip-list in spirit (same Platform.fs abstraction,
 * same idea of skip-listing vendor/build dirs) but kept fully independent:
 * codebaseIndex.ts exposes no reusable exported helper for this, only the
 * stateful CodebaseIndex class (semantic-embedding search, not exact
 * content matching, and its constructor needs a Platform instance this
 * module resolves differently — see generateProposals()).
 *
 * Immutable by construction: returns a NEW array every call rather than
 * mutating an accumulator, with `remaining` threaded through the recursion
 * to enforce the SAME global MAX_SCAN_FILES cap a mutable-accumulator
 * version would. Never throws: an unreadable directory yields [], not a
 * rejection.
 */
async function collectCandidateFiles(
  platform: Platform,
  dirPath: string,
  depth: number,
  remaining: number,
): Promise<CandidateFile[]> {
  if (depth > MAX_DEPTH || remaining <= 0) return [];

  let entries: DirEntry[];
  try {
    entries = await platform.fs.readDir(dirPath);
  } catch {
    return [];
  }

  let result: CandidateFile[] = [];
  for (const entry of entries) {
    if (result.length >= remaining) break;
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    if (entry.isDir) {
      const sub = await collectCandidateFiles(platform, entry.path, depth + 1, remaining - result.length);
      result = [...result, ...sub];
    } else if (CODE_EXTENSIONS.has(extOf(entry.name))) {
      result = [...result, { path: entry.path, filename: entry.name }];
    }
  }
  return result.slice(0, remaining);
}

/** Resolves the scan root: <projectRoot>/src when it exists and is
    non-empty (this repo's — and most JS/TS projects' — convention), else
    projectRoot itself, so the scan still works for other project layouts. */
async function resolveScanRoot(platform: Platform, projectRoot: string): Promise<string> {
  const srcPath = `${stripTrailingSlash(projectRoot)}/src`;
  try {
    const entries = await platform.fs.readDir(srcPath);
    if (entries.length > 0) return srcPath;
  } catch {
    // No src/ dir (or unreadable) — fall through to projectRoot.
  }
  return projectRoot;
}

// ── Source: TODO / FIXME ─────────────────────────────────────────────

interface TodoHit {
  path: string;
  filename: string;
  line: number;
  text: string;
}

/** Reads one file and returns its TODO/FIXME hits — isolated per-file try/
    catch so one unreadable file never drops the rest of the scan. */
async function scanFileForTodos(platform: Platform, file: CandidateFile): Promise<TodoHit[]> {
  let content: string;
  try {
    content = await platform.fs.readFile(file.path);
  } catch {
    return [];
  }
  return content
    .split('\n')
    .map((text, idx) => ({ text, line: idx + 1 }))
    .filter(({ text }) => TODO_PATTERN.test(text))
    .map(({ text, line }) => ({
      path: file.path,
      filename: file.filename,
      line,
      text: text.trim().slice(0, 140),
    }));
}

async function scanTodoFixme(platform: Platform, files: CandidateFile[]): Promise<TodoHit[]> {
  const toRead = sortedByPath(files).slice(0, MAX_READ_FILES);
  let hits: TodoHit[] = [];

  for (const file of toRead) {
    if (hits.length >= MAX_TODO_HITS) break;
    const fileHits = await scanFileForTodos(platform, file);
    hits = [...hits, ...fileHits].slice(0, MAX_TODO_HITS);
  }
  return hits;
}

async function buildTodoProposal(
  platform: Platform,
  files: CandidateFile[],
  model: string,
): Promise<MissionProposal | null> {
  const hits = await scanTodoFixme(platform, files);
  if (hits.length === 0) return null;

  const topFilenames = [...new Set(hits.map((h) => h.filename))].slice(0, TOP_FILES_SHOWN);
  const refLines = hits.slice(0, TOP_FILES_SHOWN).map((h) => `- ${h.path}:${h.line} — ${h.text}`);
  const scannedCount = Math.min(files.length, MAX_READ_FILES);

  const taskText =
    `Resolve the following TODO/FIXME markers found while scanning the first ` +
    `${scannedCount} source file(s) of this project (${hits.length} occurrence(s) found):\n` +
    `${refLines.join('\n')}\n` +
    `For each, read the surrounding code, implement the fix or missing behavior it describes, ` +
    `and remove the marker once resolved.`;

  return {
    id: 'todoFixme',
    source: 'todoFixme',
    icon: '🔍',
    accent: '#7C5CFF',
    titleKey: 'agents.proposals.todoFixme.title',
    titleParams: { count: hits.length },
    descKey: 'agents.proposals.todoFixme.desc',
    descParams: { files: topFilenames.join(', ') },
    taskText,
    quote: await quote(taskText, { model }),
    sizeClass: sizeClassOf(taskText),
  };
}

// ── Source: missing tests ────────────────────────────────────────────

function testBasenames(entries: DirEntry[]): Set<string> {
  const names = entries
    .filter((e) => !e.isDir)
    .map((e) => TEST_FILENAME_PATTERN.exec(e.name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
  return new Set(names);
}

function isTestableCandidate(file: CandidateFile, covered: Set<string>): boolean {
  if (!TESTABLE_FILENAME_PATTERN.test(file.filename)) return false;
  if (NON_TESTABLE_FILENAME_PATTERN.test(file.filename)) return false;
  return !covered.has(basenameNoExt(file.filename));
}

async function buildMissingTestsProposal(
  platform: Platform,
  projectRoot: string,
  files: CandidateFile[],
  model: string,
): Promise<MissionProposal | null> {
  const testsDir = `${stripTrailingSlash(projectRoot)}/src/__tests__`;
  let testEntries: DirEntry[];
  try {
    testEntries = await platform.fs.readDir(testsDir);
  } catch {
    return null; // No test directory to compare against — nothing reliable to propose.
  }

  const covered = testBasenames(testEntries);
  const uncovered = sortedByPath(files).filter((f) => isTestableCandidate(f, covered));
  if (uncovered.length === 0) return null;

  const topUncovered = uncovered.slice(0, TOP_FILES_SHOWN);
  const refLines = topUncovered.map((f) => `- ${f.path}`);

  const taskText =
    `Add unit tests for the following source file(s), which currently have no matching ` +
    `test file under src/__tests__ (${uncovered.length} uncovered file(s) found):\n` +
    `${refLines.join('\n')}\n` +
    `For each, create (or extend) a matching test file in src/__tests__ covering its main exported behavior.`;

  return {
    id: 'missingTests',
    source: 'missingTests',
    icon: '✅',
    accent: '#22C55E',
    titleKey: 'agents.proposals.missingTests.title',
    titleParams: { count: uncovered.length },
    descKey: 'agents.proposals.missingTests.desc',
    descParams: { files: topUncovered.map((f) => f.filename).join(', ') },
    taskText,
    quote: await quote(taskText, { model }),
    sizeClass: sizeClassOf(taskText),
  };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Generates up to MAX_PROPOSALS real mission proposals from a bounded scan
 * of `projectRoot`. Never throws: file-system access is wrapped defensively
 * at every level, and each source is additionally isolated via
 * Promise.allSettled so a single unexpected failure never blocks the
 * others. Resolves to [] when the scan finds nothing concrete — callers
 * MUST render an honest empty state in that case rather than falling back
 * to filler proposals (see EmptyStateProposals.tsx).
 */
export async function generateProposals(projectRoot: string): Promise<MissionProposal[]> {
  if (!projectRoot) return [];

  const platform = getPlatform();
  const model = getModelPickerOptions().defaultModelId;

  // Defaults to [] (never throws) if resolveScanRoot/collectCandidateFiles
  // reject unexpectedly — both already catch their own I/O failures
  // internally, so this is a last-resort safety net, not the primary path.
  let files: CandidateFile[] = [];
  try {
    const scanRoot = await resolveScanRoot(platform, projectRoot);
    files = await collectCandidateFiles(platform, scanRoot, 0, MAX_SCAN_FILES);
  } catch {
    // files already [] — nothing further to do.
  }

  if (files.length === 0) return [];

  const results = await Promise.allSettled([
    buildTodoProposal(platform, files, model),
    buildMissingTestsProposal(platform, projectRoot, files, model),
  ]);

  const proposals = results
    .filter((r): r is PromiseFulfilledResult<MissionProposal | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is MissionProposal => v !== null);

  return proposals.slice(0, MAX_PROPOSALS);
}
