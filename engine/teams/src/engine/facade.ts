/**
 * EngineFacade — the single seam between E2 (HTTP server) and E1 (engine).
 *
 * All public methods match the interface contract exactly.
 * Implementation delegates to: brains.ts, cli.ts, wiki.ts, write-queue.ts, scrub.ts.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { BRAINS_DIR } from '../config.js';
import type { EngineFacade, FederatedHit, TeamBrainStats } from '../server/engine-facade.js';
import { ensureTeamBrain } from './brains.js';
import {
  type QueryOutput,
  type SearchOutput,
  type StoreOutput,
  parseJsonOutput,
  runLazybrain,
} from './cli.js';
import { scrubSecrets } from './scrub.js';
import { renderWikiIndex as _renderWikiIndex, renderWikiNote as _renderWikiNote } from './wiki.js';
import { drainAll, enqueue } from './write-queue.js';

// Re-export facade types so callers that import from engine/facade.ts still work
export type { EngineFacade, FederatedHit, TeamBrainStats } from '../server/engine-facade.js';

// ---------------------------------------------------------------------------
// Deps injection (for testability)
// ---------------------------------------------------------------------------

export interface EngineDeps {
  /** Override brain path resolution (default: BRAINS_DIR/<slug>/brain) */
  readonly brainsDir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TAG_SANITIZE_RE = /[^a-z0-9-]/g;

function sanitizeTag(raw: string): string {
  return raw.toLowerCase().replace(TAG_SANITIZE_RE, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function usernameToTagSlug(username: string): string {
  return sanitizeTag(username);
}

function buildHtmlNote(opts: {
  noteId: string;
  type: string;
  tags: readonly string[];
  text: string;
  authorUsername: string;
  teamSlug: string;
  agent: string;
}): string {
  const now = new Date().toISOString();
  const tagsAttr = opts.tags.join(',');

  const provenanceLine = `Author: ${opts.authorUsername} via LazyBrain Teams (${opts.agent})`;
  const escapedText = opts.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<article id="${opts.noteId}" data-cerveau-version="1" data-cerveau-created="${now}" data-cerveau-source="lazybrain-teams" data-cerveau-type="${opts.type}" data-cerveau-tags="${tagsAttr}"><h1>${provenanceLine}</h1><p>${escapedText}</p></article>`;
}

function brainPathForSlug(brainsDir: string, teamSlug: string): string {
  return join(brainsDir, teamSlug, 'brain');
}

// ---------------------------------------------------------------------------
// Stats cache (30 s TTL)
// ---------------------------------------------------------------------------

interface StatsCacheEntry {
  readonly value: TeamBrainStats;
  readonly expiresAt: number;
}

const statsCache = new Map<string, StatsCacheEntry>();
const STATS_TTL_MS = 30_000;

function getCachedStats(teamSlug: string): TeamBrainStats | null {
  const entry = statsCache.get(teamSlug);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    statsCache.delete(teamSlug);
    return null;
  }
  return entry.value;
}

function setCachedStats(teamSlug: string, value: TeamBrainStats): void {
  statsCache.set(teamSlug, { value, expiresAt: Date.now() + STATS_TTL_MS });
}

// ---------------------------------------------------------------------------
// Note count helpers
// ---------------------------------------------------------------------------

function countNoteFiles(brainPath: string): number {
  const notesDir = join(brainPath, 'notes');
  try {
    const months = readdirSync(notesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    let count = 0;
    for (const month of months) {
      const files = readdirSync(join(notesDir, month.name));
      count += files.filter((f) => f.endsWith('.html')).length;
    }
    return count;
  } catch {
    return 0;
  }
}

function lastNoteMtime(brainPath: string): string | undefined {
  const notesDir = join(brainPath, 'notes');
  try {
    const months = readdirSync(notesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(notesDir, d.name));

    let latestMs = 0;

    for (const monthDir of months) {
      const files = readdirSync(monthDir).filter((f) => f.endsWith('.html'));
      for (const f of files) {
        const ms = statSync(join(monthDir, f)).mtimeMs;
        if (ms > latestMs) latestMs = ms;
      }
    }

    return latestMs > 0 ? new Date(latestMs).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// createEngine
// ---------------------------------------------------------------------------

export function createEngine(deps: EngineDeps = {}): EngineFacade {
  const brainsDir = deps.brainsDir ?? BRAINS_DIR;

  return {
    // -------------------------------------------------------------------------
    // ensureTeamBrain
    // -------------------------------------------------------------------------
    async ensureTeamBrain(teamSlug: string) {
      // Always validate slug — defense in depth regardless of code path
      const SLUG_RE = /^[a-z0-9-]{2,32}$/;
      if (!SLUG_RE.test(teamSlug)) {
        throw new Error(`Invalid team slug "${teamSlug}". Must match /^[a-z0-9-]{2,32}$/.`);
      }

      // Override brainsDir from deps if provided
      if (deps.brainsDir) {
        // Use CLI directly with explicit path
        const bp = brainPathForSlug(brainsDir, teamSlug);
        const { existsSync } = await import('node:fs');
        const { join: j } = await import('node:path');

        if (existsSync(j(bp, '.lazybrain-config.json'))) {
          return { brainPath: bp };
        }

        return enqueue(bp, async () => {
          if (existsSync(j(bp, '.lazybrain-config.json'))) {
            return { brainPath: bp };
          }

          const initResult = await runLazybrain(['init', '--brain', bp], {
            brainPath: bp,
            timeoutMs: 15_000,
          });

          if (initResult.code !== 0) {
            throw new Error(
              `[lazybrain-teams] Failed to init brain for team "${teamSlug}": ` +
                `exit ${initResult.code}\n${initResult.stderr}`,
            );
          }

          const rebuildResult = await runLazybrain(['index-rebuild'], {
            brainPath: bp,
            timeoutMs: 30_000,
          });

          if (rebuildResult.code !== 0) {
            process.stderr.write(
              `[lazybrain-teams] index-rebuild warning for "${teamSlug}": ${rebuildResult.stderr}\n`,
            );
          }

          return { brainPath: bp };
        });
      }

      return ensureTeamBrain(teamSlug);
    },

    // -------------------------------------------------------------------------
    // storeNote
    // -------------------------------------------------------------------------
    async storeNote(opts) {
      const { teamSlug, authorUsername, agent = 'manual', type = 'note', tags = [], text } = opts;

      const { brainPath } = await this.ensureTeamBrain(teamSlug);

      // Secret scrub at boundary
      const { text: cleanText, redactionCount } = scrubSecrets(text);

      if (redactionCount > 0) {
        process.stderr.write(
          `[lazybrain-teams] storeNote: redacted ${redactionCount} secret(s) for team "${teamSlug}", author "${authorUsername}"\n`,
        );
      }

      // Build tag set: caller tags + provenance tags
      const authorTag = `author-${usernameToTagSlug(authorUsername)}`;
      const teamTag = `team-${sanitizeTag(teamSlug)}`;
      const sanitizedCallerTags = tags.map(sanitizeTag).filter((t) => t.length >= 1);
      const allTags = [...new Set([...sanitizedCallerTags, authorTag, teamTag])];

      const noteId = `lbt-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

      const html = buildHtmlNote({
        noteId,
        type: sanitizeTag(type) || 'note',
        tags: allTags,
        text: cleanText,
        authorUsername,
        teamSlug,
        agent,
      });

      return enqueue(brainPath, async () => {
        const storeResult = await runLazybrain(['store', '--from-stdin'], {
          brainPath,
          input: html,
          timeoutMs: 15_000,
        });

        if (storeResult.code !== 0) {
          throw new Error(
            `[lazybrain-teams] store failed for team "${teamSlug}": ` +
              `exit ${storeResult.code}\n${storeResult.stderr}`,
          );
        }

        const stored = parseJsonOutput<StoreOutput>(storeResult);
        const finalId = stored?.id ?? noteId;

        // Update index after store
        const rebuildResult = await runLazybrain(['index-rebuild'], {
          brainPath,
          timeoutMs: 30_000,
        });

        if (rebuildResult.code !== 0) {
          process.stderr.write(
            `[lazybrain-teams] index-rebuild warning after store for "${teamSlug}": ${rebuildResult.stderr}\n`,
          );
        }

        return { noteId: finalId };
      });
    },

    // -------------------------------------------------------------------------
    // search
    // -------------------------------------------------------------------------
    async search(opts) {
      const { query, teamSlugs, top = 8 } = opts;

      // Fan out across teams in parallel (reads bypass write queue)
      const perTeam = await Promise.allSettled(
        teamSlugs.map(async (teamSlug) => {
          let brainPath: string;
          try {
            ({ brainPath } = await this.ensureTeamBrain(teamSlug));
          } catch (err) {
            process.stderr.write(
              `[lazybrain-teams] search: cannot ensure brain for "${teamSlug}": ${err}\n`,
            );
            return [] as FederatedHit[];
          }

          const result = await runLazybrain(['search', query, '--top', String(top)], {
            brainPath,
            timeoutMs: 20_000,
          });

          if (result.code !== 0) {
            process.stderr.write(
              `[lazybrain-teams] search error for "${teamSlug}": ${result.stderr}\n`,
            );
            return [] as FederatedHit[];
          }

          const parsed = parseJsonOutput<SearchOutput>(result);
          if (!parsed?.hits) return [] as FederatedHit[];

          return parsed.hits.map<FederatedHit>((h) => ({
            teamSlug,
            noteId: h.id,
            title: h.note.text.split('\n')[0] ?? h.id,
            snippet: h.note.text.slice(0, 200),
            score: h.score,
            type: h.note.type || undefined,
            date: h.note.created || undefined,
          }));
        }),
      );

      const allHits: FederatedHit[] = [];
      for (const outcome of perTeam) {
        if (outcome.status === 'fulfilled') {
          allHits.push(...outcome.value);
        }
      }

      // Merge, sort by score desc, cap at top
      allHits.sort((a, b) => b.score - a.score);
      return allHits.slice(0, top);
    },

    // -------------------------------------------------------------------------
    // renderWikiIndex
    // -------------------------------------------------------------------------
    async renderWikiIndex(teamSlug: string) {
      const { brainPath } = await this.ensureTeamBrain(teamSlug);
      return _renderWikiIndex(brainPath, teamSlug);
    },

    // -------------------------------------------------------------------------
    // renderWikiNote
    // -------------------------------------------------------------------------
    async renderWikiNote(teamSlug: string, noteId: string) {
      const { brainPath } = await this.ensureTeamBrain(teamSlug);
      return _renderWikiNote(brainPath, teamSlug, noteId);
    },

    // -------------------------------------------------------------------------
    // stats
    // -------------------------------------------------------------------------
    async stats(teamSlug: string) {
      const cached = getCachedStats(teamSlug);
      if (cached) return cached;

      let brainPath: string;
      try {
        ({ brainPath } = await this.ensureTeamBrain(teamSlug));
      } catch {
        const empty: TeamBrainStats = { notes: 0, activeDecisions: 0 };
        return empty;
      }

      const notes = countNoteFiles(brainPath);
      const lastCaptureAt = lastNoteMtime(brainPath);

      // Count active decisions via query
      let activeDecisions = 0;

      const queryResult = await runLazybrain(
        [
          'query',
          'article[data-cerveau-type="decision"]:not([data-cerveau-valid-until])',
          '--limit',
          '9999',
        ],
        { brainPath, timeoutMs: 10_000 },
      );

      if (queryResult.code === 0) {
        const parsed = parseJsonOutput<QueryOutput>(queryResult);
        activeDecisions = parsed?.count ?? 0;
      } else {
        process.stderr.write(
          `[lazybrain-teams] stats query error for "${teamSlug}": ${queryResult.stderr}\n`,
        );
      }

      const value: TeamBrainStats = {
        notes,
        activeDecisions,
        ...(lastCaptureAt ? { lastCaptureAt } : {}),
      };

      setCachedStats(teamSlug, value);
      return value;
    },

    // -------------------------------------------------------------------------
    // shutdown
    // -------------------------------------------------------------------------
    async shutdown() {
      await drainAll();
    },
  };
}
