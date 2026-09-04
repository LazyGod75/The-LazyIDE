/* formatDocument.ts — "Formater le document" (QA3/B23): best-effort
   prettier formatting, ONLY when the open project genuinely depends on it.
   Never a fake success — see this module's two exports:
     - isPrettierConfigured: a pure filesystem check (package.json), the
       only reliable local signal that a project has prettier configured.
     - runPrettierWrite: the actual spawn + exit-code classification.
   Extracted out of CenterEditor.tsx so this logic (the riskiest part of
   B23 — process spawning) is unit-testable against a mocked Platform,
   without needing a live Tauri process.
*/

import type { Platform } from '../platform/types.js';
import { joinPath } from '../paths.js';

/**
 * True when `projectRoot`'s package.json lists "prettier" under either
 * dependencies or devDependencies. This is the only local, zero-network
 * signal that formatting is actually configured for THIS project — never
 * assumes a global install exists. Returns false (never throws) for any
 * read/parse failure (no package.json, malformed JSON, etc.) — an honest
 * "not configured" rather than a crash.
 */
export async function isPrettierConfigured(
  platform: Pick<Platform, 'fs'>,
  projectRoot: string,
): Promise<boolean> {
  try {
    const raw = await platform.fs.readFile(joinPath(projectRoot, 'package.json'));
    const pkg: unknown = JSON.parse(raw);
    if (typeof pkg !== 'object' || pkg === null) return false;
    const record = pkg as Record<string, unknown>;
    return hasPrettierKey(record.dependencies) || hasPrettierKey(record.devDependencies);
  } catch {
    return false;
  }
}

function hasPrettierKey(deps: unknown): boolean {
  return typeof deps === 'object' && deps !== null && 'prettier' in deps;
}

export type FormatResult =
  | { ok: true }
  | { ok: false; message: string };

const FORMAT_TIMEOUT_MS = 15_000;

/**
 * Runs `prettier --write <filePath>` for real, via the platform's process
 * spawner — never simulated. Caller is responsible for having already
 * saved `filePath`'s current buffer to disk (prettier formats what's ON
 * DISK, not the in-editor buffer) and for re-reading the file afterwards
 * to sync the tab.
 *
 * Windows note: prettier resolves through npx, whose own binary is a
 * `.cmd` shim there — Windows' CreateProcess cannot exec a `.cmd` directly
 * (the same shim-invocation class this codebase has hit before for the
 * Claude CLI subprocess spawn, see lazy-claude-subscription-cmd-stdin-fix
 * notes), so this routes through `cmd /c` on Windows specifically, and
 * plain argv everywhere else. `--no-install` prevents npx from silently
 * fetching prettier over the network when it is NOT actually a project
 * dependency — this function must only ever be called after
 * `isPrettierConfigured` has already confirmed it is.
 */
export async function runPrettierWrite(
  platform: Pick<Platform, 'terminal'>,
  projectRoot: string,
  filePath: string,
  isWindows: boolean = typeof navigator !== 'undefined' && /win/i.test(navigator.platform),
): Promise<FormatResult> {
  const npxArgs = ['--no-install', 'prettier', '--write', filePath];
  const [command, args] = isWindows ? ['cmd', ['/c', 'npx', ...npxArgs]] : ['npx', npxArgs];

  let proc;
  try {
    proc = await platform.terminal.spawn(command, args, { cwd: projectRoot });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  let output = '';
  const unsubData = proc.onData(d => { output += d; });

  const exitCode = await new Promise<number | null>(resolve => {
    const unsubExit = proc.onExit(code => resolve(code));
    setTimeout(() => {
      unsubExit();
      resolve(null);
    }, FORMAT_TIMEOUT_MS);
  });
  unsubData();

  if (exitCode === 0) return { ok: true };
  if (exitCode === null) {
    proc.kill();
    return { ok: false, message: `timed out after ${FORMAT_TIMEOUT_MS}ms` };
  }
  return { ok: false, message: output.slice(0, 300) || `exit code ${exitCode}` };
}
