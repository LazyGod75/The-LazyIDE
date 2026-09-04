/* afterEditDiagnostics — lint-on-edit for the managed loop.

   After a successful write_file/edit_file/multi_edit, append real LSP
   diagnostics for the touched files. Never invents issues: "No diagnostics"
   and "LSP not available" are omitted so a missing language server does not
   spam every edit. Bounded: 3 files, 1.5s each, 1200 chars total.
*/

const EDIT_ACTIONS = new Set(['write_file', 'edit_file', 'multi_edit']);
const MAX_FILES = 3;
const MAX_CHARS = 1200;
export const AFTER_EDIT_DIAG_TIMEOUT_MS = 1500;

export interface AfterEditDiagnosticsOpts {
  action: string;
  observation: string;
  files?: string[];
  diagnose: (path: string) => Promise<string>;
}

function isUsableDiagnostic(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^no diagnostics$/i.test(t)) return false;
  if (t.startsWith('LSP not available')) return false;
  return true;
}

async function diagnoseOne(
  path: string,
  diagnose: (path: string) => Promise<string>,
): Promise<string | null> {
  try {
    const result = await Promise.race([
      diagnose(path),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), AFTER_EDIT_DIAG_TIMEOUT_MS);
      }),
    ]);
    if (result === null || !isUsableDiagnostic(result)) return null;
    return result.trim();
  } catch {
    return null;
  }
}

async function collectDiagnosticBlocks(
  files: string[],
  diagnose: (path: string) => Promise<string>,
): Promise<string[]> {
  const blocks: string[] = [];
  let used = 0;
  for (const path of files) {
    const text = await diagnoseOne(path, diagnose);
    if (!text) continue;
    const block = `After-edit diagnostics (${path}):\n${text}`;
    if (used + block.length > MAX_CHARS) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks;
}

export async function appendAfterEditDiagnostics(opts: AfterEditDiagnosticsOpts): Promise<string> {
  if (!EDIT_ACTIONS.has(opts.action)) return opts.observation;
  if (opts.observation.startsWith('ERROR:')) return opts.observation;
  const files = (opts.files ?? []).filter(Boolean).slice(0, MAX_FILES);
  if (files.length === 0) return opts.observation;
  const blocks = await collectDiagnosticBlocks(files, opts.diagnose);
  if (blocks.length === 0) return opts.observation;
  return `${opts.observation}\n\n${blocks.join('\n\n')}`;
}
