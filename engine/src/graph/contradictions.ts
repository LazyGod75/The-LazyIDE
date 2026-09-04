import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { indexNote, listAll } from '../indexer/fts.js';
import { readNote } from '../store/reader.js';
import { getConfig } from '../util/config.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';

export interface ContradictionHit {
  newId: string;
  oldId: string;
  newFact: string;
  oldFact: string;
  overlap: string[]; // tags shared between the two notes
  reason: 'negation' | 'replacement' | 'switch';
}

const NEGATION_MARKERS = [
  /\bno longer\b/i,
  /\babandon(?:ed|ing)\b/i,
  /\bswitched? (?:from|away from|to)\b/i,
  /\binstead of\b/i,
  /\breplaced? (?:by|with)\b/i,
  /\bdeprecat(?:ed|ing)\b/i,
  /\babandonn[éeèê]\b/i,
  /\bremplac[éeèê]\b/i,
  /\bremplac(?:e|er|ons|ent)\b/i,
  /\bplus de\b/i,
  /\bdéprécié\b/i,
  // Extended markers for common "switching to" patterns — must be compound phrases
  // to avoid single-word false positives (e.g. bare "instead" matches too much)
  /\bswitching to\b/i,
  /\brolling back to\b/i,
  /\binstead of\b/i,
  /\bnow using\b/i,
  /\breplace\s+\w+\s+with\b/i,
  /\bchanged\s+from\b/i,
  /\bupdate\s*:\s*rolling back\b/i,
  /\bupdate\s*:\s*switching\b/i,
  /\bmigrat(?:ed?|ing)\s+from\b/i,
];

/** CSMB tags notes as session:bench:csmb:<fixtureId>:<session> */
function benchFixtureId(source: string): string | null {
  const m = /^session:bench:csmb:([^:]+):/i.exec(source);
  return m ? m[1] : null;
}

const REPLACEMENT_TOKENS = [
  ['oauth', 'jwt'],
  ['postgres', 'mysql'],
  ['postgres', 'sqlite'],
  ['typescript', 'javascript'],
  ['react', 'vue'],
  ['react', 'angular'],
  ['npm', 'yarn'],
  ['npm', 'pnpm'],
  // CSS / framework version switches
  ['tailwind v3', 'tailwind v4'],
  ['tailwind v4', 'tailwind v3'],
  ['tailwindcss v3', 'tailwindcss v4'],
  ['tailwindcss v4', 'tailwindcss v3'],
  ['prisma', 'kysely'],
  ['kysely', 'prisma'],
  ['prisma', 'drizzle'],
  ['typeorm', 'prisma'],
  ['express', 'fastify'],
  ['fastify', 'express'],
  ['node', 'bun'],
  ['bun', 'node'],
];

/**
 * Scan a freshly-captured note against the existing brain for contradictions.
 * Lightweight, regex-based — no embeddings required.
 *
 * Returns suggestions; caller decides whether to annotate the new note.
 * Never modifies the old notes (safety: human confirms via /lazybrain-invalidate).
 */
export function detectContradictions(newNoteHtml: string, newNoteId: string): ContradictionHit[] {
  const { document } = parseHTML(`<!doctype html><html><body>${newNoteHtml}</body></html>`);
  // memory-batch is a third valid root tag (compress's consolidated-batch
  // notes) alongside article/section — same selector already used by
  // indexer/note-index.ts, schema/scrubber.ts and validator.ts. Omitting it
  // here made detectContradictions silently return [] for every batch note.
  const newRoot = document.querySelector('article, section, memory-batch');
  if (!newRoot) return [];

  const newFacts = Array.from(newRoot.querySelectorAll('[data-cerveau-fact]'))
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean);

  const newTags = new Set(
    (newRoot.getAttribute('data-cerveau-tags') ?? '').split(/\s+/).filter(Boolean),
  );
  const newFullTextForCandidateFilter = (newRoot.textContent ?? '').toLowerCase();

  // Candidate "old" notes that share at least one tag with the new note,
  // OR — when there are no tags — that share a replacement-token keyword pair.
  // This fallback allows contradiction detection even on untagged plain-text notes.
  const allNotes = listAll({ includeExpired: false });
  const newSource = newRoot.getAttribute('data-cerveau-source') ?? '';
  const newBenchFixture = benchFixtureId(newSource);

  const candidates = allNotes.filter((n) => {
    if (n.id === newNoteId) return false;
    // Never cross-invalidate unrelated CSMB fixtures (dense bench brain).
    if (
      newBenchFixture &&
      benchFixtureId(n.source ?? '') &&
      newBenchFixture !== benchFixtureId(n.source ?? '')
    ) {
      return false;
    }
    // Tag-based overlap (primary signal)
    if (newTags.size > 0 && n.tags) {
      const oldTags = n.tags.split(/\s+/).filter(Boolean);
      if (oldTags.some((t) => newTags.has(t))) return true;
    }
    // Keyword-based fallback: check if a specific replacement-token pair appears
    // across both notes. Both tokens A and B must appear (one in new, one in old)
    // for this to qualify — prevents false positives from single-token matches.
    const oldLower = `${(n.title ?? '').toLowerCase()} ${(n.text ?? '').toLowerCase()}`;
    for (const [a, b] of REPLACEMENT_TOKENS) {
      // Skip very short tokens to avoid false-positive matches (e.g. "node")
      if (a.length < 4 || b.length < 4) continue;
      const newHasB = newFullTextForCandidateFilter.includes(b);
      const oldHasA = oldLower.includes(a);
      const newHasA = newFullTextForCandidateFilter.includes(a);
      const oldHasB = oldLower.includes(b);
      if ((newHasB && oldHasA) || (newHasA && oldHasB)) return true;
    }
    return false;
  });

  const hits: ContradictionHit[] = [];
  // Also extract the full new note text body for wider negation scanning.
  const newFullText = (newRoot.textContent ?? '').trim();
  // Construct a merged list of new facts + full text lines for detection.
  const newTextLines = newFullText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 4);
  const newCandidateTexts = [...new Set([...newFacts, ...newTextLines])];

  for (const candidate of candidates) {
    let candHtml: string;
    try {
      candHtml = readNote(candidate.path).html;
    } catch {
      continue;
    }
    const { document: cdoc } = parseHTML(`<!doctype html><html><body>${candHtml}</body></html>`);
    const oldRoot = cdoc.querySelector('article, section, memory-batch');
    if (!oldRoot) continue;
    const oldFacts = Array.from(oldRoot.querySelectorAll('[data-cerveau-fact]'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean);
    // Also include full old text so replacement-pair matching can see old note body
    const oldFullText = (oldRoot.textContent ?? '').trim();
    const oldBodyLines = oldFullText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 4);
    const oldCandidateTexts = [...new Set([...oldFacts, ...oldBodyLines])];

    const overlap = (candidate.tags ?? '').split(/\s+/).filter((t) => newTags.has(t));

    for (const newText of newCandidateTexts) {
      const reason = detectReason(newText, oldCandidateTexts);
      if (!reason) continue;
      // Find the most plausible "old fact" that's being replaced
      const match = oldFacts.find((f) => sharesKeyTokens(newText, f, overlap)) ?? oldFacts[0];
      const oldFact = match ?? oldBodyLines[0] ?? '';
      hits.push({
        newId: newNoteId,
        oldId: candidate.id,
        newFact: newText.slice(0, 200),
        oldFact: oldFact.slice(0, 200),
        overlap,
        reason,
      });
      break; // one contradiction per candidate is enough to flag
    }
  }
  return hits;
}

function detectReason(text: string, oldFacts: string[]): ContradictionHit['reason'] | null {
  if (NEGATION_MARKERS.some((re) => re.test(text))) return 'negation';
  const lower = text.toLowerCase();

  // Check replacement token pairs — also consider old note body text (not just facts)
  const oldBody = oldFacts.join(' ').toLowerCase();
  for (const [a, b] of REPLACEMENT_TOKENS) {
    // New note mentions B (new tech), old note body mentions A (old tech).
    // Guard: if the new note mentions BOTH A and B, it is discussing the pair,
    // not actively replacing A with B — skip to avoid false positives (e.g. a
    // note about "migrating FROM prisma TO kysely" stored as the replacement note
    // would match the same pair when scanning a third note that merely mentions
    // both tools together).
    const newHasB = lower.includes(b);
    const newHasA = lower.includes(a);
    if (
      newHasB &&
      !newHasA &&
      (oldBody.includes(a) || oldFacts.some((f) => f.toLowerCase().includes(a)))
    ) {
      return 'replacement';
    }
    // New note mentions A (old tech) and old note mentions B (new tech) — reverting
    if (
      newHasA &&
      !newHasB &&
      (oldBody.includes(b) || oldFacts.some((f) => f.toLowerCase().includes(b)))
    ) {
      return 'switch';
    }
  }
  return null;
}

function sharesKeyTokens(a: string, b: string, overlapTags: string[]): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  // Use overlap tags when available
  if (overlapTags.length > 0) {
    return overlapTags.some((t) => lowerA.includes(t) && lowerB.includes(t));
  }
  // Fallback: check if any replacement-token keyword appears in both texts
  for (const [x, y] of REPLACEMENT_TOKENS) {
    if ((lowerA.includes(x) || lowerA.includes(y)) && (lowerB.includes(x) || lowerB.includes(y))) {
      return true;
    }
  }
  return false;
}

/**
 * Annotate the new note's HTML with data-cerveau-conflict-with attributes
 * pointing at the older notes that contradict it.
 *
 * Bi-temporal mode (Graphiti-style): when `LAZYBRAIN_AUTO_INVALIDATE=1`, also
 * mark the matched old notes as `data-cerveau-valid-until=<today>` and
 * `data-cerveau-invalidated-by=<newId>`. Only fired on high-confidence reasons
 * (negation, replacement) — never on plain token-switch heuristics alone.
 */
export function annotateContradictions(notePath: string, hits: ContradictionHit[]): number {
  if (hits.length === 0 || !existsSync(notePath)) return 0;
  let html = readFileSync(notePath, 'utf8');
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const root = document.querySelector('article, section, memory-batch');
  if (!root) return 0;

  const targets = [...new Set(hits.map((h) => h.oldId))].join(',');
  root.setAttribute('data-cerveau-conflict-with', targets);
  const reasons = [...new Set(hits.map((h) => h.reason))].join(',');
  root.setAttribute('data-cerveau-conflict-reason', reasons);
  // A structurally-detected contradiction is a high-charge signal: stamp the
  // saliency kind so it is indexed (notes.saliency_kind) and shows its ⊘ glyph
  // in prompt injection. Never clobber a stronger saliency (breakthrough /
  // painful-bug) that a prior annotation pass may already have assigned.
  if (!root.getAttribute('data-cerveau-saliency-kind')) {
    root.setAttribute('data-cerveau-saliency-kind', 'contradiction');
  }

  html = root.outerHTML;
  writeFileSync(notePath, html, 'utf8');

  // Check env var first, then fall back to cache-dir settings.json for daemon use cases.
  const autoInvalidate = readAutoInvalidateSetting();
  let invalidated = 0;
  if (autoInvalidate) {
    const today = nowIso().slice(0, 10);
    const newId = hits[0]?.newId ?? '';
    // Only auto-invalidate on strong signals: 'negation' (explicit marker found)
    // or 'replacement' where the new note is a decision-type (not a procedural
    // note that merely mentions the same technology pair).
    const newNoteType = (root.getAttribute('data-cerveau-type') ?? '').toLowerCase();
    // Only strict "decision" notes auto-invalidate via replacement pairs.
    // "reference" and "procedural" notes may mention both old and new technologies
    // without actively replacing one with the other.
    const isNewDecision = newNoteType === 'decision';
    const oldIds = [
      ...new Set(
        hits
          .filter((h) => h.reason === 'negation' || (h.reason === 'replacement' && isNewDecision))
          .map((h) => h.oldId),
      ),
    ];
    for (const oldId of oldIds) {
      try {
        invalidated += markInvalidatedById(oldId, today, newId) ? 1 : 0;
      } catch {
        // best-effort
      }
    }
  }

  logTelemetry({
    event: 'error', // generic event we already log
    ts: nowIso(),
    where: 'contradictions',
    message: `flagged ${hits.length} conflict(s) on ${hits[0]?.newId ?? '?'}${invalidated ? `, invalidated ${invalidated}` : ''}`,
  });
  return hits.length;
}

/**
 * Back-annotate the OLDER notes a new note contradicts, so the contradiction
 * is visible from BOTH sides (whichever note the user opens in the wiki, the
 * warning shows).
 *
 * Non-destructive: only APPENDS the new note's id to each old note's
 * data-cerveau-conflict-with (deduped) and stamps the "contradiction" saliency
 * kind when the old note has none. It never expires the old note or rewrites
 * its body — that stronger, one-way action stays behind
 * LAZYBRAIN_AUTO_INVALIDATE (markInvalidatedById). Uses the same in-place
 * opening-tag regex convention as markInvalidatedById (preserves the full note
 * template) rather than an outerHTML round-trip.
 *
 * Best-effort by contract: one malformed old note can never abort the batch.
 * Returns the number of old notes actually modified.
 */
export function backannotateConflictTargets(hits: ContradictionHit[]): number {
  if (hits.length === 0) return 0;
  const newId = hits[0]?.newId ?? '';
  if (!newId) return 0;

  const oldIds = [...new Set(hits.map((h) => h.oldId))];
  const all = listAll({ includeExpired: true });
  let modified = 0;
  for (const oldId of oldIds) {
    const target = all.find((n) => n.id === oldId);
    if (!target || !existsSync(target.path)) continue;
    try {
      if (addConflictBacklink(target.path, newId)) modified += 1;
    } catch {
      // best-effort — a single unreadable/malformed note must not abort the rest
    }
  }
  return modified;
}

/**
 * Add a `data-cerveau-conflict-with` backref (and a contradiction saliency
 * marker when absent) to a single old note's root element, then re-index it so
 * the conflict_with / saliency_kind columns reflect the change immediately.
 * Returns false when nothing changed (already linked, or no root tag).
 */
function addConflictBacklink(notePath: string, newId: string): boolean {
  const html = readFileSync(notePath, 'utf8');
  let patched = html;

  const existing = html.match(/data-cerveau-conflict-with\s*=\s*["']([^"']*)["']/i);
  if (existing) {
    const current = existing[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (current.includes(newId)) return false; // already linked — nothing to do
    const merged = [...current, newId].join(',');
    patched = patched.replace(
      /(data-cerveau-conflict-with\s*=\s*["'])[^"']*(["'])/i,
      (_m, open: string, close: string) => `${open}${merged}${close}`,
    );
  } else {
    patched = injectRootAttr(patched, `data-cerveau-conflict-with="${newId}"`);
  }

  if (!/data-cerveau-saliency-kind\s*=/i.test(patched)) {
    patched = injectRootAttr(patched, 'data-cerveau-saliency-kind="contradiction"');
  }

  if (patched === html) return false;
  writeFileSync(notePath, patched, 'utf8');
  try {
    indexNote(readNote(notePath));
  } catch {
    // best-effort — file written, DB sync may lag until the next index pass
  }
  return true;
}

/**
 * Inject an attribute into the note's opening root tag (article / section /
 * memory-batch). Same dotAll opening-tag regex markInvalidatedById relies on —
 * the Wikipedia template's <article> tag spans multiple lines.
 */
function injectRootAttr(html: string, attr: string): string {
  return html.replace(
    /(<(?:article|section|memory-batch)\b.*?)(\s*>)/s,
    (_m, head: string, tail: string) => `${head} ${attr}${tail}`,
  );
}

function markInvalidatedById(oldId: string, today: string, byId: string): boolean {
  const all = listAll({ includeExpired: true });
  const target = all.find((n) => n.id === oldId);
  if (!target) return false;

  // Safety: never invalidate a note that is newer than (or same time as) the note
  // doing the invalidating. The byId note's creation time is encoded in its id
  // prefix (YYYY-MM-DDTHH-MM-SS or YYYY-MM-DD), and also available via target.created.
  // We compare created timestamps to avoid replacement notes marking each other.
  const byTarget = all.find((n) => n.id === byId);
  if (byTarget?.created && target.created) {
    const byCreated = new Date(byTarget.created).getTime();
    const oldCreated = new Date(target.created).getTime();
    if (oldCreated >= byCreated) return false; // do not invalidate notes that are same age or newer
  }

  const html = readFileSync(target.path, 'utf8');
  if (/data-cerveau-valid-until\s*=/.test(html)) return false; // already marked

  // The <article> tag spans multiple lines in the Wikipedia template, so we use
  // the /s (dotAll) flag to allow `.` to match newlines in the regex.
  const patched = html.replace(
    /(<(?:article|section|memory-batch)\b.*?)(\s*>)/s,
    (_m, head: string, tail: string) =>
      `${head}\n         data-cerveau-valid-until="${today}" data-cerveau-invalidated-by="${byId}"${tail}`,
  );
  if (patched === html) return false;
  writeFileSync(target.path, patched, 'utf8');
  // Re-index so the DB reflects the new valid_until value immediately.
  // Without this, the ranking penalty cannot see the change.
  try {
    indexNote(readNote(target.path));
  } catch {
    // best-effort — file was written, DB sync may lag
  }
  return true;
}

/**
 * Read the autoInvalidate setting from env var first, then fall back to
 * settings.json in the cache directory (useful when running inside the daemon
 * which may not inherit LAZYBRAIN_AUTO_INVALIDATE from the shell).
 */
function readAutoInvalidateSetting(): boolean {
  if (process.env.LAZYBRAIN_AUTO_INVALIDATE === '1') return true;
  try {
    const settingsPath = join(getConfig().cachePath, 'settings.json');
    if (existsSync(settingsPath)) {
      // Strip UTF-8 BOM if present before parsing
      const raw = readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      return settings.autoInvalidate === true;
    }
  } catch {
    // best-effort
  }
  return false;
}
