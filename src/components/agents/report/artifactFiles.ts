/* artifactFiles.ts — honest disk-backed text loader for `test_run` /
   `command_output` proof artifacts' outputPath (ArtifactOutputModal.tsx).
   Sibling to artifactImage.ts — same existence-vs-unreadable distinction,
   same stripVerbatimPrefix boundary fix, but for plain captured text output
   (already UTF-8 — storeProofText/proofs.ts always writes text) instead of
   images, so no base64/data-URI step is needed here.
*/

import { getPlatform } from '../../../lib/platform';
import { stripVerbatimPrefix } from '../../../lib/paths';

export type ArtifactTextResult =
  | { status: 'ok'; text: string; truncated: boolean }
  | { status: 'missing' }
  | { status: 'unreadable' };

/** Display cap — a captured command's full stdout/stderr can be enormous;
 *  the modal only ever shows a bounded excerpt (never writes back, so
 *  truncation here is safe, unlike the editor's own read path). */
const MAX_DISPLAY_CHARS = 200_000;

function splitPath(path: string): { dir: string; name: string } {
  const sep = path.includes('\\') ? '\\' : '/';
  const idx = path.lastIndexOf(sep);
  return idx === -1 ? { dir: '.', name: path } : { dir: path.slice(0, idx), name: path.slice(idx + 1) };
}

/** Resolves a proof artifact's outputPath into its captured text content
 *  (capped at MAX_DISPLAY_CHARS), or an honest failure state. Never throws. */
export async function resolveArtifactText(path: string): Promise<ArtifactTextResult> {
  const platform = getPlatform();
  if (!platform?.fs) return { status: 'unreadable' };

  const cleanPath = stripVerbatimPrefix(path);

  try {
    const content = await platform.fs.readFile(cleanPath);
    return content.length > MAX_DISPLAY_CHARS
      ? { status: 'ok', text: content.slice(0, MAX_DISPLAY_CHARS), truncated: true }
      : { status: 'ok', text: content, truncated: false };
  } catch {
    const { dir, name } = splitPath(cleanPath);
    try {
      const entries = await platform.fs.readDir(dir);
      return entries.some((e) => !e.isDir && e.name === name)
        ? { status: 'unreadable' }
        : { status: 'missing' };
    } catch {
      return { status: 'missing' };
    }
  }
}
