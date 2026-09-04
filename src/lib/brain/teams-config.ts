/**
 * teams-config.ts — Phase 1 Teams project configuration.
 *
 * Reads `<projectRoot>/.lazybrain/teams.json` to determine whether the
 * current project is in team mode and which server/token to use.
 *
 * Format:
 *   { teamSlug: string, serverUrl?: string, tokenRef: string }
 *
 *   teamSlug  — the team identifier used in POST /t/:slug/capture
 *   serverUrl — optional server URL override (default: http://127.0.0.1:7777)
 *   tokenRef  — NAME of an env var that holds the Bearer token
 *               (never the token itself — keeps secrets out of git)
 *
 * Security: the actual Bearer token must live in an environment variable,
 * never in teams.json. tokenRef is the env var name.
 */

// ── Types ─────────────────────────────────────────────────────────

export interface TeamsConfig {
  teamSlug: string;
  serverUrl?: string;
  tokenRef: string;
}

// ── Loader ────────────────────────────────────────────────────────

/**
 * Load the Teams configuration from `<projectRoot>/.lazybrain/teams.json`.
 *
 * Returns null when:
 *   - the file does not exist
 *   - the JSON is invalid
 *   - required fields (teamSlug, tokenRef) are missing or not strings
 *
 * @param projectRoot  Absolute path to the project root directory.
 * @param readFileFn   Optional file reader for testability.
 *                     Defaults to platform.fs.readFile.
 */
export async function loadTeamsConfig(
  projectRoot: string,
  readFileFn?: (path: string) => Promise<string>,
): Promise<TeamsConfig | null> {
  const reader: (path: string) => Promise<string> =
    readFileFn ?? _platformReadFile;

  const sep = projectRoot.endsWith('/') || projectRoot.endsWith('\\') ? '' : '/';
  const configPath = `${projectRoot}${sep}.lazybrain/teams.json`;

  try {
    const content = await reader(configPath);
    const data: unknown = JSON.parse(content);

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }

    const obj = data as Record<string, unknown>;
    const teamSlug = typeof obj['teamSlug'] === 'string' ? obj['teamSlug'] : null;
    const tokenRef = typeof obj['tokenRef'] === 'string' ? obj['tokenRef'] : null;

    if (!teamSlug || !tokenRef) {
      return null;
    }

    const serverUrl =
      typeof obj['serverUrl'] === 'string' ? obj['serverUrl'] : undefined;

    return { teamSlug, tokenRef, serverUrl };
  } catch {
    // File missing, parse error, or read failure -> no teams config
    return null;
  }
}

// ── Token resolution ──────────────────────────────────────────────

/**
 * Resolve the Bearer token from an environment variable named by tokenRef.
 *
 * Security: tokenRef is the NAME of the env var, not the token itself.
 * The actual token never appears in teams.json or source code.
 *
 * Returns null if:
 *   - the env var is not set or is empty
 *   - process.env is unavailable (pure browser context without Node globals)
 *
 * In Tauri the webview does not expose Node's process.env; prefer loading
 * the token via the `teams_read_token` Tauri command (Rust reads from
 * std::env) and passing the resolved value directly to the brain capture
 * pipeline. This function serves as a synchronous fallback for Node/test
 * contexts.
 */
export function resolveToken(tokenRef: string): string | null {
  if (tokenRef.trim() === '') return null;

  // Access process.env without requiring @types/node in the DOM-targeted tsconfig.
  // globalThis.process is available in Node (vitest, Tauri sidecar) but not in
  // sandboxed browser renderers — the optional chain handles both cases safely.
  const _global = globalThis as {
    process?: { env?: Record<string, string | undefined> };
  };
  const envValue = _global.process?.env?.[tokenRef] ?? null;

  return envValue && envValue.trim() !== '' ? envValue.trim() : null;
}

// ── Internal helpers ──────────────────────────────────────────────

async function _platformReadFile(path: string): Promise<string> {
  const { getPlatform } = await import('../platform/index.js');
  return getPlatform().fs.readFile(path);
}
