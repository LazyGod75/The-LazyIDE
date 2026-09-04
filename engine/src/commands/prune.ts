/**
 * Prune command: remove noise notes and backup directories from the brain.
 *
 * Policies (composable):
 *   - 'claude-mem-observer'  Notes/knowledge-nodes whose content matches observer
 *                            templates injected by claude-mem agent harnesses.
 *   - 'session-dream'        Notes whose data-cerveau-source matches /^session:dream-/
 *                            (ephemeral per-conversation notes that accumulated as noise).
 *   - 'empty-tldr'          Notes whose TLDR is empty, a filename, or a bare timestamp.
 *   - 'backup-dirs'         Directories under the brain root matching notes_backup_*.
 *
 * Dry-run is the default: pass dryRun === false (via --apply on the CLI) to actually
 * delete. dryRun === true (or omitted) prints what would be deleted and exits cleanly.
 *
 * Never hardcodes user paths — all paths are resolved via brainRoot() / notesDir().
 */

import {
  type Dirent,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { brainRoot } from '../store/paths.js';
import { getLogger } from '../util/logger.js';
import { isAgentMetaText, isPlaceholderNoise } from './dream.js';
import { isNoteMetadataResidue } from './enrich.js';

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

export type PrunePolicy =
  | 'claude-mem-observer'
  | 'placeholder-noise'
  | 'session-dream'
  | 'empty-tldr'
  | 'backup-dirs';

export interface PruneOptions {
  /**
   * Comma-separated list of policies to apply, or an array.
   * When omitted, all policies are applied.
   */
  policy?: string | PrunePolicy[];
  /**
   * When true (default), print what would be deleted but do NOT delete anything.
   * Must be explicitly set to false to actually delete files.
   */
  dryRun?: boolean;
  /** Override the brain path (for tests). Falls back to brainRoot(). */
  brainPath?: string;
}

export interface PruneReport {
  dryRun: boolean;
  policies: PrunePolicy[];
  counts: Record<PrunePolicy, number>;
  totalFiles: number;
  totalDirs: number;
  deleted: number;
  candidates: PruneCandidate[];
}

export interface PruneCandidate {
  policy: PrunePolicy;
  path: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Observer-content detection helpers
// (reuses isAgentMetaText from dream.ts — same recognition logic)
// ---------------------------------------------------------------------------

/**
 * Patterns specific to claude-mem-observer injection residue found in stored notes.
 * These complement the general isAgentMetaText() check with patterns that appear
 * specifically in note HTML source rather than raw conversation text.
 */
const OBSERVER_CONTENT_PATTERNS: RegExp[] = [
  /observed_from_primary_session/i,
  /hello.{0,20}memory.{0,20}agent/i,
  /Record.{0,10}what.{0,10}was.{0,10}LEARNED/i,
];

const OBSERVER_SOURCE_PATTERN = /\bobserver\b/i;

/**
 * Return true when a note's HTML content looks like claude-mem observer residue.
 *
 * Checks:
 * 1. data-cerveau-source attribute contains "observer"
 * 2. The raw HTML matches any observer template pattern
 * 3. The plain-text content of the article matches isAgentMetaText()
 */
function isObserverNote(html: string): boolean {
  // Check data-cerveau-source attribute value
  const sourceMatch = html.match(/data-cerveau-source\s*=\s*["']([^"']+)["']/i);
  if (sourceMatch && OBSERVER_SOURCE_PATTERN.test(sourceMatch[1])) return true;

  // Check observer template patterns in the full HTML
  for (const pattern of OBSERVER_CONTENT_PATTERNS) {
    if (pattern.test(html)) return true;
  }

  // Extract article text and run isAgentMetaText on leading content
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const textContent = articleMatch[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
    if (isAgentMetaText(textContent)) return true;
    if (isNoteMetadataResidue(textContent)) return true;
  }

  return false;
}

/**
 * Return true when a note's HTML content is placeholder / template residue from a
 * prompt-injection attack (the RAG recall prompt leaked into conversation text and
 * was stored as a real brain note).
 *
 * Operates on the raw HTML: scans the title <h2> and the first TLDR/summary section
 * because placeholder text always appears there in the ingested notes.
 * Falls back to a full-text scan of stripped article prose for HTML-encoded variants.
 */
function isPlaceholderNote(html: string): boolean {
  // Fast path: scan the raw HTML for the unambiguous placeholder phrases.
  // These always appear verbatim (or HTML-entity-encoded) in the stored note.
  if (isPlaceholderNoise(html)) return true;

  // HTML-entity encoded variant: "&amp;quot;" or "&#39;" wrapping the phrase.
  // Strip basic HTML tags and entities from the article body and re-test.
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const stripped = articleMatch[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2000);
    if (isPlaceholderNoise(stripped)) return true;
  }

  return false;
}

/**
 * Return true when a note was produced by a session:dream- ephemeral run.
 *
 * The session source id format is "session:dream-<8hex>" — see makeConversationSessionId
 * in dream.ts. These are not inherently noise but can accumulate from bad dream runs.
 * This policy targets them when combined with other policies.
 */
function isSessionDreamNote(html: string): boolean {
  const sourceMatch = html.match(/data-cerveau-source\s*=\s*["']([^"']+)["']/i);
  return sourceMatch ? /^session:dream-/i.test(sourceMatch[1]) : false;
}

/**
 * Return true when the note's TLDR is empty, a bare filename, or a bare timestamp.
 * Reuses the same logic as validateTldr() in enrich.ts but expressed as a predicate.
 */
const FILE_EXTENSION_PATTERN =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|html|htm|css|scss|json|yaml|yml|toml|xml|md|txt|sh|sql|graphql|proto|dockerfile|lock)$/i;

function hasEmptyTldr(html: string): boolean {
  // Look for data-section="tldr" or data-cerveau-tldr
  const tldrSectionMatch = html.match(/data-section="tldr"[^>]*>([\s\S]*?)<\/section>/i);
  let tldrText = '';

  if (tldrSectionMatch) {
    tldrText = tldrSectionMatch[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    const cerveauTldr = html.match(/data-cerveau-tldr\s*=\s*["']([^"']*)["']/i);
    if (cerveauTldr) {
      tldrText = cerveauTldr[1].trim();
    }
  }

  // No TLDR section at all
  if (!html.includes('data-section="tldr"') && !html.includes('data-cerveau-tldr')) {
    return true;
  }

  // Empty TLDR
  if (!tldrText) return true;

  // Bare timestamp
  if (/^\d{4}-\d{2}/.test(tldrText)) return true;

  // Filename echo
  if (FILE_EXTENSION_PATTERN.test(tldrText)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// File discovery helpers
// ---------------------------------------------------------------------------

/** Recursively collect all .html files under a directory. Exported for
 *  reuse by repair.ts, which walks the same notes/knowledge-nodes tree. */
export function collectHtmlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return results;
  }

  for (const entry of entries) {
    const name = entry.name as string;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      results.push(...collectHtmlFiles(full));
    } else if (entry.isFile() && name.endsWith('.html')) {
      results.push(full);
    }
  }

  return results;
}

/** Discover all notes_backup_* directories directly under the brain root. */
function collectBackupDirs(root: string): string[] {
  if (!existsSync(root)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true }) as Dirent[];
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory() && /^notes_backup_/.test(e.name as string))
    .map((e) => join(root, e.name as string));
}

// ---------------------------------------------------------------------------
// Policy matchers
// ---------------------------------------------------------------------------

/** Returns a PruneCandidate or null for a single note file and policy. */
function matchPolicy(filePath: string, html: string, policy: PrunePolicy): PruneCandidate | null {
  switch (policy) {
    case 'claude-mem-observer':
      return isObserverNote(html)
        ? { policy, path: filePath, reason: 'observer-residue content detected' }
        : null;

    case 'placeholder-noise':
      return isPlaceholderNote(html)
        ? {
            policy,
            path: filePath,
            reason: 'placeholder/template prompt-injection residue detected',
          }
        : null;

    case 'session-dream':
      return isSessionDreamNote(html)
        ? { policy, path: filePath, reason: 'data-cerveau-source matches session:dream- prefix' }
        : null;

    case 'empty-tldr':
      return hasEmptyTldr(html)
        ? {
            policy,
            path: filePath,
            reason: 'TLDR section missing, empty, or filename/timestamp echo',
          }
        : null;

    case 'backup-dirs':
      // Handled separately (directory-level)
      return null;
  }
}

// ---------------------------------------------------------------------------
// Policy parsing
// ---------------------------------------------------------------------------

const ALL_POLICIES: PrunePolicy[] = [
  'claude-mem-observer',
  'placeholder-noise',
  'session-dream',
  'empty-tldr',
  'backup-dirs',
];

function parsePolicies(raw: string | PrunePolicy[] | undefined): PrunePolicy[] {
  if (!raw) return ALL_POLICIES;
  if (Array.isArray(raw)) return raw.length === 0 ? ALL_POLICIES : raw;
  const parts = raw.split(',').map((p) => p.trim()) as PrunePolicy[];
  return parts.length === 0 ? ALL_POLICIES : parts;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the prune command.
 *
 * Dry-run is the default (dryRun defaults to true). Pass dryRun === false to
 * actually delete files and directories.
 */
export function runPrune(opts: PruneOptions = {}): PruneReport {
  const log = getLogger();
  const dryRun = opts.dryRun !== false; // default true
  const policies = parsePolicies(opts.policy);

  const resolvedRoot = opts.brainPath ?? brainRoot();
  const resolvedNotesDir = join(resolvedRoot, 'notes');
  const resolvedKnDir = join(resolvedRoot, 'knowledge-nodes');

  const counts: Record<PrunePolicy, number> = {
    'claude-mem-observer': 0,
    'placeholder-noise': 0,
    'session-dream': 0,
    'empty-tldr': 0,
    'backup-dirs': 0,
  };

  const candidates: PruneCandidate[] = [];

  // --- File-level policies (claude-mem-observer, session-dream, empty-tldr) ---
  const filePolicies = policies.filter((p) => p !== 'backup-dirs');

  if (filePolicies.length > 0) {
    const noteFiles = [...collectHtmlFiles(resolvedNotesDir), ...collectHtmlFiles(resolvedKnDir)];

    for (const filePath of noteFiles) {
      let html: string;
      try {
        html = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      // A file may match multiple policies; the first match wins to avoid double-counting.
      for (const policy of filePolicies) {
        const candidate = matchPolicy(filePath, html, policy);
        if (candidate) {
          candidates.push(candidate);
          counts[policy] += 1;
          break;
        }
      }
    }
  }

  // --- Directory-level policy (backup-dirs) ---
  if (policies.includes('backup-dirs')) {
    const backupDirs = collectBackupDirs(resolvedRoot);
    for (const dir of backupDirs) {
      candidates.push({
        policy: 'backup-dirs',
        path: dir,
        reason: 'matches notes_backup_* pattern',
      });
      counts['backup-dirs'] += 1;
    }
  }

  const totalFiles = candidates.filter((c) => c.policy !== 'backup-dirs').length;
  const totalDirs = candidates.filter((c) => c.policy === 'backup-dirs').length;

  // --- Deletion (only when dryRun === false) ---
  let deleted = 0;
  if (!dryRun) {
    for (const candidate of candidates) {
      try {
        if (candidate.policy === 'backup-dirs') {
          const stat = statSync(candidate.path);
          if (stat.isDirectory()) {
            rmSync(candidate.path, { recursive: true, force: true });
          }
        } else {
          unlinkSync(candidate.path);
        }
        deleted += 1;
        log.debug({ path: candidate.path, policy: candidate.policy }, 'prune: deleted');
      } catch (err) {
        log.warn({ path: candidate.path, err: (err as Error).message }, 'prune: deletion failed');
      }
    }
  }

  log.info({ dryRun, policies, totalFiles, totalDirs, deleted }, 'prune: complete');

  return {
    dryRun,
    policies,
    counts,
    totalFiles,
    totalDirs,
    deleted,
    candidates,
  };
}
