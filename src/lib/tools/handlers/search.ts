/* Code-search / LSP-domain tool handlers: ripgrep-backed search plus
   goto-definition/find-references/diagnostics over the LSP bridge.
   Extracted verbatim from toolRuntime.ts's executeTool switch. */

import { invoke } from '@tauri-apps/api/core';
import { resolvePath } from './shared.js';
import type { ToolExecutionContext } from './types.js';

/** Explicit rg excludes for search_code/search_symbols — do not rely
 *  solely on the project's .gitignore (may be absent, incomplete, or not
 *  honored depending on how ripgrep is invoked). Keeps huge generated/
 *  vendor trees out of scope regardless. */
const RG_EXCLUDE_GLOBS =
  "--glob '!node_modules/**' --glob '!.git/**' --glob '!dist/**' --glob '!target/**' --glob '!build/**' --glob '!.lazy/**'";

export async function searchCode(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const pattern = String(args.pattern ?? '');
  if (!pattern) return 'ERROR: No search pattern provided';
  const fileGlob = args.file_glob ? ` --glob '${String(args.file_glob)}'` : '';
  const cmd = `rg --line-number --no-heading --max-count 50 ${RG_EXCLUDE_GLOBS}${fileGlob} '${pattern.replace(/'/g, "'\\''")}' .`;
  try {
    const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>('run_shell', {
      command: cmd,
      cwd: rootPath,
      timeoutMs: 15000,
    });
    if (result.exitCode === 1 && !result.stdout) return `No matches for "${pattern}"`;
    const output = result.stdout.split('\n').slice(0, 50).join('\n');
    return output || `No matches for "${pattern}"`;
  } catch (err) {
    return `ERROR: search_code failed (ripgrep may not be installed): ${String(err)}`;
  }
}

export async function searchSymbols(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const query = String(args.query ?? '');
  if (!query) return 'ERROR: No symbol query provided';
  const pattern = `(fn |function |class |interface |type |const |enum |struct |impl )\\s+${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  try {
    const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>('run_shell', {
      command: `rg --line-number --no-heading --max-count 30 ${RG_EXCLUDE_GLOBS} '${pattern.replace(/'/g, "'\\''")}' .`,
      cwd: rootPath,
      timeoutMs: 15000,
    });
    if (result.exitCode === 1 && !result.stdout) return `No symbols matching "${query}"`;
    return result.stdout.split('\n').slice(0, 30).join('\n') || `No symbols matching "${query}"`;
  } catch (err) {
    return `ERROR: search_symbols failed: ${String(err)}`;
  }
}

export async function gotoDefinition(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = resolvePath(rootPath, String(args.path ?? ''));
  const line = Number(args.line ?? 0);
  const column = Number(args.column ?? 0);
  try {
    const result = await invoke<string>('lsp_request', {
      serverId: 'auto',
      method: 'textDocument/definition',
      params: JSON.stringify({ textDocument: { uri: `file://${path}` }, position: { line: line - 1, character: column - 1 } }),
    });
    return result || 'No definition found';
  } catch (err) {
    return `LSP not available: ${String(err)}`;
  }
}

export async function findReferences(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = resolvePath(rootPath, String(args.path ?? ''));
  const line = Number(args.line ?? 0);
  const column = Number(args.column ?? 0);
  try {
    const result = await invoke<string>('lsp_request', {
      serverId: 'auto',
      method: 'textDocument/references',
      params: JSON.stringify({ textDocument: { uri: `file://${path}` }, position: { line: line - 1, character: column - 1 } }),
    });
    return result || 'No references found';
  } catch (err) {
    return `LSP not available: ${String(err)}`;
  }
}

export async function getDiagnostics(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const { rootPath } = ctx;
  const path = args.path ? resolvePath(rootPath, String(args.path ?? '')) : '';
  try {
    const result = await invoke<string>('lsp_request', {
      serverId: 'auto',
      method: 'textDocument/publishDiagnostics',
      params: JSON.stringify({ uri: path ? `file://${path}` : '' }),
    });
    return result || 'No diagnostics';
  } catch (err) {
    return `LSP not available: ${String(err)}`;
  }
}
