/**
 * profile.ts — Pure reader helpers for the user profile note.
 *
 * Extracted from src/commands/profile-update.ts so inject-context and any
 * server route can read the profile without importing the full command layer.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripTags } from '../retrieval/strip.js';
import { brainRoot } from './paths.js';

const PROFILE_FILE = '_user-profile.html';

/**
 * Absolute path of the user profile HTML note.
 */
export function profilePath(): string {
  return join(brainRoot(), PROFILE_FILE);
}

/**
 * Return the user profile as plain text for injection into LLM context.
 * Returns null when the profile has not been generated yet.
 */
export function profileTextForInjection(): string | null {
  const path = profilePath();
  if (!existsSync(path)) return null;
  try {
    const html = readFileSync(path, 'utf8');
    return stripTags(html);
  } catch {
    return null;
  }
}
