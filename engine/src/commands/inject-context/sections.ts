/**
 * sections.ts — Marker inject, main-page builder, and compact-line helpers.
 *
 * Owns: runMarkerInject (marker + highlights mode), buildMainPage,
 *       compactLine, clusterSummary, renderTopicTree.
 *
 * Session inject and feature-map logic live in session-inject.ts.
 * Extracted from inject-context.ts for size reduction.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SALIENCY_GLYPH, type SaliencyKind } from '../../annotator/saliency.js';
import { buildGraphTopologySummary } from '../../graph/analysis.js';
import { loadBacklinks } from '../../graph/backlinks.js';
import { type TopicTreeNode, loadKnowledgeGraph } from '../../graph/knowledge-graph.js';
import {
  type IndexedNote,
  listAll,
  noteVocabularyCensus,
  notesForCwdCount,
} from '../../indexer/fts.js';
import { brainRoot } from '../../store/paths.js';
import { profileTextForInjection } from '../../store/profile.js';
import { slugifyCwd } from '../../util/cwd-normalizer.js';
import { logTelemetry, nowIso } from '../../util/telemetry.js';
import { estimateTokenCount } from '../../util/tokenize.js';
import {
  type NudgeStyle,
  DEFAULT_NUDGE_STYLE,
  highlightsRecallNudge,
  markerNudge,
  shortId,
  warningPassesGate,
} from './markers.js';

// ---------------------------------------------------------------------------
// Compact-line helpers
// ---------------------------------------------------------------------------

const TYPE_ICON: Record<string, string> = {
  decision: 'D',
  episodic: 'E',
  reference: 'R',
  semantic: 'S',
  procedural: 'P',
};

function abbreviateTag(tag: string): string {
  const map: Record<string, string> = {
    typescript: 'ts',
    javascript: 'js',
    python: 'py',
    shell: 'sh',
    database: 'db',
    frontend: 'fe',
    docs: 'doc',
    config: 'cfg',
    refactor: 'rf',
    performance: 'perf',
    security: 'sec',
    testing: 'test',
  };
  return map[tag] ?? tag;
}

function stripRedundantDate(title: string, isoDate: string): string {
  return title.replace(new RegExp(`^${isoDate}\\s+`), '').trim();
}

function relationHints(n: IndexedNote): string {
  const parts: string[] = [];
  if (n.replaces) parts.push(`↺${n.replaces.split(',')[0]}`);
  if (n.causes) {
    const first = n.causes.split('|')[0];
    if (first && first.length > 0) parts.push(`∵${first.slice(0, 28)}`);
  }
  if (n.triples) {
    const t = n.triples.split(';')[0];
    if (t) parts.push(`◦${t}`);
  }
  return parts.length ? ` · ${parts.join(' ')}` : '';
}

export function compactLine(n: IndexedNote & { saliency_kind?: string | null }): string {
  const isoDate = (n.created ?? '').slice(0, 10);
  const md = isoDate.slice(5);
  const icon = TYPE_ICON[n.type ?? ''] ?? '·';
  const importance =
    n.importance != null && (n.importance < 0.4 || n.importance >= 0.8)
      ? ` [${n.importance.toFixed(1)}]`
      : '';
  const tagList = n.tags ? n.tags.split(/\s+/).slice(0, 3).map(abbreviateTag).join(',') : '';
  const tags = tagList ? ` (${tagList})` : '';
  const rawTitle = (n.title ?? n.id).slice(0, 60);
  const title = stripRedundantDate(rawTitle, isoDate);
  const rels = relationHints(n);
  const saliency = n.saliency_kind
    ? (SALIENCY_GLYPH[n.saliency_kind as NonNullable<SaliencyKind>] ?? '')
    : '';
  const iconWithSaliency = saliency ? `${icon}${saliency}` : icon;
  return `${md} ${iconWithSaliency} #${shortId(n.id)} ${title}${tags}${importance}${rels}`
    .replace(/\s+/g, ' ')
    .trim();
}

export function clusterSummary(notes: IndexedNote[]): string {
  const counts = new Map<string, number>();
  for (const n of notes) {
    if (!n.tags) continue;
    for (const tag of n.tags.split(/\s+/).filter(Boolean)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return '';
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return `clusters: ${sorted.map(([t, c]) => `${abbreviateTag(t)}=${c}`).join(' ')}`;
}

export function renderTopicTree(nodes: TopicTreeNode[], indent = ''): string {
  const lines: string[] = [];
  const sorted = [...nodes].sort((a, b) => b.noteCount - a.noteCount);
  for (const node of sorted) {
    if (node.noteCount === 0) continue;
    const hubInfo = node.hubIds.length > 0 ? ` [${node.hubIds.length} hubs]` : '';
    lines.push(`${indent}${node.name}/ (${node.noteCount})${hubInfo}`);
    if (node.children.length > 0 && indent.length < 4) {
      lines.push(renderTopicTree(node.children, `${indent}  `));
    }
  }
  return lines.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// buildMainPage
// ---------------------------------------------------------------------------

/**
 * Directory segments common to dev containers, carrying no project meaning
 * on their own (mirrors appendRecentNotesBlock's pre-existing SKIP set —
 * factored out into `deriveProjectSlug` below so both the main-page scoping
 * and the RECENT NOTES/KEY FEATURES matching share one definition).
 */
const CWD_SLUG_SKIP = new Set([
  'documents',
  'users',
  'home',
  'desktop',
  'projects',
  'repos',
  'src',
  'dev',
  'code',
  'workspace',
]);

/**
 * Derive the current project's slug from a cwd by walking from the last path
 * segment backward until a non-generic, non-drive-letter segment is found.
 * Shared by buildMainPage's project scoping and appendRecentNotesBlock/
 * appendKeyFeatures, so both use the identical definition of "current
 * project" and a fix to one automatically fixes the other. Returns '' when
 * no meaningful segment exists.
 */
function deriveProjectSlug(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i].toLowerCase();
    if (seg.length < 2 || /^[a-z]:?$/.test(seg) || CWD_SLUG_SKIP.has(seg)) continue;
    return seg.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  }
  return '';
}

/**
 * Does a note's topic belong to the project identified by `slug`? Exact
 * top-level match only (`slug` itself, or `slug/...`) — NOT a bare prefix
 * test. A prefix test (`topic.startsWith(slug)`) previously let slug "lazy"
 * match unrelated topics "lazybrain", "lazysite-internet", and
 * "lazy-backoffice" (all legitimately-distinct top-level project buckets in
 * a shared multi-project brain), leaking other projects' notes/features into
 * this project's RECENT NOTES / KEY FEATURES blocks — a real cross-project
 * contamination measured against a real ~7000-note shared brain.
 */
function topicBelongsToProject(topic: string, slug: string): boolean {
  const t = topic.toLowerCase();
  return t === slug || t.startsWith(`${slug}/`);
}

/**
 * Build the brain's project/feature structure summary. When `cwd` resolves
 * (via `deriveProjectSlug`) to a project that has its own top-level bucket
 * in this brain, ONLY that project is rendered (features/warnings/decisions
 * scoped to it) plus a one-line count of how many other projects exist —
 * instead of every project in the whole brain. Measured against a real,
 * shared ~7000-note multi-project brain: unscoped output listed 29 top-level
 * project buckets (most irrelevant to the current conversation) at ~2.5k
 * tokens; this keeps the "structure of the brain" signal but pays for only
 * the ONE project the manager is actually working in. Falls back to the
 * full unscoped listing when cwd is absent or matches no known project
 * bucket (never worse than before this scoping existed).
 */
export function buildMainPage(_notes: IndexedNote[], cwd?: string): string {
  const parts: string[] = [];
  const projects = new Map<string, Map<string, IndexedNote[]>>();
  const uncategorized: IndexedNote[] = [];

  for (const n of _notes) {
    const topic = n.topic;
    if (!topic) {
      uncategorized.push(n);
      continue;
    }
    const segments = topic.split('/');
    const project = segments[0];
    const feature = segments[1] || '_general';
    if (!projects.has(project)) projects.set(project, new Map());
    const proj = projects.get(project)!;
    if (!proj.has(feature)) proj.set(feature, []);
    proj.get(feature)!.push(n);
  }

  const slug = cwd ? deriveProjectSlug(cwd) : '';
  const matchedKey = slug
    ? [...projects.keys()].find((k) => k.toLowerCase() === slug)
    : undefined;
  const scopedProjects = matchedKey
    ? new Map([[matchedKey, projects.get(matchedKey)!]])
    : projects;

  buildProjectSummaries(scopedProjects, parts);
  if (matchedKey && projects.size > 1) {
    parts.push(`(+${projects.size - 1} other projects in brain — brain_query to explore)`);
  }
  if (uncategorized.length > 5) parts.push(`_other/ (${uncategorized.length} notes)`);
  buildScopedWarnings(scopedProjects, parts);
  buildScopedDecisions(scopedProjects, parts);
  buildStubsBlock(parts);

  return parts.join('\n');
}

function buildProjectSummaries(
  projects: Map<string, Map<string, IndexedNote[]>>,
  parts: string[],
): void {
  for (const [projectName, features] of [...projects.entries()].sort((a, b) => {
    const aCount = [...a[1].values()].reduce((s, arr) => s + arr.length, 0);
    const bCount = [...b[1].values()].reduce((s, arr) => s + arr.length, 0);
    return bCount - aCount;
  })) {
    const totalNotes = [...features.values()].reduce((s, arr) => s + arr.length, 0);
    const featureLines: string[] = [];
    for (const [featureName, featureNotes] of [...features.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      if (featureName === '_general') continue;
      const best = [...featureNotes].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
      const tldr = (best?.title ?? '').slice(0, 50);
      const dCount = featureNotes.filter((n) => n.type === 'decision').length;
      const wCount = featureNotes.filter((n) => n.warnings?.trim()).length;
      const eCount = featureNotes.filter(
        (n) =>
          (n.tags ?? '').includes('bug') ||
          (n.tags ?? '').includes('error') ||
          (n.tags ?? '').includes('critical'),
      ).length;
      const counts: string[] = [];
      if (dCount > 0) counts.push(`D:${dCount}`);
      if (wCount > 0) counts.push(`W:${wCount}`);
      if (eCount > 0) counts.push(`E:${eCount}`);
      featureLines.push(
        `  ${featureName}: ${tldr}${counts.length > 0 ? ` | ${counts.join(' ')}` : ''}`,
      );
    }
    if (featureLines.length > 0) {
      parts.push(`${projectName}/ (${totalNotes} notes)\n${featureLines.slice(0, 8).join('\n')}`);
    } else {
      parts.push(`${projectName}/ (${totalNotes} notes)`);
    }
  }
}

function buildScopedWarnings(
  projects: Map<string, Map<string, IndexedNote[]>>,
  parts: string[],
): void {
  const allWarnings: string[] = [];
  for (const [projectName, features] of projects) {
    let projectWarningCount = 0;
    for (const [featureName, featureNotes] of features) {
      if (projectWarningCount >= 3) break;
      const sortedNotes = [...featureNotes].sort(
        (a, b) => (b.importance ?? 0) - (a.importance ?? 0),
      );
      for (const n of sortedNotes) {
        if (projectWarningCount >= 3) break;
        const w = n.warnings;
        if (!w?.trim()) continue;
        for (const rawWarning of w.split('|')) {
          const text = rawWarning.trim();
          if (!warningPassesGate(text)) continue;
          const scope = featureName !== '_general' ? `${projectName}/${featureName}` : projectName;
          allWarnings.push(`  ! ${scope}: ${text.slice(0, 80)}`);
          projectWarningCount += 1;
          break;
        }
      }
    }
  }
  if (allWarnings.length > 0) parts.push(`[WARNINGS]\n${allWarnings.slice(0, 5).join('\n')}`);
}

function buildScopedDecisions(
  projects: Map<string, Map<string, IndexedNote[]>>,
  parts: string[],
): void {
  const allDecisions: string[] = [];
  for (const [projectName, features] of projects) {
    for (const [featureName, featureNotes] of features) {
      for (const n of featureNotes) {
        if (n.type !== 'decision' || n.valid_until) continue;
        const scope = featureName !== '_general' ? `${projectName}/${featureName}` : projectName;
        allDecisions.push(`  D ${scope}: ${(n.title ?? '').slice(0, 60)}`);
      }
    }
  }
  if (allDecisions.length > 0) parts.push(`[DECISIONS]\n${allDecisions.slice(0, 5).join('\n')}`);
}

/**
 * Pick up to `limit` DISTINCT displayed short ids from `fullIds` — real
 * distinct note ids can still collide on their shortId() display form (two
 * different full ids truncating to the same 32-char slug after the leading
 * date is stripped), observed against a real brain as a `[STUBS]` list
 * naming `#topic-overview-cerveau-code` twice among 5 entries. A note whose
 * shortId already appeared is skipped in favor of the next candidate — same
 * "prefer the next candidate" convention as summaryLineFor/
 * appendLastThreeNotes — rather than shown a second time or given a
 * fabricated disambiguating suffix that would not resolve via `lazybrain
 * query #<id>`.
 */
function uniqueShortIds(fullIds: string[], limit: number): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const id of fullIds) {
    if (picked.length >= limit) break;
    const short = shortId(id);
    if (seen.has(short)) continue;
    seen.add(short);
    picked.push(short);
  }
  return picked;
}

function buildStubsBlock(parts: string[]): void {
  try {
    const allNotes = listAll({ includeExpired: false });
    const stubIds = allNotes.filter((n) => n.quality === 'stub').map((n) => n.id);
    const ids = uniqueShortIds(stubIds, 5);
    if (ids.length > 0) {
      parts.push(`[STUBS] ${ids.length} notes need expansion: ${ids.map((id) => `#${id}`).join(', ')}`);
    }
  } catch {
    // best-effort
  }
}

/**
 * Build the `[USER PROFILE]` block for highlights mode — project-scoped and
 * trimmed when `cwd` resolves to a known project slug, full/untouched
 * otherwise.
 *
 * Measured against the real owner brain (2026-08-16): the always-on prefix
 * (`[USER PROFILE]` + `[BRAIN]` + `[GRAPH]`) cost ~437 tokens against a
 * 400-token ceiling BEFORE this fix — over budget on its own, so no optional
 * section (not even the new `[TAGS]` vocabulary block) ever rendered. 244 of
 * those tokens were this profile, and two of its three sections turned out
 * to be redundant once `--cwd` is known:
 *   - "Recurring interests" is a brain-WIDE tag census (~129 tokens) — the
 *     project-scoped `[TAGS]` block (buildTagVocabularyBlock) gives the same
 *     signal, scoped to the project actually being worked in, for ~61
 *     tokens.
 *   - "Active projects" (~96 tokens) lists frequent working dirs — of
 *     little use once `--cwd` already pins the one project this
 *     conversation is about.
 *   - "Stable decisions / preferences" is the one section with no
 *     project-scoped equivalent anywhere else in this context, and the
 *     highest value-per-token of the three — kept whenever it holds real
 *     content.
 *
 * Unscoped invocations (no `cwd`, or `cwd` resolves to no known project
 * bucket) keep the FULL, untouched profile — the escape hatch: with nothing
 * to scope to, the global signal is the best available one and must not be
 * degraded.
 */
export function buildProfileBlock(cwd?: string): string {
  const profile = profileTextForInjection();
  if (!profile) return '';

  const slug = cwd ? deriveProjectSlug(cwd) : '';
  if (!slug) return `[USER PROFILE]\n${profile}\n`;

  const heading = 'Stable decisions / preferences';
  const idx = profile.indexOf(heading);
  if (idx === -1) return '';
  const decisionsText = profile.slice(idx + heading.length).trim();
  if (!decisionsText || /no recurring decisions yet/i.test(decisionsText)) return '';
  return `[USER PROFILE]\n${heading}\n${decisionsText}\n`;
}

/**
 * Build the `[TAGS]` vocabulary block — the note types and top tags
 * ACTUALLY present in the brain, with real population counts, so the model
 * can target brain_query_css precisely (data-cerveau-type="…" /
 * data-cerveau-tags~="…") instead of guessing at values that may not exist.
 * Derived at call time from the SQLite index (noteVocabularyCensus) — never
 * a hardcoded list (the owner's brain and every other brain has its own,
 * different type/tag mix — see noteVocabularyCensus's doc comment), and
 * never populated with a zero-count entry: a tag/type declared here but
 * present on no note would send the model down a dead end and cost tokens
 * for nothing.
 *
 * Scoped to the current project (via deriveProjectSlug) when `cwd` resolves
 * to one, consistently with buildMainPage's scoping — a brain-wide census is
 * both less relevant to "this conversation" and pointlessly larger on a
 * shared multi-project brain.
 *
 * Tag values are printed VERBATIM — never through `abbreviateTag` (unlike
 * compactLine/clusterSummary, which use it purely for human-readable display
 * elsewhere in this file). Proven wrong the hard way (2026-08-16, real
 * brain): `abbreviateTag('typescript')` renders as `ts` here, so the
 * `[RECALL]` footer's own advice — "brain_query_css with a
 * data-cerveau-tags~= selector drawn from the [TAGS] vocabulary above" —
 * sent the model to `[data-cerveau-tags~="ts"]`, which returns ZERO hits:
 * the note's real `data-cerveau-tags` attribute contains "typescript", the
 * abbreviation exists only in this block's display text. A vocabulary block
 * whose one job is "values you can paste into a selector" must not print a
 * value that was never actually indexed.
 */
export function buildTagVocabularyBlock(cwd?: string): string {
  try {
    const slug = cwd ? deriveProjectSlug(cwd) : '';
    const { types, tags } = noteVocabularyCensus(slug || undefined);
    const typesLine = types.map((t) => `${t.value}:${t.count}`).join(' ');
    const tagsLine = tags.map((t) => `${t.value}:${t.count}`).join(' ');
    const segments: string[] = [];
    if (typesLine) segments.push(`types: ${typesLine}`);
    if (tagsLine) segments.push(`tags: ${tagsLine}`);
    return segments.length > 0 ? `[TAGS] ${segments.join(' | ')}` : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// runMarkerInject
// ---------------------------------------------------------------------------

/**
 * Build the always-on `[BRAIN]`-marker-adjacent graph structure lines: the
 * project-scoped topic tree (no header of its own — it renders inline right
 * after the marker line) plus a `[GRAPH] N nodes, M edges.` structural
 * summary line.
 *
 * The topology summary's hub-ID list is deliberately dropped here (unlike
 * `buildGraphTopologySummary`'s own default, still used verbatim by any
 * other caller of that function). Measured against the real owner brain:
 * that clause alone was ~80 of the summary line's ~98 tokens, for a
 * brain-WIDE top-5 hub list — irrelevant once `--cwd` pins one project, and
 * (unlike every other `#id` surfaced elsewhere in this same context —
 * compactLine, buildStubsBlock — both of which pass through `shortId()`)
 * printed as raw, un-shortened, free-text-derived slugs up to ~80 chars
 * each. The "N nodes, M edges" structural signal is item 2 of the four
 * required startup-context sections and is cheap (~15-20 tokens) — that part
 * stays always-on; the low-value-per-token hub clause does not.
 */
function buildGraphLines(cwd?: string): string {
  let graphLines = '';
  try {
    const graph = loadKnowledgeGraph();
    if (graph?.topicTree && graph.topicTree.length > 0) {
      // Scope to the current project's own top-level node when cwd resolves
      // to one (same slug/matching rule as buildMainPage) — a shared brain's
      // topic tree otherwise lists EVERY project (measured: 29 top-level
      // buckets against a real ~7000-note brain), most irrelevant here.
      const slug = cwd ? deriveProjectSlug(cwd) : '';
      const scopedTree = slug
        ? graph.topicTree.filter((n) => n.name.toLowerCase() === slug)
        : [];
      const treeNodes = scopedTree.length > 0 ? scopedTree : graph.topicTree;
      const treeText = renderTopicTree(treeNodes);
      if (treeText) graphLines += `\n${treeText}`;
      // Deliberately NOT repeating a "(+N other projects…)" line here: that
      // exact sentence is already emitted by buildMainPage (below, inside
      // appendHighlights's budget-gated pipeline) for the SAME cwd-derived
      // slug. Both lines used to render unconditionally, back to back,
      // stating the identical fact twice — a real duplication observed
      // against a real brain (2026-08-16). buildMainPage owns it now: it is
      // part of the required "brain structure" section, so it survives at
      // the same priority the graph-line copy used to.
    }
    const backlinks = loadBacklinks();
    const topologySummary = buildGraphTopologySummary(backlinks);
    const compactTopology = topologySummary.replace(/\. Top hubs:.*$/, '.');
    if (compactTopology) graphLines += `\n${compactTopology}`;
  } catch {
    // best-effort
  }
  return graphLines;
}

export function runMarkerInject(
  highlights = false,
  cwd?: string,
  nudge: NudgeStyle = DEFAULT_NUDGE_STYLE,
  maxTokens?: number,
): string {
  const start = Date.now();
  const all = listAll({ includeExpired: false });
  const notes = all.filter((n) => !n.path.endsWith('_user-profile.html'));

  const marker = `[BRAIN] ${notes.length} notes available.${markerNudge(nudge)}`;
  const graphLines = buildGraphLines(cwd);

  let body: string;
  if (highlights) {
    // Highlights mode (LazyManager's startup context, the ONLY caller of
    // `--mode highlights` — see highlightsRecallNudge's doc comment): the
    // always-on prefix is kept deliberately cheap (marker + trimmed graph
    // summary only) so the budget-gated pipeline below — which now also
    // decides `[USER PROFILE]`, see buildProfileBlock — has real headroom
    // left for the required sections (RECENT NOTES, [TAGS], structure).
    body = `${marker}${graphLines}`;
    if (notes.length > 0) body = appendHighlights(body, notes, cwd, nudge, maxTokens);
  } else {
    // marker mode (Claude Code hooks, `--mode marker`): unchanged historical
    // behavior — full, unscoped `[USER PROFILE]` always-on ahead of the
    // marker line. This mode is out of scope for the budget fix (its callers
    // were never measured near a tight ceiling and are unaffected by it).
    const profile = profileTextForInjection();
    const profileLine = profile ? `[USER PROFILE]\n${profile}\n` : '';
    body = `${profileLine}${marker}${graphLines}`;
  }

  logTelemetry({
    event: 'inject',
    ts: nowIso(),
    tokens: estimateTokenCount(body),
    sections: notes.length > 0 ? (highlights ? 2 : 1) : 0,
    duration_ms: Date.now() - start,
  });
  return body;
}

/**
 * Append the optional, budget-gated highlights sections — main page/cluster
 * summary, `[TAGS]` vocabulary, cluster block, project block, RECENT
 * NOTES/KEY FEATURES, `[USER PROFILE]`, in that order — on top of the
 * always-present marker/graph `body`. The order is deliberate, highest
 * value-per-token first: structure (item 2) orients the model, `[TAGS]`
 * (item 3) is what lets it fetch everything else on demand via a targeted
 * brain_query_css, and only then the smaller per-project detail blocks —
 * so a tight budget drops the least-leveraged content (a third recent note)
 * before it drops the vocabulary that makes follow-up queries cheap.
 * `[USER PROFILE]` is checked LAST among the optional sections, not first:
 * it is not one of the four required startup-context items (recent notes,
 * brain structure, tag vocabulary, usage instructions) — it is a bonus, and
 * after the step-2 scoping fix (buildProfileBlock) it is usually empty
 * anyway (no recurring cross-session decisions yet), so it must never win
 * budget over a required section. The final recall-nudge line (item 4, the
 * usage skill) is NEVER budget-gated — see below. `maxTokens`, when
 * given, is a SOFT ceiling checked BEFORE each optional section is added
 * (never mid-section truncation, since every section is already internally
 * capped) — once `body` reaches the budget, remaining optional sections are
 * skipped. This is what finally makes `--max-tokens` (already plumbed from
 * the Rust `brain_fetch_startup_context` command and the daemon's `/inject`
 * HTTP route) actually bound highlights-mode output — previously this
 * parameter was silently dropped for `mode: 'highlights'`/`'marker'`, so a
 * caller asking for a 400-token budget received however much unscoped
 * content buildMainPage/appendRecentNotesBlock happened to produce (measured
 * ~2900 tokens against a real ~7000-note shared brain, over 7x the
 * requested budget). The final recall-nudge line is always appended
 * regardless of budget — it is tiny and is the instruction that tells the
 * model how to fetch more itself, which is exactly what should survive a
 * tight budget.
 */
function appendHighlights(
  body: string,
  notes: IndexedNote[],
  cwd?: string,
  nudge: NudgeStyle = DEFAULT_NUDGE_STYLE,
  maxTokens?: number,
): string {
  let result = body;
  const rawBudget = maxTokens ?? Number.POSITIVE_INFINITY;

  // The recall-nudge footer is appended unconditionally at the end (never
  // budget-gated, by design — see this function's module doc comment), so
  // reserve its cost up front: the gated pipeline's soft ceiling should
  // target the CALLER's real budget net of that guaranteed footer, not
  // overshoot it by the footer's own size (~80 tokens) every single call.
  let footer = '';
  try {
    footer = highlightsRecallNudge(nudge);
  } catch {
    // best-effort
  }
  const budget = Number.isFinite(rawBudget)
    ? Math.max(0, rawBudget - estimateTokenCount(footer))
    : rawBudget;
  const underBudget = () => estimateTokenCount(result) < budget;

  if (underBudget()) {
    if (process.env.LAZYBRAIN_INJECT_MAINPAGE !== '0') {
      const mainPage = buildMainPage(notes, cwd);
      if (mainPage) result += `\n${mainPage}`;
    } else {
      const cluster = clusterSummary(notes);
      if (cluster) result += `\n${cluster}`;
    }
  }

  // [TAGS] vocabulary block (item 3) is placed ahead of the cluster/project/
  // RECENT-NOTES detail blocks — it is what lets the model fetch everything
  // else on demand via a targeted brain_query_css, so it earns priority over
  // a third recent note when the budget is tight (see appendHighlights's
  // module doc comment).
  if (underBudget()) {
    const tagsBlock = buildTagVocabularyBlock(cwd);
    if (tagsBlock) result += `\n${tagsBlock}`;
  }

  if (cwd && underBudget()) result = appendClusterBlock(result, cwd);
  if (cwd && underBudget()) result = appendProjectBlock(result, cwd);
  if (cwd && underBudget()) result = appendRecentNotesBlock(result, notes, cwd, budget);

  // [USER PROFILE] — lowest priority of the optional sections; see this
  // function's module doc comment for why it is checked last.
  if (underBudget()) {
    const profileBlock = buildProfileBlock(cwd);
    if (profileBlock) result += `\n${profileBlock}`;
  }

  result += footer;

  return result;
}

function appendClusterBlock(body: string, cwd: string): string {
  try {
    const slug = slugifyCwd(cwd);
    const clusterPath = join(brainRoot(), 'clusters', slug, '_cluster.html');
    if (!existsSync(clusterPath)) return body;
    const clusterHtml = readFileSync(clusterPath, 'utf-8');
    const noteCountMatch = clusterHtml.match(/name="cluster-note-count"\s+content="(\d+)"/);
    const activeDecMatch = clusterHtml.match(/name="cluster-active-decisions"\s+content="(\d+)"/);
    const hubsMatch = clusterHtml.match(/name="cluster-hubs"\s+content="([^"]+)"/);
    const noteCount = noteCountMatch ? noteCountMatch[1] : '?';
    const activeDec = activeDecMatch ? activeDecMatch[1] : '0';
    const hubs = hubsMatch ? hubsMatch[1].split(', ').slice(0, 2).join(', ') : '';
    let clusterLine = `[CLUSTER ${slug}] ${noteCount} neurons · ${activeDec} active decisions`;
    if (hubs) clusterLine += ` · hubs: ${hubs}`;
    return `${body}\n${clusterLine}`;
  } catch {
    return body;
  }
}

/**
 * `[PROJECT]` note count measures a DIFFERENT axis than the earlier
 * `<slug>/ (N notes)` line in buildMainPage's project summary, and the two
 * can legitimately disagree — labeled "(by path)" here so a reader can tell
 * them apart instead of seeing two unexplained totals for what looks like
 * the same project:
 *   - buildMainPage counts notes whose TOPIC's top-level segment equals the
 *     project slug (a classification decided once, at capture/synthesize
 *     time).
 *   - notesForCwdCount (note-helpers.ts) counts notes whose recorded
 *     source/id/path falls anywhere under this cwd on disk RIGHT NOW —
 *     including a subdirectory that a separate code-scanner run classified
 *     under its OWN top-level topic (observed on a real brain: this repo's
 *     `engine/` subtree is indexed under topic "engine", not "lazy", so
 *     buildMainPage's count excludes it while this cwd-rooted count
 *     correctly includes it).
 */
function appendProjectBlock(body: string, cwd: string): string {
  try {
    const cwdNotes = notesForCwdCount(cwd);
    if (cwdNotes.count > 0) {
      const decisions = cwdNotes.activeDecisions ? ` · active: ${cwdNotes.activeDecisions}` : '';
      return `${body}\n[PROJECT]\n  ${cwd}\n  ${cwdNotes.count} notes (by path)${decisions}`;
    }
    return body;
  } catch {
    return body;
  }
}

/**
 * Source tag written by src/lib/brain/capture.ts's captureConversationSummary
 * (frontend) — kept in sync manually with that file's own copy of this exact
 * string. The frontend and this engine are separate packages (the engine
 * runs as a sidecar subprocess from the Tauri app), so no shared import is
 * possible across that boundary.
 */
const CONVERSATION_SUMMARY_SOURCE = 'lazy-manager:conversation-summary';

/**
 * Item 1 of the startup-injection spec asks for "a summary of the last 3
 * conversations". As of the 2026-08-16 audit below (kept for the historical
 * record — the gap it describes is now closed), there was no distinct
 * conversation/session-summary note type: live capture (src-tauri's
 * brain_capture) wrote one note per EVENT (a mission, a decision, a
 * chat-learning fact — source `lazy-ide:*`), never one note summarizing a
 * whole conversation, and the only pathway that wrote one note per whole
 * conversation was the bulk history importer (import.ts, source
 * `import:claude-code`/`import:cursor`) — an explicit one-time backfill of
 * EXTERNAL tool history, not something live LazyManager sessions produced.
 *
 * That gap is now closed: src/lib/brain/capture.ts's
 * captureConversationSummary builds a deterministic (zero-LLM), one-note-
 * per-conversation summary, wired from agentsStore.tsx's
 * closeManagerConversation (an existing UI action — closing a conversation
 * tab), tagged with `CONVERSATION_SUMMARY_SOURCE` above so it can be told
 * apart from every other note. This block now PREFERS the last 3 such
 * conversation summaries when at least one exists for the project, under the
 * header `[RECENT CONVERSATIONS]` — an honest description of what it
 * actually contains. It falls back to the last 3 NOTES of any type under
 * `[RECENT NOTES]` when no conversation summary exists yet for the project
 * (a brand-new project, or simply before any conversation has been closed
 * since this capture path shipped) — never worse than before this fix,
 * and never a header that claims more than the block actually holds.
 *
 * Historical audit (2026-08-16), preserved verbatim for context: confirmed
 * against the real ~7500-note shared brain that sourceKind lives only in the
 * note's HTML attribute (not the `notes` SQL table), and the current project
 * there (topic `lazy`) had zero conversation-shaped notes at the time.
 *
 * `budget`: a SOFT token ceiling, added 2026-08-16. Before the step-2
 * always-on-prefix fix, this whole block was unreachable at a 400-token
 * budget (the prefix alone already exceeded it, so the `underBudget()` gate
 * ahead of this call in appendHighlights never passed) — so nothing here
 * had ever needed its own internal budget check, despite appendHighlights's
 * doc comment claiming every section was "already internally capped". Once
 * the prefix shrank, that gate started passing while this block still
 * unconditionally emitted up to 3 notes-with-TLDRs plus up to 15
 * key-feature lines — measured ~500+ tokens against the real brain, alone
 * nearly the entire budget. `appendLastThreeNotes`/`appendKeyFeatures` now
 * check the remaining budget before adding each note/feature line, same
 * soft-ceiling convention as every other section here (checked BEFORE a
 * unit is added, not mid-unit truncation).
 */
/**
 * Note types excluded from RECENT NOTES/CONVERSATIONS and KEY FEATURES
 * candidacy: both are synthesize-generated aggregate/index constructs, not
 * project events, so neither belongs in a block whose job is "what recently
 * happened" —
 *   - `topic-overview` (data-cerveau-source="synthesize",
 *     annotator/blocks/composers/topic-overview.ts): its `created`/
 *     synthesized-at timestamp reflects when the synthesis batch ran, not
 *     when real work happened, so a recency sort routinely surfaces a
 *     regenerated index ahead of genuine recent activity. It also never
 *     emits a `<section data-section="tldr">` (only `lead`/`Contents`
 *     structural chrome), so summaryLineFor can never find real prose for
 *     one anyway — confirmed against a real ~6000-note brain, where this
 *     exact gap made a topic-overview's `[lead]` paragraph (built by
 *     concatenating OTHER notes' text, and here carrying a corrupted raw
 *     JSON/type-union fragment) the sole candidate for `[RECENT NOTES]`.
 *   - `concept` (data-cerveau-source="concept-composer",
 *     annotator/blocks/composers/concept-neuron.ts): DOES emit a tldr
 *     section, so it survives summaryLineFor's tldr-only extraction and
 *     looksLikeProse's chrome/schema check (its one-liner is grammatically
 *     valid text: `renderTldr` always renders "<kind> concept — <title>").
 *     But queried against the real ~6000-note brain above, every single
 *     concept-neuron's title — and therefore its whole tldr — was itself a
 *     harvested fragment of structural chrome (a breadcrumb "Lazy / Code /
 *     Bench / Lib", a graph edge dump "[aggregate-…] --same-file--> lazy:…",
 *     a stats line "Notes: 2 | Sub-topics: Code | Types: 2
 *     aggregate-neuron", or literally the word "Contents"/"Code" pulled from
 *     a topic-overview's own TOC) — a separate, upstream concept-extraction
 *     defect (out of scope here: it lives in the synthesize pipeline, not
 *     inject-context), but its output is exactly the kind of non-signal this
 *     block must not surface. No amount of prose-shaped-text filtering can
 *     distinguish a templated label from a real summary, so the type itself
 *     is excluded, same as topic-overview.
 */
const GENERATED_INDEX_TYPES = new Set(['topic-overview', 'concept']);

function appendRecentNotesBlock(
  body: string,
  notes: IndexedNote[],
  cwd: string,
  budget: number,
): string {
  try {
    const projectSlug = deriveProjectSlug(cwd);
    if (!projectSlug) return body;

    const projectNotes = notes
      .filter((n) =>
        topicBelongsToProject((n as IndexedNote & { topic?: string }).topic ?? '', projectSlug),
      )
      .filter((n) => !GENERATED_INDEX_TYPES.has(n.type ?? ''))
      .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));

    let result = appendLastThreeNotes(body, projectNotes, budget);
    result = appendKeyFeatures(result, projectNotes, projectSlug, budget);
    return result;
  } catch {
    return body;
  }
}

/**
 * Detect content that reads as structural chrome or a raw markup/schema
 * fragment rather than prose, so it is rejected instead of surfaced verbatim
 * — the real defect this guards against (2026-08-16, real brain): a
 * topic-overview's lead text leaking a raw
 * `0,"kind""decision" | "fact" | "error" | "learning"}` type-union fragment
 * into `[RECENT NOTES]`. Defense in depth on top of excluding topic-overview
 * notes from candidacy (appendRecentNotesBlock) — this also protects against
 * any other note type whose tldr section ends up holding non-prose content.
 */
function looksLikeProse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^contents$/im.test(trimmed)) return false;
  if (/\[[^\]]*→#[^\]]*\]/.test(trimmed)) return false; // wikilink markup: [term→#id]
  if (/"[^"]*"\s*"[^"]*"\s*\|/.test(trimmed)) return false; // raw type-union/schema fragment
  if ((trimmed.match(/[{}]/g)?.length ?? 0) >= 2) return false; // raw JSON/object chrome
  return true;
}

/**
 * Short body preview for a RECENT NOTES/CONVERSATIONS or KEY FEATURES line:
 * the note's already-indexed `section_tldr` column — the textContent of its
 * `<section data-section="tldr">`, computed once at index time
 * (note-index.ts's extractSectionTextContent) — filtered through
 * looksLikeProse. Returns '' (never chrome, never raw HTML) when the note
 * carries no tldr section or its content fails the prose check.
 *
 * Deliberately does NOT re-read/re-parse the note's HTML the way the prior
 * implementation did (readNote + stripSection(html, 'section[data-section=
 * "tldr"]')): stripSection's selector-miss fallback chain (tldr → summary →
 * raw head-slice of the WHOLE document) is exactly what let a topic-overview
 * note's infobox stats line, Contents/TOC wikilink markup, and `[lead]`
 * marker leak into this block — a note-index.ts SQL column populated once
 * from the SAME selector never has that fallback, so it is null instead of
 * chrome for any note that genuinely lacks a tldr section.
 */
function summaryLineFor(note: IndexedNote): string {
  const tldr = (note.section_tldr ?? '').trim();
  return tldr && looksLikeProse(tldr) ? tldr.slice(0, 250) : '';
}

function appendLastThreeNotes(body: string, projectNotes: IndexedNote[], budget: number): string {
  // Prefer conversation summaries (see this file's CONVERSATION_SUMMARY_SOURCE
  // doc comment above) — falls back to any-type notes only when none exist
  // yet for this project, so the header below never overclaims.
  const conversations = projectNotes.filter((n) => n.source === CONVERSATION_SUMMARY_SOURCE);
  const usingConversations = conversations.length > 0;
  const pool = usingConversations ? conversations : projectNotes;

  // Pick the 3 most recent notes that actually have a usable prose summary —
  // a note with none is skipped in favor of the next candidate (never shown
  // with a blank/chrome body), and if NO candidate qualifies the whole block
  // is omitted below rather than emitting a header with nothing useful under
  // it (never claim more than this block actually holds).
  const picked: Array<{ note: IndexedNote; summary: string }> = [];
  for (const note of pool) {
    if (picked.length >= 3) break;
    const summary = summaryLineFor(note);
    if (!summary) continue;
    picked.push({ note, summary });
  }
  if (picked.length === 0) return body;

  const header = usingConversations ? '[RECENT CONVERSATIONS]' : '[RECENT NOTES]';
  let result = `${body}\n${header}`;
  for (const { note, summary } of picked) {
    if (estimateTokenCount(result) >= budget) break;
    const title = (note.title ?? '').slice(0, 80);
    const date = (note.created ?? '').slice(0, 10);
    result += `\n  ${date} ${title}\n    ${summary}`;
  }
  return result;
}

function appendKeyFeatures(
  body: string,
  projectNotes: IndexedNote[],
  projectSlug: string,
  budget: number,
): string {
  const groupedBySubTopic = new Map<string, IndexedNote[]>();
  for (const n of projectNotes) {
    const topic = ((n as IndexedNote & { topic?: string }).topic ?? '').toLowerCase();
    const parts = topic.split('/');
    const subTopic = parts.length > 1 ? parts.slice(1).join('/') : '_general';
    if (!groupedBySubTopic.has(subTopic)) groupedBySubTopic.set(subTopic, []);
    groupedBySubTopic.get(subTopic)!.push(n);
  }

  const header = `\n\n[KEY FEATURES ${projectSlug}]`;
  const keyFeatureLines: string[] = [];
  for (const [subTopic, subNotes] of [...groupedBySubTopic.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    if (keyFeatureLines.length >= 15) break;
    // Soft ceiling checked BEFORE adding the next line — same convention as
    // the rest of this file (see appendRecentNotesBlock's doc comment for
    // why this check exists here at all).
    const soFar = `${body}${header}\n${keyFeatureLines.join('\n')}`;
    if (estimateTokenCount(soFar) >= budget) break;
    const best = [...subNotes].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
    if (!best) continue;
    // Same indexed-column source as summaryLineFor (never a raw HTML
    // re-parse) — falls back to the title, a short and always-safe field,
    // when the best note in this subtopic carries no tldr section.
    const tldrText = summaryLineFor(best) || (best.title ?? '').slice(0, 80);
    const fullPath = subTopic === '_general' ? projectSlug : `${projectSlug}/${subTopic}`;
    keyFeatureLines.push(`  ${fullPath}: ${tldrText.slice(0, 150)}`);
  }

  if (keyFeatureLines.length > 0) {
    return `${body}${header}\n${keyFeatureLines.join('\n')}`;
  }
  return body;
}
