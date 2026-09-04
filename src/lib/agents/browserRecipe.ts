/* browserRecipe.ts — Mission D: generic web-surface publishing via a
 * driven browser, with ZERO site-specific knowledge in code.
 *
 * A `BrowserRecipe` is DATA describing how to drive one site: which steps
 * to run (navigate/waitFor/click/fill/upload/assert), which step is the
 * irreversible one, and which guard conditions count as an unexpected
 * screen. This module only knows the generic step/guard SHAPE — never a
 * specific site's selectors, URLs, or flow. The same runner drives
 * Instagram, another network, or a page with a different content format
 * without any code change: only the recipe data differs.
 *
 * Talks to the Rust commands in src-tauri/src/commands/browser_recipe.rs:
 *   - browser_recipe_open(sessionId, profileName, headless)
 *   - browser_recipe_step(sessionId, stepJson, guardsJson)
 *   - browser_recipe_close(sessionId)
 *
 * Safety model (Mission D spec):
 *   - `validateOnly` (default true) is the default VALIDATION mode: the
 *     runner stops BEFORE the step flagged `irreversible`, leaving the
 *     last completed step's screenshot as proof of the state reached.
 *   - A tripped guard or a failed step aborts immediately — never retried,
 *     never looped.
 *   - Credentials are referenced by ENVIRONMENT VARIABLE NAME only
 *     (`secretEnvVar`), resolved on the Rust side; this module never reads,
 *     holds, or logs a literal secret value.
 */

import { invoke } from '@tauri-apps/api/core';
import { errorMessage } from '../errorMessage.js';

// ── Types ──────────────────────────────────────────────────────────

export type BrowserStepKind = 'navigate' | 'waitFor' | 'click' | 'fill' | 'upload' | 'assert';

export type BrowserAssertExpectation = 'visible' | 'hidden' | 'textContains';

/** One step of a recipe. Field applicability depends on `kind` — see
 *  validateBrowserRecipe for exactly which fields each kind requires.
 *  `irreversible: true` marks the step that performs an unrecoverable
 *  action (e.g. the final "Publish" click) — the ONLY step the recipe
 *  author needs to flag; everything else about safety follows from that
 *  single bit. */
export interface BrowserStep {
  id: string;
  kind: BrowserStepKind;
  timeoutMs?: number;
  irreversible?: boolean;
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
  /** Name of an environment variable to resolve as this step's `value` —
   *  mutually exclusive with a literal `value`. Never a literal secret. */
  secretEnvVar?: string;
  filePath?: string;
  expect?: BrowserAssertExpectation;
}

/** A circuit-breaker condition: if it matches the page after ANY step, the
 *  recipe run aborts immediately with `circuitBreakerTripped` set — this is
 *  what makes an unexpected screen (captcha, identity check, changed
 *  layout) a stop signal instead of silently plowing ahead or retrying.
 *  What counts as "unexpected" is entirely up to the recipe author; this
 *  module has no built-in notion of it. */
export interface BrowserGuard {
  label: string;
  selector?: string;
  textContains?: string;
}

export interface BrowserRecipe {
  /** Identifies BOTH the persistent login profile AND the session — the
   *  same profileName always resumes the same logged-in browser profile. */
  profileName: string;
  steps: BrowserStep[];
  guards?: BrowserGuard[];
  headless?: boolean;
}

export interface BrowserStepOutcome {
  id: string;
  kind: BrowserStepKind;
  ok: boolean;
  detail?: string;
  error?: string;
  guardTripped?: string;
  screenshotBase64?: string;
}

export interface BrowserRecipeResult {
  /** True when execution halted just before an `irreversible` step because
   *  `validateOnly` was in effect — the intended default outcome for a
   *  first run of any recipe. */
  stoppedBeforeFinal: boolean;
  /** Set when a guard matched after some step — the honest "an unexpected
   *  screen appeared" signal, never silently swallowed. */
  circuitBreakerTripped: { label: string; afterStepId: string } | null;
  /** Set when the recipe/session could not even be opened, or a step
   *  failed outright (not a guard trip). Absent on a clean run. */
  failure: string | null;
  steps: BrowserStepOutcome[];
}

type ValidationResult = { ok: true } | { ok: false; reason: string };

// ── Recipe validation (boundary check — recipes are external data) ──

const REQUIRED_FIELDS_BY_KIND: Record<BrowserStepKind, string[]> = {
  navigate: ['url'],
  waitFor: [],
  click: [],
  fill: [],
  upload: ['filePath'],
  assert: ['expect'],
};

function validateStep(step: BrowserStep, index: number): string | null {
  if (typeof step.id !== 'string' || step.id.length === 0) {
    return `step[${index}]: missing or non-string "id"`;
  }
  const required = REQUIRED_FIELDS_BY_KIND[step.kind];
  if (required === undefined) {
    return `step[${index}] ("${step.id}"): unknown kind "${String(step.kind)}"`;
  }
  for (const field of required) {
    if (!(field in step) || (step as unknown as Record<string, unknown>)[field] === undefined) {
      return `step[${index}] ("${step.id}"): kind "${step.kind}" requires "${field}"`;
    }
  }
  if ((step.kind === 'waitFor' || step.kind === 'click') && !step.selector && !step.text) {
    return `step[${index}] ("${step.id}"): kind "${step.kind}" requires "selector" or "text"`;
  }
  if (step.kind === 'fill' && !step.selector) {
    return `step[${index}] ("${step.id}"): kind "fill" requires "selector"`;
  }
  if (step.kind === 'fill' && step.value !== undefined && step.secretEnvVar !== undefined) {
    return `step[${index}] ("${step.id}"): "value" and "secretEnvVar" are mutually exclusive`;
  }
  if (step.kind === 'assert' && step.expect === 'textContains' && !step.text) {
    return `step[${index}] ("${step.id}"): expect "textContains" requires "text"`;
  }
  if (step.kind === 'assert' && (step.expect === 'visible' || step.expect === 'hidden') && !step.selector) {
    return `step[${index}] ("${step.id}"): expect "${step.expect}" requires "selector"`;
  }
  return null;
}

/** Validates a recipe before any browser interaction is attempted — recipes
 *  are external data (from a stored artifact or the manager's own
 *  generation), never trusted verbatim. Returns the first problem found. */
export function validateBrowserRecipe(recipe: BrowserRecipe): ValidationResult {
  if (!recipe.profileName || typeof recipe.profileName !== 'string') {
    return { ok: false, reason: 'recipe is missing a non-empty "profileName"' };
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    return { ok: false, reason: 'recipe must have at least one step' };
  }
  for (let i = 0; i < recipe.steps.length; i += 1) {
    const problem = validateStep(recipe.steps[i], i);
    if (problem) return { ok: false, reason: problem };
  }
  const guards = recipe.guards ?? [];
  for (let i = 0; i < guards.length; i += 1) {
    const g = guards[i];
    if (!g.label || (!g.selector && !g.textContains)) {
      return { ok: false, reason: `guard[${i}]: requires "label" and one of "selector"/"textContains"` };
    }
  }
  return { ok: true };
}

// ── Step JSON shaping ────────────────────────────────────────────────

/** Strips the recipe-authoring `id` field out of the step payload sent to
 *  Rust — the id is a caller-side bookkeeping concern (matching outcomes
 *  back to steps), not something the controller needs to execute a step. */
function stepPayload(step: BrowserStep): Record<string, unknown> {
  const { id: _id, irreversible: _irreversible, ...rest } = step;
  return rest;
}

interface RawStepResult {
  ok: boolean;
  detail?: string | null;
  error?: string | null;
  guardTripped?: string | null;
  screenshotBase64?: string | null;
}

function parseStepResult(raw: string): RawStepResult {
  try {
    const parsed = JSON.parse(raw) as RawStepResult;
    return {
      ok: parsed.ok === true,
      detail: parsed.detail ?? undefined,
      error: parsed.error ?? undefined,
      guardTripped: parsed.guardTripped ?? undefined,
      screenshotBase64: parsed.screenshotBase64 ?? undefined,
    };
  } catch {
    return { ok: false, error: `Malformed step result: ${raw}` };
  }
}

// ── Execution ────────────────────────────────────────────────────────

export interface RunBrowserRecipeOptions {
  /** Default true: the safe, default validation mode — stop BEFORE the
   *  step flagged `irreversible`, proving the state reached with the last
   *  screenshot instead of performing the irreversible action. */
  validateOnly?: boolean;
}

/** Runs a recipe against a persistent browser profile session. Never
 *  retries a failed step or a tripped guard — either condition aborts the
 *  run immediately and is reported honestly in the result, not swallowed.
 *  Always closes the session on the way out, success or failure. */
export async function runBrowserRecipe(
  recipe: BrowserRecipe,
  opts: RunBrowserRecipeOptions = {},
): Promise<BrowserRecipeResult> {
  const validation = validateBrowserRecipe(recipe);
  if (!validation.ok) {
    return { stoppedBeforeFinal: false, circuitBreakerTripped: null, failure: validation.reason, steps: [] };
  }

  const validateOnly = opts.validateOnly ?? true;
  const sessionId = recipe.profileName;
  const guardsJson = JSON.stringify(recipe.guards ?? []);
  const steps: BrowserStepOutcome[] = [];
  let stoppedBeforeFinal = false;
  let circuitBreakerTripped: BrowserRecipeResult['circuitBreakerTripped'] = null;
  let failure: string | null = null;

  try {
    await invoke<string>('browser_recipe_open', {
      sessionId,
      profileName: recipe.profileName,
      headless: recipe.headless ?? true,
    });
  } catch (err: unknown) {
    // Rust inserts the controller process into its session map BEFORE
    // reporting an "open" failure, so a failed open can still leave a
    // spawned-but-unopened process behind — best-effort close it now
    // rather than waiting for the next same-profile open or app exit.
    try {
      await invoke<string>('browser_recipe_close', { sessionId });
    } catch {
      /* best-effort cleanup only */
    }
    return {
      stoppedBeforeFinal: false,
      circuitBreakerTripped: null,
      failure: `Failed to open recipe session: ${errorMessage(err)}`,
      steps: [],
    };
  }

  try {
    for (const step of recipe.steps) {
      if (step.irreversible && validateOnly) {
        stoppedBeforeFinal = true;
        break;
      }

      let raw: string;
      try {
        raw = await invoke<string>('browser_recipe_step', {
          sessionId,
          stepJson: JSON.stringify(stepPayload(step)),
          guardsJson,
        });
      } catch (err: unknown) {
        steps.push({ id: step.id, kind: step.kind, ok: false, error: errorMessage(err) });
        failure = `Step "${step.id}" failed: ${errorMessage(err)}`;
        break;
      }

      const result = parseStepResult(raw);
      steps.push({
        id: step.id,
        kind: step.kind,
        ok: result.ok,
        detail: result.detail ?? undefined,
        error: result.error ?? undefined,
        guardTripped: result.guardTripped ?? undefined,
        screenshotBase64: result.screenshotBase64 ?? undefined,
      });

      // Circuit breaker or step failure: abort immediately, never retry,
      // never loop — this is the honest stop signal, not a silent skip.
      if (result.guardTripped) {
        circuitBreakerTripped = { label: result.guardTripped, afterStepId: step.id };
        break;
      }
      if (!result.ok) {
        failure = result.error ?? `Step "${step.id}" failed`;
        break;
      }
    }
  } finally {
    // Always close, success or failure — closing itself is best-effort
    // (never overrides the real result computed above with its own error).
    try {
      await invoke<string>('browser_recipe_close', { sessionId });
    } catch {
      /* best-effort cleanup only */
    }
  }

  return { stoppedBeforeFinal, circuitBreakerTripped, failure, steps };
}
