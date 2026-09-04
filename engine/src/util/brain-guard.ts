/**
 * Shared brain-existence guard.
 *
 * Commands that read from the brain should call assertBrainExists() early
 * so users get a clear "run init first" message instead of confusing empty
 * results or cryptic filesystem errors.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { brainRoot } from '../store/paths.js';

/**
 * Throw a human-friendly error when the brain directory or its notes/
 * subdirectory does not exist.
 *
 * @throws {Error} "Brain not found at <path>. Run 'lazybrain init' first…"
 */
export function assertBrainExists(): void {
  const root = brainRoot();
  if (!existsSync(root) || !existsSync(join(root, 'notes'))) {
    throw new Error(
      `Brain not found at ${root}. Run 'lazybrain init' first (or set LAZYBRAIN_BRAIN_PATH).`,
    );
  }
}
