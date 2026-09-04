/* harnessRules.ts — Brain-as-harness: rule/agent/objective neurons.

   The central data model for the harness-engineering design (see
   _HARNESS-DESIGN-NOTES.md §5). Every harness artifact that other IDEs
   store as a static file (CLAUDE.md, .cursorrules, AGENTS.md, feature
   lists) becomes a TYPED BRAIN NEURON here, queryable deterministically
   by CSS selector over its data-cerveau-* attributes, and injected by
   SELECTING THE RIGHT BLOCK for the current context (project, agent,
   mode, active files) — never a dump.

   Design contract (mirrors the existing brain notes conventions):
   - The brain is the source of truth; files (AGENTS.md) are projections.
   - Rules are reference DATA only when injected: the prompt-building
     block wraps them in <harness_rules>...</harness_rules> and forbids
     treating them as directives/system prompts (same trust model as
     buildPromptBrainContext in ../brain/context.ts).
   - Lifecycle: trial → proven | evicted, driven by evalGate-style
     evidence (see lessons/evalGate.ts). `proven` rules inject first,
     `evicted` rules never inject (kept for audit).
   - Source: manual | learned | imported. `imported` rules are captured
     from the user's existing AGENTS.md/CLAUDE.md/.cursorrules/.lazyrules
     on project open (interop, revocable).

   Pure functions (parse/serialize/select/render) are separated from the
   thin async I/O wrappers so the ranking and selection logic is
   unit-testable on fixtures — the same convention skillInjection.ts and
   frictionMiner.ts follow.
*/

import { getPlatform } from '../platform/index.js';
import type { CaptureEvent } from '../platform/types.js';
import { estimateTokens } from '../brain/context.js';
import { matchPathGlob } from './harnessPathGlob.js';
import { parseRulesFile } from './harnessParseRules.js';

export { matchPathGlob };
export { parseRulesFile };

// ── Types ──────────────────────────────────────────────────────────

/** Where a rule applies. `general` = all projects (user level). */
export type RuleScope = 'general' | 'project' | 'module' | 'agent' | 'mode';

/** Where a rule came from — drives trust and revocability. */
export type RuleSource = 'manual' | 'learned' | 'imported';

/** Lifecycle status — `proven` injects first, `evicted` never injects. */
export type RuleStatus = 'trial' | 'proven' | 'evicted';

/** A single harness rule. Serialized as an <article data-cerveau-*> note. */
export interface HarnessRule {
  id: string;
  /** Short, imperative title (e.g. "[rule] Always run tests before claiming done"). */
  title: string;
  /** The rule body — short, actionable. */
  body: string;
  scope: RuleScope;
  /** Project id when scope=project (the projectIdFromRoot form). */
  project?: string;
  /** Agent name when scope=agent — the rule is bound to a specific agent. */
  agentName?: string;
  /** Mode name when scope=mode — e.g. "manager", "mission", "evaluator". */
  mode?: string;
  /** Glob the rule applies to (progressive disclosure), e.g. "src/lib/agents/**". */
  pathGlob?: string;
  /** Ordering — higher wins. */
  priority: number;
  source: RuleSource;
  status: RuleStatus;
  /** ISO date after which the rule stops injecting. */
  validUntil?: string;
  tags: string[];
  /** Provenance for `learned` rules: the mission that produced this rule. */
  missionId?: string;
  /** Provenance for `learned` rules: the verdict score that gated it. */
  verdictScore?: number;
}

/** Context against which rules are selected for injection. */
export interface HarnessRuleContext {
  project?: string;
  /** Absolute paths the current turn/mission touches (module glob matching). */
  activePaths?: string[];
  agentName?: string;
  mode?: string;
  /** When true, include trial rules (mission boot). Default true. */
  includeTrial?: boolean;
}

// ── Constants ──────────────────────────────────────────────────────

/** data-cerveau-type value for rule neurons. */
export const RULE_NEURON_TYPE = 'rule';
/** data-cerveau-type value for agent neurons. */
export const AGENT_NEURON_TYPE = 'agent';
/** data-cerveau-type value for objective (project-state) neurons. */
export const OBJECTIVE_NEURON_TYPE = 'objective';

/** Tag prefix used for structural queries (retro-compat with existing CSS queries). */
export const RULE_TAG = 'harness:rule';

/** Default token budget for the injected harness rules block. */
export const DEFAULT_RULES_MAX_TOKENS = 1200;
/** Default token budget for the injected agent block. */
export const DEFAULT_AGENT_MAX_TOKENS = 1200;
/** Default token budget for the injected project-state block. */
export const DEFAULT_STATE_MAX_TOKENS = 800;
/** Default token budget for module-scoped rules (progressive disclosure). */
export const DEFAULT_MODULE_MAX_TOKENS = 600;

/** Standard onboarding files, in priority order (first match wins for reading). */
export const STANDARD_RULES_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.lazyrules',
  '.lazyrules.md',
  'LAZYRULES',
  'LAZYRULES.md',
] as const;

// ── Pure: HTML serialization ──────────────────────────────────────

function attr(name: string, value: string | number | undefined): string {
  if (value === undefined || value === '') return '';
  return ` ${name}="${escapeAttr(String(value))}"`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/** Serialize a rule to an <article data-cerveau-*> HTML block. Pure. */
export function buildRuleArticleHtml(rule: HarnessRule): string {
  const lines = [
    '<article' +
      ` data-cerveau-type="${RULE_NEURON_TYPE}"` +
      ` data-cerveau-scope="${rule.scope}"` +
      attr('data-cerveau-project', rule.project) +
      attr('data-cerveau-path', rule.pathGlob) +
      attr('data-cerveau-agent', rule.agentName) +
      attr('data-cerveau-mode', rule.mode) +
      attr('data-cerveau-priority', rule.priority) +
      attr('data-cerveau-source', rule.source) +
      attr('data-cerveau-status', rule.status) +
      attr('data-cerveau-valid-until', rule.validUntil) +
      '>',
    `  <h1>${rule.title}</h1>`,
    `  <p>${rule.body}</p>`,
    '</article>',
  ];
  return lines.join('\n');
}

/** Convert a rule to a CaptureEvent for brain.capture. Pure. */
export function ruleToCaptureEvent(rule: HarnessRule): CaptureEvent {
  const tags = [RULE_TAG, `scope:${rule.scope}`, `status:${rule.status}`];
  if (rule.project) tags.push(`project:${rule.project}`);
  if (rule.agentName) tags.push(`agent:${rule.agentName}`);
  if (rule.mode) tags.push(`mode:${rule.mode}`);
  if (rule.missionId) tags.push(`mission:${rule.missionId}`);
  tags.push(...rule.tags);

  return {
    kind: 'learning',
    title: `[rule] ${rule.title.replace(/^\[rule\]\s*/i, '').slice(0, 120)}`,
    text: rule.body,
    tags,
    source: `lazy-ide:${rule.source === 'imported' ? 'rules-import' : 'harness'}`,
    space: 'code',
    cwd: rule.project,
    topic: rule.scope,
  };
}

// ── Pure: context-aware selection (the "right block") ──────────────

/**
 * Select which rules to inject for a given context. Pure.
 *
 * Selection order (the "bon bail" resolution):
 *   1. Never inject `evicted` or expired rules.
 *   2. `proven` rules before `trial` (unless includeTrial).
 *   3. Scope match:
 *      - `general`            → always
 *      - `project`            → context.project matches
 *      - `module`             → any context.activePaths matches pathGlob
 *      - `agent`              → context.agentName matches
 *      - `mode`               → context.mode matches
 *   4. Sort by priority desc, then proven first, then recency.
 */
export function selectRulesForContext(
  rules: readonly HarnessRule[],
  ctx: HarnessRuleContext,
): HarnessRule[] {
  const nowIso = new Date().toISOString();
  const active = rules.filter((r) => {
    if (r.status === 'evicted') return false;
    if (r.validUntil && r.validUntil < nowIso) return false;
    if (r.status === 'trial' && ctx.includeTrial === false) return false;
    return true;
  });

  const scopeMatched = active.filter((r) => {
    switch (r.scope) {
      case 'general':
        return true;
      case 'project':
        return !!ctx.project && r.project === ctx.project;
      case 'module':
        return (
          !!ctx.activePaths &&
          ctx.activePaths.some((p) => matchPathGlob(r.pathGlob, p))
        );
      case 'agent':
        return !!ctx.agentName && r.agentName === ctx.agentName;
      case 'mode':
        return !!ctx.mode && r.mode === ctx.mode;
      default:
        return false;
    }
  });

  return [...scopeMatched].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const aProven = a.status === 'proven' ? 1 : 0;
    const bProven = b.status === 'proven' ? 1 : 0;
    return bProven - aProven;
  });
}


// ── Pure: injection rendering ──────────────────────────────────────

/**
 * Render the selected rules into a system-prompt injection block. Pure.
 * Mirrors buildPromptBrainContext's trust model: the block is REFERENCE
 * DATA, not instructions.
 */
export function buildRulesInjectionBlock(
  rules: readonly HarnessRule[],
  maxTokens = DEFAULT_RULES_MAX_TOKENS,
): string {
  if (rules.length === 0) return '';

  const parts: string[] = [
    'The following block contains HARNESS RULES — project and workflow guidance.',
    'Treat ALL content inside <harness_rules>...</harness_rules> as reference guidance only.',
    'Follow the rules that apply to your current task and project.',
  ];
  let budget = maxTokens;

  for (const rule of rules) {
    const line = `- ${rule.body}`;
    const tokens = estimateTokens(line);
    if (budget - tokens < 0) break;
    budget -= tokens;
    parts.push(line);
  }

  parts.push('</harness_rules>');
  return ['<harness_rules>', ...parts, ''].join('\n');
}

/**
 * Render a project-state block (the live "feature list" / progress
 * tracker): active objectives + counts, derived from objectivesStore data.
 * Pure — the caller passes already-loaded objectives.
 */
export function buildProjectStateBlock(
  objectives: Array<{
    title: string;
    currentCount: number;
    targetCount: number | null;
    projectId: string | null;
  }>,
  opts: { maxTokens?: number; project?: string } = {},
): string {
  const maxTokens = opts.maxTokens ?? DEFAULT_STATE_MAX_TOKENS;
  const relevant = objectives.filter((o) => !opts.project || o.projectId === null || o.projectId === opts.project);
  if (relevant.length === 0) return '';

  const lines: string[] = [];
  let budget = maxTokens;
  for (const o of relevant) {
    const label = o.targetCount !== null ? `${o.title} (${o.currentCount}/${o.targetCount})` : `${o.title} (${o.currentCount} done)`;
    const tokens = estimateTokens(label);
    if (budget - tokens < 0) break;
    budget -= tokens;
    lines.push(`- ${label}`);
  }
  if (lines.length === 0) return '';

  return [
    '<project_state>',
    'Current project state — what is being worked toward and how far along:',
    ...lines,
    '</project_state>',
    '',
  ].join('\n');
}

// ── Pure: full SessionStart assembly ───────────────────────────────

/**
 * Assemble the full SessionStart harness block for a mission prompt:
 *   general rules → project rules → module rules → agent rules → mode
 *   rules → project state (objectives). Each section is independently
 *   budgeted. Pure assembly: all inputs are passed in; returns '' when
 *   nothing applies.
 */
export function assembleHarnessSessionBlock(
  rules: readonly HarnessRule[],
  ctx: HarnessRuleContext,
  objectives: Array<{
    title: string;
    currentCount: number;
    targetCount: number | null;
    projectId: string | null;
  }>,
  opts: { rulesMaxTokens?: number; stateMaxTokens?: number } = {},
): string {
  const blocks: string[] = [];

  // General rules (the "root CLAUDE.md map").
  const general = selectRulesForContext(rules, { ...ctx, activePaths: undefined });
  const generalBlock = buildRulesInjectionBlock(
    general.filter((r) => r.scope === 'general'),
    opts.rulesMaxTokens ?? DEFAULT_RULES_MAX_TOKENS,
  );
  if (generalBlock) blocks.push(generalBlock);

  // Project + module + agent + mode rules.
  const scoped = selectRulesForContext(rules, ctx).filter(
    (r) => r.scope !== 'general',
  );
  const scopedBlock = buildRulesInjectionBlock(
    scoped,
    opts.rulesMaxTokens ?? DEFAULT_RULES_MAX_TOKENS,
  );
  if (scopedBlock) blocks.push(scopedBlock);

  // Project state (live feature list / progress tracker).
  const stateBlock = buildProjectStateBlock(objectives, {
    maxTokens: opts.stateMaxTokens ?? DEFAULT_STATE_MAX_TOKENS,
    project: ctx.project,
  });
  if (stateBlock) blocks.push(stateBlock);

  return blocks.join('\n').trim();
}


// ── Async I/O wrappers (thin, never throw to callers) ──────────────

/**
 * Capture a rule as a brain neuron. Fire-and-forget: a brain failure
 * never propagates to the caller. Returns the capture id when the brain
 * answered, null otherwise.
 */
export async function captureRule(rule: HarnessRule): Promise<string | null> {
  try {
    const platform = getPlatform();
    if (!platform?.brain?.capture) return null;
    const result = await platform.brain.capture(ruleToCaptureEvent(rule));
    if (result?.id) {
      const { scheduleSidecarReloadAfterStore } = await import('./sidecarReload.js');
      scheduleSidecarReloadAfterStore();
    }
    return result?.id ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[harnessRules] captureRule failed:', rule.title, msg);
    return null;
  }
}

/**
 * Read the first standard onboarding file that exists in the project
 * root, in priority order (AGENTS.md > CLAUDE.md > .cursorrules > …).
 * Returns { fileName, content } or null when none exists.
 */
export async function readStandardRulesFile(
  projectRoot: string,
  platformFs?: { readFile(path: string): Promise<string> },
): Promise<{ fileName: string; content: string } | null> {
  const fs = platformFs ?? getPlatform().fs;
  for (const name of STANDARD_RULES_FILES) {
    const filePath = `${projectRoot}/${name}`.replace(/\\/g, '/');
    try {
      const content = await fs.readFile(filePath);
      if (content && content.trim()) {
        return { fileName: name, content: content.trim() };
      }
    } catch {
      // file not found — try next
    }
  }
  return null;
}

/**
 * Import a project's standard onboarding file into brain rule neurons.
 * `source=imported` keeps the rules revocable (a user can delete them from
 * the Règles panel). Deduplicates against existing imported rules by body.
 * Returns the number of rules actually captured.
 */
export async function importProjectOnboardingFile(
  projectRoot: string,
  project?: string,
): Promise<number> {
  try {
    const found = await readStandardRulesFile(projectRoot);
    if (!found) return 0;
    const parsed = parseRulesFile(found.content, {
      scope: 'project',
      project,
      source: 'imported',
      status: 'proven',
    });
    if (parsed.length === 0) return 0;

    let captured = 0;
    const existing = await listRules({ status: 'proven', scope: 'project', project });
    const existingBodies = new Set(existing.map((r) => r.body.toLowerCase()));

    for (const rule of parsed) {
      if (existingBodies.has(rule.body.toLowerCase())) continue;
      const id = await captureRule(rule);
      if (id) {
        captured++;
        existingBodies.add(rule.body.toLowerCase());
      }
    }
    return captured;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[harnessRules] importProjectOnboardingFile failed:', msg);
    return 0;
  }
}


/**
 * List rules stored in the brain via structural CSS queries. Because the
 * engine returns text (not structured rows), this function parses the
 * queryCss output heuristically — matching the pattern already used by
 * skillInjection.ts's parseSkillBrainOutput. When no brain is available it
 * returns [] (never throws).
 */
export async function listRules(opts: {
  status?: RuleStatus;
  scope?: RuleScope;
  project?: string;
  limit?: number;
} = {}): Promise<HarnessRule[]> {
  try {
    const platform = getPlatform();
    if (!platform?.brain?.queryCss) return [];
    const selectors: string[] = [`article[data-cerveau-type="${RULE_NEURON_TYPE}"]`];
    if (opts.status) selectors.push(`[data-cerveau-status="${opts.status}"]`);
    if (opts.scope) selectors.push(`[data-cerveau-scope="${opts.scope}"]`);
    if (opts.project) selectors.push(`[data-cerveau-project="${opts.project}"]`);
    const raw = await platform.brain.queryCss(selectors.join(''), opts.limit ?? 100);
    return parseRuleCssOutput(raw);
  } catch {
    return [];
  }
}

/**
 * Parse the text output of a brain_query_css call into HarnessRule[]
 * objects. Pure. The engine's queryCss output has one line per note of
 * the form: `#<id> | <title>: <body>` (same shape parseSkillBrainOutput
 * in skillInjection.ts relies on).
 */
export function parseRuleCssOutput(raw: string): HarnessRule[] {
  if (!raw || raw === '0 matches' || raw.startsWith('(')) return [];
  const rules: HarnessRule[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^#([\w-]+)\s*\|\s*(\[rule\]\s*.+?):\s*(.*)$/i);
    if (!m) continue;
    const body = (m[3] ?? '').trim();
    rules.push({
      id: m[1],
      title: m[2].trim(),
      body: body || m[2].trim(),
      scope: 'project',
      priority: 50,
      source: 'imported',
      status: 'proven',
      tags: [],
    });
  }
  return rules;
}

/**
 * Load and assemble the harness SessionStart block from REAL sources:
 *   - rules from the brain (general + project + agent + mode scopes)
 *   - objectives from objectivesStore (loaded on demand)
 *   - imported onboarding file, when present and not yet imported
 *
 * Fire-and-forget friendly: returns '' on any failure — a harness block
 * must never block mission start.
 */
export async function loadHarnessSessionBlock(
  ctx: HarnessRuleContext,
  opts: { projectRoot?: string; includeTrial?: boolean } = {},
): Promise<string> {
  try {
    const rules = await listRules({ limit: 200 });
    const objectives = await loadObjectivesForHarness();

    // Lazy import: when the project has a standard onboarding file that we
    // have not captured yet, capture it once (revocable, source=imported).
    if (opts.projectRoot) {
      try {
        await importProjectOnboardingFile(opts.projectRoot, ctx.project);
      } catch {
        // non-fatal — rules still work from the brain
      }
    }

    return assembleHarnessSessionBlock(rules, ctx, objectives);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[harnessRules] loadHarnessSessionBlock failed:', msg);
    return '';
  }
}

/**
 * Load objectives for the harness block. Uses objectivesStore when
 * available (dynamic import to avoid a hard dependency cycle), falling
 * back to [] on any failure.
 */
async function loadObjectivesForHarness(
): Promise<Array<{ title: string; currentCount: number; targetCount: number | null; projectId: string | null }>> {
  try {
    const { ensureObjectivesLoaded, getObjectives } = await import('../objectives/objectivesStore.js');
    await ensureObjectivesLoaded();
    return getObjectives();
  } catch {
    return [];
  }
}


// ── AGENTS.md projection (G2) ─────────────────────────────────────

/** Ownership markers for the brain-owned block inside a user's AGENTS.md. */
export const AGENTS_MD_BEGIN_MARKER = '<!-- lazybrain:begin generated:do-not-edit -->';
export const AGENTS_MD_END_MARKER = '<!-- lazybrain:end -->';

/**
 * Render the brain-owned AGENTS.md block from rules + project state. Pure.
 * Same marker convention as the engine's export-agents-md.ts: human prose
 * outside the markers is never touched; unbalanced markers abort the write.
 */
export function renderAgentsMdBlock(
  rules: readonly HarnessRule[],
  objectives: Array<{ title: string; currentCount: number; targetCount: number | null; projectId: string | null }>,
  opts: { project?: string; maxTokens?: number } = {},
): string {
  const lines: string[] = [];
  lines.push(AGENTS_MD_BEGIN_MARKER);
  lines.push('# Harness rules (maintained by Lazy — do not edit between markers)');

  const applicable = selectRulesForContext(rules, { project: opts.project });
  let budget = opts.maxTokens ?? DEFAULT_RULES_MAX_TOKENS;
  for (const rule of applicable) {
    const line = `- ${rule.body}`;
    const tokens = estimateTokens(line);
    if (budget - tokens < 0) break;
    budget -= tokens;
    lines.push(line);
  }

  const relevantObjectives = objectives.filter((o) => !opts.project || o.projectId === null || o.projectId === opts.project);
  if (relevantObjectives.length > 0) {
    lines.push('');
    lines.push('## Current goals');
    for (const o of relevantObjectives) {
      lines.push(`- ${o.targetCount !== null ? `${o.title} (${o.currentCount}/${o.targetCount})` : `${o.title} (${o.currentCount} done)`}`);
    }
  }

  lines.push(AGENTS_MD_END_MARKER);
  return lines.join('\n');
}

/**
 * Upsert the brain-owned AGENTS.md block into the project's AGENTS.md file.
 * Preserves human prose outside the markers; replaces the old brain block
 * when present. Returns { written, reason } — never throws.
 */
export async function writeAgentsMdProjection(
  projectRoot: string,
  opts: { project?: string } = {},
): Promise<{ written: boolean; reason: string }> {
  try {
    const rules = await listRules({ limit: 200 });
    const objectives = await loadObjectivesForHarness();
    const block = renderAgentsMdBlock(rules, objectives, { project: opts.project });
    const targetPath = `${projectRoot}/AGENTS.md`.replace(/\\/g, '/');

    const platform = getPlatform();
    let existing = '';
    try {
      existing = await platform.fs.readFile(targetPath);
    } catch {
      // file does not exist — we will create it
    }

    const beginIdx = existing.indexOf(AGENTS_MD_BEGIN_MARKER);
    const endIdx = existing.indexOf(AGENTS_MD_END_MARKER);

    let next: string;
    if (beginIdx === -1 && endIdx === -1) {
      next = existing.trim()
        ? `${existing.trim()}\n\n${block}\n`
        : block;
    } else if (beginIdx === -1 || endIdx === -1) {
      // Unbalanced markers — never touch a file we don't own cleanly.
      return { written: false, reason: 'unbalanced markers — aborting to preserve human content' };
    } else {
      next = existing.slice(0, beginIdx) + block + existing.slice(endIdx + AGENTS_MD_END_MARKER.length);
    }

    await platform.fs.writeFile(targetPath, next);
    return { written: true, reason: 'projection written' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[harnessRules] writeAgentsMdProjection failed:', msg);
    return { written: false, reason: msg };
  }
}

