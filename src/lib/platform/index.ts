/* getPlatform() — returns the appropriate Platform implementation.
   - Under Tauri (desktop): TauriPlatform (native Rust backend).
   - In browser / Playwright: WebPlatform (mock, unchanged).
   Detection uses the '__TAURI_INTERNALS__' sentinel injected by Tauri.
*/

import type { Platform } from './types.js';
import { WebPlatform } from './web.js';
import { TauriPlatform } from './tauri.js';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Keep internal alias for legacy callers in this file.
const isTauriRuntime = isTauri;

export function getPlatform(): Platform {
  if (isTauriRuntime()) {
    return TauriPlatform;
  }
  return WebPlatform;
}

export type { Platform } from './types.js';
export type {
  FileSystem,
  DirEntry,
  Terminal,
  TerminalProcess,
  Git,
  GitStatus,
  GitFile,
  Brain,
  BrainSearchResult,
  BrainRecallResult,
  BrainGraphData,
  BrainGraphNode,
  BrainGraphEdge,
  BrainNoteMeta,
  HistorySource,
  SeedEstimate,
  SeedProgressEvent,
  ModelInfo,
  ModelProvider,
  SpawnOptions,
  CodeGraphPlatform,
} from './types.js';
