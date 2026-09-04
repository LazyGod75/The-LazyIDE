/* fileWatcher.ts — Watch mode for incremental code graph updates.
   Uses Tauri's event system or a polling fallback to detect file changes
   and trigger incremental re-indexing of only the changed files.

   In the browser/web mock, this is a no-op (no filesystem to watch).
*/

import type { FileHashStore } from './fileHash.js';
import { diffFileHashes, type HashDiffResult } from './fileHash.js';

// ── Watcher interface ─────────────────────────────────────────────

export interface FileWatcherOptions {
  /** Project root directory to watch. */
  projectRoot: string;
  /** Debounce interval in ms (default: 500). */
  debounceMs?: number;
  /** Callback when files change. */
  onChanges: (result: HashDiffResult) => void;
  /** Function to read directory contents. */
  readDir: (path: string) => Promise<Array<{ name: string; path: string; isDir: boolean }>>;
  /** Function to read a file's content. */
  readFile: (path: string) => Promise<string>;
  /** File hash store to track changes. */
  hashStore: FileHashStore;
}

export interface FileWatcher {
  /** Start watching for changes. */
  start(): void;
  /** Stop watching and clean up. */
  stop(): void;
  /** Whether the watcher is currently active. */
  isRunning: boolean;
}

// ── Polling-based watcher ─────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', '__pycache__',
  '.next', '.nuxt', '.cache', '.lazy', '.windsurf', '.claude',
  'vendor', '.venv', 'venv', 'env', '.gitnexus', 'coverage',
  'tree-sitter-wasms',
]);

const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go',
  'java', 'kt', 'kts', 'rb', 'c', 'h', 'cpp', 'cc', 'cxx',
  'hpp', 'hxx', 'cs', 'swift', 'php', 'scala', 'sc', 'sol',
  'dart', 'lua', 'el', 'erl', 'ex', 'exs', 'zig', 'sh', 'bash',
  'vue', 'res', 'rescript', 'yaml', 'yml', 'toml', 'json',
  'html', 'htm', 'css', 'ml', 'ocaml', 'ql', 'elm',
]);

function isSourceFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return SOURCE_EXTENSIONS.has(ext);
}

export function createPollingFileWatcher(opts: FileWatcherOptions): FileWatcher {
  const debounceMs = opts.debounceMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function collectFiles(dir: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    async function walk(d: string, depth: number): Promise<void> {
      if (depth > 8) return;
      let entries: Array<{ name: string; path: string; isDir: boolean }>;
      try {
        entries = await opts.readDir(d);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (entry.isDir) {
          await walk(entry.path, depth + 1);
        } else if (isSourceFile(entry.name)) {
          try {
            const content = await opts.readFile(entry.path);
            files.set(entry.path, content);
          } catch {
            // Skip unreadable
          }
        }
      }
    }
    await walk(dir, 0);
    return files;
  }

  async function checkForChanges(): Promise<void> {
    if (!running) return;
    try {
      const currentFiles = await collectFiles(opts.projectRoot);
      const diff = await diffFileHashes(opts.hashStore, currentFiles);
      if (diff.changed.length > 0 || diff.deleted.length > 0) {
        opts.onChanges(diff);
      }
    } catch {
      // Ignore errors during polling
    }
  }

  function debouncedCheck(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void checkForChanges();
    }, debounceMs);
  }

  return {
    isRunning: false,
    start() {
      if (running) return;
      running = true;
      this.isRunning = true;
      // Initial check after a short delay
      setTimeout(() => void debouncedCheck(), 100);
      // Poll every 3 seconds
      pollTimer = setInterval(() => void debouncedCheck(), 3000);
    },
    stop() {
      running = false;
      this.isRunning = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}

// ── Tauri event-based watcher (if available) ──────────────────────

/**
 * Create a file watcher that uses Tauri's fs events when available,
 * falling back to polling otherwise.
 */
export async function createFileWatcher(
  opts: FileWatcherOptions,
): Promise<FileWatcher> {
  // Try to use Tauri's listen API for file system events
  try {
    const tauriApi = await import('@tauri-apps/api/event');
    const tauriFs = await import('@tauri-apps/api/core');

    // Check if we're in a Tauri environment
    if (typeof tauriFs.invoke === 'function') {
      // Try to invoke a native file watcher command
      // If it doesn't exist, fall back to polling
      try {
        await tauriFs.invoke('start_file_watcher', { path: opts.projectRoot });
      } catch {
        // Native watcher not available — use polling
        return createPollingFileWatcher(opts);
      }

      const unlisten = await tauriApi.listen<string>('file://changed', (event) => {
        // A file changed — trigger debounced check
        const _filePath = event.payload;
        // We still need to read and hash to know what actually changed
        void (async () => {
          const currentFiles = new Map<string, string>();
          try {
            const content = await opts.readFile(_filePath);
            currentFiles.set(_filePath, content);
          } catch {
            // File may have been deleted
          }
          const diff = await diffFileHashes(opts.hashStore, currentFiles);
          if (diff.changed.length > 0 || diff.deleted.length > 0) {
            opts.onChanges(diff);
          }
        })();
      });

      return {
        isRunning: true,
        start() {},
        stop() {
          void unlisten();
          void tauriFs.invoke('stop_file_watcher', { path: opts.projectRoot }).catch(() => {});
        },
      };
    }
  } catch {
    // Not in Tauri environment
  }

  return createPollingFileWatcher(opts);
}
