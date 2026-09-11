import { readFileSync } from 'node:fs';
import { buildWikilinkContext, injectWikilinks } from '../annotator/wikilinks.js';
import {
  annotateContradictions,
  backannotateConflictTargets,
  detectContradictions,
} from '../graph/contradictions.js';
import { indexNote, listAll } from '../indexer/fts.js';
import { armPendingEnrich } from '../store/pending-enrich.js';
import { readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { getLogger } from '../util/logger.js';
import { isConvEligibleNoteHtml, runIncrementalEnrich } from './enrich.js';
import { runRecomposeAll } from './recompose-all.js';

export interface StoreCliOptions {
  fromFile?: string;
  fromStdin?: boolean;
  html?: string;
  overwrite?: boolean;
  /** See WriteOptions.upsertIfRicher (store/writer.ts) — replace an
   *  existing note's body only when the new one is richer, preserving
   *  data-cerveau-created and refreshing data-cerveau-updated. */
  upsertIfRicher?: boolean;
  /** When set, a conversation-eligible note's enrich+recompose tail is
   *  deferred to the serving sidecar via a pending-enrich marker (see
   *  store/pending-enrich.ts) instead of running ~30s of corpus work inside
   *  the capture child's 30s timeout. Used by the desktop app's brain_capture
   *  spawn; CLI-only flows keep the synchronous default so their brains still
   *  get enriched without any sidecar running. */
  deferEnrich?: boolean;
  pretty?: boolean;
}

export async function runStore(opts: StoreCliOptions): Promise<string> {
  const log = getLogger();
  let html = opts.html;
  if (!html && opts.fromFile) {
    html = readFileSync(opts.fromFile, 'utf8');
  }
  if (!html) {
    html = await readStdin();
  }
  if (!html.trim()) {
    throw new Error('Empty HTML input');
  }

  // Inject wikilinks before writing: build context from existing indexed notes
  try {
    const indexedNotes = listAll({ includeExpired: false });
    if (indexedNotes.length > 0) {
      const ctx = buildWikilinkContext(
        indexedNotes.map((n) => ({
          id: n.id,
          concepts: n.concepts ?? null,
          entities: n.entities ?? null,
          tags: n.tags ?? '',
        })),
      );
      // Only inject if we have enough context (at least 2 other notes)
      if (ctx.knownNoteIds.size >= 2) {
        html = injectWikilinks(html, ctx);
        log.debug({ noteCount: ctx.knownNoteIds.size }, 'wikilinks injected during store');
      }
    }
  } catch (err) {
    // Best-effort: log but don't fail note creation
    log.warn({ err: (err as Error).message }, 'wikilinks injection failed, continuing without it');
  }

  const result = writeNote(html, {
    overwrite: opts.overwrite,
    upsertIfRicher: opts.upsertIfRicher,
  });
  // Index immediately for read-after-write consistency
  const note = readNote(result.path);
  indexNote(note);

  // Trigger incremental conv→file-neuron enrichment. This is the write path
  // the real desktop app uses for every in-editor capture (Rust's
  // brain_capture spawns `lazybrain store` per event over stdin — see
  // src-tauri/src/commands/brain/capture.rs) — capture.ts/capture-vibe.ts's
  // equivalent auto-run wiring never runs for these notes because the app
  // never calls the `capture` CLI verb. Without this call, a decision/bug
  // typed in the app would never attach to its file-neuron.
  //
  // Guarded to conversation-shaped notes only (isConvEligibleNoteHtml is the
  // exact same filter buildConvNotes uses for the enrichment corpus, so the
  // guard can never disagree with what the enrichment pass would itself
  // accept) — `store` is also used to write file-neuron/concept/aggregate
  // HTML directly in some flows, and those can never carry conversational
  // decisions/bugs, so skip the readAllNotes() scan entirely for them.
  //
  // Throttled by runIncrementalEnrich's own since-last-run checkpoint
  // (enrich-state.json), so a burst of rapid captures pays the full
  // readAllNotes()+reclassify scan at most once per throttle window.
  // Resilient: runIncrementalEnrich never throws — a broken enrich pass
  // must never fail a `store` call.
  if (isConvEligibleNoteHtml(html)) {
    // Contradiction detection: flag the new note (and back-annotate the notes
    // it contradicts) so the brain's contradiction-warning feature actually
    // fires in the app. The desktop writes every in-editor neuron via `store`,
    // never via `capture` — previously the ONLY caller of detectContradictions
    // (graph/contradictions.ts) — so without this the feature never ran in the
    // product. Reuses the same conversation-eligibility guard as enrichment:
    // generated file-neuron / concept HTML can never carry a conversational
    // decision that contradicts another note.
    //
    // Resilient by contract: every failure is swallowed — a broken
    // contradiction pass must never fail a `store` call (mirrors capture.ts).
    // Cost is bounded by detectContradictions' own candidate filter (it only
    // reads notes that share a tag or a known replacement-token pair with the
    // new note), so no throttle beyond this guard is required.
    try {
      const hits = detectContradictions(note.html, result.id);
      if (hits.length > 0) {
        annotateContradictions(result.path, hits);
        backannotateConflictTargets(hits);
        // Re-index the new note so its conflict_with / saliency_kind columns
        // reflect the just-written attributes.
        indexNote(readNote(result.path));
        log.debug({ note: result.id, conflicts: hits.length }, 'store: contradiction(s) flagged');
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'store: contradiction detection failed (non-fatal)',
      );
    }

    if (opts.deferEnrich) {
      // Deferred path: arm the marker and skip the corpus-wide tail. If the
      // marker write itself fails, fall through to the synchronous pass —
      // losing the enrichment entirely would be worse than a slow capture.
      let armed = false;
      try {
        armPendingEnrich(result.id);
        armed = true;
      } catch (err) {
        log.warn(
          { err: (err as Error).message },
          'store: pending-enrich marker write failed — running enrichment inline',
        );
      }
      if (!armed) {
        await runIncrementalEnrich();
        try {
          await runRecomposeAll();
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'store: recompose-all failed (non-fatal)');
        }
      }
    } else {
      await runIncrementalEnrich();
      try {
        await runRecomposeAll();
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'store: recompose-all failed (non-fatal)');
      }
    }
  }

  if (opts.pretty) {
    return `Stored: ${result.id}\n  path: ${result.path}\n  size: ${result.sizeBytes}B\n  attrs: ${result.attrsCount}`;
  }
  return JSON.stringify(result, null, 2);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      const raw = Buffer.concat(chunks);
      resolve(decodeBufferAsUtf8(raw));
    });
  });
}

/**
 * Decode a buffer as UTF-8, with fallback handling for UTF-16 LE/BE BOMs.
 * PowerShell 5.1 on Windows defaults to UTF-16 LE when piping strings,
 * which mangles non-ASCII characters (e.g. French accents) if read as UTF-8.
 */
function decodeBufferAsUtf8(buf: Buffer): string {
  // UTF-16 LE BOM: FF FE
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  // UTF-16 BE BOM: FE FF
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Node has no built-in UTF-16 BE decoder; swap bytes then decode as LE
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length - 1; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  // UTF-8 BOM: EF BB BF — strip BOM then decode normally
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  // Default: assume UTF-8
  return buf.toString('utf8');
}
