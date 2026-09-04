/**
 * Brain lifecycle management.
 *
 * ensureTeamBrain: idempotent creation of a per-team brain under BRAINS_DIR.
 * Slug is validated strictly to prevent path traversal and invalid filesystem names.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { BRAINS_DIR } from '../config.js';
import { parseJsonOutput, runLazybrain } from './cli.js';
import { enqueue } from './write-queue.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9-]{2,32}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function teamBrainPath(teamSlug: string): string {
  return join(BRAINS_DIR, teamSlug, 'brain');
}

function isInitialized(brainPath: string): boolean {
  return existsSync(join(brainPath, '.lazybrain-config.json'));
}

function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid team slug "${slug}". Must match ${SLUG_RE.toString()}.`);
  }
}

// ---------------------------------------------------------------------------
// ensureTeamBrain
// ---------------------------------------------------------------------------

/**
 * Ensure the brain for the given team slug is initialized.
 *
 * If already initialized: returns the path immediately (idempotent).
 * If not: runs `lazybrain init --brain <path>` then `lazybrain index-rebuild`
 * through the write queue.
 */
export async function ensureTeamBrain(teamSlug: string): Promise<{ brainPath: string }> {
  validateSlug(teamSlug);

  const brainPath = teamBrainPath(teamSlug);

  if (isInitialized(brainPath)) {
    return { brainPath };
  }

  // Enqueue so concurrent calls for the same slug don't race on init
  return enqueue(brainPath, async () => {
    // Re-check inside the queue (another enqueue may have completed init)
    if (isInitialized(brainPath)) {
      return { brainPath };
    }

    const initResult = await runLazybrain(['init', '--brain', brainPath], {
      brainPath,
      timeoutMs: 15_000,
    });

    if (initResult.code !== 0) {
      throw new Error(
        `[lazybrain-teams] Failed to init brain for team "${teamSlug}": ` +
          `exit ${initResult.code}\n${initResult.stderr}`,
      );
    }

    // Verify init printed the expected confirmation
    if (!initResult.stdout.includes('Initialized brain at')) {
      process.stderr.write(
        `[lazybrain-teams] Unexpected init output for "${teamSlug}": ${initResult.stdout}\n`,
      );
    }

    const rebuildResult = await runLazybrain(['index-rebuild'], {
      brainPath,
      timeoutMs: 30_000,
    });

    if (rebuildResult.code !== 0) {
      // Non-fatal: index can be rebuilt later; brain is usable
      process.stderr.write(
        `[lazybrain-teams] index-rebuild warning for "${teamSlug}": ${rebuildResult.stderr}\n`,
      );
    }

    const rebuildOutput = parseJsonOutput<{ indexed: number }>(rebuildResult);
    process.stderr.write(
      `[lazybrain-teams] Brain "${teamSlug}" initialized. ` +
        `Indexed ${rebuildOutput?.indexed ?? 0} notes.\n`,
    );

    return { brainPath };
  });
}
