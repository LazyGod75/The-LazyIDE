/**
 * build-hierarchy: creates one knowledge-node per topic-tree level.
 * Root → Projects → Modules → Features.
 * Replaces the per-conversation synthesize-nodes for the hierarchical pipeline.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type HierarchyNode, type HierarchyTree, extractHierarchy } from '../graph/hierarchy.js';
import { knowledgeNodePath, slug } from '../store/paths.js';
import { readAllNotes } from '../store/reader.js';
import { getLogger } from '../util/logger.js';
import { nowIso } from '../util/telemetry.js';
import { type HierarchyNodeInput, composeHierarchyNode } from './hierarchy-node-composer.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface BuildHierarchyOptions {
  force?: boolean;
  pretty?: boolean;
}

export interface BuildHierarchyReport {
  rootCreated: boolean;
  projectsCreated: number;
  modulesCreated: number;
  featuresCreated: number;
  totalCreated: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeExists(nodeSlugId: string): boolean {
  return existsSync(knowledgeNodePath(nodeSlugId));
}

function writeNode(nodeSlugId: string, html: string): void {
  const targetPath = knowledgeNodePath(nodeSlugId);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, html, 'utf8');
}

function buildInput(node: HierarchyNode, tree: HierarchyTree, created: string): HierarchyNodeInput {
  return {
    node,
    tree,
    decisions: [],
    bugs: [],
    ideas: [],
    rules: [],
    facts: [],
    qa: [],
    codeFiles: [],
    created,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runBuildHierarchy(
  opts: BuildHierarchyOptions,
): Promise<BuildHierarchyReport> {
  const log = getLogger();
  const report: BuildHierarchyReport = {
    rootCreated: false,
    projectsCreated: 0,
    modulesCreated: 0,
    featuresCreated: 0,
    totalCreated: 0,
    errors: [],
  };

  const notes = readAllNotes();
  log.debug({ noteCount: notes.length }, 'build-hierarchy: notes loaded');

  const tree = extractHierarchy(notes);
  log.debug(
    { totalNodes: tree.totalNodes, projects: tree.projects.length },
    'build-hierarchy: hierarchy extracted',
  );

  const created = nowIso();

  for (const [, node] of tree.byId) {
    const nodeSlugId = slug(node.id);

    if (!opts.force && nodeExists(nodeSlugId)) {
      log.debug({ nodeId: node.id }, 'build-hierarchy: skipped (exists)');
      continue;
    }

    try {
      const input = buildInput(node, tree, created);
      const html = composeHierarchyNode(input);
      writeNode(nodeSlugId, html);

      if (node.level === 0) {
        report.rootCreated = true;
      } else if (node.level === 1) {
        report.projectsCreated += 1;
      } else if (node.level === 2) {
        report.modulesCreated += 1;
      } else {
        report.featuresCreated += 1;
      }

      report.totalCreated += 1;
      log.debug({ nodeId: node.id, level: node.level }, 'build-hierarchy: created');
    } catch (err) {
      const msg = (err as Error).message;
      report.errors.push(`${node.id}: ${msg}`);
      log.warn({ nodeId: node.id, err: msg }, 'build-hierarchy: node failed');
    }
  }

  log.debug(
    {
      rootCreated: report.rootCreated,
      projects: report.projectsCreated,
      modules: report.modulesCreated,
      features: report.featuresCreated,
      errors: report.errors.length,
    },
    'build-hierarchy: done',
  );

  return report;
}
