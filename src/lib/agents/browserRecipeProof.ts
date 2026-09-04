/* browserRecipeProof.ts — Mission B: turns a BrowserRecipeResult (Mission D,
 * browserRecipe.ts) into a durable, inspectable "proof of what happened"
 * record, so the founder's own directive ("range les screens dans une
 * fenêtre liée aux agents, en plus de les donner au LazyManager") has real
 * data to render on the canvas AND real data the manager can reason about.
 *
 * Nothing here is specific to any one site/subject — a BrowserRecipe is
 * already generic DATA (see browserRecipe.ts's own header), and every
 * function below only ever reads the generic step/guard/outcome SHAPE.
 *
 * Three consumers, one source of truth (a BrowserProofRun):
 *   - the canvas (a preview-surface `SurfaceHtmlView`, via buildBrowserProofHtml
 *     — see reconcilerEdges.ts's buildSurfaceEdges for how it gets tethered
 *     to the owning mission(s) with real edges);
 *   - the manager (summarizeBrowserProofRun + listBrowserProofCaptureRefs —
 *     a stable ref per capture plus a plain-text account of the run, so the
 *     model can refer to "the third screenshot" without re-deriving anything);
 *   - disk (persistBrowserProofScreenshots — bounded in-memory/persisted-state
 *     footprint, see capBrowserProofScreenshots's own doc comment).
 *
 * WIRING CONTRACT (this module has no store/React dependency of its own —
 * the caller, agentsStore.tsx's `run_browser_recipe` case, is out of this
 * task's file perimeter and must do the actual wiring):
 *
 *   const runId = createBrowserProofRunId(recipe.profileName, missionId);
 *   let run = buildBrowserProofRun({ id: runId, missionId, recipe, result });
 *   run = await persistBrowserProofScreenshots(run); // best-effort disk backup
 *   const view: SurfaceHtmlView = {
 *     id: run.id,
 *     label: `${recipe.profileName} — ${new Date(run.createdAtMs).toLocaleTimeString()}`,
 *     html: buildBrowserProofHtml(run, labels), // labels built once via t(), see this file's BrowserProofLabels doc comment
 *   };
 *   const surfaceId = browserProofSurfaceId(recipe.profileName);
 *   canvasStoreVanilla.getState().upsertBrowserProofSurface(surfaceId, view, {
 *     ownerRefs: [makeRef('mission', missionId)], // whichever mission(s) actually ran this — see this file's own header note on the current gap
 *     projectId,
 *   });
 *   // Manager-facing: attach both to whatever the model reads back.
 *   const summary = summarizeBrowserProofRun(run);
 *   const captureRefs = listBrowserProofCaptureRefs(run); // stable ref per capture
 *
 * KNOWN GAP (documented, not fixed here — outside this task's perimeter):
 * the `run_browser_recipe` ManagerAction (lib/agents/types.ts) carries no
 * `missionId` today — agentsStore.tsx's executor calls runBrowserRecipe
 * directly from the manager-chat action loop, not from a running fleet
 * mission's own tool loop. Whoever wires this must decide which mission id
 * to pass as `missionId` above (e.g. a mission spawned specifically to run
 * the recipe) — `ownerRefs` accepts as many mission/loop refs as actually
 * contributed, so this is additive whenever that mission model firms up.
 */

import { getPlatform } from '../platform/index.js';
import { joinPath } from '../paths.js';
import { isTauri } from '../platform/index.js';
import type { BrowserRecipe, BrowserRecipeResult, BrowserStepKind } from './browserRecipe.js';

// ── Types ──────────────────────────────────────────────────────────

/** The four honest outcomes a recipe run can end in — see browserRecipe.ts's
 *  own `BrowserRecipeResult` doc comments for what each field means. Kept as
 *  a closed union (rather than re-deriving ad hoc at every call site) so
 *  "stopped on purpose" and "stopped because something unexpected happened"
 *  are always the SAME two distinguishable values everywhere this is read —
 *  the founder's directive #4 ("le coupe-circuit doit se distinguer de
 *  l'arrêt volontaire") is enforced by construction, not by convention. */
export type BrowserProofOutcome = 'stoppedBeforeFinal' | 'circuitBreaker' | 'failed' | 'completed';

/** One step's view in a proof run's timeline. Deliberately an ALLOWLIST of
 *  fields copied one-by-one from BrowserStepOutcome (never `...step`) — see
 *  buildBrowserProofRun's own doc comment for why: BrowserStepOutcome is
 *  already secret-free by construction (browser_recipe.rs never echoes a
 *  resolved `secretEnvVar`/`value` back), but an allowlist means a FUTURE
 *  field silently added to that type upstream can never leak into a proof
 *  view without a deliberate change here too. */
export interface BrowserProofStepView {
  id: string;
  kind: BrowserStepKind;
  ok: boolean;
  detail?: string;
  error?: string;
  guardTripped?: string;
  /** True for the step the recipe author flagged `irreversible` — present
   *  on at most one step (browserRecipe.ts's own contract). */
  irreversible: boolean;
  /** Stable reference for this ONE capture (`${runId}:${stepId}`) —
   *  independent of where/whether the image itself is still retained inline
   *  or only on disk (see {@link BrowserProofStepView.screenshotDiskPath}) —
   *  this is what the manager can hold onto and refer back to. Present iff
   *  a screenshot was actually captured for this step. */
  screenshotRef?: string;
  /** The raw capture as a displayable `data:image/png;base64,...` URI.
   *  Present only while this step is still inside the retention window (see
   *  {@link capBrowserProofScreenshots}) — absent does NOT mean "no
   *  screenshot exists", only "not kept inline"; check `screenshotRef`
   *  for that. */
  screenshotDataUri?: string;
  /** Set by {@link persistBrowserProofScreenshots} once the capture has been
   *  written to disk — the durable reference survives even after
   *  {@link capBrowserProofScreenshots} drops the inline data URI. */
  screenshotDiskPath?: string;
}

/** A single browser-recipe execution, shaped for display + manager
 *  reasoning. Built once per run by {@link buildBrowserProofRun}, never
 *  mutated in place afterward (capping/persisting both return a NEW run). */
export interface BrowserProofRun {
  id: string;
  missionId: string;
  profileName: string;
  createdAtMs: number;
  outcome: BrowserProofOutcome;
  /** Present only for `outcome: 'stoppedBeforeFinal'` — the id of the
   *  irreversible step the run stopped BEFORE (never executed). */
  stoppedBeforeStepId?: string;
  /** Present only for `outcome: 'circuitBreaker'` — which guard tripped and
   *  after which step, verbatim from BrowserRecipeResult.circuitBreakerTripped. */
  circuitBreaker?: { label: string; afterStepId: string };
  /** Present only for `outcome: 'failed'`, verbatim from
   *  BrowserRecipeResult.failure. */
  failureReason?: string;
  steps: BrowserProofStepView[];
}

// ── Ids ───────────────────────────────────────────────────────────────

/** Sanitizes an arbitrary string into an id-safe slug — same
 *  allow-alphanumeric-dash-underscore posture as browser_recipe.rs's own
 *  `sanitize_profile_name`, reimplemented here in TS since this module never
 *  crosses the Tauri boundary for id derivation. */
function slugify(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '-');
  return cleaned.length > 0 ? cleaned : 'default';
}

/** The ONE surface id every run of a given profile lands on — repeated runs
 *  accumulate as navigable views on this SAME surface (upsertBrowserProofSurface's
 *  own contract), never spawning a second node per run, same "reuse across
 *  repeated calls" convention canvasStore.ts's reportWebSearch/
 *  upsertArtifactSurface already establish. */
export function browserProofSurfaceId(profileName: string): string {
  return `browserProof-${slugify(profileName)}`;
}

/** A fresh, unique id for ONE execution (used as both the run's own id and
 *  its {@link SurfaceHtmlView} id) — includes the mission id so two
 *  concurrent missions running the SAME profile never collide. */
export function createBrowserProofRunId(profileName: string, missionId: string, nowMs: number = Date.now()): string {
  return `${browserProofSurfaceId(profileName)}:${slugify(missionId)}:${nowMs}`;
}

// ── Building the run from a BrowserRecipeResult ────────────────────────

/** Honest outcome derivation — mirrors runBrowserRecipe's own precedence
 *  exactly (browserRecipe.ts: a circuit breaker or failure always aborts the
 *  loop before `stoppedBeforeFinal` could even be reached, so this checks in
 *  the same order). */
export function deriveBrowserProofOutcome(result: BrowserRecipeResult): BrowserProofOutcome {
  if (result.circuitBreakerTripped) return 'circuitBreaker';
  if (result.failure) return 'failed';
  if (result.stoppedBeforeFinal) return 'stoppedBeforeFinal';
  return 'completed';
}

/** Finds the step the run stopped BEFORE in validation mode: the first
 *  `irreversible` step in the RECIPE's own order that never actually ran
 *  (i.e. is absent from `executedIds`). Defensive rather than assuming "the
 *  first irreversible step, period" — a hand-authored recipe with more than
 *  one `irreversible: true` step is still handled honestly (only reports one
 *  that genuinely never executed), even though runBrowserRecipe's own loop
 *  never lets more than one matter in practice (it breaks the instant it
 *  meets the first). */
function findStoppedBeforeStepId(recipe: BrowserRecipe, executedIds: ReadonlySet<string>): string | undefined {
  return recipe.steps.find((s) => s.irreversible === true && !executedIds.has(s.id))?.id;
}

/**
 * Pure transform: BrowserRecipeResult + the BrowserRecipe that produced it
 * -> a {@link BrowserProofRun}. No I/O, no canvas/store dependency — safe to
 * call from anywhere (including inside a mission's own tool-loop code, once
 * that wiring exists — see this module's header).
 */
export function buildBrowserProofRun(params: {
  id: string;
  missionId: string;
  recipe: BrowserRecipe;
  result: BrowserRecipeResult;
  nowMs?: number;
}): BrowserProofRun {
  const { id, missionId, recipe, result } = params;
  const outcome = deriveBrowserProofOutcome(result);
  const executedIds = new Set(result.steps.map((s) => s.id));
  const irreversibleIds = new Set(recipe.steps.filter((s) => s.irreversible === true).map((s) => s.id));

  const steps: BrowserProofStepView[] = result.steps.map((step) => ({
    id: step.id,
    kind: step.kind,
    ok: step.ok,
    detail: step.detail,
    error: step.error,
    guardTripped: step.guardTripped,
    irreversible: irreversibleIds.has(step.id),
    screenshotRef: step.screenshotBase64 ? `${id}:${step.id}` : undefined,
    screenshotDataUri: step.screenshotBase64 ? `data:image/png;base64,${step.screenshotBase64}` : undefined,
  }));

  return {
    id,
    missionId,
    profileName: recipe.profileName,
    createdAtMs: params.nowMs ?? Date.now(),
    outcome,
    stoppedBeforeStepId: outcome === 'stoppedBeforeFinal' ? findStoppedBeforeStepId(recipe, executedIds) : undefined,
    circuitBreaker: result.circuitBreakerTripped ?? undefined,
    failureReason: result.failure ?? undefined,
    steps,
  };
}

// ── Bounding in-memory/persisted weight (founder directive #7) ────────

/** Max screenshots kept as inline `data:` URIs per run — protects both the
 *  running app's memory and layout.json's on-disk size against an unbounded
 *  base64 payload accumulating across a long recipe (a real recipe can have
 *  dozens of steps, and canvasStore's tracked slice — including every
 *  surface's htmlViews — round-trips through JSON on every autosave). Keeps
 *  the MOST RECENT captures (the steps closest to wherever the run stopped)
 *  since that is what a user checking "what happened right before the stop"
 *  actually needs first; older captures within the same run keep their
 *  `screenshotRef` (still resolvable via disk once
 *  {@link persistBrowserProofScreenshots} has run) but drop
 *  `screenshotDataUri`. */
export const BROWSER_PROOF_INLINE_SCREENSHOT_CAP = 8;

/** Returns a NEW run (never mutates `run`) with only the last `cap` captures
 *  kept inline. A run at or under the cap is returned unchanged (same
 *  reference) for cheap no-op calls. */
export function capBrowserProofScreenshots(
  run: BrowserProofRun,
  cap: number = BROWSER_PROOF_INLINE_SCREENSHOT_CAP,
): BrowserProofRun {
  const withInline = run.steps.filter((s) => s.screenshotDataUri !== undefined);
  if (withInline.length <= cap) return run;
  const dropCount = withInline.length - cap;
  let seen = 0;
  return {
    ...run,
    steps: run.steps.map((step) => {
      if (step.screenshotDataUri === undefined) return step;
      const shouldDrop = seen < dropCount;
      seen += 1;
      return shouldDrop ? { ...step, screenshotDataUri: undefined } : step;
    }),
  };
}

// ── Manager-facing contract (founder directive #5) ─────────────────────

/** One capture the manager can refer to and reason about — the stable ref
 *  plus just enough context (which step, whether it succeeded) to describe
 *  it in prose without needing to re-open the run. */
export interface BrowserProofCaptureRef {
  ref: string;
  stepId: string;
  ok: boolean;
}

/** Every capture in `run`, in execution order — the manager-facing "at
 *  minimum a stable reference per capture" half of directive #5. */
export function listBrowserProofCaptureRefs(run: BrowserProofRun): BrowserProofCaptureRef[] {
  return run.steps
    .filter((step): step is BrowserProofStepView & { screenshotRef: string } => step.screenshotRef !== undefined)
    .map((step) => ({ ref: step.screenshotRef, stepId: step.id, ok: step.ok }));
}

/** Plain-text account of the run — the manager-facing "textual summary of
 *  the whole run" half of directive #5. Deliberately NOT localized (same
 *  "plain, non-localized system-generated text" convention agentsStore.tsx's
 *  own run_browser_recipe toasts already use, per that file's own comment) —
 *  this is data fed back to the MODEL, not shown to the user directly. */
export function summarizeBrowserProofRun(run: BrowserProofRun): string {
  const total = run.steps.length;
  const okCount = run.steps.filter((s) => s.ok).length;
  const shotCount = run.steps.filter((s) => s.screenshotRef).length;
  const base = `Browser recipe run "${run.profileName}" (ref: ${run.id}): ${okCount}/${total} step(s) completed, ${shotCount} screenshot(s) captured.`;
  switch (run.outcome) {
    case 'stoppedBeforeFinal':
      return `${base} Stopped deliberately before the irreversible step${run.stoppedBeforeStepId ? ` "${run.stoppedBeforeStepId}"` : ''} (validation mode) — no irreversible action was taken.`;
    case 'circuitBreaker':
      return `${base} Circuit breaker tripped on guard "${run.circuitBreaker?.label ?? 'unknown'}" after step "${run.circuitBreaker?.afterStepId ?? 'unknown'}" — an unexpected screen was detected and the run aborted immediately.`;
    case 'failed':
      return `${base} Run failed: ${run.failureReason ?? 'unknown error'}.`;
    case 'completed':
      return `${base} All steps ran to completion, including the irreversible one.`;
    default:
      return base;
  }
}

// ── Canvas rendering (reuses PreviewNode's ArtifactSurfaceCard) ────────

/**
 * Every static string {@link buildBrowserProofHtml} needs, pre-translated by
 * the caller via `t()` (this module stays framework/i18n-free, same
 * "pure, no React" posture as every other lib/agents/*.ts leaf module) —
 * see src/i18n/locales/*.ts's `canvas.proof.*` keys. `{stepId}`/`{label}`/
 * `{reason}` placeholders are substituted by this module, not by the caller.
 */
export interface BrowserProofLabels {
  outcomeStoppedTitle: string;
  outcomeCircuitBreakerTitle: string;
  outcomeFailedTitle: string;
  outcomeCompletedTitle: string;
  /** Template with a `{stepId}` placeholder. */
  stoppedBeforeLine: string;
  /** Template with `{label}`/`{stepId}` placeholders. */
  circuitBreakerLine: string;
  /** Template with a `{reason}` placeholder. */
  failedLine: string;
  irreversibleExecutedBadge: string;
  stepOkBadge: string;
  stepFailedBadge: string;
  screenshotCappedNote: string;
  noScreenshotNote: string;
  stepsHeading: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fillTemplate(template: string, params: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(params)) {
    out = out.replace(new RegExp(`\\{${key}\\}`, 'g'), escapeHtml(value));
  }
  return out;
}

function outcomeBanner(run: BrowserProofRun, labels: BrowserProofLabels): string {
  switch (run.outcome) {
    case 'stoppedBeforeFinal':
      return `<div class="banner banner-stop"><strong>${escapeHtml(labels.outcomeStoppedTitle)}</strong><p>${fillTemplate(labels.stoppedBeforeLine, { stepId: run.stoppedBeforeStepId ?? '' })}</p></div>`;
    case 'circuitBreaker':
      return `<div class="banner banner-breaker"><strong>${escapeHtml(labels.outcomeCircuitBreakerTitle)}</strong><p>${fillTemplate(labels.circuitBreakerLine, { label: run.circuitBreaker?.label ?? '', stepId: run.circuitBreaker?.afterStepId ?? '' })}</p></div>`;
    case 'failed':
      return `<div class="banner banner-failed"><strong>${escapeHtml(labels.outcomeFailedTitle)}</strong><p>${fillTemplate(labels.failedLine, { reason: run.failureReason ?? '' })}</p></div>`;
    case 'completed':
      return `<div class="banner banner-completed"><strong>${escapeHtml(labels.outcomeCompletedTitle)}</strong></div>`;
    default:
      return '';
  }
}

function stepRow(step: BrowserProofStepView, run: BrowserProofRun, labels: BrowserProofLabels): string {
  const isBreakerStep = run.outcome === 'circuitBreaker' && run.circuitBreaker?.afterStepId === step.id;
  const rowClass = isBreakerStep ? 'step step-breaker' : step.ok ? 'step step-ok' : 'step step-failed';
  const statusBadge = step.ok
    ? `<span class="badge badge-ok">${escapeHtml(labels.stepOkBadge)}</span>`
    : `<span class="badge badge-failed">${escapeHtml(labels.stepFailedBadge)}</span>`;
  const irreversibleBadge = step.irreversible
    ? `<span class="badge badge-irreversible">${escapeHtml(labels.irreversibleExecutedBadge)}</span>`
    : '';
  const detailLine = step.detail ? `<div class="detail">${escapeHtml(step.detail)}</div>` : '';
  const errorLine = step.error ? `<div class="error">${escapeHtml(step.error)}</div>` : '';
  const guardLine = step.guardTripped ? `<div class="guard">${escapeHtml(step.guardTripped)}</div>` : '';
  const image = step.screenshotDataUri
    ? `<img class="shot" src="${step.screenshotDataUri}" alt="${escapeHtml(step.id)}" />`
    : step.screenshotRef
      ? `<div class="shot-missing">${escapeHtml(labels.screenshotCappedNote)}</div>`
      : `<div class="shot-missing">${escapeHtml(labels.noScreenshotNote)}</div>`;

  return `<li class="${rowClass}">
    <div class="step-head">
      <span class="step-id">${escapeHtml(step.id)}</span>
      <span class="step-kind">${escapeHtml(step.kind)}</span>
      ${statusBadge}${irreversibleBadge}
    </div>
    ${detailLine}${errorLine}${guardLine}
    ${image}
  </li>`;
}

/**
 * Builds the self-contained HTML document rendered inside PreviewNode's
 * `ArtifactSurfaceCard` (`SurfaceHtmlView.html` — see that component's own
 * header: an EMPTY-sandbox `srcDoc` iframe, so no script/style ever escapes
 * regardless of what a target page's own DOM text (`detail`/`error`) might
 * contain — every dynamic value is HTML-escaped here anyway, as defense in
 * depth against the rendered layout itself breaking). Internally caps inline
 * screenshots via {@link capBrowserProofScreenshots} so the OUTPUT STRING
 * itself (what actually gets persisted in layout.json once stored on a
 * surface) is always bounded, regardless of whether the caller remembered to
 * cap the run first.
 */
export function buildBrowserProofHtml(run: BrowserProofRun, labels: BrowserProofLabels): string {
  const capped = capBrowserProofScreenshots(run);
  const stepsHtml = capped.steps.map((step) => stepRow(step, capped, labels)).join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; background: #12121a; color: #e6e6ef; font: 12px/1.4 -apple-system, Segoe UI, sans-serif; }
  .banner { border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
  .banner p { margin: 4px 0 0; opacity: 0.85; }
  .banner-stop { background: rgba(59,130,246,0.15); border: 1px solid rgba(59,130,246,0.4); }
  .banner-breaker { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.5); }
  .banner-failed { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.5); }
  .banner-completed { background: rgba(34,197,94,0.15); border: 1px solid rgba(34,197,94,0.4); }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .step { border-radius: 8px; padding: 8px 10px; background: #1b1b26; border: 1px solid rgba(255,255,255,0.08); }
  .step-breaker { border-color: rgba(239,68,68,0.6); background: rgba(239,68,68,0.08); }
  .step-failed { border-color: rgba(239,68,68,0.35); }
  .step-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .step-id { font-weight: 700; }
  .step-kind { opacity: 0.6; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 999px; }
  .badge-ok { background: rgba(34,197,94,0.2); color: #4ade80; }
  .badge-failed { background: rgba(239,68,68,0.2); color: #f87171; }
  .badge-irreversible { background: rgba(234,179,8,0.2); color: #facc15; }
  .detail { opacity: 0.75; margin-top: 4px; }
  .error { color: #f87171; margin-top: 4px; }
  .guard { color: #fb923c; margin-top: 4px; }
  .shot { max-width: 100%; border-radius: 6px; margin-top: 6px; display: block; }
  .shot-missing { opacity: 0.5; font-style: italic; margin-top: 6px; }
  h2 { font-size: 12px; text-transform: uppercase; opacity: 0.6; margin: 16px 0 8px; }
</style>
</head>
<body>
${outcomeBanner(capped, labels)}
<h2>${escapeHtml(labels.stepsHeading)}</h2>
<ul>
${stepsHtml}
</ul>
</body>
</html>`;
}

// ── Disk persistence (founder directive #7 — bounded weight) ──────────

const BROWSER_PROOF_DISK_DIR = 'browser-proofs';

/** Resolves `<appDataDir>/browser-proofs` — a stable, PROJECT-INDEPENDENT
 *  root (same rationale as lib/brain/consolidation.ts's own rootTrunkPath:
 *  a recipe session belongs to a profile, not necessarily any one open
 *  project), Tauri-only (guarded by isTauri() at the one call site below). */
async function browserProofRoot(): Promise<string> {
  const { appDataDir } = await import('@tauri-apps/api/path');
  const base = await appDataDir();
  return joinPath(base, BROWSER_PROOF_DISK_DIR);
}

/**
 * Best-effort disk backup of every inline screenshot in `run` — the
 * "stockage sur disque avec référence" half of directive #7's weight
 * strategy: once this has run, {@link capBrowserProofScreenshots} can safely
 * drop an inline `data:` URI from memory/persisted canvas state without
 * losing the capture entirely, since `screenshotDiskPath` still resolves it.
 *
 * Never throws — a failure to persist (disk full, permissions, running in
 * the web/test platform) degrades to "no disk backup this run", identical
 * to the in-memory-only behavior this app already had before this module
 * existed, never a crash of the recipe-run flow that called it. No-op
 * outside Tauri (browser recipes themselves only ever run in the desktop
 * app — see browserRecipe.ts's own `invoke` calls).
 */
export async function persistBrowserProofScreenshots(run: BrowserProofRun): Promise<BrowserProofRun> {
  if (!isTauri()) return run;
  const stepsWithShots = run.steps.filter((s) => s.screenshotDataUri !== undefined);
  if (stepsWithShots.length === 0) return run;

  try {
    const platform = getPlatform();
    const dir = joinPath(await browserProofRoot(), slugify(run.id));
    await platform.fs.createDir(dir);

    const steps = await Promise.all(
      run.steps.map(async (step) => {
        if (!step.screenshotDataUri) return step;
        try {
          const filePath = joinPath(dir, `${slugify(step.id)}.txt`);
          // Written as plain text (the base64 string itself, same "plain
          // text write" convention as proofs.ts's storeProofText) — no
          // binary write path is needed since the content is already a
          // text-safe base64 payload.
          await platform.fs.writeFile(filePath, step.screenshotDataUri);
          return { ...step, screenshotDiskPath: filePath };
        } catch {
          // One capture failing to persist must never lose the rest.
          return step;
        }
      }),
    );
    return { ...run, steps };
  } catch {
    // Directory creation (or appDataDir resolution) failed — degrade to the
    // unpersisted run rather than throwing out of a recipe-run success path.
    return run;
  }
}
