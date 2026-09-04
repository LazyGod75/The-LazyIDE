/**
 * scope.ts — OrgScope type + scope.json loader.
 *
 * Invisible to the solo user: default is 'solo', and scope.json parses
 * safely to 'solo' whenever it is absent or invalid — no behavior change
 * for users who never opt into a team.
 *
 * This module used to also export a hardcoded `TEAMS_ENABLED = false`
 * constant that permanently gated the teams dispatch path off regardless
 * of real org state (T4.2 audit finding: the "three-flag trap" — this
 * constant, a second build-time flag in features.ts, and a Team-tab gate
 * in AppShell.tsx that all had to independently agree, and never could).
 * That constant is removed. The single runtime entitlement now lives in
 * teamsActive() (src/lib/features.ts), which capture.ts's dispatch() and
 * unifiedEntitlement.ts both read instead.
 */

// ── Org-level scope (teams hierarchy) ────────────────────────────
//
// Distinct from BrainScope ('current' | 'all' | { project }) in types.ts,
// which addresses which project-brain to query. OrgScope addresses the
// organizational collaboration tier.

export type OrgScope = 'solo' | 'team' | 'dept' | 'global';

// ── Validation ────────────────────────────────────────────────────

const VALID_SCOPES: ReadonlySet<string> = new Set<OrgScope>([
  'solo',
  'team',
  'dept',
  'global',
]);

/**
 * Parse a raw JSON value into an OrgScope.
 * Returns 'solo' for any unrecognized or absent value (safe default).
 */
export function parseOrgScope(raw: unknown): OrgScope {
  if (typeof raw === 'string' && VALID_SCOPES.has(raw)) {
    return raw as OrgScope;
  }
  return 'solo';
}

// ── Loader ────────────────────────────────────────────────────────

/**
 * Load the organizational scope for a project from
 * `<projectRoot>/scope.json`.
 *
 * Accepted formats:
 *   {"scope": "team"}      — object with a scope key
 *   "team"                 — plain string
 *
 * Returns 'solo' when:
 *   - the file does not exist
 *   - the file is not valid JSON
 *   - the scope value is not a recognized OrgScope
 *
 * @param projectRoot  Absolute path to the project root directory.
 * @param readFileFn   Optional file-reader for testability.
 *                     Defaults to platform.fs.readFile.
 */
export async function loadProjectScope(
  projectRoot: string,
  readFileFn?: (path: string) => Promise<string>,
): Promise<OrgScope> {
  const reader: (path: string) => Promise<string> =
    readFileFn ?? _platformReadFile;

  // Use platform-agnostic join (avoid importing 'path' in browser context)
  const sep = projectRoot.endsWith('/') || projectRoot.endsWith('\\') ? '' : '/';
  const scopePath = `${projectRoot}${sep}scope.json`;

  try {
    const content = await reader(scopePath);
    const data: unknown = JSON.parse(content);

    // {"scope": "team"} shape
    if (
      data !== null &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      'scope' in data
    ) {
      return parseOrgScope((data as Record<string, unknown>)['scope']);
    }

    // plain string "team"
    return parseOrgScope(data);
  } catch {
    // File missing, parse error, or read failure → default to solo
    return 'solo';
  }
}

/** Default reader: delegates to the active Platform's fs.readFile. */
async function _platformReadFile(path: string): Promise<string> {
  // Lazy import to avoid circular deps and to keep this module usable
  // in non-platform contexts (CLI, tests with explicit reader).
  const { getPlatform } = await import('../platform/index.js');
  return getPlatform().fs.readFile(path);
}
