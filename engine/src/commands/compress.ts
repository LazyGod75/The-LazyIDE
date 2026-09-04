import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldCapture } from '../capture/validator.js';
import { deleteNote, indexNote } from '../indexer/fts.js';
import { stripNote } from '../retrieval/strip.js';
import { batchesDir } from '../store/paths.js';
import { readAllNotes, readNote } from '../store/reader.js';
import { PKG_VERSION } from '../util/pkg-version.js';
import { logTelemetry, nowIso } from '../util/telemetry.js';

export interface CompressCliOptions {
  session?: string;
  olderThanDays?: number; // compress working-tier notes older than N days
  dryRun?: boolean;
  pretty?: boolean;
  purgeNoise?: boolean;
  purgeSource?: string; // prefix match on data-cerveau-source (e.g. "bench:locomo")
}

/**
 * Compress N working-tier notes from a session into a single <memory-batch>.
 * Marks the originals as data-cerveau-superseded-by="batch-id" but keeps them.
 */
export function runCompress(opts: CompressCliOptions): string {
  if (opts.purgeNoise) {
    return runPurgeNoise(opts);
  }
  if (opts.purgeSource) {
    return runPurgeSource(opts.purgeSource, opts);
  }
  const notes = readAllNotes();
  const olderThanMs = (opts.olderThanDays ?? 7) * 86_400_000;
  const cutoff = Date.now() - olderThanMs;

  const candidates = notes.filter((n) => {
    if (n.path.includes('batches')) return false; // never recompress
    const ageOk = n.mtimeMs < cutoff;
    if (opts.session) {
      return n.html.includes(`session:${opts.session}`) && ageOk;
    }
    return ageOk;
  });

  if (candidates.length === 0) {
    return JSON.stringify({ status: 'noop', reason: 'no candidates' });
  }

  const stripped = candidates.map((n) => ({ id: n.id, note: stripNote(n.html) }));
  const tags = new Set<string>();
  for (const s of stripped) for (const t of s.note.tags) tags.add(t);

  const allFacts = stripped.flatMap((s) => s.note.facts.map((f) => ({ ...f, from: s.id })));
  // Keep only the highest-importance / highest-confidence facts
  const keptFacts = [...allFacts]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.min(12, Math.ceil(allFacts.length / 3)));

  const batchId = `batch-${nowIso().slice(0, 10)}-${(opts.session ?? 'all').slice(0, 8)}`;
  const factsHtml = keptFacts
    .map(
      (f) =>
        `  <p data-cerveau-fact data-cerveau-confidence="${f.confidence.toFixed(2)}" data-cerveau-source="#${f.from}">${htmlEscape(f.text)}</p>`,
    )
    .join('\n');

  const periodStart = new Date(Math.min(...candidates.map((c) => c.mtimeMs)))
    .toISOString()
    .slice(0, 10);
  const periodEnd = nowIso().slice(0, 10);

  const html = `<memory-batch id="${batchId}"
              data-cerveau-version="${PKG_VERSION}"
              data-cerveau-created="${nowIso()}"
              data-cerveau-type="semantic"
              data-cerveau-source="batch:${batchId}"
              data-cerveau-tier="archival"
              data-cerveau-batch-size="${candidates.length}"
              data-cerveau-batch-period="${periodStart}/${periodEnd}"
              data-cerveau-consolidated-from="${candidates.map((c) => c.id).join(',')}"
              data-cerveau-compression-ratio="${(keptFacts.length / Math.max(1, allFacts.length)).toFixed(2)}"
              data-cerveau-dreamed-at="${nowIso()}"
              data-cerveau-dreamer="heuristic"
              data-cerveau-tags="${[...tags].join(' ')}">
  <h2>Consolidated batch ${batchId}</h2>
  <p data-cerveau-summary>${candidates.length} notes from ${periodStart} to ${periodEnd} → ${keptFacts.length} salient facts.</p>
${factsHtml}
</memory-batch>`;

  if (opts.dryRun) {
    return JSON.stringify({
      status: 'dry-run',
      batch_id: batchId,
      candidates: candidates.length,
      facts_kept: keptFacts.length,
      ratio: keptFacts.length / Math.max(1, allFacts.length),
      html,
    });
  }

  const dir = batchesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${batchId}.html`);
  writeFileSync(path, html, 'utf8');
  indexNote(readNote(path));

  logTelemetry({
    event: 'compress',
    ts: nowIso(),
    session: opts.session,
    in_count: candidates.length,
    out_size_bytes: Buffer.byteLength(html, 'utf8'),
    compression_ratio: keptFacts.length / Math.max(1, allFacts.length),
    model: 'heuristic',
  });

  return opts.pretty
    ? `Compressed ${candidates.length} notes → ${batchId} (${keptFacts.length} facts kept)`
    : JSON.stringify({
        batch_id: batchId,
        path,
        candidates: candidates.length,
        facts_kept: keptFacts.length,
      });
}

/**
 * Mark legacy noisy notes as invalidated. Same heuristic as the capture validator,
 * but applied retroactively to the brain's stripped text. Idempotent: notes already
 * carrying `data-cerveau-valid-until` are skipped.
 */
function runPurgeNoise(opts: CompressCliOptions): string {
  const start = Date.now();
  const notes = readAllNotes();
  const today = nowIso().slice(0, 10);

  const noisy: Array<{ id: string; path: string; reason: string }> = [];

  for (const note of notes) {
    if (/data-cerveau-valid-until\s*=/.test(note.html)) continue; // already invalidated
    let text: string;
    try {
      text = stripNote(note.html).text;
    } catch {
      continue;
    }
    if (!text) continue;
    const v = shouldCapture(text);
    if (!v.ok && v.reason !== 'duplicate') {
      noisy.push({ id: note.id, path: note.path, reason: v.reason });
    }
  }

  if (opts.dryRun) {
    return JSON.stringify({
      status: 'dry-run',
      scanned: notes.length,
      noisy: noisy.length,
      samples: noisy.slice(0, 5),
    });
  }

  let invalidated = 0;
  for (const item of noisy) {
    try {
      const html = readFileSync(item.path, 'utf8');
      const patched = html.replace(
        /(<(?:article|section|memory-batch)\b[^>]*?)(\s*>)/,
        (_match, head: string, tail: string) =>
          `${head} data-cerveau-valid-until="${today}" data-cerveau-invalidated-by="purge-noise:${item.reason}"${tail}`,
      );
      if (patched !== html) {
        writeFileSync(item.path, patched, 'utf8');
        try {
          indexNote(readNote(item.path));
        } catch {
          /* keep going */
        }
        invalidated += 1;
      }
    } catch {
      // skip unreadable
    }
  }

  logTelemetry({
    event: 'compress',
    ts: nowIso(),
    in_count: invalidated,
    out_size_bytes: 0,
    compression_ratio: notes.length ? invalidated / notes.length : 0,
    model: 'purge-noise',
  });

  const payload = {
    status: 'ok',
    scanned: notes.length,
    invalidated,
    duration_ms: Date.now() - start,
  };
  return opts.pretty
    ? `Purged ${invalidated}/${notes.length} noisy notes in ${payload.duration_ms}ms`
    : JSON.stringify(payload);
}

/**
 * Hard-delete notes whose `data-cerveau-source` starts with the given prefix.
 * Used to roll back bench ingest from the real brain (`bench:locomo:*`).
 * Files are removed AND the FTS index entries dropped. Idempotent.
 */
function runPurgeSource(prefix: string, opts: CompressCliOptions): string {
  const start = Date.now();
  const notes = readAllNotes();
  const matches: Array<{ id: string; path: string }> = [];
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match both `data-cerveau-source="prefix..."` and `data-cerveau-source="session:prefix..."`
  // since the annotator prepends `session:` to user-provided session ids.
  const pattern = new RegExp(`data-cerveau-source="(?:session:)?${escapedPrefix}`);
  for (const n of notes) {
    if (pattern.test(n.html)) matches.push({ id: n.id, path: n.path });
  }

  if (opts.dryRun) {
    return JSON.stringify({
      status: 'dry-run',
      prefix,
      candidates: matches.length,
      samples: matches.slice(0, 5).map((m) => m.id),
    });
  }

  let deleted = 0;
  for (const m of matches) {
    try {
      unlinkSync(m.path);
      deleteNote(m.id);
      deleted += 1;
    } catch {
      // skip
    }
  }

  const payload = {
    status: 'ok',
    prefix,
    scanned: notes.length,
    deleted,
    duration_ms: Date.now() - start,
  };
  return opts.pretty
    ? `Purged ${deleted}/${matches.length} notes matching source prefix "${prefix}" in ${payload.duration_ms}ms`
    : JSON.stringify(payload);
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
