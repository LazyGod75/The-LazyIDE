/* missionScopeGuard.ts — Detects a mission task naming an absolute directory
 * path that lies OUTSIDE the project root the mission is about to launch
 * against.
 *
 * Real gap (LazyManager QA, 2026-08-01): a user asked the manager, in plain
 * language, to finish a project located at an absolute path that was NOT
 * the currently active project. addMission (agentsStore.tsx) resolves
 * exactly ONE working directory per launch (resolveProjectRoot's return
 * value — the same root runtime.ts's agent_run invoke and its brain wiring
 * use) — there is no per-mission "target path" field on launch_mission, so
 * a task naming a DIFFERENT project's path used to run silently against the
 * ACTIVE project's cwd/worktree/brain, with no error anywhere in the
 * pipeline. App logs confirmed it end-to-end: `agent_run: brain_search MCP
 * wired ... brain=<ACTIVE project>\.lazybrain\brain` while the task named a
 * completely different repo.
 *
 * WHY THIS LAYER (the task's own "explain your choice" requirement): a real
 * "does this path exist as a directory" check would need a Rust round-trip,
 * but every existing UNJAILED fs probe is jailed on purpose —
 * `read_dir`/`read_file`/etc. (src-tauri/src/commands/fs.rs) all go through
 * `ensure_path_in_any_open_project`, which rejects any path that is not
 * already inside an OPEN project. That is exactly the precondition this
 * guard exists to catch the ABSENCE of, so none of them can be reused here,
 * and adding a new unjailed Rust command would need a rebuild — out of
 * scope for a hot-reload-only change (the app is running live). This guard
 * is therefore a pure, textual heuristic living entirely in TypeScript at
 * addMission's single choke point (every mission-launch path funnels
 * through addMission, not just the manager's launch_mission) — no I/O, so
 * it can never hang, never fail open on a slow/broken backend, and is
 * trivially unit-testable.
 *
 * PRECISION TRADEOFF (documented, not hidden): only Windows drive-letter
 * absolute paths ("C:\...") are scanned for — this matches the app's only
 * shipped platform and the exact shape of the real repro. POSIX-style
 * single-leading-slash paths are deliberately NOT scanned: they collide
 * constantly with ordinary task text that is not a filesystem reference at
 * all (REST routes like "/api/users", markdown headings, URL paths) and
 * would turn this into a false-positive generator. A drive-letter path is a
 * much higher-precision signal — it essentially never appears in task text
 * except as a genuine filesystem reference.
 *
 * URL FALSE-POSITIVE FIX (2026-08-04): the drive-letter regex only requires
 * ONE letter before ":\" or ":/", with no boundary check on what precedes
 * that letter. A task naming an ordinary URL — "http://localhost:3000/
 * game/index.html" — was misread starting at the scheme's OWN last letter
 * ("p://localhost:3000/game/index.html"), refused as an out-of-scope path,
 * and even showed the user a truncated "p://..." mention. `maskUrls` strips
 * every real URL (any `scheme://...` token) out of the task text BEFORE the
 * drive-letter scan runs, so a URL's scheme letters can never be mistaken
 * for a one-letter Windows drive.
 *
 * Since no fs existence check is available (see above), a mismatch is
 * flagged from path TEXT alone, normalized and compared against the
 * resolved root — this can occasionally misfire on a task that merely
 * MENTIONS an unrelated absolute path in passing ("compare with the
 * approach used in C:\other\project") without intending it as the
 * mission's real target. Given the alternative this guard replaces — a
 * mission silently executing against the WRONG project's cwd/brain, with
 * the user only finding out once the judge rejects it — a rare, loud,
 * fully recoverable false refusal (the caller leaves the mission in a
 * 'failed' state with an explicit statusReason, never silently drops it —
 * see agentsStore.tsx's addMission) is the safer failure mode. The
 * manager's own open_project doctrine (managerEngine.ts) is the PRIMARY
 * fix — this is the backstop for whenever that doctrine is bypassed (a
 * direct New Mission modal launch, a future action, a bug).
 *
 * FALSE-POSITIVE FIX (2026-08-02, missions M4/M5): both were blocked despite
 * naming the CORRECT project. Root cause was two-fold, both now fixed here:
 *   1. `activeRoot` arrives verbatim-prefixed (`\\?\C:\...`, Rust
 *      canonicalize() output) while a task-mentioned path never is, and
 *      drive-letter case can differ — normalizeForCompare() strips the
 *      prefix and case-folds so both sides compare on equal footing (single
 *      helper, used for both `root` and `candidate` below — never ad hoc).
 *   2. buildTaskForNode (runGraph.ts) appends machine-generated context
 *      AFTER the real task text: an "## Upstream graph inputs" JSON block
 *      and a "## Brain recall (automatic)" block of recalled note snippets
 *      hard-truncated to 200 chars (brainBus.ts's formatRecallBlock). A
 *      recalled note had been truncated to exactly "...cerveau\lazy-backo"
 *      — a strict TEXT prefix of the real active root
 *      "...cerveau\lazy-backoffice" but not a path ancestor (no separator
 *      boundary), so it read as a genuinely different, out-of-scope path.
 *      stripInjectedContextBlocks() now cuts the scanned text at the first
 *      of either header, so only the real instruction is ever scanned —
 *      the deliberate "sibling directory sharing a name prefix" refusal
 *      (…\Lazy vs …\LazySite-internet, still enforced) stays intact because
 *      it can only ever fire on the genuine task text, never on incidental
 *      truncated noise appended after it.
 *
 * EXTRA-READABLE-ROOTS FIX (2026-08-18, live repro: a 12-step Lazy-Docs plan
 * — M66/M67/M68 — blocked at launch, zero worktrees created): a mission can
 * now legitimately declare `extraReadableProjectIds` on a plan step (see
 * OrchestratorPlanStep.extraReadableProjectIds, types.ts), resolved by the
 * SGR `launchMission` callback / the manager's `launch_mission` executor
 * (agentsStore.tsx) into `Mission.extraReadableRoots` — absolute,
 * already-open project roots the mission's agent may genuinely READ from
 * beyond its own worktree (see that field's own doc comment for the full
 * `--add-dir` + Edit/Write-denying `--settings` mechanism, extra_roots.rs).
 * This guard predates that field and knew nothing about it: naming a path
 * inside a DECLARED extra-readable root is exactly what the feature is
 * FOR, yet the guard refused it the same as a genuinely wrong-cwd mention,
 * with zero mission dispatched. `findOutOfScopeTaskPath` now takes those
 * already-resolved roots as an optional third argument and exempts a
 * mentioned path that lies AT or UNDER one of them (`isPathWithinRoot`,
 * declared-root-then-mention order only — NOT the reverse: a mention that
 * is merely an ANCESTOR of a declared root, e.g. naming "C:\Users\user\
 * Documents" when only "...\Documents\GameOn" was declared, is still
 * flagged, since that names far more than what was actually granted).
 *
 * READ vs WRITE (the trade-off this file's own "pure textual heuristic, no
 * I/O" design forces): this guard cannot tell, from task text alone,
 * whether a mention of a path under a declared extra root means "read
 * this for context" (the declared, legitimate use) or "write into this"
 * (never legitimate via extraReadableRoots — read-only by contract). Rather
 * than trying to guess intent from wording and risk silently widening the
 * guard on a misread, the chosen behaviour is: let the mention through
 * unconditionally once its root is declared, and rely on the SEPARATE,
 * already-existing enforcement layer to make the write-vs-read distinction
 * where it can actually be made safely — Rust's extra_roots.rs pairs every
 * granted root with a generated `--settings` file that denies Edit/Write
 * under it, independent of what the task text says, so a task that both
 * names a declared root AND intends to write there still cannot actually
 * write once dispatched. This guard's own job stays exactly what its
 * header already claims: stop the LAUNCH from running against the WRONG
 * project's cwd/worktree/brain. `repoPath`/the worktree are never affected
 * by a declared extra root, so exempting these mentions here reopens
 * nothing the original 2026-08-01 fix closed — it only stops refusing a
 * launch whose cross-project read was already explicitly declared and
 * already independently re-validated downstream.
 */

import { isPathWithinRoot, normalizeForPathCompare } from '../paths.js';
import { UPSTREAM_GRAPH_INPUTS_HEADER } from './graph/dataPlane.js';
import { BRAIN_RECALL_HEADER } from './graph/brainBus.js';

/** Headers marking the start of blocks that `buildTaskForNode` (runGraph.ts)
 *  appends AFTER the real task instruction: machine-generated upstream JSON
 *  and brain-recall note snippets (see brainBus.ts's formatRecallBlock —
 *  snippets are hard-truncated to 200 chars and can end mid-path). Neither
 *  block expresses the mission's actual target, so scanning them for
 *  "outside the active project" absolute paths is pure noise at best and a
 *  false refusal at worst: a truncated recall snippet like
 *  "...cerveau\lazy-backo" is a strict TEXT prefix of the real active root
 *  "...cerveau\lazy-backoffice" but not a path ancestor (no separator
 *  boundary), so it used to trip the guard on every mission whose recalled
 *  notes happened to mention the active project's own path (real incident,
 *  missions M4/M5, 2026-08-02: both blocked despite naming the correct
 *  project, because a note snippet truncated at exactly "lazy-backo"). */
const INJECTED_CONTEXT_HEADERS = [UPSTREAM_GRAPH_INPUTS_HEADER, BRAIN_RECALL_HEADER];

/** Cuts `taskText` at the earliest occurrence of any auto-injected context
 *  block header, keeping only the real task instruction that precedes them.
 *  No-op when neither header is present. */
function stripInjectedContextBlocks(taskText: string): string {
  let cutAt = -1;
  for (const header of INJECTED_CONTEXT_HEADERS) {
    const idx = taskText.indexOf(header);
    if (idx !== -1 && (cutAt === -1 || idx < cutAt)) cutAt = idx;
  }
  return cutAt === -1 ? taskText : taskText.slice(0, cutAt);
}

/** Matches a full URL — a scheme (letter, then any run of
 *  letters/digits/`+`/`.`/`-`) followed by "://" and the rest of the token
 *  up to whitespace/quote/angle-bracket — e.g. "http://localhost:3000/x",
 *  "https://example.com/path". Left-to-right regex matching naturally finds
 *  the EARLIEST valid start and extends as far as the greedy scheme class
 *  allows, so this captures the URL's real, full scheme ("http"), never
 *  just its last letter — see `maskUrls` below for why that matters. */
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]*/g;

/** Blanks out every URL in `taskText` (replaced with spaces of the same
 *  length, so offsets/length are preserved) before the drive-letter scan
 *  below ever runs. Without this, `WINDOWS_ABSOLUTE_PATH_RE` — which only
 *  requires ONE letter immediately before ":\" or ":/" with no check on
 *  what precedes THAT letter — matches starting at a URL scheme's own LAST
 *  letter: "http://localhost:3000/game/index.html" was misread as the
 *  drive-letter path "p://localhost:3000/game/index.html" and refused as
 *  out-of-scope (real repro, 2026-08-04). A genuine Windows path is never
 *  affected: it never contains "scheme://" (a Windows path uses a single
 *  "\" or "/" right after the drive letter's ":", never "://"). */
function maskUrls(taskText: string): string {
  return taskText.replace(URL_RE, (match) => ' '.repeat(match.length));
}

/** Matches a Windows drive-letter absolute path and everything attached to
 *  it up to the first whitespace/quote/angle-bracket/pipe/wildcard — the
 *  minimum-depth rule (drive + at least 2 named segments) is enforced
 *  explicitly in `findOutOfScopeTaskPath` below, not baked into the regex,
 *  so the depth rule stays a single, readable, testable place. */
const WINDOWS_ABSOLUTE_PATH_RE = /[A-Za-z]:[\\/][^\s"'<>|?*\r\n]+/g;

/** Trailing punctuation a natural-language sentence commonly leaves stuck to
 *  a path mention ("...at C:\Foo\Bar." or "...(C:\Foo\Bar)") — stripped
 *  before comparison so it never corrupts the match. */
function stripTrailingPunctuation(candidate: string): string {
  return candidate.replace(/[.,;:!?)\]"'\u2014\u2013]+$/, '');
}

export interface OutOfScopeTaskPath {
  /** The absolute path mentioned in the task text, exactly as extracted
   *  (post-punctuation-strip, pre-normalization — safe to show the user
   *  verbatim). */
  mentionedPath: string;
  /** The resolved root the mission was about to launch against. */
  activeRoot: string;
}

/** Extracts every Windows absolute path mention from the REAL task text
 *  (injected context blocks stripped, trailing punctuation stripped,
 *  minimum-depth rule applied) — the same scan findOutOfScopeTaskPath
 *  performs, exposed for callers that need the mentions themselves rather
 *  than just the first out-of-scope verdict (e.g. agentsStore.tsx's
 *  launch_mission executor resolving which OPEN project a mentioned path
 *  belongs to, see findOwningProject). Single source for the regex +
 *  strip + depth rules so the two scans can never diverge. */
export function extractTaskAbsolutePaths(taskText: string | undefined): string[] {
  if (!taskText) return [];
  const ownTaskText = maskUrls(stripInjectedContextBlocks(taskText));
  const matches = ownTaskText.match(WINDOWS_ABSOLUTE_PATH_RE);
  if (!matches) return [];
  const out: string[] = [];
  for (const raw of matches) {
    const mentionedPath = stripTrailingPunctuation(raw);
    // path-lint-ignore: mentionedPath is extracted from free-text task
    // prompts (WINDOWS_ABSOLUTE_PATH_RE match), never a canonicalize()
    // result — segment-count only, not a cross-source comparison.
    const segments = mentionedPath.split(/[\\/]+/).filter(Boolean);
    if (segments.length < 3) continue;
    out.push(mentionedPath);
  }
  return out;
}

/**
 * Scans `taskText` for a Windows absolute path that is neither the same as,
 * an ancestor of, nor a descendant of `activeRoot`, AND not at-or-under any
 * of `extraReadableRoots` (see this file's header, "EXTRA-READABLE-ROOTS
 * FIX" — already-resolved, currently-open project roots the mission was
 * explicitly granted cross-project READ access to, e.g. from
 * `Mission.extraReadableRoots`). Returns the first such mismatch, or `null`
 * when the task carries no absolute path, only paths inside `activeRoot` or
 * a declared extra-readable root, or `activeRoot` itself is not a real
 * resolved root (empty / '.' — the addMission fallback for "could not
 * resolve").
 */
export function findOutOfScopeTaskPath(
  taskText: string | undefined,
  activeRoot: string | undefined,
  extraReadableRoots?: readonly string[],
): OutOfScopeTaskPath | null {
  if (!taskText || !activeRoot) return null;
  const root = normalizeForPathCompare(activeRoot);
  if (!root || root === '.') return null;

  const ownTaskText = maskUrls(stripInjectedContextBlocks(taskText));
  const matches = ownTaskText.match(WINDOWS_ABSOLUTE_PATH_RE);
  if (!matches) return null;

  for (const raw of matches) {
    const mentionedPath = stripTrailingPunctuation(raw);
    // path-lint-ignore: mentionedPath is extracted from free-text task
    // prompts, never a canonicalize() result — segment-count only.
    const segments = mentionedPath.split(/[\\/]+/).filter(Boolean);
    // Drive letter + at least 2 named segments (e.g. "C:\Users\user") —
    // shallow mentions ("C:\", "C:\Windows") are too generic to confidently
    // treat as naming a specific other project.
    if (segments.length < 3) continue;
    // Bidirectional: the mentioned path may be an ancestor of the active
    // root (e.g. "C:\Users\user\Documents", a parent-folder mention) just
    // as often as a descendant of it — both are in scope.
    if (isPathWithinRoot(activeRoot, mentionedPath) || isPathWithinRoot(mentionedPath, activeRoot)) continue;
    // Declared extra-readable roots — one direction only (mentionedPath AT
    // or UNDER the declared root, never the reverse): the mission was
    // explicitly granted read access to exactly that root, not to whatever
    // broader ancestor a task might happen to name. See header for why this
    // exemption cannot be exploited to WRITE outside activeRoot.
    if (extraReadableRoots?.some((extraRoot) => isPathWithinRoot(extraRoot, mentionedPath))) continue;
    return { mentionedPath, activeRoot };
  }
  return null;
}
