/* managerEccCatalog.ts — Compact, grouped catalog of ECC_AGENTS for the
   manager's per-turn system prompt (see managerEngine.ts's
   buildManagerDynamicContext).

   The previous approach injected `ECC_AGENTS.slice(0, 20).map(a =>
   "- @${a.name}: ${a.displayName} — ${a.description.slice(0, 80)}")` — a
   hard alphabetical cut. Every content/creative persona (marketing-agent,
   seo-specialist, and the 6 added alongside them) sorts past index 19, so
   the manager never saw a single one and could not decompose a marketing
   or content request using the library.

   This module replaces that slice with a grouped catalog: Content &
   Creative and every generalist agent are named individually (short,
   hand-written role instead of an 80-char description slice — cheaper and
   reads better than a mid-sentence cut); only the large same-shape
   per-language clusters (reviewers, build-resolvers — one clone per
   language) collapse into a single summary line naming a few
   representatives. The full roster stays one `list_agents` action away.
*/

import type { EccAgent } from './ecc/eccAgentTypes.js';
import { ECC_AGENTS } from './eccAgents.js';

// Content/creative personas — ALWAYS named individually so the manager can
// decompose marketing/content requests. Keep in sync with any new
// content-domain persona added under lib/agents/ecc/.
const CONTENT_CREATIVE_NAMES = [
  'web-researcher',
  'content-strategist',
  'copywriter',
  'video-producer',
  'carousel-designer',
  'brand-identity',
  'marketing-agent',
  'seo-specialist',
];

const ARCHITECTURE_PLANNING_NAMES = [
  'architect',
  'planner',
  'code-architect',
  'a11y-architect',
  'homelab-architect',
  'network-architect',
  'gan-planner',
];

const REVIEW_QUALITY_NAMES = [
  'code-reviewer',
  'security-reviewer',
  'tdd-guide',
  'e2e-runner',
  'code-simplifier',
  'refactor-cleaner',
  'silent-failure-hunter',
  'type-design-analyzer',
  'comment-analyzer',
  'spec-miner',
  'pr-test-analyzer',
  'agent-evaluator',
  'gan-evaluator',
  'opensource-sanitizer',
  'performance-optimizer',
  'database-reviewer',
  'healthcare-reviewer',
  'mle-reviewer',
  'network-config-reviewer',
];

const BUILD_INFRA_NAMES = [
  'build-error-resolver',
  'doc-updater',
  'harness-optimizer',
  'harmonyos-app-resolver',
  'opensource-forker',
  'opensource-packager',
  'network-troubleshooter',
  'gan-generator',
];

const META_NAMES = [
  'chief-of-staff',
  'code-explorer',
  'conversation-analyzer',
  'docs-lookup',
  'loop-operator',
];

// Per-language clusters: one near-identical clone per language/framework —
// the only groups collapsed to a summary line instead of named in full.
const LANGUAGE_REVIEWER_NAMES = [
  'cpp-reviewer', 'csharp-reviewer', 'django-reviewer', 'fastapi-reviewer',
  'flutter-reviewer', 'fsharp-reviewer', 'go-reviewer', 'java-reviewer',
  'kotlin-reviewer', 'php-reviewer', 'python-reviewer', 'react-reviewer',
  'rust-reviewer', 'swift-reviewer', 'typescript-reviewer', 'vue-reviewer',
];
const LANGUAGE_REVIEWER_EXAMPLES = [
  'python-reviewer', 'typescript-reviewer', 'go-reviewer', 'java-reviewer', 'react-reviewer',
];

const LANGUAGE_BUILD_RESOLVER_NAMES = [
  'cpp-build-resolver', 'dart-build-resolver', 'django-build-resolver',
  'go-build-resolver', 'java-build-resolver', 'kotlin-build-resolver',
  'pytorch-build-resolver', 'react-build-resolver', 'rust-build-resolver',
  'swift-build-resolver',
];
const LANGUAGE_BUILD_RESOLVER_EXAMPLES = [
  'go-build-resolver', 'java-build-resolver', 'react-build-resolver', 'rust-build-resolver',
];

// Short, hand-written role per agent (<=8 words) for the groups above —
// deliberately not sliced from `description`, which reads broken mid-
// sentence when cut. Add an entry here for any agent added to a *_NAMES
// group above; an agent missing from this table falls back to a truncated
// description (see `roleFor` below), so nothing silently loses its role.
const ROLE: Record<string, string> = {
  'web-researcher': 'researches web, competitors, and market',
  'content-strategist': 'turns research into a locked content angle',
  copywriter: 'writes marketing copy, scripts, and posts',
  'video-producer': 'builds and renders promo videos with Remotion',
  'carousel-designer': 'designs multi-slide social image carousels',
  'brand-identity': 'defines naming, voice, and visual direction',
  'marketing-agent': 'campaign strategy, positioning, copy, launch plans',
  'seo-specialist': 'technical SEO audits and remediation',

  architect: 'system design and architectural decisions',
  planner: 'plans complex features and refactors',
  'code-architect': 'feature architecture blueprints from existing code',
  'a11y-architect': 'accessibility (WCAG) architecture and audits',
  'homelab-architect': 'home/small-lab network design plans',
  'network-architect': 'enterprise/multi-site network architecture design',
  'gan-planner': 'expands a prompt into a full product spec',

  'code-reviewer': 'general code review for quality and security',
  'security-reviewer': 'flags vulnerabilities and security issues',
  'tdd-guide': 'enforces write-tests-first development',
  'e2e-runner': 'end-to-end test generation and runs',
  'code-simplifier': 'simplifies code, preserves behavior',
  'refactor-cleaner': 'removes dead code and duplication',
  'silent-failure-hunter': 'finds swallowed errors and bad fallbacks',
  'type-design-analyzer': 'reviews type design and invariants',
  'comment-analyzer': 'audits comment accuracy and rot risk',
  'spec-miner': 'extracts behavioral specs from a codebase',
  'pr-test-analyzer': 'reviews PR test coverage quality',
  'agent-evaluator': 'scores agent output against a rubric',
  'gan-evaluator': 'tests the live app, scores it',
  'opensource-sanitizer': 'scans a fork for leaked secrets',
  'performance-optimizer': 'finds and fixes performance bottlenecks',
  'database-reviewer': 'PostgreSQL schema, query, security review',
  'healthcare-reviewer': 'clinical safety and PHI compliance review',
  'mle-reviewer': 'ML pipeline and model-serving review',
  'network-config-reviewer': 'router/switch config security review',

  'build-error-resolver': 'fixes build/type errors, minimal diffs',
  'doc-updater': 'updates codemaps and docs from code',
  'harness-optimizer': 'improves agent harness reliability and cost',
  'harmonyos-app-resolver': 'HarmonyOS/ArkTS build errors and review',
  'opensource-forker': 'forks and strips a project for release',
  'opensource-packager': 'generates OSS packaging (README, LICENSE, CI)',
  'network-troubleshooter': 'diagnoses connectivity, routing, DNS issues',
  'gan-generator': 'implements features from spec and eval feedback',

  'chief-of-staff': 'triages multi-channel communication (email/chat)',
  'code-explorer': 'traces execution paths in a codebase',
  'conversation-analyzer': 'mines transcripts for hookable behaviors',
  'docs-lookup': 'fetches current library/API documentation',
  'loop-operator': 'monitors and intervenes on agent loops',
};

// ── Relevance filtering (token-efficiency wave, 2026-08-01) ────────
//
// Every named group above used to render in FULL on every single turn,
// unconditionally — the only "conditional" behavior in the whole manager
// dynamic-context block that was NOT actually conditional (compare
// buildManagerDynamicContext's modelCatalogBlock/canvasDigestBlock/etc,
// managerEngine.ts, which all gate on real per-turn signals). A request
// that is clearly about ONE domain ("écris-moi une campagne marketing")
// still paid for full Architecture/Review/Build detail it had no use for.
//
// Fix: `relevanceQuery` (typically the current user message) is matched
// against a small bilingual (FR/EN — this product's users write in
// either) keyword set per named group. A group whose keywords don't match
// collapses to the SAME compact "@name, @name …and N more" shape the
// language-reviewer/build-resolver clusters already use below, instead of
// disappearing — no agent ever becomes literally unnameable, only less
// verbose to reach.
//
// Safety rule (never skip this when changing the matching below): if NO
// group matches ANY keyword at all — an ambiguous/generic turn ("aide-moi
// avec ça", or relevanceQuery omitted entirely) — EVERY group renders in
// full, exactly as before this filter existed. Never let ambiguity narrow
// the manager's options; only a turn that clearly names its domain does.
// See managerEccCatalog.test.ts's "relevance filtering" describe block for
// the tests that pin this down, including the real-ECC_AGENTS reachability
// check the task's remediation requires.
const GROUP_KEYWORDS: Record<string, readonly string[]> = {
  contentCreative: [
    'content', 'contenu', 'marketing', 'copywriting', 'copywriter', 'seo',
    'video', 'vidéo', 'carousel', 'carrousel', 'brand', 'branding', 'post',
    'social', 'réseaux sociaux', 'blog', 'script', 'promo', 'campaign',
    'campagne', 'instagram', 'newsletter', 'article',
  ],
  architecturePlanning: [
    'architecture', 'planifi', ' plan ', 'plan de', 'system design',
    'refactor', 'structure', 'schéma', 'schema', 'a11y', 'accessib',
    'network design', 'réseau d\'entreprise',
  ],
  reviewQuality: [
    'review', 'revue', ' test ', 'tests', 'tdd', 'bug', 'security',
    'sécurité', ' qa ', 'quality', 'qualité', 'audit', 'lint', 'simplifi',
    'dead code', 'performance', 'perf ',
  ],
  buildInfra: [
    'build', 'compil', ' error', 'erreur', 'deploy', 'déploi', 'ci/cd',
    'pipeline ci', 'package', 'documentation', 'infra', 'harness',
    'opensource', 'open source', 'network config', 'connectivité',
  ],
};

function matchesGroup(query: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => query.includes(kw));
}

/** First N names from a *_NAMES definition array, used as the example set
 *  a collapsed group shows — same shape collapsedGroup already renders for
 *  the language-reviewer/build-resolver clusters. */
function exampleNames(names: readonly string[], count: number): readonly string[] {
  return names.slice(0, count);
}

function roleFor(agent: EccAgent): string {
  return ROLE[agent.name] ?? agent.description.split(/\s+/).slice(0, 8).join(' ').replace(/[,;:]$/, '');
}

function agentLine(agent: EccAgent): string {
  return `- @${agent.name} — ${roleFor(agent)}`;
}

function namedGroup(label: string, names: readonly string[], byName: ReadonlyMap<string, EccAgent>): string[] {
  const lines = names
    .map((name) => byName.get(name))
    .filter((agent): agent is EccAgent => agent !== undefined)
    .map(agentLine);
  return lines.length > 0 ? [`${label}:`, ...lines] : [];
}

function collapsedGroup(
  label: string,
  allNames: readonly string[],
  exampleNames: readonly string[],
  byName: ReadonlyMap<string, EccAgent>,
): string[] {
  const present = allNames.filter((name) => byName.has(name));
  if (present.length === 0) return [];
  const examples = exampleNames.filter((name) => present.includes(name));
  const remaining = present.length - examples.length;
  const tail = remaining > 0 ? ` …and ${remaining} more (use list_agents to see all)` : '';
  return [`- ${label} (${present.length}): ${examples.map((n) => `@${n}`).join(', ')}${tail}`];
}

/**
 * Build the compact, grouped ECC catalog block injected into the manager's
 * per-turn system prompt. Accepts an explicit agent list (defaults to the
 * real ECC_AGENTS) so it stays independently testable from a fixture.
 *
 * `relevanceQuery` (typically the current turn's user message, threaded in
 * via ManagerContext.lastUserMessage — see managerEngine.ts's
 * buildManagerDynamicContext) narrows the four major named groups to a
 * compact collapsed summary when their keywords don't match, saving real
 * per-turn chars on a clearly single-domain request. Omitted or empty
 * (every existing caller/test that calls this with 0-1 args) reproduces
 * the exact prior full-detail output byte-for-byte — see the "Relevance
 * filtering" section above for the full safety rule this must uphold.
 */
export function buildEccAgentCatalog(agents: readonly EccAgent[] = ECC_AGENTS, relevanceQuery?: string): string {
  const byName = new Map(agents.map((a) => [a.name, a] as const));
  const placed = new Set<string>([
    ...CONTENT_CREATIVE_NAMES,
    ...ARCHITECTURE_PLANNING_NAMES,
    ...REVIEW_QUALITY_NAMES,
    ...BUILD_INFRA_NAMES,
    ...META_NAMES,
    ...LANGUAGE_REVIEWER_NAMES,
    ...LANGUAGE_BUILD_RESOLVER_NAMES,
  ]);

  const query = (relevanceQuery ?? '').toLowerCase();
  const contentMatch = matchesGroup(query, GROUP_KEYWORDS.contentCreative);
  const architectureMatch = matchesGroup(query, GROUP_KEYWORDS.architecturePlanning);
  const reviewMatch = matchesGroup(query, GROUP_KEYWORDS.reviewQuality);
  const buildMatch = matchesGroup(query, GROUP_KEYWORDS.buildInfra);
  const anyMatch = contentMatch || architectureMatch || reviewMatch || buildMatch;
  // Ambiguity → show everything (safety rule, see this function's doc
  // comment). Only a query that clearly names ITS OWN domain narrows the
  // OTHER groups — a group whose own keywords matched always stays full.
  const contentDetailed = !anyMatch || contentMatch;
  const architectureDetailed = !anyMatch || architectureMatch;
  const reviewDetailed = !anyMatch || reviewMatch;
  const buildDetailed = !anyMatch || buildMatch;

  const lines: string[] = [
    ...(contentDetailed
      ? namedGroup('Content & Creative', CONTENT_CREATIVE_NAMES, byName)
      : collapsedGroup('Content & Creative', CONTENT_CREATIVE_NAMES, exampleNames(CONTENT_CREATIVE_NAMES, 4), byName)),
    ...(architectureDetailed
      ? namedGroup('Architecture & Planning', ARCHITECTURE_PLANNING_NAMES, byName)
      : collapsedGroup('Architecture & Planning', ARCHITECTURE_PLANNING_NAMES, exampleNames(ARCHITECTURE_PLANNING_NAMES, 3), byName)),
    ...(reviewDetailed
      ? namedGroup('Review & Quality', REVIEW_QUALITY_NAMES, byName)
      : collapsedGroup('Review & Quality', REVIEW_QUALITY_NAMES, exampleNames(REVIEW_QUALITY_NAMES, 4), byName)),
    ...collapsedGroup('Language reviewers', LANGUAGE_REVIEWER_NAMES, LANGUAGE_REVIEWER_EXAMPLES, byName),
    ...(buildDetailed
      ? namedGroup('Build & Infra', BUILD_INFRA_NAMES, byName)
      : collapsedGroup('Build & Infra', BUILD_INFRA_NAMES, exampleNames(BUILD_INFRA_NAMES, 3), byName)),
    ...collapsedGroup('Language build-resolvers', LANGUAGE_BUILD_RESOLVER_NAMES, LANGUAGE_BUILD_RESOLVER_EXAMPLES, byName),
    // Meta stays ALWAYS fully named regardless of relevance — small (5
    // agents), generalist, and frequently cross-cutting (chief-of-staff
    // triage, docs-lookup) rather than tied to one domain; collapsing it
    // would save ~150 chars for a real risk of hiding a broadly useful
    // agent on an unrelated-looking turn.
    ...namedGroup('Meta', META_NAMES, byName),
  ];

  // Safety net: an agent added to ECC_AGENTS without a matching entry above
  // (e.g. a new persona added but not yet categorized) is still surfaced by
  // name here instead of silently disappearing — the whole point of this
  // catalog is that no agent goes invisible to the manager again.
  const leftover = agents.filter((a) => !placed.has(a.name));
  if (leftover.length > 0) {
    lines.push('Other:', ...leftover.map(agentLine));
  }

  return lines.join('\n');
}
