/* reviewPreflight.ts — Trust-critical defect #1 (M53 forensics, lazy-backoffice):
   verify a mission's computed diff actually represents everything the agent
   left in its worktree, BEFORE that diff goes to the judge pipeline.

   ── WHAT HAPPENED ────────────────────────────────────────────────────────
   Mission M53 ("Admin dashboard scaffold") produced a real 19-file Vite+React
   scaffold in its worktree — all of it left UNTRACKED in git. The review's
   diffFiles ended up containing only README.md (a tracked, modified file),
   and the tester/reviewer/security/final judges reviewed a README, believed
   it was the whole deliverable, and returned request_changes (1/3 approve).
   Real work was rejected for a reason that never applied to it, and the
   recorded verdict was meaningless.

   Two independent root causes, two independent fixes:
     1. diffParse.ts's parseDiffFiles only recognized `diff --git` as a file
        boundary, so the untracked-file blocks agent_worktree_diff_inner
        (git.rs) inlines (which carry no `diff --git` header of their own)
        got mis-attributed onto whichever tracked file preceded them in the
        raw string. Fixed there — see that file's own doc comment.
     2. THIS MODULE: even a correctly-parsed diff can still be missing a file
        the Rust side failed to embed at all (binary content, invalid UTF-8,
        any other `fs::read_to_string` failure in agent_worktree_diff_inner
        silently drops that file with zero signal). Fix #1 above cannot
        recover data that was never in the diff string to begin with.

   ── THE GUARD ─────────────────────────────────────────────────────────────
   detectDiffCoverageGap cross-checks the worktree's real `git status`
   (untracked '?', added 'A', modified 'M' — the only statuses that put NEW
   content into a diff; a deletion 'D' needs no content and is already
   handled correctly by the existing `git diff HEAD` path) against the set
   of filenames the computed diff actually attributes lines to. Any git-seen
   path absent from the diff is a genuine coverage gap: the diff does not
   represent the work, and runtime.ts must never hand that off to
   evaluateMission as if it were complete — see evaluator.ts's
   buildDiffCoverageGapVerdict, which turns a non-empty gap into an explicit,
   never-fabricated "request changes, here is what's missing" verdict instead
   of silently running judges against an incomplete diff.

   Pure — no I/O — fully unit-testable in isolation, same convention as
   diffParse.ts and gitPreflight.ts's computeCollidingUntrackedPaths.
*/

import type { GitFile } from '../platform/types.js';

// ── App-infra exclusion (same convention as gitPreflight.ts's
// isAgentInfraPath — this app's own `.lazy/`/`.lazybrain/` scaffolding is
// never part of a mission's deliverable, even though the worktree carries
// no committed .gitignore for it until the mission itself adds one) ───────

const AGENT_INFRA_EXACT = ['.lazy', '.lazybrain'];
const AGENT_INFRA_PREFIXES = ['.lazy/', '.lazybrain/'];

function isAgentInfraPath(relPath: string): boolean {
  // path-lint-ignore: relPath is a git-relative path (git status output),
  // never a raw canonicalize() path — no verbatim prefix to strip here.
  const normalized = relPath.replace(/\\/g, '/');
  return AGENT_INFRA_EXACT.includes(normalized) || AGENT_INFRA_PREFIXES.some((p) => normalized.startsWith(p));
}

function comparablePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Git statuses that put NEW content into a diff — the only ones a coverage
 *  gap can meaningfully apply to. A pure deletion ('D') needs no new content
 *  embedded anywhere and is already fully represented by the ordinary
 *  `git diff HEAD` tracked-file path (never routes through the
 *  untracked-file inlining this module exists to backstop). */
const CONTENT_BEARING_STATUSES = new Set<GitFile['status']>(['?', 'A', 'M']);

/**
 * Which of the worktree's real, content-bearing changed paths (per `git
 * status`, minus this app's own infra) are NOT reflected as their own entry
 * in the computed diff. Empty result = the diff genuinely represents every
 * change git can see — the common, healthy case. Non-empty = "fail loudly":
 * the caller must not let this diff stand in for the mission's full output.
 */
export function detectDiffCoverageGap(
  gitFiles: readonly GitFile[],
  diffFiles: readonly { filename: string }[],
): string[] {
  const diffPaths = new Set(diffFiles.map((f) => comparablePath(f.filename)));
  const gaps = gitFiles
    .filter((f) => CONTENT_BEARING_STATUSES.has(f.status) && !isAgentInfraPath(f.path))
    .map((f) => comparablePath(f.path))
    .filter((p) => !diffPaths.has(p));
  // De-duplicate (a rename or a status tool reporting the same path twice
  // must never inflate the reported gap) and sort for deterministic,
  // readable output in the verdict summary / UI banner.
  return Array.from(new Set(gaps)).sort();
}

// ── Empty deliverable — trust-critical defect #2 (M2 forensics) ──────────
//
// Mission M2 ("Consolider la base de code sur une branche de travail…")
// left a worktree containing only the pre-existing README.md — zero
// commits (`git log main..HEAD` empty), diffFiles === [] — a GENUINELY
// empty diff, not the mis-attributed/incomplete one detectDiffCoverageGap
// above catches (that function's own gaps list was correctly [] here: there
// was no untracked content Rust failed to embed, because there was no
// content at all). The judge pipeline still ran against this nothing: the
// tester was inconclusive (no test script), the reviewer correctly flagged
// "no diff provided", but the security role read the empty diff as "no code
// = no security risk" and approved — the final judge then leaned on that
// approval, 1/2 approve on a mission that did nothing.
//
// isDiffGenuinelyEmpty is the pure "is there truly nothing here" check;
// runtime.ts's Step C combines it with evaluator.ts's isVerificationMission
// (the one legitimate exception — a diff-less investigation/verification
// mission, whose own contract expects a report, not code) to populate
// mission.emptyDeliverable, which evaluator.ts's evaluateMission then checks
// FIRST, before ever dispatching to a judge sub-agent — same short-circuit
// shape as diffIncompleteFiles/detectDiffCoverageGap above.

/**
 * True when a mission's diff carries no content whatsoever: no files, no
 * snippet lines, no added/removed line counts. Distinct from
 * detectDiffCoverageGap's gap list (which flags a diff that has SOME
 * content but is missing files git can see) — a mission with any content on
 * ANY of these fields is not empty, even if the others are zero/absent
 * (e.g. a pure-deletion diff can have diffFiles/diffSnippet content with
 * diffAdded === 0).
 */
export function isDiffGenuinelyEmpty(diff: {
  diffFiles: readonly { filename: string }[];
  diffSnippet: readonly string[];
  diffAdded: number;
  diffRemoved: number;
}): boolean {
  return (
    diff.diffFiles.length === 0 &&
    diff.diffSnippet.length === 0 &&
    diff.diffAdded === 0 &&
    diff.diffRemoved === 0
  );
}
