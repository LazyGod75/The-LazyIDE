/* index.ts — Barrel export for the codegraph module. */

// Types
export type {
  CodeNode, CodeEdge, CodeGraph, SymbolKind, EdgeType, EdgeConfidence,
  ImpactResult, ImpactDirection, ImpactLevel, ImpactSymbol,
  ContextView, TraceResult, TraceHop,
  ProcessFlow, ProcessStep,
  RouteMapping, DiffImpact, RenamePreview, RenameChange,
  CodeCluster, StalenessReport,
  RepoEntry, RepoGroup,
  PipelinePhase, PipelinePhaseId, PipelineProgress,
  GeneratedSkill,
} from './types.js';

// Scanner (A1, A9, A10)
export { scanFile, collectSourceFiles, MAX_FILE_SIZE } from './scanner.js';
export type { ScanResult, WalkOptions } from './scanner.js';

// Resolver (A1)
export { resolveCrossFile, buildGraph } from './resolver.js';

// Analyzer (A2, A3, A4, A5, A6, A7, A9)
export {
  analyzeImpact, buildContext, findTrace,
  detectProcesses, mapRoutes, analyzeDiffImpact,
  previewRename, detectClusters,
} from './analyzer.js';

// Pipeline (G)
export { runPipeline, checkStaleness, PIPELINE_PHASES } from './pipeline.js';
export type { PipelineOptions, PipelineResult } from './pipeline.js';

// Registry (E)
export {
  listRepos, getRepo, getRepoByPath, registerRepo, unregisterRepo,
  listGroups, getGroup, createGroup, addToGroup, removeFromGroup, deleteGroup,
  checkGroupStaleness, searchAcrossRepos,
} from './registry.js';
export type { GroupStaleness, CrossRepoSearchResult } from './registry.js';

// Code tools (C)
export {
  CODE_QUERY_TOOL, CODE_CONTEXT_TOOL, CODE_IMPACT_TOOL,
  CODE_TRACE_TOOL, CODE_DETECT_CHANGES_TOOL, CODE_RENAME_TOOL,
  ALL_CODE_TOOLS,
  parseCodeDirective,
  formatCodeQueryResult, formatImpactResult, formatContextResult,
} from './codeTools.js';
export type { ParsedCodeDirective } from './codeTools.js';

// Events (D)
export {
  CodeGraphEventBridge, getCodeGraphEventBridge,
} from './codeEvents.js';
export type { CodeGraphEvent, CodeGraphEventResult, CodeGraphEventType } from './codeEvents.js';

// Skills generator (H)
export {
  generateSkills, generateAgentsMd, mergeAgentsMd,
  CODEGRAPH_BEGIN_MARKER, CODEGRAPH_END_MARKER,
} from './skillsGenerator.js';

// Language registry (tree-sitter — 30+ languages + TOML custom)
export {
  BUILTIN_LANGUAGES, getLanguageConfig, getSupportedExtensions, isSupportedFile,
  registerCustomLanguages, parseLanguagesToml, grammarWasmUrl,
  TREE_SITTER_WASM_BASE,
} from './languageRegistry.js';
export type { LanguageConfig, CustomLanguageEntry } from './languageRegistry.js';

// Tree-sitter scanner (AST-based parsing)
export {
  scanFileWithTreeSitter, isTreeSitterAvailable, preloadGrammars,
} from './treeSitterScanner.js';

// File hashing (incremental indexing)
export {
  sha256, createFileHashStore, diffFileHashes, updateHashes,
} from './fileHash.js';
export type { FileHashStore, HashDiffResult } from './fileHash.js';

// Token savings measurement
export {
  estimateTokens, estimateFileTokens, computeSavings, estimateCorpusSize,
  estimateCorpusSizeFromNodes, wrapWithSavings, wrapResultWithSavings,
} from './tokenSavings.js';
export type { TokenSavings } from './tokenSavings.js';

// File watcher (watch mode / daemon)
export {
  createFileWatcher, createPollingFileWatcher,
} from './fileWatcher.js';
export type { FileWatcher, FileWatcherOptions } from './fileWatcher.js';
