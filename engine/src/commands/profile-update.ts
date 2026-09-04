import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseHTML } from 'linkedom';
import { indexNote, listAll } from '../indexer/fts.js';
import { brainRoot } from '../store/paths.js';
import { readAllNotes, readNote } from '../store/reader.js';
import { getLogger } from '../util/logger.js';
import { PKG_VERSION } from '../util/pkg-version.js';
// Re-export so existing callers still work without any change
export { profileTextForInjection } from '../store/profile.js';

export interface ProfileUpdateOptions {
  pretty?: boolean;
  /** Min number of notes a tag must appear in to be considered stable. */
  minOccurrences?: number;
  /** Force rebuild even if the profile is recent. */
  force?: boolean;
}

const PROFILE_ID = '_user-profile';
const PROFILE_FILE = '_user-profile.html';

export function runProfileUpdate(opts: ProfileUpdateOptions): string {
  const root = brainRoot();
  const notesPath = join(root, PROFILE_FILE);
  const minOcc = opts.minOccurrences ?? 3;

  const all = listAll({ includeExpired: false });
  if (all.length === 0) {
    return JSON.stringify({ status: 'noop', reason: 'no notes' });
  }

  // 1. Tag frequency = stable interests
  const tagFreq = new Map<string, number>();
  for (const n of all) {
    for (const t of (n.tags ?? '').split(/\s+/).filter(Boolean)) {
      tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
    }
  }
  const stableTags = [...tagFreq.entries()]
    .filter(([, c]) => c >= minOcc)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // 2. Recurring decisions = stable preferences
  // Look for fact text starting with "decision" or "decided" (heuristic)
  const decisionFacts: string[] = [];
  for (const n of all.slice(0, 200)) {
    if (n.type !== 'decision') continue;
    try {
      const html = readNote(n.path).html;
      const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
      const facts = Array.from(document.querySelectorAll('[data-cerveau-fact]'))
        .map((el) => (el.textContent ?? '').trim())
        .filter((t) => t.length > 10 && t.length < 200);
      if (facts.length) decisionFacts.push(facts[0]);
    } catch {
      // skip
    }
  }
  const topDecisions = uniqueByPrefix(decisionFacts).slice(0, 12);

  // 3. Common cwd / project hints (data-cerveau-cwd in source notes)
  // Normalize each cwd before counting to avoid counting the same project under
  // different slash/case variants. Reject cwds that are implausible on the
  // current platform (e.g. /home/... on Windows from Vibe fixtures).
  const cwdFreq = new Map<string, number>();
  const log = getLogger();
  const platform = process.platform as NodeJS.Platform;
  for (const note of readAllNotes()) {
    try {
      const cwdMatch = note.html.match(/data-cerveau-cwd\s*=\s*"([^"]+)"/);
      if (!cwdMatch) continue;
      const raw = cwdMatch[1];
      const normalized = normalizeCwd(raw);
      if (!isCwdPlausible(normalized, platform)) {
        log.debug({ raw, platform }, 'profile-update: skipping implausible cwd');
        continue;
      }
      cwdFreq.set(normalized, (cwdFreq.get(normalized) ?? 0) + 1);
    } catch {
      // ignore
    }
  }
  const topCwds = [...cwdFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cwd, n]) => `${cwd} (${n})`);

  const now = new Date().toISOString();
  const html = `<article id="${PROFILE_ID}"
         data-cerveau-version="${PKG_VERSION}"
         data-cerveau-created="${now}"
         data-cerveau-updated="${now}"
         data-cerveau-type="reference"
         data-cerveau-source="auto:profile"
         data-cerveau-tier="archival"
         data-cerveau-importance="1.0"
         data-cerveau-tags="profile user preferences">

  <h2>User profile (auto)</h2>

  <section>
    <h3>Recurring interests (stable tags)</h3>
    <ul>
${stableTags.map(([t, c]) => `      <li><code>${t}</code> — ${c} notes</li>`).join('\n')}
    </ul>
  </section>

  <section>
    <h3>Active projects (frequent working dirs)</h3>
    <ul>
${topCwds.length === 0 ? '      <li>(no cwd metadata captured yet)</li>' : topCwds.map((s) => `      <li><code>${htmlEscape(s)}</code></li>`).join('\n')}
    </ul>
  </section>

  <section>
    <h3>Stable decisions / preferences</h3>
    <ul>
${topDecisions.length === 0 ? '      <li>(no recurring decisions yet)</li>' : topDecisions.map((d) => `      <li>${htmlEscape(d)}</li>`).join('\n')}
    </ul>
  </section>
</article>`;

  if (!existsSync(dirname(notesPath))) mkdirSync(dirname(notesPath), { recursive: true });
  writeFileSync(notesPath, html, 'utf8');

  try {
    indexNote({
      path: notesPath,
      id: PROFILE_ID,
      html,
      sizeBytes: Buffer.byteLength(html),
      mtimeMs: Date.now(),
    });
  } catch {
    // ignore
  }

  const payload = {
    path: notesPath,
    stable_tags: stableTags.length,
    decisions_kept: topDecisions.length,
    cwds_kept: topCwds.length,
    notes_analysed: all.length,
  };
  return opts.pretty
    ? `User profile rebuilt:\n  ${stableTags.length} stable tags, ${topDecisions.length} decisions, ${topCwds.length} cwds\n  → ${notesPath}`
    : JSON.stringify(payload, null, 2);
}

/**
 * Normalize a cwd string for deduplication:
 *   - backslashes → forward slashes
 *   - collapse duplicate slashes
 *   - strip trailing slash(es)
 *   - Windows-style paths (drive letter present): fully lowercased so that
 *     "C:/Users/Alice/proj", "c:/users/alice/proj/" and "C:\\Users\\Alice\\proj"
 *     all collapse to "c:/users/alice/proj".
 *   - Unix paths: left as-is (case-sensitive file systems).
 *
 * Exported for testing.
 */
export function normalizeCwd(cwd: string): string {
  let s = cwd.replace(/\\/g, '/');
  // Collapse duplicate slashes
  s = s.replace(/\/+/g, '/');
  // Strip trailing slash
  s = s.replace(/\/+$/, '');
  // Windows-style path (starts with drive letter): lowercase entire string.
  if (/^[A-Za-z]:/.test(s)) {
    s = s.toLowerCase();
  }
  return s;
}

/**
 * Return false when a cwd string is implausible on the given platform.
 * This filters out cross-platform fixture noise (e.g. /home/david on Windows).
 *
 * On win32: reject paths starting with /home, /usr, /tmp, /var
 * On posix: reject paths matching a Windows drive letter pattern (C:/, D:/, etc.)
 *
 * Exported for testing; inject `platform` to avoid process.platform coupling.
 */
export function isCwdPlausible(cwd: string, platform: NodeJS.Platform | string): boolean {
  if (platform === 'win32') {
    // Reject Unix absolute paths that would never exist on Windows
    return !/^\/(home|usr|tmp|var)\b/.test(cwd);
  }
  // Posix: reject Windows drive-letter paths
  return !/^[a-z]:\//i.test(cwd);
}

function uniqueByPrefix(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.slice(0, 40).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function profileExists(): boolean {
  const path = join(brainRoot(), PROFILE_FILE);
  if (!existsSync(path)) return false;
  try {
    const html = readFileSync(path, 'utf8');
    return html.includes(`id="${PROFILE_ID}"`);
  } catch {
    return false;
  }
}

// profilePath and profileTextForInjection are now in src/store/profile.ts
// and re-exported above for backward compatibility.
