/* artifactImage.ts — best-effort, HONEST disk-backed rendering for
   `screenshot` proof artifacts inside the per-project Rapport page
   (ArtifactGallery.tsx).

   W9 FIX: the previous version of this module could not render a REAL
   screenshot thumbnail at all — the only disk-read command exposed to the
   frontend was `read_file` (src-tauri/src/commands/fs.rs), which calls
   Rust's `fs::read_to_string` and therefore REQUIRES valid UTF-8; a real
   PNG/JPEG's own header bytes are never valid UTF-8, so every real
   screenshot artifact hard-failed and fell back to the honest-but-useless
   "illisible" (unreadable) state. src-tauri now exposes a binary-safe
   `read_file_base64` command (same `ensure_path_in_any_open_project`
   containment guard as `read_file`, see fs.rs's `read_file_base64_inner`)
   — this module tries THAT first and only falls back to the legacy
   UTF-8-only `readFile` round-trip when it is unavailable (the web/
   Playwright mock platform, which has no real filesystem to read binary
   content from — see platform/types.ts's `FileSystem.readFileBase64` doc
   comment for why it's optional).

   What this module does, honestly:
     - Tries platform.fs.readFileBase64(path) (stripVerbatimPrefix'd first —
       every disk-read command rejects a Windows `\\?\` prefix, see
       paths.ts's header comment for the bug-class history) when the
       platform exposes it. On success, the returned base64 text becomes
       the data: URI directly — a byte-for-byte-correct thumbnail for ANY
       file type (binary or text), not just the UTF-8 subset the old path
       could handle.
     - Falls back to platform.fs.readFile(path) + a UTF-8-byte base64
       re-encode when readFileBase64 is unavailable or itself fails — this
       only round-trips correctly for a file that WAS valid UTF-8 (e.g. an
       SVG screenshot, or a test fixture) rather than corrupting/guessing at
       binary content; kept for platforms/paths where the binary-safe
       command genuinely cannot help.
     - On failure (either path), distinguishes "file never existed" from
       "file exists but could not be decoded/read" by listing the parent
       directory — so the gallery can show an honest, distinct state instead
       of a broken <img> or a misleading "fichier absent" for a real file
       this platform layer simply cannot decode.
     - Applies a ~5MB inline-size guard: for the base64 path, computed as
       `base64.length * 0.75` (the decoded byte count a base64 string of
       that length represents — base64 encodes 3 bytes as 4 characters,
       hence the 0.75 = 3/4 factor) since there is no separate stat/metadata
       call exposed; for the legacy UTF-8 path, the same guard as before
       (`content.length`, already a byte-ish measure for that path).
*/

import { getPlatform, type Platform } from '../../../lib/platform';
import { stripVerbatimPrefix } from '../../../lib/paths';

export type ArtifactImageResult =
  | { status: 'ok'; dataUri: string }
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'too-large' };

/** Post-read inline-size guard (spec: "verify size guard ~5MB") — measured
 *  in UTF-16 code units of the decoded string, the only size signal
 *  available without a stat call. */
const MAX_INLINE_CHARS = 5_000_000;

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
}

/** Separator-agnostic dirname/basename — paths.ts has no dirname helper and
 *  is a read-only shared module this wave must not extend. */
function splitPath(path: string): { dir: string; name: string } {
  const sep = path.includes('\\') ? '\\' : '/';
  const idx = path.lastIndexOf(sep);
  return idx === -1 ? { dir: '.', name: path } : { dir: path.slice(0, idx), name: path.slice(idx + 1) };
}

/** Base64-encodes a JS string's UTF-8 byte representation. Only a faithful
 *  reconstruction of the ORIGINAL file bytes when that file was valid UTF-8
 *  to begin with (see this module's header) — a genuinely binary image will
 *  already have failed at readFile() and never reach this function. */
function toBase64Utf8(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Distinguishes "file never existed" from "file exists but could not be
 *  decoded/read" by listing the parent directory — shared by both the
 *  binary-safe and legacy UTF-8 read attempts below so the gallery always
 *  gets the same honest classification regardless of which path failed. */
async function classifyReadFailure(
  platform: Platform,
  cleanPath: string,
): Promise<ArtifactImageResult> {
  const { dir, name } = splitPath(cleanPath);
  try {
    const entries = await platform.fs.readDir(dir);
    return entries.some((e) => !e.isDir && e.name === name) ? { status: 'unreadable' } : { status: 'missing' };
  } catch {
    return { status: 'missing' };
  }
}

/** Binary-safe attempt (src-tauri's `read_file_base64` — see this module's
 *  header). `null` means "not available or itself failed", not "resolved" —
 *  the caller falls back to the legacy UTF-8 path in that case rather than
 *  treating it as a terminal failure state, since a platform that lacks
 *  this command (the web/Playwright mock) must not be treated as if the
 *  file were unreadable. */
async function tryReadFileBase64(
  platform: Platform,
  cleanPath: string,
): Promise<ArtifactImageResult | null> {
  if (!platform.fs.readFileBase64) return null;
  let base64: string;
  try {
    base64 = await platform.fs.readFileBase64(cleanPath);
  } catch {
    return null;
  }
  // ~5MB inline-size guard, computed on the DECODED byte count a base64
  // string of this length represents (base64 encodes 3 bytes as 4
  // characters, hence * 0.75 = * 3/4) — there is no separate stat call
  // exposed to check size before reading.
  if (base64.length * 0.75 > MAX_INLINE_CHARS) return { status: 'too-large' };
  const mime = EXT_MIME[extOf(cleanPath)] ?? 'image/png';
  return { status: 'ok', dataUri: `data:${mime};base64,${base64}` };
}

/**
 * Resolves a screenshot ProofArtifact's `path` into a renderable data: URI,
 * or an honest failure state. Never throws.
 */
export async function resolveScreenshotSrc(path: string): Promise<ArtifactImageResult> {
  const platform = getPlatform();
  if (!platform?.fs) return { status: 'unreadable' };

  const cleanPath = stripVerbatimPrefix(path);

  const binaryResult = await tryReadFileBase64(platform, cleanPath);
  if (binaryResult) return binaryResult;
  if (platform.fs.readFileBase64) {
    // The command exists but genuinely failed (not just "unavailable on
    // this platform") — resolve the honest missing/unreadable distinction
    // instead of silently falling through to a second, redundant attempt
    // via the legacy UTF-8 path (which would fail identically for a real
    // binary screenshot anyway).
    return classifyReadFailure(platform, cleanPath);
  }

  // Legacy fallback (readFileBase64 unavailable on this platform — e.g. the
  // web/Playwright mock): same UTF-8-only round-trip this module always
  // used before the binary-safe command existed.
  let content: string;
  try {
    content = await platform.fs.readFile(cleanPath);
  } catch {
    return classifyReadFailure(platform, cleanPath);
  }

  if (content.length > MAX_INLINE_CHARS) return { status: 'too-large' };

  try {
    const mime = EXT_MIME[extOf(cleanPath)] ?? 'image/png';
    return { status: 'ok', dataUri: `data:${mime};base64,${toBase64Utf8(content)}` };
  } catch {
    return { status: 'unreadable' };
  }
}
