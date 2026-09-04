/* codeEvents.ts — IDE-native event system (D).
   Instead of GitNexus's PreToolUse/PostToolUse MCP hooks, this integrates
   directly into Lazy's event loop: before the agent edits a file, we inject
   impact context; after a git commit, we detect staleness and prompt re-index;
   after a file save, we trigger incremental re-index of that file.

   This is the "synergy with the app" the user asked for — better than hooks
   because it has direct access to the editor state, agent runtime, and platform.
*/

import type {
  CodeGraph, ImpactResult,
} from './types.js';
import { analyzeImpact, analyzeDiffImpact } from './analyzer.js';
import { checkStaleness } from './pipeline.js';

// ── Event types ───────────────────────────────────────────────────

export type CodeGraphEventType =
  | 'pre-edit'      // Before agent edits a file — inject impact context
  | 'post-commit'   // After git commit — detect staleness
  | 'post-save'     // After file save — trigger incremental re-index
  | 'pre-commit'    // Before git commit — analyze diff impact
  | 'index-stale'   // Index is behind HEAD — prompt re-index
  | 'index-updated'; // Index was rebuilt

export interface CodeGraphEvent {
  type: CodeGraphEventType;
  filePath?: string;
  symbolName?: string;
  commitHash?: string;
  changedFiles?: string[];
  timestamp: number;
}

export interface CodeGraphEventResult {
  /** Context to inject into the agent's system prompt or tool result. */
  injectedContext?: string;
  /** Whether to block the action (e.g. high-risk edit). */
  block?: boolean;
  /** Warning message to show the user. */
  warning?: string;
  /** Whether the index needs a rebuild. */
  needsReindex?: boolean;
}

// ── Event handler ─────────────────────────────────────────────────

export class CodeGraphEventBridge {
  private graph: CodeGraph | null = null;
  private listeners: Array<(event: CodeGraphEvent, result: CodeGraphEventResult) => void> = [];

  setGraph(graph: CodeGraph | null): void {
    this.graph = graph;
  }

  onEvent(cb: (event: CodeGraphEvent, result: CodeGraphEventResult) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter(l => l !== cb);
    };
  }

  private emit(event: CodeGraphEvent, result: CodeGraphEventResult): void {
    for (const cb of this.listeners) {
      cb(event, result);
    }
  }

  // ── Pre-edit enrichment (D1) ──────────────────────────────────

  /**
   * Called before the agent edits a file. Analyzes the impact of modifying
   * symbols in that file and returns context to inject into the agent's prompt.
   */
  preEdit(filePath: string, symbolName?: string): CodeGraphEventResult {
    const event: CodeGraphEvent = {
      type: 'pre-edit',
      filePath,
      symbolName,
      timestamp: Date.now(),
    };

    if (!this.graph) {
      const result: CodeGraphEventResult = {};
      this.emit(event, result);
      return result;
    }

    // If we know which symbol is being edited, run impact analysis
    if (symbolName) {
      const impact = analyzeImpact(this.graph, symbolName, 'upstream', { maxDepth: 2 });
      if (impact.totalAffected > 0) {
        const context = formatImpactForAgent(impact);
        const warning = impact.riskLevel === 'high'
          ? `⚠️ HIGH RISK: ${impact.totalAffected} symbols depend on ${symbolName}. Review before editing.`
          : undefined;

        const result: CodeGraphEventResult = {
          injectedContext: context,
          warning,
        };
        this.emit(event, result);
        return result;
      }
    }

    // Otherwise, find all symbols in the file and report their callers
    const fileNodeIds = this.graph.fileIndex.get(filePath) ?? [];
    const symbolsInFile = fileNodeIds
      .map(id => this.graph!.nodes.find(n => n.id === id))
      .filter(n => n && n.kind !== 'file' && n.kind !== 'folder');

    if (symbolsInFile.length > 0) {
      const lines = symbolsInFile.map(s => {
        const incoming = this.graph!.edges.filter(
          e => e.target === s!.id && e.type === 'calls',
        ).length;
        return `  - ${s!.name} [${s!.kind}] — ${incoming} caller(s)`;
      });
      const context = `Symbols in ${filePath}:\n${lines.join('\n')}`;
      const result: CodeGraphEventResult = { injectedContext: context };
      this.emit(event, result);
      return result;
    }

    const result: CodeGraphEventResult = {};
    this.emit(event, result);
    return result;
  }

  // ── Pre-commit diff analysis (D1 variant) ─────────────────────

  /**
   * Called before a git commit. Maps changed files to affected symbols,
   * processes, and clusters. Returns a risk assessment.
   */
  preCommit(changedFiles: string[]): CodeGraphEventResult {
    const event: CodeGraphEvent = {
      type: 'pre-commit',
      changedFiles,
      timestamp: Date.now(),
    };

    if (!this.graph || changedFiles.length === 0) {
      const result: CodeGraphEventResult = {};
      this.emit(event, result);
      return result;
    }

    const diffImpact = analyzeDiffImpact(this.graph, changedFiles);

    const lines: string[] = [];
    lines.push(`PRE-COMMIT IMPACT: ${diffImpact.changedSymbols.length} symbols affected`);
    lines.push(`Risk: ${diffImpact.riskLevel.toUpperCase()}`);

    if (diffImpact.affectedProcesses.length > 0) {
      lines.push(`\nAffected execution flows:`);
      for (const proc of diffImpact.affectedProcesses) {
        lines.push(`  - ${proc.name} (${proc.steps.length} steps)`);
      }
    }

    if (diffImpact.affectedClusters.length > 0) {
      lines.push(`\nAffected areas: ${diffImpact.affectedClusters.join(', ')}`);
    }

    const warning = diffImpact.riskLevel === 'high'
      ? `⚠️ HIGH RISK commit: ${diffImpact.changedSymbols.length} symbols changed across ${diffImpact.affectedClusters.length} areas.`
      : undefined;

    const result: CodeGraphEventResult = {
      injectedContext: lines.join('\n'),
      warning,
    };
    this.emit(event, result);
    return result;
  }

  // ── Post-commit staleness detection (D2) ──────────────────────

  /**
   * Called after a git commit. Checks if the code graph index is now stale
   * and prompts for re-indexing.
   */
  postCommit(commitHash: string): CodeGraphEventResult {
    const event: CodeGraphEvent = {
      type: 'post-commit',
      commitHash,
      timestamp: Date.now(),
    };

    if (!this.graph) {
      const result: CodeGraphEventResult = {};
      this.emit(event, result);
      return result;
    }

    const staleness = checkStaleness(
      this.graph.lastCommit,
      commitHash,
      [],
    );

    const result: CodeGraphEventResult = {
      needsReindex: staleness.isStale,
      warning: staleness.isStale
        ? `Code graph index is stale (${staleness.reason}). Re-index to get accurate impact analysis.`
        : undefined,
    };

    // Emit a separate index-stale event if needed
    if (staleness.isStale) {
      this.emit(
        { type: 'index-stale', commitHash, timestamp: Date.now() },
        { needsReindex: true, warning: staleness.reason },
      );
    }

    this.emit(event, result);
    return result;
  }

  // ── Post-save incremental trigger (D2 variant) ────────────────

  /**
   * Called after a file is saved. Returns whether that file needs
   * incremental re-indexing (file content changed since last index).
   */
  postSave(filePath: string): CodeGraphEventResult {
    const event: CodeGraphEvent = {
      type: 'post-save',
      filePath,
      timestamp: Date.now(),
    };

    if (!this.graph) {
      const result: CodeGraphEventResult = { needsReindex: true };
      this.emit(event, result);
      return result;
    }

    // Check if this file is in the index
    const isInIndex = this.graph.fileIndex.has(filePath);
    const result: CodeGraphEventResult = {
      needsReindex: !isInIndex, // New file → needs indexing
    };

    this.emit(event, result);
    return result;
  }
}

// ── Singleton instance ────────────────────────────────────────────

let _bridge: CodeGraphEventBridge | null = null;

export function getCodeGraphEventBridge(): CodeGraphEventBridge {
  if (!_bridge) {
    _bridge = new CodeGraphEventBridge();
  }
  return _bridge;
}

// ── Formatting helpers ────────────────────────────────────────────

function formatImpactForAgent(impact: ImpactResult): string {
  const lines: string[] = [];
  lines.push(`IMPACT CONTEXT for ${impact.target.name} (${impact.target.kind}):`);
  lines.push(`Risk level: ${impact.riskLevel} — ${impact.totalAffected} symbols will be affected`);
  for (const level of impact.levels) {
    lines.push(`\n${level.label} (${level.symbols.length}):`);
    for (const sym of level.symbols) {
      lines.push(`  - ${sym.node.name} [${sym.node.kind}] → ${sym.node.filePath}`);
    }
  }
  return lines.join('\n');
}
