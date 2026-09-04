/* managerActionValidator.ts — Per-type field validation for ManagerAction.
 *
 * parseManagerActions (managerEngine.ts) previously only checked that the
 * parsed JSON object had a `type` string matching a known action type. It
 * never validated that the REQUIRED fields for that type were present or
 * had the right shape — a malformed `launch_mission` missing its `task`
 * string, or a `brain_query` with a non-string `query`, would silently
 * pass through and either crash the executor or no-op confusingly.
 *
 * This module provides a per-type validator map. Each validator checks
 * the required fields for its action type and returns { ok: false, reason }
 * when a required field is missing or has the wrong type. Optional fields
 * are NOT validated (their presence is a bonus, not a requirement).
 */

export type ValidationResult = { ok: true } | { ok: false; reason: string };

type Validator = (a: Record<string, unknown>) => ValidationResult;

function requireString(a: Record<string, unknown>, field: string): true | string {
  const v = a[field];
  if (typeof v !== 'string' || v.length === 0) return `missing or non-string "${field}"`;
  return true;
}

function requireNumber(a: Record<string, unknown>, field: string): true | string {
  const v = a[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) return `missing or non-finite-number "${field}"`;
  return true;
}

function requireArray(a: Record<string, unknown>, field: string): true | string {
  const v = a[field];
  if (!Array.isArray(v)) return `missing or non-array "${field}"`;
  return true;
}

function requireBoolean(a: Record<string, unknown>, field: string): true | string {
  const v = a[field];
  if (typeof v !== 'boolean') return `missing or non-boolean "${field}"`;
  return true;
}

/** Optional field: only checked when present — a `modelId` (exact catalog
 *  id, see ManagerModelId's doc comment in types.ts) is never required, but
 *  when the model DID emit one it must be a non-empty string, not some other
 *  JSON type that would blow up resolveManagerModelId's catalog lookup. */
function optionalString(a: Record<string, unknown>, field: string): true | string {
  const v = a[field];
  if (v === undefined) return true;
  if (typeof v !== 'string' || v.length === 0) return `non-string "${field}"`;
  return true;
}

/** Optional field: only checked when present — e.g. create_loop's
 *  `superviseFirstN` (charter-seeded regime threshold) is never required
 *  (an ordinary ungated loop omits it entirely), but a present value must be
 *  a real number. */
function optionalNumber(a: Record<string, unknown>, field: string): true | string {
  const v = a[field];
  if (v === undefined) return true;
  if (typeof v !== 'number' || !Number.isFinite(v)) return `non-finite-number "${field}"`;
  return true;
}

/** Optional field: only checked when present — run_browser_recipe's
 *  `validateOnly` defaults to true (RunBrowserRecipeOptions, browserRecipe.ts)
 *  so the model never needs to spell out the safe default just to stay
 *  token-compact; a present value must still be a real boolean. */
function optionalBoolean(a: Record<string, unknown>, field: string): true | string {
  const v = a[field];
  if (v === undefined) return true;
  if (typeof v !== 'boolean') return `non-boolean "${field}"`;
  return true;
}

/** Optional field: only checked when present — launch_mission's
 *  `extraReadableProjectIds` (cross-project read access, see
 *  ManagerAction's own doc comment in types.ts) is never required (the
 *  overwhelming common case: a mission only needs its own worktree), but a
 *  present value must be an array of non-empty strings, not some other
 *  JSON shape that would blow up the executor's per-entry project
 *  resolution. */
function optionalStringArray(a: Record<string, unknown>, field: string): true | string {
  const v = a[field];
  if (v === undefined) return true;
  if (!Array.isArray(v) || !v.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    return `non-string-array "${field}"`;
  }
  return true;
}

function requireObject(a: Record<string, unknown>, field: string): true | string {
  const v = a[field];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return `missing or non-object "${field}"`;
  return true;
}

function ok(): ValidationResult {
  return { ok: true };
}

function fail(reason: string): ValidationResult {
  return { ok: false, reason };
}

function check(...checks: Array<true | string>): ValidationResult {
  for (const c of checks) {
    if (c !== true) return fail(c);
  }
  return ok();
}

/** Validates one entry of propose_mission_charter's `decisions` array — see
 *  DecisionWithRecommendation's doc comment (types.ts) for why every field
 *  here is required: a decision that only asks (no `recommended`/`rationale`)
 *  is the ordinary structuring question, not a charter decision. */
function requireDecisionShape(d: unknown): true | string {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return 'a "decisions" entry must be an object';
  const dd = d as Record<string, unknown>;
  const question = requireString(dd, 'question');
  if (question !== true) return `decision ${question}`;
  const options = requireArray(dd, 'options');
  if (options !== true) return `decision ${options}`;
  const recommended = requireString(dd, 'recommended');
  if (recommended !== true) return `decision ${recommended}`;
  const rationale = requireString(dd, 'rationale');
  if (rationale !== true) return `decision ${rationale}`;
  return true;
}

/** Validates propose_mission_charter's full shape — the five-block Mission
 *  Charter (see MissionCharter's doc comment, types.ts). Structural only
 *  (field presence/type); the RULE that "recurring"/"permanent" is the only
 *  nature ever entering trial mode lives in the prompt (managerEngine.ts),
 *  not here — a validator checks shape, not business logic. */
function validateMissionCharterAction(a: Record<string, unknown>): ValidationResult {
  const objective = requireString(a, 'objective');
  if (objective !== true) return fail(objective);

  const nature = a['nature'];
  if (typeof nature !== 'object' || nature === null || Array.isArray(nature)) {
    return fail('missing or non-object "nature"');
  }
  const kind = (nature as Record<string, unknown>)['kind'];
  if (kind !== 'unique' && kind !== 'recurring' && kind !== 'permanent') {
    return fail('"nature.kind" must be "unique", "recurring", or "permanent"');
  }

  const decisionsCheck = requireArray(a, 'decisions');
  if (decisionsCheck !== true) return fail(decisionsCheck);
  for (const d of a['decisions'] as unknown[]) {
    const shapeCheck = requireDecisionShape(d);
    if (shapeCheck !== true) return fail(shapeCheck);
  }

  const gates = a['validationGates'];
  if (typeof gates !== 'object' || gates === null || Array.isArray(gates)) {
    return fail('missing or non-object "validationGates"');
  }
  if (!Array.isArray((gates as Record<string, unknown>)['frozenOnce'])) {
    return fail('"validationGates.frozenOnce" must be an array');
  }

  const learning = a['learning'];
  if (typeof learning !== 'object' || learning === null || Array.isArray(learning)) {
    return fail('missing or non-object "learning"');
  }
  const l = learning as Record<string, unknown>;
  for (const field of ['measure', 'measureSource', 'influences', 'killSwitch']) {
    const v = l[field];
    if (typeof v !== 'string' || v.length === 0) return fail(`missing or non-string "learning.${field}"`);
  }

  return ok();
}

/** Validates one entry of propose_artifact's `variants[].views` array — see
 *  ArtifactView's doc comment (types.ts): `id`/`label`/`html` are required,
 *  `width`/`height` are optional and unchecked here (their presence is a
 *  bonus, same convention as every other optional field in this module). */
function requireArtifactViewShape(v: unknown): true | string {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'a "views" entry must be an object';
  const vv = v as Record<string, unknown>;
  const id = requireString(vv, 'id');
  if (id !== true) return `view ${id}`;
  const label = requireString(vv, 'label');
  if (label !== true) return `view ${label}`;
  const html = requireString(vv, 'html');
  if (html !== true) return `view ${html}`;
  return true;
}

/** Validates one entry of propose_artifact's `variants` array — an
 *  id/label plus at least one view (ArtifactVariant's own doc comment: "at
 *  least one view — never assumed to be exactly one"). */
function requireArtifactVariantShape(v: unknown): true | string {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'a "variants" entry must be an object';
  const vv = v as Record<string, unknown>;
  const id = requireString(vv, 'id');
  if (id !== true) return `variant ${id}`;
  const label = requireString(vv, 'label');
  if (label !== true) return `variant ${label}`;
  const viewsCheck = requireArray(vv, 'views');
  if (viewsCheck !== true) return `variant ${viewsCheck}`;
  const views = vv['views'] as unknown[];
  if (views.length === 0) return 'variant "views" must have at least one entry';
  for (const view of views) {
    const shapeCheck = requireArtifactViewShape(view);
    if (shapeCheck !== true) return shapeCheck;
  }
  return true;
}

/** Validates propose_artifact's full shape (visible-artifact fix — see
 *  ArtifactProposal's doc comment, types.ts): a name plus at least one
 *  variant, each carrying at least one view. Structural only, same
 *  "shape, not business logic" scope as validateMissionCharterAction above. */
function validateProposeArtifactAction(a: Record<string, unknown>): ValidationResult {
  const name = requireString(a, 'name');
  if (name !== true) return fail(name);

  const variantsCheck = requireArray(a, 'variants');
  if (variantsCheck !== true) return fail(variantsCheck);
  const variants = a['variants'] as unknown[];
  if (variants.length === 0) return fail('"variants" must have at least one entry');
  for (const v of variants) {
    const shapeCheck = requireArtifactVariantShape(v);
    if (shapeCheck !== true) return fail(shapeCheck);
  }

  const artifactId = optionalString(a, 'artifactId');
  if (artifactId !== true) return fail(artifactId);
  const version = optionalString(a, 'version');
  if (version !== true) return fail(version);
  const selectedVariantId = optionalString(a, 'selectedVariantId');
  if (selectedVariantId !== true) return fail(selectedVariantId);
  const projectId = optionalString(a, 'projectId');
  if (projectId !== true) return fail(projectId);

  return ok();
}

const validators: Record<string, Validator> = {
  create_agent: (a) => check(requireObject(a, 'agent')),
  launch_mission: (a) => check(
    requireString(a, 'task'),
    optionalString(a, 'modelId'),
    optionalString(a, 'projectId'),
    optionalStringArray(a, 'extraReadableProjectIds'),
  ),
  launch_best_of_n: (a) => check(requireString(a, 'task'), requireNumber(a, 'n'), optionalString(a, 'modelId')),
  fork_graph_run: (a) => check(requireString(a, 'planId')),
  resume_graph_run: (a) => check(requireString(a, 'planId')),
  create_loop: (a) => check(
    requireString(a, 'task'),
    optionalString(a, 'modelId'),
    optionalNumber(a, 'superviseFirstN'),
    optionalString(a, 'measure'),
    optionalString(a, 'killSwitch'),
    optionalString(a, 'templateArtifactRef'),
  ),
  pause_loop: (a) => check(requireString(a, 'loopId')),
  delete_loop: (a) => check(requireString(a, 'loopId')),
  stop_mission: (a) => check(requireString(a, 'missionId')),
  stop_all: () => ok(),
  retry_mission: (a) => check(requireString(a, 'missionId')),
  delete_mission: (a) => check(requireString(a, 'missionId'), optionalBoolean(a, 'discardWorktree')),
  list_agents: () => ok(),
  list_missions: () => ok(),
  brain_query: (a) => {
    if (a['sessionId'] !== undefined && typeof a['sessionId'] !== 'string') {
      return fail('non-string "sessionId"');
    }
    return check(requireString(a, 'query'));
  },
  brain_query_css: (a) => check(requireString(a, 'selector')),
  brain_neighbours: (a) => check(requireString(a, 'id')),
  scan_project: (a) => {
    if (a['projectId'] !== undefined && typeof a['projectId'] !== 'string') {
      return fail('non-string "projectId"');
    }
    if (a['depth'] !== undefined && a['depth'] !== 'quick' && a['depth'] !== 'deep') {
      return fail('"depth" must be "quick" or "deep"');
    }
    return ok();
  },
  web_search: (a) => check(requireString(a, 'query')),
  web_fetch: (a) => check(requireString(a, 'url')),
  query_mission: (a) => check(requireString(a, 'missionId')),
  get_agent_output: (a) => check(requireString(a, 'missionId')),
  clone_mission: (a) => check(requireString(a, 'missionId')),
  quote_mission: (a) => check(requireString(a, 'task')),
  spawn_submissions: (a) => check(requireString(a, 'missionId')),
  set_budget: (a) => check(requireNumber(a, 'limitUsd')),
  set_approval_mode: (a) => check(requireString(a, 'mode')),
  revert_mission: (a) => check(requireString(a, 'missionId')),
  briefing_query: () => ok(),
  decision_lookup: (a) => check(requireString(a, 'question')),
  reassign_agent: (a) => check(requireString(a, 'missionId'), requireString(a, 'model')),
  answer_question: (a) => check(requireString(a, 'missionId'), requireString(a, 'answer')),
  canvas_overview: () => ok(),
  create_draft: (a) => check(requireString(a, 'task'), optionalString(a, 'modelId')),
  launch_draft: () => ok(),
  chain_agents: (a) => {
    const t = a['target'];
    if (t === null || typeof t !== 'object' || Array.isArray(t)) return fail('missing or non-object "target"');
    return ok();
  },
  unchain: (a) => check(requireString(a, 'chainId')),
  arrange_canvas: () => ok(),
  focus_canvas: () => ok(),
  move_node: (a) => check(requireNumber(a, 'x'), requireNumber(a, 'y')),
  canvas_note: (a) => check(requireString(a, 'text')),
  collapse_project: (a) => check(requireString(a, 'projectId'), requireBoolean(a, 'collapsed')),
  analyze_frictions: () => ok(),
  pin_chain: (a) => check(requireString(a, 'chainId')),
  unpin_chain: (a) => check(requireString(a, 'chainId')),
  refire_chain: (a) => check(requireString(a, 'chainId')),
  approve_mission: (a) => check(requireString(a, 'missionId')),
  reject_mission: (a) => check(requireString(a, 'missionId'), requireString(a, 'feedback')),
  create_router: (a) => {
    const br = requireArray(a, 'branches');
    if (br !== true) return fail(br);
    const branches = a['branches'] as unknown[];
    if (branches.length < 2) return fail('router must have at least 2 branches');
    return ok();
  },
  open_report: () => ok(),
  save_macro: (a) => check(requireString(a, 'name'), requireArray(a, 'refs')),
  instantiate_macro: (a) => check(requireString(a, 'name')),
  // This only guards the outer envelope — `steps` themselves (id
  // uniqueness/dependsOn integrity) are repaired downstream, right before
  // createOrchestrator persists them, by graph/planStepRepair.ts's
  // `repairPlanSteps` (P0 crash round 3, P2 — see that module's own header
  // for why the check belongs there and not here: it needs live canvas
  // state this validator has no access to).
  generate_plan: (a) => check(requireString(a, 'objective')),
  execute_plan: (a) => check(requireString(a, 'planId')),
  revise_plan: (a) => check(requireString(a, 'planId')),
  reject_plan: (a) => check(requireString(a, 'planId')),
  start_preview: () => ok(),
  provision_service: (a) => check(requireString(a, 'service')),
  teardown_service: (a) => check(requireString(a, 'serviceId')),
  clear_canvas: (a) => check(requireString(a, 'scope'), optionalBoolean(a, 'includeReview')),
  archive_mission: (a) => check(requireString(a, 'missionId')),
  archive_terminated: () => ok(),
  delete_draft: (a) => check(requireString(a, 'draftId')),
  delete_note: (a) => check(requireString(a, 'noteId')),
  delete_router: (a) => check(requireString(a, 'routerId')),
  delete_join: (a) => check(requireString(a, 'joinId')),
  delete_frame: (a) => check(requireString(a, 'frameId')),
  close_surface: (a) => check(requireString(a, 'surfaceId')),
  open_project: (a) => check(requireString(a, 'path')),
  create_project: (a) => check(requireString(a, 'path')),
  close_project: () => ok(),
  self_improve: () => ok(),
  create_agent_template: (a) => check(requireString(a, 'missionId')),
  learn_pattern: (a) => check(requireString(a, 'trigger'), requireString(a, 'action'), requireString(a, 'outcome')),
  propose_mission_charter: (a) => validateMissionCharterAction(a),
  propose_artifact: (a) => validateProposeArtifactAction(a),
  info: (a) => check(requireString(a, 'message')),
  // ── LazyBots (A3) — the manager creates/manages LazyBots from the chat.
  // `name` is required for create (the manager must ask the user for one —
  // never invent it); `botId` is required for update/run/stop. `systemPrompt`
  // is required because the executor builds a real BotConfig from it.
  // Optional rich fields (profileIds / routines / avatar / budgetCapUsd)
  // mirror botsStore.createBot — validated only when present.
  create_lazybot: (a) => {
    const routinesCheck = (() => {
      if (a['routines'] === undefined) return true as const;
      if (!Array.isArray(a['routines'])) return 'non-array "routines"';
      return true as const;
    })();
    return check(
      requireString(a, 'name'),
      requireString(a, 'systemPrompt'),
      optionalString(a, 'description'),
      optionalString(a, 'avatar'),
      optionalNumber(a, 'budgetCapUsd'),
      optionalStringArray(a, 'profileIds'),
      routinesCheck,
    );
  },
  update_lazybot: (a) => check(requireString(a, 'botId'), requireObject(a, 'patch')),
  run_lazybot: (a) => check(requireString(a, 'botId'), requireString(a, 'task')),
  stop_lazybot: (a) => check(requireString(a, 'botId')),
  list_lazybots: () => ok(),
  // Mission D — generic web-surface publishing via a driven browser (see
  // src/lib/agents/browserRecipe.ts). `recipe` is opaque DATA here (no
  // site-specific shape checking belongs in the manager dispatch layer —
  // runBrowserRecipe/validateBrowserRecipe do the real, per-step
  // validation); this only guards the outer envelope the model must emit.
  // `validateOnly` defaults to true (see optionalBoolean's doc comment) —
  // FIX: this used to require it via requireBoolean, which rejected the
  // (correct, token-compact) common case of omitting the safe default.
  run_browser_recipe: (a) => check(requireObject(a, 'recipe'), optionalBoolean(a, 'validateOnly')),
};

/** Every recognized manager action type — the exhaustive list actionGate's
 *  classifier is expected to cover (see actionClassifier.test's "none
 *  unknown" assertion). Derived from the validator map itself so it can
 *  never drift out of sync with what parseManagerActions/executeManagerAction
 *  actually accept. */
export const KNOWN_ACTION_TYPES: readonly string[] = Object.keys(validators);

/** Validate a single parsed action object against its type's required fields.
 *  Returns { ok: true } when valid, or { ok: false, reason } with a
 *  human-readable explanation of what's wrong. Unknown action types
 *  (not in the validator map) are rejected. */
export function validateManagerAction(a: unknown): ValidationResult {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) {
    return fail('not an object');
  }
  const obj = a as Record<string, unknown>;
  const type = obj['type'];
  if (typeof type !== 'string') {
    return fail('missing or non-string "type"');
  }
  const validator = validators[type];
  if (!validator) {
    return fail(`unknown action type "${type}"`);
  }
  return validator(obj);
}
