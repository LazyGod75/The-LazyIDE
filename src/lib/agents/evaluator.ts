/* evaluator.ts — Mission evaluation pipeline (tester + reviewer + security + judge).
   After an implementer run produces a diff, this module spawns evaluator sub-runs
   and aggregates into a JudgeVerdict. Dispatch is mode-aware, mirroring how
   missions themselves run (see runtime.ts's planAndAct):

     - claude-code / codex (native CLI, Tauri)  -> evaluateLive, via agent_run
     - managed (Pro subscription, Tauri)        -> evaluateManaged, via the
                                                     managed provider + run_shell
     - pro / live-key / mock (Tauri, no engine) -> evaluateScripted, real test
                                                     runner but no real reviewer
     - no Tauri runtime at all                  -> buildUnavailableVerdict()

   HONESTY CONTRACT:
   - Evaluation is NEVER fabricated. Every path either runs a real sub-agent
     (native CLI or managed LLM) and a real test command, or returns a
     clearly-labelled placeholder verdict with passed=false explaining what's
     missing. No path invents a passing score.
   - evaluateManaged's tester role never guesses pass/fail counts: it reports
     the real run_shell exit code, and only includes counts when they can be
     parsed from the command's own output.
*/

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Mission } from '../agents/types.js';
import type { JudgeVerdict, ReviewerVerdict, RiskLevel, VerdictOutcome } from '../agents/types.js';
import { getPlatform } from '../platform/index.js';
import { getProviderMode, getDefaultModelIdForMode, DEFAULT_MODEL, findModelById } from '../models/index.js';
import { loadAccessSettings } from '../models/accessSettings.js';
import { streamManagedAgentTurn } from '../models/managedProvider.js';
import { classifyDefinitiveProviderError } from '../models/byokProviders.js';
import { stripReasoningLines } from './reasoningLeak.js';
import { joinPath, stripVerbatimPrefix, normalizeRepoPathForGit } from '../paths.js';
import { emitEvent } from '../journal/journal.js';
import { projectIdFromRoot } from '../journal/projectId.js';

// ── Runtime availability check ────────────────────────────────────
// NOTE: intentionally NOT imported from platform/index.ts's isTauri(),
// even though the check is identical. Many test files
// `vi.mock('../lib/platform', () => ({ getPlatform: ... }))` with a
// FULL (non-partial) mock that omits isTauri — importing it here made
// those mocks throw "No isTauri export is defined on the mock" the
// instant this module's evaluated code path called it. Kept local
// until that test-mock convention is addressed (see review report).
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** True when a native CLI agent backend is available (claude-code or codex).
 *  Mirrors runtime.ts's isLiveAgentAvailable — duplicated locally (rather
 *  than imported) because runtime.ts imports evaluateMission from this
 *  module; importing back from runtime.ts would create a circular
 *  dependency. */
function isLiveAgentAvailable(): boolean {
  if (!isTauriRuntime()) return false;
  const mode = getProviderMode();
  return mode === 'claude-code' || mode === 'codex';
}

/** True when the managed (Pro) backend is the active provider mode.
 *  Mirrors runtime.ts's isManagedAgentAvailable — see isLiveAgentAvailable's
 *  comment above for why this is duplicated rather than imported. */
function isManagedAgentAvailable(): boolean {
  if (!isTauriRuntime()) return false;
  return getProviderMode() === 'managed';
}

/**
 * Resolves the model id for managed-mode evaluator sub-agents: the
 * mission's own model when it's already an OpenRouter-format id (contains
 * '/' — the same convention accessSettings.ts documents for
 * AccessSettings.model under accessMode 'pro'), otherwise the user's saved
 * preference, otherwise the mode default. This is the exact fallback chain
 * runtime.ts's planAndAct uses to resolve planAndActManaged's model (see
 * managedModel in runMission/planAndAct) — reused here so the evaluator
 * judges a mission with the same model the mission itself ran with,
 * whenever that's available.
 */
function resolveManagedModel(mission: Mission): string {
  if (mission.model.includes('/')) return mission.model;
  return loadAccessSettings().model ?? getDefaultModelIdForMode('managed');
}

/**
 * Native Anthropic model ids for the LIVE (native CLI, agent_run) evaluator
 * sub-agents — tester/reviewer/security run on the cheap tier, judge on a
 * stronger tier. MUST be full registry ids (e.g. 'claude-haiku-4-5'), never
 * a bare alias like 'haiku'/'sonnet': registry.ts's own contract states
 * there are two separate id namespaces ("Native Anthropic ids... used by
 * the CLI/BYOK Rust path" vs. OpenRouter ids for the managed path) and says
 * to "Never mix them" — chat.rs's real claude-CLI call site (used by every
 * other native-CLI caller in this app) only ever defaults to/consumes full
 * ids like "claude-haiku-4-5", never a bare alias.
 *
 * DEFECT C (2026-07 in-app QA): this file used to hardcode the bare
 * literals 'haiku' and 'sonnet' directly as agent_run's `model` field for
 * the live path. That is neither a valid native id nor an OpenRouter id —
 * every native sub-agent (tester/reviewer/security/judge) failed uniformly
 * at `claude` CLI startup, before doing any work, which is exactly why ALL
 * FOUR roles failed identically with "Evaluator exited with code 1" instead
 * of a content-dependent subset failing. Resolved via findModelById (never
 * a raw literal) so these can never silently drift from registry.ts's own
 * ids; falls back to DEFAULT_MODEL if a queried id is ever renamed there —
 * this can never throw or pass an unresolved id to the CLI.
 */
const LIVE_SUBAGENT_MODEL = findModelById('claude-haiku-4-5')?.id ?? DEFAULT_MODEL.id;
const LIVE_JUDGE_MODEL = findModelById('claude-sonnet-5')?.id ?? DEFAULT_MODEL.id;

// ── Tauri event types ─────────────────────────────────────────────

interface AgentDoneEvent {
  result: string;
  exit_code: number;
}

// ── Helpers ───────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Grace period (ms) a failing agent://done event waits for its companion
 *  agent://error event before giving up on it — see runEvaluatorAgent. */
const EVALUATOR_ERROR_GRACE_MS = 300;

/**
 * Run a single evaluator sub-agent via agent_run.
 * Returns the raw text result from the agent.
 * Rejects if the agent runner is unavailable.
 *
 * DEFECT C (2026-07 in-app QA): agent_run (agent.rs) always emits BOTH
 * agent://done and agent://error together whenever the CLI process fails
 * (non-zero exit code, or is_error in its result line) — done carries only
 * the bare exit code, error carries the real reason (stderr output, or the
 * is_error summary). This function used to resolve as soon as EITHER event
 * arrived, so whichever happened to be delivered first won: in practice
 * that was always the done event (emitted first on the Rust side), which
 * meant the generic "Evaluator exited with code N" always won the race and
 * silently discarded the error event's actual diagnostic text — every
 * native sub-agent (tester/reviewer/security/judge) failed with that exact
 * uninformative message no matter what actually went wrong underneath.
 *
 * Fix: a failing done event no longer resolves immediately — it records a
 * generic fallback message and gives the companion error event a brief
 * grace window to arrive and overwrite it with the real reason (which it
 * always does, per agent_run's contract above). If no error event shows up
 * within that window (contract violation / edge case), the generic message
 * is used so this can never hang forever — HONESTY CONTRACT: always settle
 * with the best information available, never silently wait forever.
 *
 * Also fixes a related hang: previously, if invoke('agent_run', ...) itself
 * rejected synchronously (e.g. ensure_repo_in_project's path validation
 * failing before the Rust command ever emits a done/error event), the
 * promise below was never resolved and this function — and the whole
 * evaluator pipeline awaiting it — hung indefinitely instead of surfacing
 * an honest failure.
 */
async function runEvaluatorAgent(opts: {
  evalId: string;
  task: string;
  worktreePath: string;
  model: string;
}): Promise<string> {
  const { evalId, task, worktreePath, model } = opts;

  const doneEventName = `agent://done/${evalId}`;
  const errorEventName = `agent://error/${evalId}`;

  let result = '';
  let agentError: string | null = null;
  let settled = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveFinished: () => void = () => undefined;
  const cleanups: Array<() => void> = [];

  const agentFinished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    for (const fn of cleanups) fn();
    resolveFinished();
  };

  const [doneUnsub, errorUnsub] = await Promise.all([
    listen<AgentDoneEvent>(doneEventName, (event) => {
      if (settled) return;
      result = event.payload.result ?? '';
      if (event.payload.exit_code === 0) {
        settle();
        return;
      }
      // Generic fallback only — agent://error (same Rust code path, always
      // emitted alongside a failing done event) carries the real reason and
      // overwrites this if it arrives within the grace window below.
      agentError = `Evaluator exited with code ${event.payload.exit_code}`;
      fallbackTimer = setTimeout(settle, EVALUATOR_ERROR_GRACE_MS);
    }),
    listen<string>(errorEventName, (event) => {
      if (settled) return;
      agentError = event.payload ?? 'Evaluator error';
      settle();
    }),
  ]);
  cleanups.push(doneUnsub, errorUnsub);

  invoke('agent_run', {
    req: {
      id: evalId,
      worktreePath: normalizeRepoPathForGit(worktreePath),
      tool: 'claude',
      model,
      task,
      system: 'You are an autonomous evaluator. Assess the given diff/task and output a concise JSON verdict.',
      // DEFECT 1 (2026-07 acceptance test): the evaluator sub-agents used to
      // run in 'plan' mode (--permission-mode=plan), which is READ-ONLY and
      // blocks execution tools (Bash). The tester sub-agent therefore could
      // NOT run the test suite, reported a false failure, and the judge then
      // penalized a perfectly good change for the evaluator's OWN inability to
      // execute — scoring it 0 / request_changes. Run the sub-agents with
      // 'acceptEdits' instead — the same execution-capable mode the
      // implementer mission uses (see runtime.ts) — so the tester can actually
      // run tests. Mapping is in lib.rs's permission_flag(): 'plan' ->
      // --permission-mode=plan (no exec), 'acceptEdits' ->
      // --permission-mode=acceptEdits (exec allowed). --allowedTools is
      // additive under acceptEdits (agent.rs), so naming Read/Bash documents
      // the tester's needs without narrowing anything.
      // camelCase is required — AgentRunRequest (src-tauri/src/commands/agent.rs)
      // has #[serde(rename_all = "camelCase")]; a snake_case key silently
      // deserializes to None (see runtime.ts's matching fix).
      permissionMode: 'acceptEdits',
      allowedTools: ['Read', 'Bash'],
      deniedTools: undefined,
    },
  }).catch((err: unknown) => {
    // invoke() rejecting means the Tauri command failed synchronously,
    // before it ever got to emit a done/error event — settle here so this
    // never hangs (see this function's doc comment above).
    agentError = agentError ?? String(err);
    settle();
  });

  await agentFinished;

  if (agentError) {
    throw new Error(agentError);
  }

  return result;
}

/**
 * Run a single evaluator sub-agent turn through the managed (Pro) provider.
 * Unlike runEvaluatorAgent (native CLI path, which gives the sub-agent its
 * own Bash tool via agent_run), the managed proxy only streams one LLM
 * completion per call — there is no agentic tool-use loop wired up for it
 * here. Any real command output a role needs (e.g. test results) must be
 * gathered beforehand and folded into the task text — see runManagedTester,
 * which is why the tester role never calls this at all.
 */
async function runManagedEvaluatorAgent(opts: { task: string; model: string }): Promise<string> {
  let text = '';
  for await (const chunk of streamManagedAgentTurn({
    messages: [{ role: 'user', content: opts.task }],
    system:
      'You are an autonomous evaluator. Assess the given diff/task and output a concise JSON verdict.',
    model: opts.model,
  })) {
    text += chunk;
  }
  return text;
}

/** The only valid ReviewerVerdict['verdict'] literals — anything else out of
 *  a sub-agent's JSON (a hallucinated string, a number, an object) must never
 *  reach ReviewerVerdict.verdict as-is. See parseReviewerResult's shape
 *  validation below. */
const VALID_VERDICT_OUTCOMES: ReadonlySet<VerdictOutcome> = new Set([
  'approve',
  'request_changes',
  'reject',
]);

function isValidVerdictOutcome(value: unknown): value is VerdictOutcome {
  return typeof value === 'string' && VALID_VERDICT_OUTCOMES.has(value as VerdictOutcome);
}

/**
 * Parse a ReviewerVerdict out of an agent's raw text output.
 * The agent is asked to produce JSON but may not — we do a best-effort parse
 * and fall back to a text-based verdict when JSON is absent.
 *
 * `raw` is stripped of leaked reasoning-channel lines (stripReasoningLines,
 * reasoningLeak.ts — the SAME rule managerEngine.ts's sanitizeManagerDisplayText
 * applies to the manager's own reply) BEFORE any JSON extraction or text
 * fallback: a managed/reasoning-model sub-agent can spill whole
 * `[reasoning]…` lines ahead of its actual verdict, and without this the
 * leak would ride straight into `summary` — surfaced verbatim in Cockpit's
 * "Rejeter avec feedback" popover and the gate.failed journal payload.
 *
 * VALIDATION (B4): the matched text can be syntactically valid JSON while
 * still being the wrong SHAPE — a sub-agent can hallucinate `verdict` as a
 * number, `summary` as a nested object, or `verdict` as a string outside the
 * three known literals. Casting straight to `Partial<ReviewerVerdict>` (the
 * previous code) trusted that shape at face value and let a wrong-typed
 * value flow into the returned ReviewerVerdict — from there into judge
 * prompts, journal payloads, and UI text. Every field is now checked
 * explicitly; anything that fails validation falls back to the exact same
 * safe default the "no JSON found at all" path already used below, so a
 * malformed response degrades to a clearly-labelled non-approval instead of
 * an undefined/incoherent state.
 */
export function parseReviewerResult(
  raw: string,
  role: ReviewerVerdict['role'],
): ReviewerVerdict {
  const cleaned = stripReasoningLines(raw);
  try {
    // Look for the first JSON object in the output
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsedRaw: unknown = JSON.parse(jsonMatch[0]);
      if (typeof parsedRaw === 'object' && parsedRaw !== null && !Array.isArray(parsedRaw)) {
        const parsed = parsedRaw as Record<string, unknown>;
        return {
          role,
          verdict: isValidVerdictOutcome(parsed.verdict) ? parsed.verdict : 'request_changes',
          summary: typeof parsed.summary === 'string' ? parsed.summary : cleaned.slice(0, 200),
          score:
            typeof parsed.score === 'number' && Number.isFinite(parsed.score)
              ? parsed.score
              : undefined,
        };
      }
      // Matched `{...}` but it parsed into something other than a plain
      // object (e.g. `null`) — fall through to the text heuristic below,
      // same as "no JSON found at all".
    }
  } catch {
    // Fall through to text-based extraction
  }

  // Heuristic: look for approve/reject keywords in the output
  const lower = cleaned.toLowerCase();
  const verdict: ReviewerVerdict['verdict'] = lower.includes('approve')
    ? 'approve'
    : lower.includes('reject')
    ? 'reject'
    : 'request_changes';

  return {
    role,
    verdict,
    summary: cleaned.slice(0, 300).replace(/\n+/g, ' ').trim(),
  };
}

// ── "Asked-but-never-ran" detection (R13 — M18 false-pass dogfood fix) ────
//
// BLOQUANT (R13 dogfood, 2026-07): a verification mission's tester sub-agent
// can get stuck at a pending/blocked Bash-approval request (the underlying
// CLI asked to run the command and never actually received an approval — see
// the real captured feedback: "tu t'es arrêté à la demande d'approbation pour
// la commande Bash et tu as rapporté ça comme résultat final") and STILL
// free-write a confident "approve"/"passed" JSON verdict in its final reply —
// an LLM asked to "assess and output a verdict" can hallucinate success over
// a tool call it never completed. `parseReviewerResult` trusts that JSON at
// face value, so this read straight through as a fabricated pass (M18).
//
// This is detected from the raw sub-agent transcript text itself (never
// trusting the model's own self-report), mirroring hasNoTestScriptConfigured's
// "detect the structural problem before trusting the verdict" shape: keyword
// markers (FR + EN) for a pending/blocked tool-approval request, combined
// with the ABSENCE of any real execution evidence (an exit-code marker or
// parseable pass/fail counts) — a transcript that both asked for approval AND
// shows real command output afterward (e.g. a retried, later-approved call)
// must not be misread as blocked.

/** Keyword markers (FR + EN) for a pending/blocked tool-approval request —
 *  the agent ASKED to run a command and stopped there, rather than actually
 *  executing it. Matched case-insensitively against a sub-agent's raw output. */
const BLOCKED_APPROVAL_MARKERS =
  /\b(waiting for approval|requires? (your )?approval|needs? approval|permission (is )?required|permission denied|not (been )?granted permission|awaiting approval|approval request|tool use was rejected|demande d'approbation|en attente d'approbation|n[ée]cessite (une )?approbation|permission refus[ée]e)\b/i;

/** Evidence a command actually ran to completion: an exit-code marker (the
 *  same `[exit N]` shape toolRuntime.ts's formatRunCommandResult produces) or
 *  parseable pass/fail counts (parseTestCounts's own pattern, reused here). */
const EXECUTION_EVIDENCE = /\[exit \d+\]|\bexit code[:\s]+\d+\b|\d+\s+(passed|failed)\b/i;

/**
 * True when `raw` reads as a sub-agent that got stuck at a pending/blocked
 * tool-approval request WITHOUT any evidence a command actually ran (see this
 * section's header comment). A heuristic, same honesty limits as
 * `parseReviewerResult`'s own keyword fallback — but the only real
 * evaluator-side defense against a verification mission's sub-agent claiming
 * success over a tool call it never completed.
 */
export function looksLikeAskedButNeverRan(raw: string): boolean {
  return BLOCKED_APPROVAL_MARKERS.test(raw) && !EXECUTION_EVIDENCE.test(raw);
}

/**
 * Overrides a parsed ReviewerVerdict to inconclusive when its own raw source
 * text shows the "asked-but-never-ran" shape (see looksLikeAskedButNeverRan)
 * — regardless of what the parsed JSON/heuristic verdict itself claimed.
 * Inconclusive is a NON-VOTE (aggregateVerdict, DEFECT 1): this can never
 * read as a code rejection, and — critically — can never be trusted as an
 * "approve" either, closing the false-pass gap. A verdict with no matching
 * raw evidence passes through completely unchanged.
 */
function guardAgainstAskedButNeverRan(verdict: ReviewerVerdict, raw: string): ReviewerVerdict {
  if (!looksLikeAskedButNeverRan(raw)) return verdict;
  return {
    ...verdict,
    verdict: 'request_changes',
    summary:
      `Asked to run a command but never received an executed result (blocked/pending approval request) — ` +
      `inconclusive, NOT a real pass, regardless of what the sub-agent's own summary claimed. Raw: ${verdict.summary}`,
    inconclusive: true,
  };
}

// ── "Nothing to review" approval guard (M2 forensics) ─────────────────
//
// Real captured failure (mission M2, lazy-backoffice): the security
// sub-agent was handed an essentially empty diff and reasoned, correctly on
// its own narrow terms, that an empty repository carries no security risk —
// "Repository est vierge avec seed initial. Aucun code source détecté — pas
// de risques de secrets codés en dur…" — then expressed that as verdict:
// 'approve'. The final judge then treated that approval as positive
// evidence and approved too: "Le dépôt ne contient qu'un commit de seed,
// sans code source. L'agent security confirme l'absence de risques…".
// "No code to review, therefore nothing is wrong" is a category error:
// approve means "I checked, it's good" — there was nothing to check.
//
// The PRIMARY defense is evaluateMission's own mission.emptyDeliverable
// short-circuit below, which never lets ANY of these prompts run at all
// against a mission whose diff is genuinely empty. This guard is the
// belt-and-braces backstop for every path that check cannot cover (a
// partial/trivial diff that isn't literally empty, a future bypass of the
// short-circuit, evaluateScripted's own placeholder path) — same shape as
// looksLikeAskedButNeverRan/guardAgainstAskedButNeverRan above: detected
// from the raw sub-agent transcript text itself, never trusting the
// model's own verdict field at face value.

/** Keyword markers (FR + EN) for "there was no diff/no code to review" —
 *  matched case-insensitively against a sub-agent's raw output. Deliberately
 *  narrow (real M53/M2 dogfood wording, not generic words like "no issues"
 *  or "no security issues" that a genuinely GOOD review legitimately says)
 *  so this can never false-positive on an honest approval of real work. */
// Note: deliberately no TRAILING \b — JS regex's \b is ASCII-only (\w =
// [A-Za-z0-9_]), so a phrase ending in an accented letter (e.g. "détecté",
// "trouvé") is followed by a non-word char on BOTH sides and a trailing \b
// would never match there (this broke the FR alternatives below during
// development — see reviewPreflight-adjacent evaluator.test.ts's
// looksLikeVacuousApproval suite for the regression coverage). A leading \b
// is safe (every alternative starts with a plain ASCII letter) and is kept
// to avoid matching mid-word.
const NO_DIFF_MARKERS =
  /\b(nothing to review|empty diff|no diff (was |is )?(provided|available)|no (code|changes?|content|source code) (was |were |is |to )?(provided|found|detected|available|to review)|repository is (empty|blank)|aucun code(\s+source)?\s+(d[ée]tect[ée]|trouv[ée]|fourni)|sans code source|d[ée]p[ôo]t (est )?vierge|rien [àa] (revoir|examiner)|aucune modification (n'a )?[ée]t[ée] fournie)/i;

/**
 * True when `raw` reads as a sub-agent that approved on the grounds that
 * there was nothing to review (see this section's header comment) —
 * regardless of whether `verdict` itself is 'approve' (the check only
 * matters when it is; callers gate on that).
 */
export function looksLikeVacuousApproval(raw: string): boolean {
  return NO_DIFF_MARKERS.test(raw);
}

/**
 * Overrides a parsed ReviewerVerdict to inconclusive when it approved AND
 * its own raw source text shows the "nothing to review, therefore approve"
 * shape (see looksLikeVacuousApproval) — mirrors
 * guardAgainstAskedButNeverRan's shape exactly. Inconclusive is a NON-VOTE
 * (aggregateVerdict, DEFECT 1): this can never read as a code rejection,
 * and — critically — can never be trusted as an "approve" either, closing
 * the M2 false-pass gap. Never touches a 'request_changes'/'reject'
 * verdict, or one whose raw text has no matching evidence.
 */
function guardAgainstVacuousApproval(verdict: ReviewerVerdict, raw: string): ReviewerVerdict {
  if (verdict.verdict !== 'approve') return verdict;
  if (!looksLikeVacuousApproval(raw)) return verdict;
  return {
    ...verdict,
    verdict: 'request_changes',
    summary:
      `Overridden: ${verdict.role} approved on the grounds that there was nothing to review — ` +
      `"no code = no risk" is not evidence of correctness (see M2 forensics). Raw: ${verdict.summary}`,
    inconclusive: true,
  };
}

// ── Unavailable-runtime placeholder ──────────────────────────────

/**
 * Returns a clearly-labelled placeholder verdict for use when the live
 * runtime (Tauri + claude CLI) is not available. Never fabricates approval.
 */
function buildUnavailableVerdict(): JudgeVerdict {
  const placeholder: ReviewerVerdict = {
    role: 'judge',
    verdict: 'request_changes',
    summary:
      'Evaluation unavailable (no agent runtime). ' +
      'The live Tauri + claude CLI runtime is required to run tester/reviewer/judge sub-agents. ' +
      'Open the desktop app with a configured claude CLI to get a real verdict.',
    score: undefined,
  };

  return {
    score: 0,
    passed: false,
    risk: 'high',
    reviewers: [placeholder],
    createdAt: nowIso(),
    // R11 — no sub-agent ever ran at all (no runtime), so `score: 0` above
    // is a placeholder, never a real evaluation — see aggregateVerdict's
    // own doc comment / JudgeVerdict.scoreUnavailable for the honesty rule
    // this flag drives in the UI.
    scoreUnavailable: true,
  };
}

// ── Diff coverage gap — trust-critical defect #1 (M53 forensics) ──
//
// Never run the normal judge pipeline against a diff that runtime.ts's
// Step C (reviewPreflight.ts's detectDiffCoverageGap) already found to be
// missing real content the worktree's own `git status` reports. Reviewing
// a partial diff as if it were the whole deliverable is exactly what
// happened to mission M53: a real 19-file Vite scaffold, reviewed as
// "README.md, 952 lines added" — the judges believed a README was the
// whole deliverable and rejected genuinely good, unseen work.

/**
 * Returns a clearly-labelled, never-fabricated verdict for a mission whose
 * diff does not represent everything in its worktree — same "explicit
 * placeholder, no invented pass" convention as buildUnavailableVerdict/
 * buildNoTestScriptVerdict above. Always request_changes: a human must look
 * at the worktree directly (or re-run the mission so its own commit step
 * captures everything) before this mission can be judged at all — the judge
 * sub-agents are never even invoked, since whatever they'd see is known in
 * advance to be incomplete.
 */
function buildDiffCoverageGapVerdict(missingFiles: readonly string[]): JudgeVerdict {
  const fileList = missingFiles.join(', ');
  const placeholder: ReviewerVerdict = {
    role: 'judge',
    verdict: 'request_changes',
    summary:
      `Diff incomplete: the worktree contains ${missingFiles.length} file(s) that git sees as ` +
      `changed but that never made it into the computed diff — ${fileList}. ` +
      'This diff does not represent the mission\'s full output, so it was never handed to the ' +
      'tester/reviewer/security sub-agents — reviewing a partial diff as if it were complete is ' +
      'how real work gets rejected unseen. Inspect the worktree directly, or re-run the mission ' +
      'so its own commit step captures everything, before judging it.',
    score: undefined,
    // Not a code-quality objection — the evaluator infrastructure itself
    // refused to run, same non-vote semantics as a tester that couldn't
    // execute (see ReviewerVerdict.inconclusive's own doc comment).
    inconclusive: true,
  };

  return {
    score: 0,
    passed: false,
    risk: 'high',
    reviewers: [placeholder],
    createdAt: nowIso(),
    scoreUnavailable: true,
  };
}

// ── Empty deliverable — trust-critical defect #2 (M2 forensics) ───
//
// Mirrors buildDiffCoverageGapVerdict above exactly, for the sibling defect:
// never run the judge pipeline against a mission whose diff is genuinely
// EMPTY (mission.emptyDeliverable, set by runtime.ts's Step C — see
// reviewPreflight.ts's isDiffGenuinelyEmpty + this file's own
// isVerificationMission for how that flag is computed and why a diff-less
// verification mission is the one legitimate exception, never routed
// here). Real case: mission M2 produced a worktree with only the
// pre-existing README.md — zero commits — yet still collected a security
// "approve" ("no code = no risk, by construction") and a final judge
// approval leaning on that vacuous approval as positive evidence (1/2
// approve on a mission that did nothing).

/**
 * Returns a clearly-labelled, never-fabricated verdict for a mission whose
 * diff is genuinely empty — same "explicit placeholder, no invented pass"
 * convention as buildUnavailableVerdict/buildDiffCoverageGapVerdict above.
 * Always request_changes: an empty deliverable is not evidence of
 * correctness, it means the work was never done — a human must look at the
 * mission directly (re-run it, or discard it) before it can be judged at
 * all. The judge sub-agents are never even invoked, since "no code = no
 * risk" is exactly the vacuous reasoning that let M2 collect approvals.
 */
function buildEmptyDeliverableVerdict(): JudgeVerdict {
  const placeholder: ReviewerVerdict = {
    role: 'judge',
    verdict: 'request_changes',
    summary:
      'Mission produced no deliverable: the worktree diff is genuinely empty (no commits, no file ' +
      'changes) and this mission does not read as a diff-less verification/investigation task. An ' +
      'empty deliverable is not evidence of correctness — it means the work was never done. The ' +
      'tester/reviewer/security/judge pipeline was never run against it; this is an honest failure, ' +
      'never a fabricated approval built from "no code = no risk" reasoning (see mission M2).',
    score: undefined,
    // Not a code-quality objection — there was no code to have an opinion
    // about. Same non-vote semantics as buildDiffCoverageGapVerdict's own
    // placeholder (ReviewerVerdict.inconclusive's doc comment).
    inconclusive: true,
  };

  return {
    score: 0,
    passed: false,
    risk: 'high',
    reviewers: [placeholder],
    createdAt: nowIso(),
    scoreUnavailable: true,
  };
}

// ── Scripted evaluation fallback (mock mode) ──────────────────────

/** Local non-vote consensus for evaluateScripted — the same DEFECT-1 rule
 *  aggregateVerdict applies for evaluateLive/evaluateManaged (a conclusive
 *  reviewer decides, an `inconclusive` one is never counted as a rejection),
 *  kept as its own small function rather than a call into aggregateVerdict:
 *  that function also parses judge JSON and derives risk from a `security`
 *  role, neither of which this no-LLM mode ever has. Bug fixed here: the
 *  previous version hardcoded `passed: false` unconditionally, so even a
 *  worktree whose tests genuinely passed could never clear evaluation —
 *  runner unavailability (or any other non-vote) must never be the reason a
 *  mission fails, but it must not be the reason one is forced to pass either. */
function aggregateScriptedVerdict(
  reviewers: ReviewerVerdict[],
  testsResult: { passed: number; failed: number } | undefined,
): JudgeVerdict {
  const conclusive = reviewers.filter((r) => r.inconclusive !== true);
  const passed = conclusive.length > 0 && conclusive.every((r) => r.verdict === 'approve');
  const conclusiveScores = conclusive
    .map((r) => r.score)
    .filter((s): s is number => typeof s === 'number');
  const scoreUnavailable = conclusiveScores.length === 0;

  return {
    score: scoreUnavailable
      ? 0
      : Math.round(conclusiveScores.reduce((a, b) => a + b, 0) / conclusiveScores.length),
    passed,
    // No security role ever runs in this mode: 'high' is the honest
    // conservative default whenever nothing conclusive backs a lower risk,
    // 'medium' once a real tester result is the one thing that does.
    risk: passed ? 'medium' : 'high',
    reviewers,
    tests: testsResult,
    createdAt: nowIso(),
    ...(scoreUnavailable ? { scoreUnavailable: true } : {}),
  };
}

/**
 * Scripted evaluator for the "Tauri, no engine" mode (pro-not-active,
 * live-key/BYOK such as DeepSeek, or mock) — no live CLI agent and no
 * managed subscription means no LLM sub-agent can review the diff. Runs the
 * REAL test runner (platform.tests.run, backed by the Rust run_tests
 * command) against the mission's OWN worktree — never the base repoPath,
 * which reflects pre-mission state and would silently grade the wrong code
 * (BUG fixed here: the previous version was called with repoPath, matching
 * evaluateLive/evaluateManaged's tester, which both correctly use
 * worktreePath — see runManagedTester's doc comment).
 *
 * A tester that could not run at all (no recognised test tool in the
 * worktree, missing binary, timeout) is `inconclusive` — a NON-VOTE, same
 * DEFECT-1 contract as every other pipeline in this file — never a
 * fabricated `request_changes`. The reviewer/judge placeholders are marked
 * `inconclusive` for the identical reason (no LLM ever ran them for real).
 * aggregateScriptedVerdict then decides `passed` from whichever roles are
 * actually conclusive, so a mission whose real tests pass can now genuinely
 * pass here too, instead of the previous unconditional `passed: false`.
 */
/**
 * B25 — when scripted mode has a real deliverable (diff / files), leave the
 * LLM-reviewer placeholder and emit a conclusive heuristic review instead of
 * an always-inconclusive stub. Still honest: never invents a pass on empty
 * work, and flags obvious gap markers (TODO/FIXME bombs in the snippet).
 */
export function buildScriptedReviewerVerdict(mission: Mission): ReviewerVerdict {
  const hasDiff =
    (mission.diffSnippet?.length ?? 0) > 0 || (mission.diffFiles?.length ?? 0) > 0;
  if (!hasDiff) {
    return {
      role: 'reviewer',
      verdict: 'request_changes',
      summary:
        `Scripted mode has no live agent to review "${mission.title}" and no diff ` +
        'deliverable was present — no actual code critique was performed.',
      inconclusive: true,
    };
  }
  const snippet = (mission.diffSnippet ?? []).join('\n');
  const bomb = /\b(?:TODO|FIXME|XXX)\b/.test(snippet);
  if (bomb) {
    return {
      role: 'reviewer',
      verdict: 'request_changes',
      summary:
        `Scripted diff review of "${mission.title}": found TODO/FIXME markers in the ` +
        'diff snippet — request changes (no LLM; heuristic only).',
      score: 40,
    };
  }
  const fileCount = mission.diffFiles?.length ?? 0;
  return {
    role: 'reviewer',
    verdict: 'approve',
    summary:
      `Scripted diff review of "${mission.title}": ${fileCount || 'non-empty'} file change(s), ` +
      'no TODO/FIXME bombs in the snippet (heuristic — not a live LLM review).',
    score: 75,
  };
}

/** B25 — conclusive scripted judge when at least one real vote exists. */
export function buildScriptedJudgeVerdict(
  reviewers: readonly ReviewerVerdict[],
): ReviewerVerdict {
  const conclusive = reviewers.filter((r) => r.role !== 'judge' && r.inconclusive !== true);
  if (conclusive.length === 0) {
    return {
      role: 'judge',
      verdict: 'request_changes',
      summary:
        'Evaluation ran in scripted mode with no conclusive tester/reviewer vote — ' +
        'use the desktop CLI or managed engine for a full review.',
      inconclusive: true,
    };
  }
  const allApprove = conclusive.every((r) => r.verdict === 'approve');
  const scores = conclusive
    .map((r) => r.score)
    .filter((s): s is number => typeof s === 'number');
  return {
    role: 'judge',
    verdict: allApprove ? 'approve' : 'request_changes',
    summary: allApprove
      ? `Scripted judge: ${conclusive.length} conclusive vote(s) all approve (tester/diff heuristic).`
      : `Scripted judge: ${conclusive.length} conclusive vote(s); at least one requested changes.`,
    score: scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : undefined,
  };
}

async function evaluateScripted(
  mission: Mission,
  worktreePath: string,
  onProgress?: (msg: string) => void,
): Promise<JudgeVerdict> {
  onProgress?.('Running test suite (scripted mode)…');
  await delay(400);

  const platform = getPlatform();
  let testsResult: { passed: number; failed: number } | undefined;
  let testerVerdict: ReviewerVerdict;

  try {
    const run = await platform.tests.run(worktreePath);
    testsResult = { passed: run.passed, failed: run.failed };
    onProgress?.(`Tests: ${run.passed} passed, ${run.failed} failed`);
    testerVerdict = {
      role: 'tester',
      verdict: testsResult.failed === 0 ? 'approve' : 'request_changes',
      summary: `${testsResult.passed} tests passed, ${testsResult.failed} failed (real test runner).`,
      score: testsResult.failed === 0 ? 85 : Math.max(0, 85 - testsResult.failed * 10),
    };
  } catch (err) {
    // Runner genuinely unavailable for this worktree (no recognised test
    // tool, missing binary, timeout — see test_runner.rs's detect_tool) —
    // an evaluator-INFRASTRUCTURE failure, not evidence the change is bad.
    // NON-VOTE (DEFECT 1), same convention as runManagedTester's identical
    // catch branch: "could not run" must never read as "rejected".
    onProgress?.('Test runner unavailable in this environment');
    testerVerdict = {
      role: 'tester',
      verdict: 'request_changes',
      summary: `Test runner unavailable — ${String(err).slice(0, 200)}. No verdict was fabricated.`,
      inconclusive: true,
    };
  }

  await delay(200);

  // B25 — leave the reviewer/judge placeholder when a scripted path is
  // possible (real tests and/or a real diff deliverable).
  const reviewerVerdict = buildScriptedReviewerVerdict(mission);
  const judgeVerdict = buildScriptedJudgeVerdict([testerVerdict, reviewerVerdict]);

  return aggregateScriptedVerdict([testerVerdict, reviewerVerdict, judgeVerdict], testsResult);
}

// ── Shared sub-agent task prompts (native + managed paths) ────────
// Extracted so evaluateLive and evaluateManaged send the exact same
// reviewer/security/judge instructions regardless of which backend runs them.
// The tester prompt is NOT shared: the native tester asks the sub-agent to
// run tests itself (it has its own Bash tool via agent_run), while the
// managed tester runs the command directly (see runManagedTester) — there is
// no equivalent LLM prompt on that path.

/**
 * Resolves the mission's own stated objective/acceptance criteria — the
 * literal thing the user asked for — for feeding to the reviewer/security/
 * judge prompts below. Falls back through contract.objective (the
 * formalized launch contract, spec §8) -> agentTask (the full task prompt
 * actually given to the implementer) -> title (the last resort every
 * mission always has).
 *
 * MISSION-JUDGE-OBJECTIVE FIX (2026-08, real repro): a mission "crée un
 * fichier hello.txt à la racine contenant exactement le mot BONJOUR" was
 * carried out correctly — the file existed with exactly that content — and
 * still scored 15/100 and had its merge blocked. Root cause: the reviewer/
 * security/judge prompts below never told the sub-agents WHAT the mission
 * was actually trying to achieve, only a generic code-quality rubric
 * ("immutability, naming, error handling, file size, function length") with
 * nothing in a one-line text file to apply it to, plus an instruction
 * (formerly NEVER_APPROVE_NOTHING_TO_REVIEW) that forced a reject verdict
 * for ANY diff read as having "no meaningful code to review" — which is
 * exactly what a correct non-code deliverable looks like. Feeding the real
 * objective in lets every role grade "did the diff satisfy what was asked"
 * instead of "is there code here worth admiring".
 */
function missionObjectiveText(mission: Mission): string {
  const objective = mission.contract?.objective?.trim();
  if (objective) return objective;
  const agentTask = mission.agentTask?.trim();
  if (agentTask) return agentTask;
  return mission.title;
}

/**
 * Shared preamble for buildReviewerTask/buildSecurityTask/buildJudgeTask:
 * states the mission's real objective and instructs every role to grade
 * against IT — not against a one-size-fits-all code-quality checklist. See
 * missionObjectiveText's doc comment for the real failure this fixes.
 *
 * Explicitly calls out the non-code case (a plain-text file, a config
 * value, a JSON/YAML fixture, a markdown doc, an asset, a rename, or a
 * deletion): code-quality criteria like "immutability" or "function length"
 * do not apply to those and must never be used to penalize them. A correct,
 * minimal, non-code deliverable that matches the objective is a legitimate
 * high-scoring pass — being small or simple is not evidence of a problem.
 */
function objectiveGradingPreamble(mission: Mission): string {
  return (
    `Stated objective / acceptance criteria: ${missionObjectiveText(mission)}\n\n` +
    `Judge the diff primarily on whether it satisfies this objective — that is the acceptance ` +
    `criterion, not code sophistication. If the deliverable is NOT source code (a plain-text file, ` +
    `a config value, a JSON/YAML fixture, a markdown doc, an asset, a rename, or a deletion), ` +
    `code-quality criteria meant for source code (immutability, naming conventions, function length, ` +
    `and similar) simply do not apply to it and MUST NOT be used to penalize it — grade it instead on ` +
    `whether its content/structure exactly matches what the objective asked for. A correct, minimal, ` +
    `non-code deliverable that matches the objective is a legitimate high-scoring pass; being small ` +
    `or simple is not evidence of a problem.\n\n`
  );
}

/** Shared closing rule for buildReviewerTask/buildSecurityTask (M2
 *  forensics): "no code = no risk" is not a valid basis for approval when
 *  the diff is genuinely EMPTY — see guardAgainstVacuousApproval's doc
 *  comment above for the real failure this backstops (security approved an
 *  empty repo as risk-free, the judge then treated that as positive
 *  evidence). Code-enforced by guardAgainstVacuousApproval regardless of
 *  what the sub-agent outputs; this instruction is the first line of
 *  defense, not the only one.
 *
 *  2026-08 fix: this used to fire on ANY diff read as having "no meaningful
 *  code to review" — which also matches a correct non-code deliverable, not
 *  just a genuinely empty one (see missionObjectiveText's doc comment for
 *  the real repro this caused). Narrowed to fire only on a diff with NO
 *  real content at all; a diff that DOES have content — code or not — must
 *  be graded against the objective (objectiveGradingPreamble above) instead
 *  of rejected merely for lacking source code to critique. */
const NEVER_APPROVE_EMPTY_DIFF =
  `If the diff above is completely empty (no lines added, removed, or changed at all), you MUST NOT ` +
  `approve — output "request_changes" and say explicitly that there was nothing to review. An empty ` +
  `diff is never evidence of correctness, and "no code = no risk" is not a valid reason to approve. ` +
  `But a diff that DOES contain real content is never "nothing to review" merely because that ` +
  `content is not source code — judge it against the stated objective above instead.\n\n`;

/** Shared closing rule (2026-08 fabrication incident — the second, and more
 *  important, line of defense; see ANTI_FABRICATION_INSTRUCTION in
 *  managedAgentPolicy.ts for the producing-side instruction this backstops).
 *
 *  Real repro: a mission was asked to replace a stale "Coming soon" price
 *  placeholder with wording that merely "indicates availability" — no price
 *  was given anywhere in the objective, the repo, or Stripe config. The
 *  implementer invented "$29/month" across every locale file and the
 *  reviewer APPROVED it, because the rubric only ever checked "does this
 *  satisfy the objective" and "is the code well-formed" — a fabricated,
 *  well-formatted price satisfies both. This closes that gap: any diff
 *  introducing a specific factual claim (a price, a version number, an
 *  identifier, a date, a URL, a credential, a proper name) that is not
 *  traceable to the stated objective or to something already present in the
 *  repo/diff context is grounds to reject, regardless of how plausible or
 *  well-formatted it looks — plausibility is not evidence of correctness.
 *  An honestly-marked placeholder (TODO, "à confirmer", an explicit gap) is
 *  the OPPOSITE of a fabrication and must never be penalized for it — see
 *  ANTI_FABRICATION_INSTRUCTION: an honest gap is strictly better than an
 *  invented value. */
const NEVER_APPROVE_FABRICATED_FACTS =
  `FABRICATION CHECK: if the diff introduces a specific factual claim — a price, a version number, an ` +
  `identifier, a date, a URL, a credential, or a proper name — that does NOT appear in the stated ` +
  `objective above and is NOT already present elsewhere in the repo/diff context, treat it as a ` +
  `fabricated fact: you MUST NOT approve. Output "request_changes" (or "reject" if you are the ` +
  `security reviewer) and say explicitly which value looks invented and where it should have come ` +
  `from instead. This applies even when the value is plausible-looking and well-formatted — e.g. an ` +
  `invented price like "$29/month" reads exactly like a real one; a confident, specific-looking number ` +
  `is never itself evidence that it is correct. An honestly-marked placeholder (a TODO, "à confirmer", ` +
  `or another clearly-labelled gap) is NOT a fabrication and must not be penalized for being ` +
  `incomplete — an honest gap is strictly better than an invented value.\n\n`;

/** Judge-side variant of NEVER_APPROVE_FABRICATED_FACTS above. The judge
 *  (buildJudgeTask) never sees the raw diff — only the reviewer/security
 *  verdict summaries — so it cannot inspect the diff itself for an invented
 *  value. What it CAN do is treat a reviewer's fabrication finding as
 *  disqualifying: a reviewer flagging an unsourced factual claim is real
 *  evidence of a defect, not a nitpick to average away against other,
 *  passing reviewers. */
const NEVER_APPROVE_FABRICATED_FACTS_JUDGE =
  `FABRICATION CHECK: if any reviewer above reports a fabricated or unsourced factual claim (a price, ` +
  `version, identifier, date, URL, credential, or proper name invented rather than sourced from the ` +
  `objective or the repo), treat that as a disqualifying defect — you MUST NOT approve, regardless of ` +
  `how well other reviewers scored the change. A confident, well-formatted invented value is never ` +
  `evidence of correctness, and it is worse than an honestly-marked placeholder.\n\n`;

function buildReviewerTask(mission: Mission, diffContext: string): string {
  return (
    `You are a senior code reviewer.\n` +
    `Mission: "${mission.title}"\n` +
    objectiveGradingPreamble(mission) +
    `Diff:\n${diffContext}\n\n` +
    `When the deliverable IS source code, also review it for: code quality, immutability, naming, ` +
    `error handling, file size, function length.\n` +
    NEVER_APPROVE_EMPTY_DIFF +
    NEVER_APPROVE_FABRICATED_FACTS +
    `Output JSON: { "verdict": "approve"|"request_changes"|"reject", "summary": "...", "score": 0-100 }`
  );
}

function buildSecurityTask(mission: Mission, diffContext: string): string {
  return (
    `You are a security engineer.\n` +
    `Mission: "${mission.title}"\n` +
    objectiveGradingPreamble(mission) +
    `Diff:\n${diffContext}\n\n` +
    `Check for: hardcoded secrets, injection, missing auth, unsafe deps, exposed error details. A ` +
    `non-code deliverable with no such surface (e.g. a plain-text or config file with no executable ` +
    `logic) simply has nothing to flag here — that absence is not itself a reason to withhold ` +
    `approval.\n\n` +
    NEVER_APPROVE_EMPTY_DIFF +
    NEVER_APPROVE_FABRICATED_FACTS +
    `Output JSON: { "verdict": "approve"|"request_changes"|"reject", "summary": "...", "score": 0-100 }`
  );
}

function buildJudgeTask(mission: Mission, reviewerSummaries: string): string {
  return (
    `You are an evaluation judge aggregating verdicts for a mission.\n` +
    `Mission: "${mission.title}"\n` +
    objectiveGradingPreamble(mission) +
    NEVER_APPROVE_FABRICATED_FACTS_JUDGE +
    `This is the PRIMARY acceptance criterion — not general code sophistication. When the objective ` +
    `describes a specific, checkable artifact (a file with exact content, a config value, a deletion, ` +
    `a rename, a docs-only change) and the reviewers confirm that artifact exists and matches exactly, ` +
    `that is a genuine, high-scoring PASS — even when there is little or no source code to critique. ` +
    `Apply "all tests pass" only when tests exist for this change, and code-quality/security scrutiny ` +
    `only to the parts of the deliverable that are actually code.\n\n` +
    `Reviewer verdicts:\n${reviewerSummaries}\n\n` +
    `IMPORTANT: A reviewer marked "inconclusive" produced no usable evidence — either it could NOT ` +
    `run because of an evaluator infrastructure problem (e.g. the test suite could not be executed), ` +
    `or it approved/rejected on the grounds that there was nothing to review (an empty diff is never ` +
    `evidence of correctness). Neither is evidence that the change is wrong OR right. Treat ` +
    `inconclusive reviewers as a lack of signal: ignore them, judge only on the conclusive reviewers, ` +
    `and do NOT lower the score, raise the score, or change your verdict merely because a reviewer ` +
    `could not run or had nothing to review.\n\n` +
    `IMPORTANT: if there is no conclusive evidence at all that any real work was reviewed (every ` +
    `reviewer above is inconclusive, or the diff itself was genuinely empty), you MUST NOT approve — ` +
    `output "request_changes" and say explicitly that there is no conclusive evidence of any real ` +
    `work. Never approve on the grounds that nothing was found wrong when nothing was checked. But a ` +
    `diff that IS conclusively reviewed and matches the objective is real evidence regardless of how ` +
    `small or simple it is — never treat "trivial" as a synonym for "unreviewed".\n\n` +
    `Produce a final verdict. Output JSON:\n` +
    `{ "verdict": "approve"|"request_changes"|"reject", "summary": "...", "score": 0-100, "risk": "low"|"medium"|"high" }`
  );
}

/**
 * Builds the reviewer-summary block fed to the judge (native + managed paths).
 * Inconclusive reviewers (evaluator-infrastructure failures) are labelled as
 * such — rather than shown with their raw 'request_changes' verdict — so the
 * judge can follow buildJudgeTask's instruction to treat them as non-signals
 * instead of reading a placeholder rejection as a real one (DEFECT 1).
 */
function formatReviewerSummaries(reviewers: ReviewerVerdict[]): string {
  return reviewers
    .map((r) => {
      const status = r.inconclusive
        ? 'inconclusive (non-vote — infra failure or nothing to review, NOT a code defect)'
        : r.verdict;
      return `${r.role}: ${status} — ${r.summary}`;
    })
    .join('\n');
}

// ── Shared verdict aggregation (native + managed paths) ────────────

/**
 * Aggregates tester/reviewer/security/judge ReviewerVerdicts into the final
 * JudgeVerdict.
 *
 * DEFECT 1 (2026-07 acceptance test) — distinguishing "the change is bad /
 * tests failed" from "the evaluator could not run the tests":
 * A sub-agent flagged `inconclusive` hit an evaluator-INFRASTRUCTURE failure
 * (it could not run at all — agent_run rejected, plan-mode/CLI blocked
 * execution, the test shell failed, the worktree path was invalid). That is
 * NOT evidence the change is wrong, so an inconclusive sub-agent is treated as
 * a NON-VOTE here: it never counts as a rejection and never pulls the score
 * toward 0. This is what stops the pipeline from scoring a perfectly good
 * change 0 / request_changes just because the evaluator itself couldn't run.
 *
 *   - risk:   from the judge's JSON, falling back to the security verdict.
 *   - passed: the judge is authoritative WHEN IT ACTUALLY PRODUCED A VERDICT
 *             (conclusive); when the judge itself could not run, fall back to
 *             the consensus of the conclusive non-judge reviewers.
 *   - score:  the judge's own score when the judge is conclusive; otherwise
 *             the average of the CONCLUSIVE reviewers' scores; else 0.
 *
 * Honest limit: the judge is an LLM, so its OWN score/verdict can still be
 * mis-set if it penalizes a change for an inconclusive reviewer despite being
 * told not to (see buildJudgeTask). The deterministic guarantees above only
 * cover what this function controls — non-vote exclusion and the judge-down
 * fallback; the primary defense against the observed bug is running the
 * sub-agents with an execution-capable permission in the first place (see
 * runEvaluatorAgent) so the tester is not inconclusive at all.
 *
 * R11 (judge-score honesty rule) — a SECOND, narrower dishonesty this
 * function used to have: `judgeConclusive` above only means "the judge
 * sub-agent didn't throw" — it says NOTHING about whether the judge's raw
 * text actually PARSED as JSON. `parseReviewerResult`'s heuristic text
 * fallback (no `{...}` found, or `JSON.parse` failed) still manufactures a
 * `verdict` by scanning for the word "approve"/"reject" in the raw text, but
 * NEVER sets a `score`. The old code trusted that shaky heuristic verdict for
 * `passed` regardless, and fell back to averaging every reviewer's score —
 * which, when EVERY reviewer's response was equally unparsable prose (score
 * absent everywhere), silently became `0`: a fabricated « Verdict 0/100 » on
 * a mission the heuristic itself had just called "approve" (passed=true).
 *
 * Fixed with one additional gate, `judgeScoreParsable` (the judge is
 * conclusive AND produced a real numeric `score` from actual JSON — not the
 * text heuristic): only THEN is the judge's own `verdict` trusted for
 * `passed`; otherwise `passed` falls back to the SAME conclusive-non-judge
 * consensus rule the "judge inconclusive" case already used (reused
 * verbatim, not a second implementation). Likewise `score` only trusts the
 * judge's number when `judgeScoreParsable`; otherwise the conclusive
 * reviewers' average when one exists; only when NEITHER exists does `score`
 * fall back to the `0` placeholder — and THAT fallback is the one honestly
 * flagged via `scoreUnavailable: true`, so the UI (VerdictChip,
 * chrome/nodeChrome.tsx) can render « Verdict — » instead of a number nobody
 * actually produced, rather than presenting a fabricated 0/100 as if it were
 * real signal.
 */
function aggregateVerdict(
  reviewers: ReviewerVerdict[],
  testsResult: { passed: number; failed: number } | undefined,
  judgeVerdictRaw: string,
): JudgeVerdict {
  const judgeEntry = reviewers.find((r) => r.role === 'judge');
  // The judge counts only when it actually produced a verdict — an
  // inconclusive judge (its own sub-agent could not run) is not authoritative.
  const judgeConclusive = judgeEntry !== undefined && judgeEntry.inconclusive !== true;
  const judgeScore = judgeEntry?.score;
  // R11 — the NARROWER gate this function's own doc comment describes:
  // conclusive AND the judge's raw text actually parsed into a real numeric
  // score (parseReviewerResult's JSON branch), never the text-heuristic
  // fallback (which never sets `score` at all). Only a judge that cleared
  // this bar is trusted for `passed`/`score` below.
  const judgeScoreParsable = judgeConclusive && typeof judgeScore === 'number';

  let risk: RiskLevel = 'medium';
  try {
    const jsonMatch = judgeVerdictRaw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { risk?: string };
      if (parsed.risk === 'low' || parsed.risk === 'medium' || parsed.risk === 'high') {
        risk = parsed.risk;
      }
    }
  } catch {
    // Derive risk from security verdict
    const secVerdict = reviewers.find((r) => r.role === 'security');
    if (secVerdict?.verdict === 'reject') risk = 'high';
    else if (secVerdict?.verdict === 'approve') risk = 'low';
  }

  // Non-judge reviewers that actually produced a verdict (inconclusive ones
  // are non-votes — an evaluator-infra failure must never read as a rejection).
  const conclusiveNonJudge = reviewers.filter(
    (r) => r.role !== 'judge' && r.inconclusive !== true,
  );
  const approveCount = conclusiveNonJudge.filter((r) => r.verdict === 'approve').length;
  // R11 — `passed` only trusts the judge's own verdict when it cleared the
  // `judgeScoreParsable` bar (a real, structured JSON verdict, not a
  // keyword-scan guess over unparsable prose); otherwise it derives honestly
  // from the conclusive non-judge reviewers' consensus, same rule as the
  // "judge inconclusive" case.
  const passed = judgeScoreParsable
    ? judgeEntry!.verdict === 'approve'
    : conclusiveNonJudge.length > 0 && approveCount === conclusiveNonJudge.length;

  // Score: the judge's own score when it's genuinely parsable; otherwise the
  // average of the conclusive reviewers' scores. Inconclusive sub-agents carry
  // no signal and are excluded, so an infra failure never drags the score to 0.
  const conclusiveScores = reviewers
    .filter((r) => r.inconclusive !== true)
    .map((r) => r.score)
    .filter((s): s is number => typeof s === 'number');
  // R11 — true only when NEITHER the judge NOR any conclusive reviewer has a
  // real number to offer: the one case where `avgScore` below has no honest
  // value and falls back to a `0` placeholder. See JudgeVerdict.scoreUnavailable's
  // doc comment for what this drives in the UI.
  const scoreUnavailable = !judgeScoreParsable && conclusiveScores.length === 0;
  const avgScore = judgeScoreParsable
    ? judgeScore!
    : conclusiveScores.length > 0
    ? Math.round(conclusiveScores.reduce((a, b) => a + b, 0) / conclusiveScores.length)
    : 0;

  return {
    score: avgScore,
    passed,
    risk,
    reviewers,
    tests: testsResult,
    createdAt: nowIso(),
    ...(scoreUnavailable ? { scoreUnavailable: true } : {}),
  };
}

// ── Journal: gate.passed / gate.failed per evaluator role ─────────

/**
 * Emits gate.passed (verdict.verdict === 'approve') or gate.failed (anything
 * else, including an inconclusive infra-failure fallback verdict — its
 * summary already says "sub-agent failed", so gate.failed's `reason` stays
 * honest rather than needing a separate signal). Called once per role right
 * after evaluateLive/evaluateManaged push that role's ReviewerVerdict, native
 * and managed alike — evaluator.ts owns every evaluation path, unlike
 * runtime.ts/managedAgent.ts's engine-specific split.
 */
function emitGateEvent(projectId: string, missionId: string, verdict: ReviewerVerdict): void {
  if (verdict.verdict === 'approve') {
    void emitEvent({
      type: 'gate.passed',
      tsMs: Date.now(),
      projectId,
      missionId,
      actor: 'agent',
      payload: { role: verdict.role, score: verdict.score },
    });
    return;
  }
  void emitEvent({
    type: 'gate.failed',
    tsMs: Date.now(),
    projectId,
    missionId,
    actor: 'agent',
    payload: { role: verdict.role, reason: verdict.summary },
  });
}

// ── No-test-script detection (structural evaluator-infra check) ──────
//
// MAJEUR (R3 dogfood, 2026-07): a repo with no `npm test` script (or no
// package.json at all) makes BOTH the managed tester (runManagedTester's
// `npm test` via run_shell) and the live tester (the LLM sub-agent asked to
// "run the test suite") fail STRUCTURALLY — there is no test command to run,
// full stop. Before this fix that structural absence was indistinguishable
// from a real test failure: the managed path scored it ~20 (npm's "Missing
// script" exit reported the same way as a real failing exit code) and the
// live path let an LLM improvise a low-confidence verdict — either way
// dragging the judge's score down to ~20-30 and forcing every merge on that
// project to need a manual override, even for a perfectly good change.
//
// ReviewerVerdict.inconclusive exists for exactly this class of problem
// (evaluator-infrastructure failure, not a code defect — see DEFECT 1's
// aggregateVerdict doc comment) — this check makes the tester report
// inconclusive UP FRONT, before ever attempting to run anything, instead of
// discovering the absence via a failing command's exit code.

/**
 * True when `worktreePath` has no runnable "npm test" configured: either no
 * package.json at all, or a package.json whose "test" script is missing,
 * empty, or still `npm init`'s own placeholder
 * (`echo "Error: no test specified" && exit 1`). Mirrors the Rust side's own
 * `has_test` check (src-tauri/src/test_runner.rs's detect_tool) — kept as an
 * independent TS check here since neither the managed tester (run_shell
 * 'npm test' directly) nor the live tester (an LLM sub-agent) goes through
 * that Rust command. Never throws: any read/parse failure (missing file,
 * unreadable, malformed JSON) is itself evidence there's no runnable test
 * script, so it resolves `true` rather than propagating.
 */
async function hasNoTestScriptConfigured(worktreePath: string): Promise<boolean> {
  try {
    // read_file (the Tauri command behind platform.fs.readFile) rejects a
    // \\?\-verbatim prefix — see paths.ts's header for the bug history —
    // hence the strip here, mirroring every other read_file call site.
    const pkgPath = stripVerbatimPrefix(joinPath(worktreePath, 'package.json'));
    const raw = await getPlatform().fs.readFile(pkgPath);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true;

    const scripts = (parsed as { scripts?: unknown }).scripts;
    const testScript =
      typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)
        ? (scripts as Record<string, unknown>).test
        : undefined;

    return (
      typeof testScript !== 'string' ||
      testScript.trim().length === 0 ||
      testScript === 'echo "Error: no test specified" && exit 1'
    );
  } catch {
    return true;
  }
}

/** Shared inconclusive tester verdict for the no-test-script case (see
 *  hasNoTestScriptConfigured above) — used by both evaluateLive and
 *  runManagedTester so the summary text and inconclusive flag stay
 *  identical regardless of which pipeline hit it. */
function buildNoTestScriptVerdict(): ReviewerVerdict {
  return {
    role: 'tester',
    verdict: 'request_changes',
    summary:
      'No test script configured on this project (no package.json, or no "test" script) — ' +
      'the tester could not run. This is an evaluator-infrastructure limitation, not a code defect.',
    inconclusive: true,
  };
}

// ── Verification-mission judging (M12 dogfood fix, BLOQUANT #3) ──────
//
// A verification mission ("vérifier que le build passe" / "verify the tests
// pass" / "check that X works") never touches a file on purpose — its whole
// job is to run a command and report the result. Before this fix, that
// mission still went through the ordinary reviewer/security LLM sub-agents,
// which were handed an empty diff (mission.diffSnippet has nothing to show)
// and — same class of false negative hasNoTestScriptConfigured already
// fixes for "no test script" — read "no diff" as "nothing was done",
// scoring the mission ~20/request_changes even when its verification
// command genuinely passed. That is exactly backwards: a diff-less
// verification mission that ran its command and got a clean result should
// approve; one whose tester couldn't run at all should be inconclusive
// (a non-vote, per DEFECT 1/aggregateVerdict), NEVER a fabricated pass and
// NEVER a false rejection for having "no diff" when none was ever expected.

/** Keywords (FR + EN) that mark a mission's own text as a verification/check
 *  task rather than a code-change task. Matched against title + agentTask +
 *  contract.objective — whichever are present. */
const VERIFICATION_KEYWORDS =
  /\b(v[ée]rifi\w*|verify|verification|verifying|verified|check that|make sure (the )?(build|tests?)|s'assurer que|confirm(e|ing)? that)\b/i;

/**
 * True when `mission` reads as a verification/check task AND produced no
 * file diff. A mission that DID change files is never classified this way
 * even if its text also mentions "verify" — a real diff means there IS
 * something for the normal reviewer/security path to critique, so the
 * ordinary (non-verification) judging path remains correct for it.
 */
export function isVerificationMission(mission: Mission): boolean {
  const hasDiff = (mission.diffSnippet?.length ?? 0) > 0 || (mission.diffFiles?.length ?? 0) > 0;
  if (hasDiff) return false;

  const text = [mission.title, mission.agentTask, mission.contract?.objective]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ');
  return VERIFICATION_KEYWORDS.test(text);
}

/**
 * Builds a reviewer/security-equivalent verdict for a no-diff verification
 * mission FROM the tester's own verification output, instead of running the
 * normal LLM reviewer/security sub-agents against an empty diff (which would
 * misread "no diff" as "no work done" — see this section's header comment).
 * Never fabricates approval: mirrors the tester's own conclusiveness and
 * verdict exactly, so a passing verification run reads as approve, a failing
 * one as request_changes (with the real reason surfaced), and a tester that
 * could not run at all as inconclusive (a non-vote in aggregateVerdict).
 */
function buildVerificationOutputVerdict(
  role: 'reviewer' | 'security',
  testerVerdict: ReviewerVerdict,
): ReviewerVerdict {
  if (testerVerdict.inconclusive) {
    return {
      role,
      verdict: 'request_changes',
      summary:
        `Verification mission: no file diff expected, and the tester could not run to produce ` +
        `verification output for ${role} to judge — inconclusive (evaluator-infrastructure limitation, not a code defect).`,
      inconclusive: true,
    };
  }

  if (testerVerdict.verdict === 'approve') {
    return {
      role,
      verdict: 'approve',
      summary: `Verification mission: judged on the tester's verification output (${testerVerdict.summary}). No file diff was expected.`,
      score: testerVerdict.score,
    };
  }

  return {
    role,
    verdict: 'request_changes',
    summary: `Verification mission: verification output indicates a failure — ${testerVerdict.summary}`,
    score: testerVerdict.score,
  };
}

/**
 * For a verification mission, replaces the normal [tester, reviewer,
 * security] LLM pipeline with [tester, verification-derived reviewer,
 * verification-derived security] — see buildVerificationOutputVerdict.
 * Returns null for a non-verification mission so callers fall through to the
 * ordinary LLM reviewer/security sub-agent calls unchanged.
 */
export function buildVerificationMissionReviewers(
  mission: Mission,
  testerVerdict: ReviewerVerdict,
): ReviewerVerdict[] | null {
  if (!isVerificationMission(mission)) return null;
  return [
    testerVerdict,
    buildVerificationOutputVerdict('reviewer', testerVerdict),
    buildVerificationOutputVerdict('security', testerVerdict),
  ];
}

// ── Live evaluation (Tauri + claude CLI) ──────────────────────────

/**
 * Live evaluation pipeline: spawns tester, reviewer, security, and judge
 * sub-agent runs via agent_run, then aggregates results into a JudgeVerdict.
 */
async function evaluateLive(
  mission: Mission,
  worktreePath: string,
  repoPath: string,
  projectId: string,
  onProgress?: (msg: string) => void,
): Promise<JudgeVerdict> {
  const missionId = mission.id;
  const diffContext = mission.diffSnippet
    ? mission.diffSnippet.slice(0, 30).join('\n')
    : `Mission: ${mission.title}`;

  const reviewers: ReviewerVerdict[] = [];
  let testsResult: { passed: number; failed: number } | undefined;

  // 1. Tester — runs tests and reports pass/fail counts
  onProgress?.('Running tester sub-agent…');
  if (await hasNoTestScriptConfigured(worktreePath)) {
    // Structural evaluator-infrastructure limitation (no package.json / no
    // "test" script) — NOT a code defect (see this file's "No-test-script
    // detection" section above). Skip the sub-agent entirely rather than let
    // an LLM improvise a verdict for a repo it structurally cannot test.
    reviewers.push(buildNoTestScriptVerdict());
    emitGateEvent(projectId, missionId, reviewers[reviewers.length - 1]);
    onProgress?.('Tester: no test script configured (inconclusive)');
  } else {
    try {
      const testerTask =
        `You are a tester evaluating a code change.\n` +
        `Mission: "${mission.title}"\n` +
        `Diff summary:\n${diffContext}\n\n` +
        `Run the test suite (npm test or equivalent) and report results.\n` +
        `Output JSON: { "verdict": "approve"|"request_changes"|"reject", "summary": "...", "score": 0-100, "tests": { "passed": N, "failed": N } }`;

      const testerRaw = await runEvaluatorAgent({
        evalId: `${missionId}-tester`,
        task: testerTask,
        worktreePath,
        model: LIVE_SUBAGENT_MODEL,
      });

      // R13 — guard BEFORE pushing: a sub-agent that got stuck on a pending/
      // blocked Bash-approval request must never read as a real pass, even
      // when its own JSON claims 'approve' (see guardAgainstAskedButNeverRan's
      // doc comment — the M18 false-pass dogfood finding).
      const testerVerdict = guardAgainstAskedButNeverRan(parseReviewerResult(testerRaw, 'tester'), testerRaw);
      reviewers.push(testerVerdict);
      emitGateEvent(projectId, missionId, testerVerdict);

      // Extract test counts if the agent included them
      try {
        const jsonMatch = testerRaw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            tests?: { passed?: number; failed?: number };
          };
          if (parsed.tests) {
            testsResult = {
              passed: parsed.tests.passed ?? 0,
              failed: parsed.tests.failed ?? 0,
            };
          }
        }
      } catch {
        // Test count extraction is optional
      }

      onProgress?.(`Tester: ${testerVerdict.verdict}`);
    } catch (err) {
      reviewers.push({
        role: 'tester',
        verdict: 'request_changes',
        summary: `Tester sub-agent failed: ${String(err).slice(0, 200)}`,
        // Evaluator-infrastructure failure (the sub-agent could not run) — a
        // NON-VOTE, never a code rejection. See aggregateVerdict (DEFECT 1).
        inconclusive: true,
      });
      emitGateEvent(projectId, missionId, reviewers[reviewers.length - 1]);
      onProgress?.('Tester sub-agent failed');
    }
  }

  // Also try platform.tests.run() for more reliable counts
  if (!testsResult) {
    try {
      const platform = getPlatform();
      const run = await platform.tests.run(repoPath);
      testsResult = { passed: run.passed, failed: run.failed };
      onProgress?.(`Platform tests: ${run.passed}/${run.passed + run.failed} pass`);
    } catch {
      // Not available in this environment
    }
  }

  // Verification mission (M12 dogfood fix): no diff is expected, so judge on
  // the tester's own verification output instead of handing an LLM reviewer/
  // security sub-agent an empty diff — see buildVerificationMissionReviewers's
  // doc comment. `reviewers` has exactly the tester's verdict at this point
  // (steps above always push exactly one). Returns null (falls through to
  // the normal LLM reviewer/security calls below) for any mission that
  // isn't a diff-less verification task.
  const verificationReviewers = buildVerificationMissionReviewers(mission, reviewers[0]);

  if (verificationReviewers) {
    reviewers.push(verificationReviewers[1], verificationReviewers[2]);
    for (const verdict of verificationReviewers.slice(1)) {
      emitGateEvent(projectId, missionId, verdict);
      onProgress?.(`${verdict.role}: ${verdict.verdict}${verdict.inconclusive ? ' (inconclusive)' : ''}`);
    }
  } else {
    // 2. Reviewer — code critique
    onProgress?.('Running reviewer sub-agent…');
    try {
      const reviewerRaw = await runEvaluatorAgent({
        evalId: `${missionId}-reviewer`,
        task: buildReviewerTask(mission, diffContext),
        worktreePath,
        model: LIVE_SUBAGENT_MODEL,
      });

      reviewers.push(
        guardAgainstVacuousApproval(
          guardAgainstAskedButNeverRan(parseReviewerResult(reviewerRaw, 'reviewer'), reviewerRaw),
          reviewerRaw,
        ),
      );
      emitGateEvent(projectId, missionId, reviewers[reviewers.length - 1]);
      onProgress?.(`Reviewer: ${reviewers[reviewers.length - 1].verdict}`);
    } catch (err) {
      reviewers.push({
        role: 'reviewer',
        verdict: 'request_changes',
        summary: `Reviewer sub-agent failed: ${String(err).slice(0, 200)}`,
        // Infra failure — a NON-VOTE, not a code rejection (DEFECT 1).
        inconclusive: true,
      });
      emitGateEvent(projectId, missionId, reviewers[reviewers.length - 1]);
      onProgress?.('Reviewer sub-agent failed');
    }

    // 3. Security — security audit
    onProgress?.('Running security sub-agent…');
    try {
      const securityRaw = await runEvaluatorAgent({
        evalId: `${missionId}-security`,
        task: buildSecurityTask(mission, diffContext),
        worktreePath,
        model: LIVE_SUBAGENT_MODEL,
      });

      reviewers.push(
        guardAgainstVacuousApproval(
          guardAgainstAskedButNeverRan(parseReviewerResult(securityRaw, 'security'), securityRaw),
          securityRaw,
        ),
      );
      emitGateEvent(projectId, missionId, reviewers[reviewers.length - 1]);
      onProgress?.(`Security: ${reviewers[reviewers.length - 1].verdict}`);
    } catch (err) {
      reviewers.push({
        role: 'security',
        verdict: 'request_changes',
        summary: `Security sub-agent failed: ${String(err).slice(0, 200)}`,
        // Infra failure — a NON-VOTE, not a code rejection (DEFECT 1).
        inconclusive: true,
      });
      emitGateEvent(projectId, missionId, reviewers[reviewers.length - 1]);
      onProgress?.('Security sub-agent failed');
    }
  }

  // 4. Judge — aggregate and score
  onProgress?.('Running judge sub-agent…');
  const reviewerSummaries = formatReviewerSummaries(reviewers);

  let judgeVerdictRaw = '';
  try {
    judgeVerdictRaw = await runEvaluatorAgent({
      evalId: `${missionId}-judge`,
      task: buildJudgeTask(mission, reviewerSummaries),
      worktreePath,
      model: LIVE_JUDGE_MODEL,
    });

    reviewers.push(
      guardAgainstVacuousApproval(
        guardAgainstAskedButNeverRan(parseReviewerResult(judgeVerdictRaw, 'judge'), judgeVerdictRaw),
        judgeVerdictRaw,
      ),
    );
    emitGateEvent(projectId, missionId, reviewers[reviewers.length - 1]);
    onProgress?.(`Judge: ${reviewers[reviewers.length - 1].verdict}`);
  } catch (err) {
    reviewers.push({
      role: 'judge',
      verdict: 'request_changes',
      summary: `Judge sub-agent failed: ${String(err).slice(0, 200)}`,
      // Infra failure — a NON-VOTE. When the judge itself could not run,
      // aggregateVerdict falls back to the conclusive reviewers' consensus
      // instead of forcing a 0/request_changes verdict (DEFECT 1).
      inconclusive: true,
    });
    emitGateEvent(projectId, missionId, reviewers[reviewers.length - 1]);
    onProgress?.('Judge sub-agent failed');
  }

  return aggregateVerdict(reviewers, testsResult, judgeVerdictRaw);
}

// ── Managed evaluation (Tauri + Pro subscription) ───────────────────

/** Shell command used to run the test suite for the tester role in managed
 *  mode. Matches the assumption already baked into the native tester's own
 *  prompt above ("npm test or equivalent") — Lazy IDE and the missions it
 *  evaluates are npm-based projects. */
const MANAGED_TEST_COMMAND = 'npm test';
const MANAGED_TEST_TIMEOUT_MS = 120000;

/**
 * Best-effort pass/fail extraction from arbitrary test-runner output
 * (vitest/jest/pytest/cargo all emit some "<N> passed" / "<N> failed"
 * phrase). Returns undefined — never a guessed {0,0} — when neither phrase
 * is present, so callers never fabricate counts (HONESTY CONTRACT).
 */
function parseTestCounts(output: string): { passed: number; failed: number } | undefined {
  const passedMatch = output.match(/(\d+)\s+passed/i);
  const failedMatch = output.match(/(\d+)\s+failed/i);
  if (!passedMatch && !failedMatch) return undefined;
  return {
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
  };
}

/**
 * True when a path string is absolute (Windows drive-letter/UNC/extended, or
 * POSIX root) rather than relative or empty. A relative path (e.g. '.', '',
 * './worktree') passed as run_shell's cwd fails the Rust side's
 * Path::canonicalize() there, because it resolves against the Tauri
 * process's own cwd, not the project root — see ensure_repo_in_project_root
 * in src-tauri/src/lib.rs. This is exactly what produced the "path
 * canonicalize failed" bug when a caller (e.g. a stale repoPath of '.')
 * left worktreePath relative.
 */
function isAbsolutePath(path: string | undefined): path is string {
  if (!path) return false;
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
}

/**
 * Runs the project test suite for the tester role in managed mode, via the
 * run_shell Tauri command — the same bridge managedAgent.ts's executeTool
 * uses for its 'run_command' tool (invoke('run_shell', { command, cwd,
 * timeoutMs })) — with the mission worktree as cwd, so the mission's own
 * diff is what gets tested, not the unmodified main repo.
 *
 * No LLM is involved: exit code + best-effort output parsing are ground
 * truth, never a model's guess. Never throws — an invalid (non-absolute)
 * worktreePath is rejected upfront (HONESTY CONTRACT guard: never attempt a
 * canonicalize that's guaranteed to fail), and any run_shell failure
 * (missing capability, timeout, unresolvable cwd) is caught too — both
 * produce an honest 'request_changes' verdict, never a fabricated pass.
 */
async function runManagedTester(
  worktreePath: string,
): Promise<{ verdict: ReviewerVerdict; tests?: { passed: number; failed: number } }> {
  if (!isAbsolutePath(worktreePath)) {
    return {
      verdict: {
        role: 'tester',
        verdict: 'request_changes',
        summary:
          `Tester unavailable — no valid worktree path (got "${worktreePath}"). ` +
          'The mission repo/worktree path did not resolve to an absolute path, ' +
          'so no test command was run. No verdict was fabricated.',
        // Could not run the tests (infra) — a NON-VOTE, not a code rejection
        // (DEFECT 1). Distinct from the exit-code != 0 branch below, which is
        // a REAL test failure.
        inconclusive: true,
      },
      tests: undefined,
    };
  }

  if (await hasNoTestScriptConfigured(worktreePath)) {
    // Structural evaluator-infrastructure limitation (no package.json / no
    // "test" script) — NOT a code defect (see this file's "No-test-script
    // detection" section above). Detected BEFORE running `npm test`, so a
    // no-test repo never sees npm's own "Missing script" exit code
    // misread as a real test failure.
    return { verdict: buildNoTestScriptVerdict(), tests: undefined };
  }

  try {
    const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>(
      'run_shell',
      { command: MANAGED_TEST_COMMAND, cwd: worktreePath, timeoutMs: MANAGED_TEST_TIMEOUT_MS },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const tests = parseTestCounts(output);
    const ok = result.exitCode === 0;

    return {
      verdict: {
        role: 'tester',
        verdict: ok ? 'approve' : 'request_changes',
        summary: tests
          ? `${tests.passed} passed, ${tests.failed} failed (managed shell run, exit ${result.exitCode}).`
          : `Test command exited ${result.exitCode} (managed shell run). Output:\n${output.slice(0, 300)}`,
        score: ok ? 85 : tests ? Math.max(0, 85 - tests.failed * 10) : 20,
      },
      tests,
    };
  } catch (err) {
    return {
      verdict: {
        role: 'tester',
        verdict: 'request_changes',
        summary: `Tester unavailable — run_shell failed: ${String(err).slice(0, 200)}. No verdict was fabricated.`,
        // run_shell itself failed (missing capability, timeout, unresolvable
        // cwd) — the tests could not be run. NON-VOTE, not a code rejection
        // (DEFECT 1). The exit-code != 0 branch above is the REAL-failure case.
        inconclusive: true,
      },
      tests: undefined,
    };
  }
}

/**
 * Managed (Pro) evaluation pipeline. Mirrors evaluateLive's four-role shape
 * (tester, reviewer, security, judge) but dispatches through the managed
 * provider instead of the native CLI agent_run path:
 *   - tester: real run_shell execution in the worktree (ground truth, no LLM)
 *   - reviewer / security / judge: streamManagedAgentTurn LLM calls, all
 *     using the same model resolution the mission itself ran with
 *     (resolveManagedModel)
 * This replaces the previous behavior where 'managed' fell through to
 * evaluateScripted and never got a real reviewer/judge — see the dispatch
 * table in evaluateMission.
 */
async function evaluateManaged(
  mission: Mission,
  worktreePath: string,
  projectId: string,
  onProgress?: (msg: string) => void,
): Promise<JudgeVerdict> {
  const model = resolveManagedModel(mission);
  const diffContext = mission.diffSnippet
    ? mission.diffSnippet.slice(0, 30).join('\n')
    : `Mission: ${mission.title}`;

  // 1. Tester — real shell execution in the worktree, no LLM guesswork.
  onProgress?.('Running tester sub-agent (managed — shell)…');
  const { verdict: testerVerdict, tests: testsResult } = await runManagedTester(worktreePath);
  emitGateEvent(projectId, mission.id, testerVerdict);
  onProgress?.(`Tester: ${testerVerdict.verdict}`);

  // Verification mission (M12 dogfood fix): no diff is expected, so judge on
  // the tester's own verification output instead of handing an LLM reviewer/
  // security an empty diff — see buildVerificationMissionReviewers's doc
  // comment. Returns null (falls through to the normal LLM path below)
  // for any mission that isn't a diff-less verification task.
  const verificationReviewers = buildVerificationMissionReviewers(mission, testerVerdict);
  if (verificationReviewers) {
    for (const verdict of verificationReviewers.slice(1)) {
      emitGateEvent(projectId, mission.id, verdict);
      onProgress?.(`${verdict.role}: ${verdict.verdict}${verdict.inconclusive ? ' (inconclusive)' : ''}`);
    }
    return evaluateManagedJudge(mission, verificationReviewers, testsResult, projectId, model, onProgress);
  }

  let reviewers: ReviewerVerdict[] = [testerVerdict];

  // 2. Reviewer — LLM code critique via the managed provider
  onProgress?.('Running reviewer sub-agent (managed)…');
  try {
    const reviewerRaw = await runManagedEvaluatorAgent({
      task: buildReviewerTask(mission, diffContext),
      model,
    });
    reviewers = [...reviewers, guardAgainstVacuousApproval(parseReviewerResult(reviewerRaw, 'reviewer'), reviewerRaw)];
    emitGateEvent(projectId, mission.id, reviewers[reviewers.length - 1]);
    onProgress?.(`Reviewer: ${reviewers[reviewers.length - 1].verdict}`);
  } catch (err) {
    reviewers = [
      ...reviewers,
      {
        role: 'reviewer',
        verdict: 'request_changes',
        summary: `Reviewer sub-agent failed: ${String(err).slice(0, 200)}`,
        // Infra failure — a NON-VOTE, not a code rejection (DEFECT 1).
        inconclusive: true,
      },
    ];
    emitGateEvent(projectId, mission.id, reviewers[reviewers.length - 1]);
    onProgress?.('Reviewer sub-agent failed');
  }

  // 3. Security — LLM security audit via the managed provider
  onProgress?.('Running security sub-agent (managed)…');
  try {
    const securityRaw = await runManagedEvaluatorAgent({
      task: buildSecurityTask(mission, diffContext),
      model,
    });
    reviewers = [...reviewers, guardAgainstVacuousApproval(parseReviewerResult(securityRaw, 'security'), securityRaw)];
    emitGateEvent(projectId, mission.id, reviewers[reviewers.length - 1]);
    onProgress?.(`Security: ${reviewers[reviewers.length - 1].verdict}`);
  } catch (err) {
    reviewers = [
      ...reviewers,
      {
        role: 'security',
        verdict: 'request_changes',
        summary: `Security sub-agent failed: ${String(err).slice(0, 200)}`,
        // Infra failure — a NON-VOTE, not a code rejection (DEFECT 1).
        inconclusive: true,
      },
    ];
    emitGateEvent(projectId, mission.id, reviewers[reviewers.length - 1]);
    onProgress?.('Security sub-agent failed');
  }

  return evaluateManagedJudge(mission, reviewers, testsResult, projectId, model, onProgress);
}

/**
 * Stable literal marker for a judge verdict that is `inconclusive` because
 * the judge sub-agent's OWN provider call hit a definitive (never-retry)
 * error (401/402/403/404 — auth/balance/permission/model-not-found; see
 * byokProviders.ts's ProviderDefinitiveError/classifyDefinitiveProviderError),
 * as opposed to any other evaluator-infrastructure failure. Embedded as a
 * `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: ` prefix in the verdict's `summary`
 * (ReviewerVerdict has no separate machine-readable reason field, and
 * types.ts is out of scope for this change) rather than a new typed field —
 * downstream UI can detect it via
 * `verdict.summary.startsWith('judge_unavailable_provider:')`.
 *
 * CONTRACT: this exact string is consumed by another worktree's UI work
 * (distinguishing "judges rejected" from "judges could not run" — see the
 * 2026-08-05 DeepSeek 402 incident, where a hung judge pipeline surfaced to
 * the user as the misleading "Le juge a rejeté cette mission" instead of an
 * honest "the judges could not run"). Keep it a stable literal — do not
 * rename without updating that consumer.
 */
export const JUDGE_UNAVAILABLE_PROVIDER_REASON = 'judge_unavailable_provider';

/**
 * Shared step 4 (judge) for evaluateManaged: runs the LLM judge sub-agent
 * against `reviewers`' summaries and aggregates into the final JudgeVerdict.
 * Extracted so the normal LLM reviewer/security path and the verification-
 * mission path (buildVerificationMissionReviewers) both funnel through the
 * exact same judge + aggregation logic rather than duplicating it.
 */
async function evaluateManagedJudge(
  mission: Mission,
  reviewers: ReviewerVerdict[],
  testsResult: { passed: number; failed: number } | undefined,
  projectId: string,
  model: string,
  onProgress?: (msg: string) => void,
): Promise<JudgeVerdict> {
  onProgress?.('Running judge sub-agent (managed)…');
  const reviewerSummaries = formatReviewerSummaries(reviewers);

  let judgeVerdictRaw = '';
  let allReviewers = reviewers;
  try {
    judgeVerdictRaw = await runManagedEvaluatorAgent({
      task: buildJudgeTask(mission, reviewerSummaries),
      model,
    });
    allReviewers = [...allReviewers, guardAgainstVacuousApproval(parseReviewerResult(judgeVerdictRaw, 'judge'), judgeVerdictRaw)];
    emitGateEvent(projectId, mission.id, allReviewers[allReviewers.length - 1]);
    onProgress?.(`Judge: ${allReviewers[allReviewers.length - 1].verdict}`);
  } catch (err) {
    // 2026-08-05 DeepSeek 402 incident — a judge call that hits a definitive
    // provider error (never-retry: bad key, empty balance, no permission,
    // unknown model) must NEVER hang, NEVER read as a reject vote, and NEVER
    // throw out of this pipeline. It already lands here as an ordinary
    // inconclusive NON-VOTE (same as any other judge sub-agent failure,
    // below) — this branch only ADDS the distinct, stable reason marker
    // (JUDGE_UNAVAILABLE_PROVIDER_REASON) so downstream UI can tell "the
    // judges could not run" apart from "the judges ran and rejected".
    const providerErr = classifyDefinitiveProviderError(err);
    allReviewers = [
      ...allReviewers,
      {
        role: 'judge',
        verdict: 'request_changes',
        summary: providerErr
          ? `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: ${providerErr.providerId} — ${providerErr.shortReason} ` +
            `(provider error, not a code defect — the judge could not run).`
          : `Judge sub-agent failed: ${String(err).slice(0, 200)}`,
        // Infra failure — a NON-VOTE. aggregateVerdict falls back to the
        // conclusive reviewers' consensus rather than a forced 0 (DEFECT 1).
        inconclusive: true,
      },
    ];
    emitGateEvent(projectId, mission.id, allReviewers[allReviewers.length - 1]);
    onProgress?.(providerErr ? 'Judge sub-agent unavailable (provider error)' : 'Judge sub-agent failed');
  }

  return aggregateVerdict(allReviewers, testsResult, judgeVerdictRaw);
}

// ── Public API ────────────────────────────────────────────────────

export interface EvaluateOptions {
  repoPath: string;
  worktreePath?: string;
  onProgress?: (msg: string) => void;
}

/**
 * Sanitizes a branch/mission identifier for use as a worktree directory
 * name, exactly mirroring the Rust side's safe_branch logic in
 * agent_create_worktree_inner (src-tauri/src/lib.rs) so a JS-reconstructed
 * path always points at the same directory Rust actually created.
 */
function sanitizeWorktreeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9\-_]/g, '-');
}

/**
 * Reconstructs a mission's worktree directory from repoPath + mission.worktree.
 *
 * There is no separate absolute-path field on Mission — runtime.ts's
 * runMission only ever persists the branch name (`worktree: branch`); the
 * real, live worktreePath it creates (via agent_create_worktree) is a local
 * variable that is never written back onto the mission object. So the
 * branch name plus repoPath is the only durable trail back to the
 * directory, and it must be joined exactly the way the Rust side does it
 * (agent_create_worktree_inner: repo_dir.join(".lazy").join("worktrees")
 * .join(safe_branch), i.e. Path::join — same separator throughout, never
 * mixed).
 *
 * CRITICAL (this is the bug this function fixes): NEVER join with a
 * hardcoded '/'. repoPath is typically get_project_root's
 * std::fs::canonicalize() result, which on Windows is \\?\-prefixed
 * (verbatim). Verbatim paths disable all separator normalization, so
 * appending "/.lazy/worktrees/..." with a literal slash produces a
 * mixed-separator string (e.g. `\\?\C:\...\Lazy/.lazy/worktrees/...`) that
 * Rust's Path::canonicalize() fails to resolve even though the directory
 * exists on disk — the exact "Tester unavailable — run_shell failed: path
 * canonicalize failed" bug. joinPath (../paths) reuses whatever separator
 * repoPath already contains, keeping a verbatim prefix internally
 * consistent (all backslashes) — see its doc comment for the full rationale.
 *
 * Exported so callers that already know the mission (e.g. MissionDetail.tsx)
 * can compute and pass an explicit worktreePath up front, rather than
 * leaning on this as a hidden fallback.
 */
export function resolveWorktreePath(
  repoPath: string,
  mission: Pick<Mission, 'worktree' | 'id'>,
): string {
  const segment = sanitizeWorktreeSegment(mission.worktree ?? mission.id);
  return joinPath(repoPath, '.lazy', 'worktrees', segment);
}

/**
 * evaluateMission — entry point for the judge pipeline.
 *
 * Dispatches to (mirrors runtime.ts's planAndAct routing table):
 *   - evaluateManaged  (managed/Pro subscription via the ai-proxy + run_shell)
 *   - evaluateLive     (Tauri + claude CLI/codex, native agent_run)
 *   - evaluateScripted (Tauri, no engine — pro/live-key/mock — real test
 *     runner only, no real reviewer/judge)
 *   - buildUnavailableVerdict (no Tauri runtime at all)
 *
 * NEVER fabricates a passed=true verdict when a real sub-agent/model
 * couldn't run.
 *
 * Returns a JudgeVerdict. Callers must store it on the mission.
 */
export async function evaluateMission(
  mission: Mission,
  opts: EvaluateOptions,
): Promise<JudgeVerdict> {
  // Trust-critical defect #1 (M53 forensics) — checked FIRST, before even
  // the runtime-availability check below: runtime.ts's Step C already
  // proved (via reviewPreflight.ts's detectDiffCoverageGap) that this
  // mission's diff is missing real content the worktree's own git status
  // reports. No dispatch below this point can fix that — every one of them
  // hands `mission`'s diff straight to a tester/reviewer/security sub-agent
  // as if it were complete, which is exactly the M53 failure mode.
  if (mission.diffIncompleteFiles && mission.diffIncompleteFiles.length > 0) {
    opts.onProgress?.(
      `Diff incomplete — ${mission.diffIncompleteFiles.length} file(s) missing from the computed diff, refusing to run judges`,
    );
    return buildDiffCoverageGapVerdict(mission.diffIncompleteFiles);
  }

  // Trust-critical defect #2 (M2 forensics) — same short-circuit shape as
  // the diffIncompleteFiles guard above: runtime.ts's Step C already proved
  // (isDiffGenuinelyEmpty + NOT isVerificationMission) that this mission
  // produced literally nothing — no commits, no diff — and isn't a
  // legitimate diff-less investigation/verification task. Never hand an
  // empty diff to the judge pipeline: "no code = no risk" reads as a
  // security approval by construction, and a downstream judge then treats
  // that vacuous approval as positive evidence — the exact M2 failure
  // (1/2 approve on a mission that did nothing).
  if (mission.emptyDeliverable === true) {
    opts.onProgress?.('Mission produced no deliverable — refusing to run judges');
    return buildEmptyDeliverableVerdict();
  }

  if (!isTauriRuntime()) {
    opts.onProgress?.('Agent runtime unavailable — using scripted evaluation');
    return buildUnavailableVerdict();
  }

  // Use the caller-provided worktreePath directly whenever present (e.g.
  // MissionDetail.tsx's handleRunReview now computes one via
  // resolveWorktreePath up front) — only reconstruct as a last resort for
  // callers that don't. See resolveWorktreePath's doc comment above for why
  // this must never be a hardcoded-'/' string join.
  const worktreePath = opts.worktreePath ?? resolveWorktreePath(opts.repoPath, mission);
  const projectId = projectIdFromRoot(opts.repoPath);

  if (isManagedAgentAvailable()) {
    opts.onProgress?.('Starting managed (Pro) evaluation pipeline…');
    return evaluateManaged(mission, worktreePath, projectId, opts.onProgress);
  }

  if (isLiveAgentAvailable()) {
    opts.onProgress?.('Starting live evaluation pipeline…');
    return evaluateLive(mission, worktreePath, opts.repoPath, projectId, opts.onProgress);
  }

  // Tauri available but no claude CLI and no managed subscription (pro /
  // live-key / mock) — scripted mode with real test runner. worktreePath
  // (not opts.repoPath) so the real test runner grades the mission's own
  // diff, not the pre-mission base repo — see evaluateScripted's doc comment.
  opts.onProgress?.('Claude CLI not configured — scripted evaluation with real tests');
  return evaluateScripted(mission, worktreePath, opts.onProgress);
}

// ── Shared verdict-score formatting (R13 — "Verdict 0/100" residual fix) ───
//
// MAJEUR (R13 dogfood, 2026-07): R11 fixed nodeChrome.tsx's node-chip score
// display to check `verdict.scoreUnavailable` before rendering a number
// (never presenting the `0` PLACEHOLDER aggregateVerdict/evaluateScripted/
// buildUnavailableVerdict use when no real score exists as if it were real
// signal). R12's dogfood run still saw a bare "0/100" on OTHER surfaces
// (MissionDetailJudge's score ring, DataInspector's inspector table,
// managerAdvice's rejected-mission summary, the rejection-review question
// text) — each one re-derived its own ad hoc score line instead of sharing
// nodeChrome's rule. These two helpers are the ONE source every surface must
// call through from now on, so a future new surface (or a future change to
// the rule itself) only needs to change it here.

/** True when `verdict.score` is a REAL number a sub-agent actually produced
 *  — false when it is the `0` placeholder aggregateVerdict/evaluateScripted/
 *  buildUnavailableVerdict fall back to when nothing conclusive ever ran. */
export function isVerdictScoreAvailable(verdict: Pick<JudgeVerdict, 'scoreUnavailable'>): boolean {
  return verdict.scoreUnavailable !== true;
}

/**
 * Plain-text "N/100" (or an honest unavailable label) for the many surfaces
 * that build a French/English literal string rather than going through
 * useI18n's `t()` (managerAdvice.ts, agentsStore.tsx's rejection-review
 * question, learningLoop.ts's capture text, runtime.ts's chat-log line…).
 * i18n-aware surfaces (nodeChrome.tsx, MissionDetailJudge.tsx) should still
 * gate on `isVerdictScoreAvailable` directly and render their OWN localized
 * "unavailable" string via `t()` — this helper's fallback text is for
 * non-i18n call sites only, so it stays a plain, honest label rather than a
 * silently-untranslated string leaking into a localized UI.
 */
export function formatVerdictScoreLine(verdict: JudgeVerdict, unavailableLabel = 'score indisponible'): string {
  return isVerdictScoreAvailable(verdict) ? `${Math.round(verdict.score)}/100` : unavailableLabel;
}

/**
 * deriveJudgesApproved — backward-compat string derived from a JudgeVerdict.
 * Used to keep mission.judgesApproved in sync.
 *
 * Inconclusive reviewers (evaluator-infra failures) are excluded from the
 * denominator: an evaluator that could not run is not a vote, so it would be
 * misleading to count it as a missing approval (e.g. "2/3 approve" when the
 * 3rd simply couldn't run — reported as "2/2 approve" instead). See DEFECT 1.
 */
export function deriveJudgesApproved(verdict: JudgeVerdict): string {
  const nonJudge = verdict.reviewers.filter(
    (r) => r.role !== 'judge' && r.inconclusive !== true,
  );
  const approveCount = nonJudge.filter((r) => r.verdict === 'approve').length;
  return `${approveCount}/${nonJudge.length} approve`;
}
