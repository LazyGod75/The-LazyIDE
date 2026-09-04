import { homedir, tmpdir } from 'node:os';
import { basename as pathBasename } from 'node:path';

export interface NormalizedCwd {
  raw: string;
  topicPath: string;
  segments: string[];
  project: string;
}

/**
 * Canonical project segment: lowercase a single directory or project name
 * so that "Acme", "ACME", "acme" all resolve to "acme".
 *
 * This is the single source of truth for project-name normalization.
 * Call this whenever deriving a grouping key (topic path first segment)
 * from a filesystem directory name.
 *
 * The original display label (mixed-case) is preserved by callers for
 * human-readable output; only the returned canonical key is used for
 * tree grouping and breadcrumb hrefs.
 */
export function canonicalProjectSegment(dirName: string): string {
  return dirName.toLowerCase();
}

// Folders that are common dev containers but carry no semantic meaning.
const STRIP_SEGMENTS = new Set([
  'documents',
  'projects',
  'code',
  'workspace',
  'workspaces',
  'dev',
  'repos',
  'repo',
  'src',
  'source',
  'home',
  'users',
  'user',
]);

// Paths that indicate a system location with no project context.
const SYSTEM_PREFIXES = ['windows', 'system32', 'program files', 'programdata', 'appdata'];

function normalizeSeparators(raw: string): string {
  // backslash → slash, then collapse multiple consecutive slashes
  return raw.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * Strips user-specific and well-known dev container prefixes from a path.
 * Detects home dir dynamically via os.homedir() — no hardcoded usernames.
 */
export function stripUserPrefix(path: string): string {
  let p = normalizeSeparators(path).trim();

  // %USERPROFILE% literal
  p = p.replace(/^%userprofile%\/?/i, '');

  // Literal ~ shorthand
  p = p.replace(/^~\/?/, '');

  // Resolve homedir dynamically to handle any username
  const home = normalizeSeparators(homedir()).toLowerCase();
  const tmp = normalizeSeparators(tmpdir()).toLowerCase();
  const lower = p.toLowerCase();

  if (lower.startsWith(`${home}/`)) {
    p = p.slice(home.length + 1);
  } else if (lower.startsWith(`${tmp}/`) || lower === tmp) {
    return ''; // temp path → unusable
  }

  // Generic patterns: /home/<user>/ or /Users/<user>/ or C:/Users/<user>/
  // Strip optional leading slash, optional drive letter, then home|users/<name>/
  p = p.replace(/^\//, ''); // strip leading slash
  p = p.replace(/^[a-z]:\//i, ''); // strip drive letter (C:/, D:/)
  p = p.replace(/^[a-z]\//i, ''); // strip malformed drive (c/, d/ — missing colon)
  p = p.replace(/^\//, ''); // strip leading slash again (after drive)
  p = p.replace(/^(?:home|users)\/[^/]+\//i, ''); // strip /home/<user>/ or /Users/<user>/

  return p;
}

/**
 * Splits a hyphenated project name into segments when the segment does not
 * itself contain slashes (i.e., it's a top-level token, not a directory path).
 *
 * "Acme-Tracking-cal" → ["acme", "tracking", "cal"]
 * "acme" → ["acme"]
 */
export function splitHyphenated(segment: string): string[] {
  // Only split if the segment contains a hyphen and looks like a project name
  // (no path separators remaining at this point).
  if (!segment.includes('-')) return [segment];
  return segment.split('-').filter(Boolean);
}

function isSystemPath(segments: string[]): boolean {
  return segments.some((s) => SYSTEM_PREFIXES.includes(s.toLowerCase()));
}

/**
 * Parses a raw cwd string into a hierarchical topic path.
 * Returns null when the path cannot be reduced to a meaningful project context.
 */
export function normalizeCwd(rawCwd: string): NormalizedCwd | null {
  if (!rawCwd || !rawCwd.trim()) return null;

  const stripped = stripUserPrefix(rawCwd.trim());
  if (!stripped) return null;

  // Split on forward slashes, lowercase everything
  const parts = stripped
    .split('/')
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);

  if (parts.length === 0) return null;
  if (isSystemPath(parts)) return null;

  // Remove known dev-container segments that appear at the START of the path.
  // We stop stripping once we hit something that looks like a real project name.
  let start = 0;
  while (start < parts.length && STRIP_SEGMENTS.has(parts[start])) {
    start++;
  }

  const meaningful = parts.slice(start);
  if (meaningful.length === 0) return null;

  // For the first segment only: apply hyphen splitting if no further path
  // segments follow it (pure project-name token) OR always split the first
  // segment because folder names like "Acme-Tracking-cal" should become
  // multi-level paths.
  const [first, ...rest] = meaningful;
  const firstSegments = splitHyphenated(first);

  // For subsequent segments, keep hyphens as-is (they may be legitimate folder names)
  const allSegments = [...firstSegments, ...rest].filter(Boolean);

  if (allSegments.length === 0) return null;

  const topicPath = allSegments.join('/');
  const project = allSegments[0];

  return {
    raw: rawCwd,
    topicPath,
    segments: allSegments,
    project,
  };
}

/**
 * Slugify a working directory path to a cluster / filesystem-safe ID.
 * E.g., "/home/user/projects/lazybrain" → "lazybrain"
 *
 * Moved here from src/commands/build-clusters.ts so both commands and sources
 * can import from a pure-util module with no command-layer dependencies.
 */
export function slugifyCwd(cwd: string): string {
  let base = pathBasename(cwd);
  // Fallback: use last meaningful path segment if basename is too generic
  if (['src', 'app', 'project', 'code'].includes(base.toLowerCase())) {
    const parts = cwd.split(/[/\\]+/).filter(Boolean);
    base = parts[parts.length - 2] || base;
  }
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}
