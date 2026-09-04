/**
 * Claude CLI streaming helpers.
 *
 * For `ask` mode: spawns with --output-format stream-json --verbose --safe-mode
 * and streams text chunks via JSON parsing.
 *
 * For `agent` mode: spawns with --output-format text --safe-mode --dangerously-skip-permissions
 * and streams plain-text output directly. (text format is more reliable for autonomous
 * tool-use tasks; stream-json with verbose triggers extended thinking that intercepts tasks.)
 *
 * --safe-mode is always added: it skips CLAUDE.md/hooks/plugins while keeping
 * subscription auth + built-in tools (Bash, Write, etc.) functional.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

export type ChunkCallback = (text: string) => void;

/**
 * On Windows, spawn('claude') fails — the npm global is a .cmd shim that requires
 * shell:true, but shell:true mangles newlines in the -p argument.
 *
 * Solution: discover the actual claude.exe binary from the npm global path,
 * which can be spawned directly (no shell needed, no argument mangling).
 *
 * Fallback order:
 *   1. APPDATA/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe
 *   2. 'claude' (works on Unix; on Windows requires the PATH to include the .cmd)
 */
export function resolveClaudeExe(): string {
  if (process.platform !== 'win32') return 'claude';

  const appData = process.env['APPDATA'] ?? 'C:\\Users\\Default\\AppData\\Roaming';
  const exe = `${appData}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

  if (existsSync(exe)) return exe;

  // Fallback: try npm global prefix
  return 'claude';
}

const CLAUDE_CMD = resolveClaudeExe();

export interface ClaudeRunOptions {
  model?: string;
  cwd?: string;
  /** true → adds --dangerously-skip-permissions (agent autonomous mode) */
  agentMode?: boolean;
  /**
   * Output format override.
   * - 'stream-json': streaming JSON events (default for ask, needs --verbose)
   * - 'text': plain text final output (default for agent — more reliable for tool-use)
   */
  outputFormat?: 'stream-json' | 'text';
}

/**
 * Run `claude -p <prompt>` and stream the response to onChunk.
 * Resolves when the process exits 0; rejects on non-zero exit or spawn error.
 */
export function spawnClaude(
  prompt: string,
  onChunk: ChunkCallback,
  opts: ClaudeRunOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const model = opts.model ?? 'haiku';
    // Agent mode defaults to text output — more reliable for autonomous tool-use.
    // Ask mode defaults to stream-json for incremental display.
    const format = opts.outputFormat ?? (opts.agentMode ? 'text' : 'stream-json');

    const args: string[] = [
      '-p', prompt,
      '--model', model,
      '--output-format', format,
      // safe-mode: skip CLAUDE.md/hooks/plugins.
      // Auth + built-in tools still work. Required for headless CLI use.
      '--safe-mode',
    ];

    // stream-json requires --verbose flag
    if (format === 'stream-json') {
      args.push('--verbose');
    }

    if (opts.agentMode) {
      args.push('--dangerously-skip-permissions');
    }

    const child: ChildProcess = spawn(CLAUDE_CMD, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // shell: false — use claude.cmd directly so Windows cmd.exe doesn't
      // mangle newlines/special chars in the -p argument.
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: Error) => reject(err));

    if (format === 'text') {
      // Plain text mode: stream stdout bytes directly as text chunks
      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (text) onChunk(text);
      });

      child.on('close', (code: number | null) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`claude exited with code ${code}. ${stderr.slice(0, 200)}`));
        }
      });
    } else {
      // stream-json mode: parse JSON lines and extract text deltas
      let buf = '';
      let textEmitted = false;
      let resultFallback = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          extractTextChunks(trimmed, (text) => {
            textEmitted = true;
            onChunk(text);
          }, (result) => {
            resultFallback = result;
          });
        }
      });

      child.on('close', (code: number | null) => {
        // Flush remaining buffer
        if (buf.trim()) {
          extractTextChunks(buf.trim(), (text) => {
            textEmitted = true;
            onChunk(text);
          }, (result) => {
            resultFallback = result;
          });
        }
        // If no text was streamed but result line had content, emit it
        if (!textEmitted && resultFallback) {
          onChunk(resultFallback);
        }
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`claude exited with code ${code}. ${stderr.slice(0, 200)}`));
        }
      });
    }
  });
}

/**
 * Extract text deltas from a single stream-json line.
 * Mirrors extract_text_from_stream_json in src-tauri/src/lib.rs.
 * Also handles the result line as a final-answer fallback.
 */
function extractTextChunks(
  line: string,
  onChunk: ChunkCallback,
  onResult?: (r: string) => void,
): void {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  // Format 1: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
  const msg = v['message'] as Record<string, unknown> | undefined;
  if (msg) {
    const content = msg['content'] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          if (block['text']) onChunk(block['text']);
          return;
        }
      }
    }
  }

  // Format 2: direct text delta {"type":"text","text":"..."}
  if (v['type'] === 'text' && typeof v['text'] === 'string' && v['text']) {
    onChunk(v['text']);
    return;
  }

  // Format 3: {"type":"result","result":"..."} — final answer (fallback for ask)
  if (v['type'] === 'result' && typeof v['result'] === 'string' && v['result'] && onResult) {
    onResult(v['result']);
  }
}
