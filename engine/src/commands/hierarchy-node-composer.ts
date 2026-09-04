/**
 * hierarchy-node-composer: HTML composer for hierarchical knowledge-nodes.
 * Produces one article per topic-tree level (root / project / module / feature).
 * Sections are conditional — only rendered when data exists.
 */

import type { HierarchyNode, HierarchyTree } from '../graph/hierarchy.js';
import { PKG_VERSION } from '../util/pkg-version.js';
import { nowIso } from '../util/telemetry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HierarchyNodeInput {
  node: HierarchyNode;
  tree: HierarchyTree;
  // Aggregated data — populated by Task 4 (enrich), empty by default
  decisions: Array<{ text: string; sourceId: string }>;
  bugs: Array<{ text: string; sourceId: string }>;
  ideas: Array<{ text: string; sourceId: string }>;
  rules: Array<{ text: string; sourceId: string }>;
  facts: Array<{ text: string; sourceId: string }>;
  qa: Array<{ question: string; sourceId: string }>;
  codeFiles: Array<{ path: string; language: string; lineCount: number }>;
  created: string;
}

// ---------------------------------------------------------------------------
// Escape helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nodeSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ---------------------------------------------------------------------------
// Section renderers (all conditional)
// ---------------------------------------------------------------------------

function renderBreadcrumb(node: HierarchyNode, tree: HierarchyTree): string {
  if (node.level === 0)
    return '<nav class="breadcrumb"><span aria-current="page">Brain</span></nav>';

  const crumbs: string[] = [
    '<a href="#/node/_root" data-cerveau-link-type="parent" data-cerveau-link-confidence="extracted">Brain</a>',
  ];

  // Walk up the ancestor chain
  const segments: HierarchyNode[] = [];
  let cursor: HierarchyNode | undefined = node;
  while (cursor && cursor.level > 0) {
    segments.unshift(cursor);
    cursor = cursor.parent ? tree.byId.get(cursor.parent) : undefined;
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    if (isLast) {
      crumbs.push(`<span aria-current="page">${esc(seg.segment)}</span>`);
    } else {
      crumbs.push(
        `<a href="#/node/${esc(nodeSlug(seg.id))}" data-cerveau-link-type="parent" data-cerveau-link-confidence="extracted">${esc(seg.segment)}</a>`,
      );
    }
  }

  return `<nav class="breadcrumb">${crumbs.join(' / ')}</nav>`;
}

function renderChildrenSection(node: HierarchyNode, tree: HierarchyTree): string {
  if (node.children.length === 0) return '';

  const levelLabel = node.level === 0 ? 'Projects' : node.level === 1 ? 'Modules' : 'Features';

  const items = node.children
    .map((childId) => {
      const child = tree.byId.get(childId);
      if (!child) return '';
      const convLabel =
        child.conversationCount === 1
          ? '1 conversation'
          : `${child.conversationCount} conversations`;
      return (
        `<li><a href="#/node/${esc(nodeSlug(child.id))}" ` +
        `data-cerveau-link-type="contains" data-cerveau-link-confidence="extracted">${esc(child.segment)}</a> ` +
        `<small>${esc(convLabel)}</small></li>`
      );
    })
    .filter(Boolean);

  return `<section data-section="children"><h3>${esc(levelLabel)}</h3><ul class="edge-list">${items.join('\n')}</ul></section>`;
}

function renderCodeFilesSection(
  codeFiles: HierarchyNodeInput['codeFiles'],
  title = 'Architecture',
): string {
  if (codeFiles.length === 0) return '';

  const items = codeFiles
    .slice(0, 20)
    .map(
      (f) =>
        `<li><data value="file:${esc(f.path)}" data-cerveau-entity-type="file">${esc(f.path)}</data>` +
        ` <small>${esc(f.language)}, ${f.lineCount}L</small></li>`,
    );

  const list =
    codeFiles.length > 5
      ? `<details><summary>${codeFiles.length} files</summary><ul>${items.join('\n')}</ul></details>`
      : `<ul>${items.join('\n')}</ul>`;

  return `<section data-section="architecture"><h3>${esc(title)}</h3>${list}</section>`;
}

function renderDecisionsSection(decisions: HierarchyNodeInput['decisions']): string {
  if (decisions.length === 0) return '';
  const items = decisions
    .slice(0, 10)
    .map(
      (d) =>
        `<aside role="doc-note" class="decision-box"><strong>Decision:</strong> ${esc(d.text)}\n` +
        `<p class="source"><a href="#/note/${esc(d.sourceId)}" data-cerveau-link-type="documents" data-cerveau-link-confidence="inferred">source</a></p></aside>`,
    )
    .join('\n');
  return `<section data-section="decisions"><h3>Decisions</h3>${items}</section>`;
}

function renderBugsSection(bugs: HierarchyNodeInput['bugs']): string {
  if (bugs.length === 0) return '';
  const items = bugs
    .slice(0, 10)
    .map(
      (b) =>
        `<aside role="doc-errata"><strong data-cerveau-kind="bug">Bug:</strong> ${esc(b.text)}` +
        `\n<p class="source"><a href="#/note/${esc(b.sourceId)}" data-cerveau-link-type="fixes" data-cerveau-link-confidence="inferred">source</a></p></aside>`,
    )
    .join('\n');
  return `<section data-section="bugs"><h3>Bugs &amp; Issues</h3>${items}</section>`;
}

function renderIdeasSection(ideas: HierarchyNodeInput['ideas']): string {
  if (ideas.length === 0) return '';
  const items = ideas
    .slice(0, 10)
    .map(
      (i) =>
        `<li data-cerveau-fact data-cerveau-kind="idea">${esc(i.text)} <a href="#/note/${esc(i.sourceId)}" data-cerveau-link-type="mentions" data-cerveau-link-confidence="inferred">source</a></li>`,
    );
  return `<section data-section="ideas"><h3>Ideas</h3><ul>${items.join('\n')}</ul></section>`;
}

function renderRulesSection(rules: HierarchyNodeInput['rules']): string {
  if (rules.length === 0) return '';
  const items = rules
    .slice(0, 10)
    .map((r) => `<aside role="doc-tip">${esc(r.text)}</aside>`)
    .join('\n');
  return `<section data-section="rules"><h3>Rules</h3>${items}</section>`;
}

function renderFactsSection(facts: HierarchyNodeInput['facts']): string {
  if (facts.length === 0) return '';
  const items = facts
    .slice(0, 15)
    .map(
      (f) =>
        `<li data-cerveau-fact>${esc(f.text)} <a href="#/note/${esc(f.sourceId)}" data-cerveau-link-type="mentions" data-cerveau-link-confidence="inferred">source</a></li>`,
    );
  const list =
    facts.length > 5
      ? `<details open><summary>${facts.length} facts</summary><ul>${items.join('\n')}</ul></details>`
      : `<ul>${items.join('\n')}</ul>`;
  return `<section data-section="facts"><h3>Facts</h3>${list}</section>`;
}

function renderQaSection(qa: HierarchyNodeInput['qa']): string {
  if (qa.length === 0) return '';
  const items = qa
    .slice(0, 10)
    .map(
      (q) =>
        `<div class="qa-pair" data-cerveau-kind="qa"><p class="question"><strong>Q:</strong> ${esc(q.question)}</p>` +
        `<p class="source"><a href="#/note/${esc(q.sourceId)}" data-cerveau-link-type="documents" data-cerveau-link-confidence="inferred">source</a></p></div>`,
    )
    .join('\n');
  return `<section data-section="qa"><h3>Q&amp;A</h3>${items}</section>`;
}

function renderConversationSourcesSection(noteIds: readonly string[]): string {
  if (noteIds.length === 0) return '';
  const items = noteIds
    .slice(0, 20)
    .map(
      (id) =>
        `<li><a href="#/note/${esc(id)}" data-cerveau-link-type="source" data-cerveau-link-confidence="extracted">${esc(id)}</a></li>`,
    );
  const list =
    noteIds.length > 5
      ? `<details><summary>${noteIds.length} conversations</summary><ul>${items.join('\n')}</ul></details>`
      : `<ul>${items.join('\n')}</ul>`;
  return `<section data-section="sources"><h3>Conversation Sources</h3>${list}</section>`;
}

// ---------------------------------------------------------------------------
// Level-specific TLDR builders
// ---------------------------------------------------------------------------

function buildTldr(node: HierarchyNode, _tree: HierarchyTree): string {
  if (node.level === 0) {
    const projectCount = node.children.length;
    const totalConvs = node.conversationCount;
    return `Brain index — ${projectCount} project${projectCount !== 1 ? 's' : ''}, ${totalConvs} conversation${totalConvs !== 1 ? 's' : ''}.`;
  }
  if (node.level === 1) {
    const moduleCount = node.children.length;
    const convCount = node.conversationCount;
    return `Project ${node.segment} — ${moduleCount} module${moduleCount !== 1 ? 's' : ''}, ${convCount} conversation${convCount !== 1 ? 's' : ''}.`;
  }
  if (node.level === 2) {
    const featureCount = node.children.length;
    const convCount = node.conversationCount;
    return `Module ${node.segment} — ${featureCount} feature${featureCount !== 1 ? 's' : ''}, ${convCount} conversation${convCount !== 1 ? 's' : ''}.`;
  }
  // level 3+
  const convCount = node.conversationCount;
  return `Feature ${node.segment} — ${convCount} conversation${convCount !== 1 ? 's' : ''}.`;
}

function buildTitle(node: HierarchyNode): string {
  if (node.level === 0) return 'Brain Index';
  return node.id
    .split('/')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' / ');
}

// ---------------------------------------------------------------------------
// Stats section (root only)
// ---------------------------------------------------------------------------

function renderRootStats(tree: HierarchyTree): string {
  const totalNodes = tree.totalNodes;
  const projectCount = tree.projects.length;
  let moduleCount = 0;
  let featureCount = 0;

  for (const [, node] of tree.byId) {
    if (node.level === 2) moduleCount += 1;
    if (node.level >= 3) featureCount += 1;
  }

  const rows = [
    `<tr><td>Total nodes</td><td>${totalNodes}</td></tr>`,
    `<tr><td>Projects</td><td>${projectCount}</td></tr>`,
    `<tr><td>Modules</td><td>${moduleCount}</td></tr>`,
    `<tr><td>Features</td><td>${featureCount}</td></tr>`,
  ];

  return `<section data-section="stats"><h3>Stats</h3><table class="wikitable compact"><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${rows.join('\n')}</tbody></table></section>`;
}

// ---------------------------------------------------------------------------
// Main compose function
// ---------------------------------------------------------------------------

export function composeHierarchyNode(input: HierarchyNodeInput): string {
  const { node, tree } = input;
  const now = nowIso();
  const id = nodeSlug(node.id);
  const title = buildTitle(node);
  const tldr = buildTldr(node, tree);

  // Derive project from id path
  const project = node.level === 0 ? '_root' : node.id.split('/')[0];

  const sections: string[] = [];

  // TLDR — always present
  sections.push(`<section data-section="tldr"><p>${esc(tldr)}</p></section>`);

  // Root: stats + children list only
  if (node.level === 0) {
    sections.push(renderRootStats(tree));
    sections.push(renderChildrenSection(node, tree));
  }

  // Project (level 1): modules + architecture + aggregated enrichment
  if (node.level === 1) {
    sections.push(renderChildrenSection(node, tree));
    sections.push(renderCodeFilesSection(input.codeFiles, 'Architecture'));
    sections.push(renderDecisionsSection(input.decisions));
    sections.push(renderBugsSection(input.bugs));
    sections.push(renderIdeasSection(input.ideas));
    sections.push(renderRulesSection(input.rules));
  }

  // Module (level 2): features + architecture + module-specific enrichment
  if (node.level === 2) {
    sections.push(renderChildrenSection(node, tree));
    sections.push(renderCodeFilesSection(input.codeFiles, 'Architecture'));
    sections.push(renderDecisionsSection(input.decisions));
    sections.push(renderBugsSection(input.bugs));
    sections.push(renderIdeasSection(input.ideas));
    sections.push(renderRulesSection(input.rules));
  }

  // Feature (level 3+): code files + full enrichment + conversation sources
  if (node.level >= 3) {
    sections.push(renderChildrenSection(node, tree));
    sections.push(renderCodeFilesSection(input.codeFiles, 'Code Files'));
    sections.push(renderDecisionsSection(input.decisions));
    sections.push(renderBugsSection(input.bugs));
    sections.push(renderIdeasSection(input.ideas));
    sections.push(renderRulesSection(input.rules));
    sections.push(renderFactsSection(input.facts));
    sections.push(renderQaSection(input.qa));
    sections.push(renderConversationSourcesSection(node.noteIds));
  }

  const sectionCount = sections.filter(Boolean).length;

  const levelLabel =
    node.level === 0
      ? 'root'
      : node.level === 1
        ? 'project'
        : node.level === 2
          ? 'module'
          : 'feature';

  const article = [
    `<article id="${esc(id)}"`,
    `  data-cerveau-version="${PKG_VERSION}"`,
    `  data-cerveau-created="${esc(input.created)}"`,
    `  data-cerveau-synthesized-at="${esc(now)}"`,
    `  data-cerveau-type="hierarchy-node"`,
    `  data-cerveau-source="build-hierarchy"`,
    `  data-cerveau-level="${node.level}"`,
    `  data-cerveau-level-label="${esc(levelLabel)}"`,
    `  data-cerveau-topic="${esc(node.id)}"`,
    `  data-cerveau-project="${esc(project)}"`,
    `  data-cerveau-conv-count="${node.conversationCount}"`,
    `  data-cerveau-child-count="${node.children.length}"`,
    `  data-cerveau-section-count="${sectionCount}"`,
    '>',
    `<header class="wiki-header">`,
    `  <h1>${esc(title)}</h1>`,
    `  <aside class="infobox"><dl>`,
    `    <dt>Level</dt><dd><span class="type-badge ${esc(levelLabel)}">${esc(levelLabel)}</span></dd>`,
    `    <dt>Topic</dt><dd>${esc(node.id)}</dd>`,
    `    <dt>Conversations</dt><dd>${node.conversationCount}</dd>`,
    `    <dt>Children</dt><dd>${node.children.length}</dd>`,
    '  </dl></aside>',
    '</header>',
    renderBreadcrumb(node, tree),
    ...sections.filter(Boolean),
    '</article>',
  ];

  return article.join('\n');
}
