/* fsErrors.ts — Locale-independent classification of Rust fs-command
   rejections (read_file / read_text_file / read_file_base64, see
   src-tauri/src/commands/fs.rs).

   Extracted from lib/tools/handlers/files.ts's isMissingFileReadError (that
   file keeps using it via this shared export instead of its own private
   copy) — a SECOND independent copy of this classification, in
   lib/agents/orchestratorState.ts, used to match on the English PHRASE
   inside the OS's error message ('cannot find', 'No such file', 'not
   find'). That phrase is what Windows' FormatMessageW localizes — on a
   French-language Windows install `read_file` returns "... Le fichier
   spécifié est introuvable. (os error 2)", which matched NONE of those
   English substrings, so the "this file simply doesn't exist yet" case
   silently fell through to the generic warn-and-return-empty branch on
   every non-English OS. The bug: orchestratorState.ts logged a raw,
   localized, alarming-looking OS error line for the completely ordinary
   case of a fresh project with no `.lazy/orchestrators.json` yet.
*/

/**
 * Whether a `read_file`-family rejection indicates the target simply does
 * not exist (an expected, non-error condition for optional per-project
 * state files) — as opposed to any OTHER failure (permission denied, the
 * 20MB read-ceiling refusal, project-root containment, a project-state lock
 * error, ...) which callers must still surface/log, since silently
 * swallowing those can hide a real problem (e.g. files.ts's write_file
 * undo-snapshot check: overwriting an existing file with no snapshot).
 *
 * Matches the actual Rust error text `read_file`/`read_text_file`/
 * `read_file_base64` can produce for a missing path (see
 * src-tauri/src/commands/fs.rs): `ensure_path_in_project` calls
 * `Path::canonicalize()` on the target BEFORE the command's own
 * `fs::metadata()` call, so for a genuinely-missing file the dominant error
 * is "path canonicalize failed for '<path>': ... (os error 2)" (ENOENT) or
 * "... (os error 3)" (ERROR_PATH_NOT_FOUND, a missing parent dir) — not
 * "metadata failed", which only wraps a rarer race where canonicalize
 * succeeds but a follow-up fs::metadata() call fails (and can just as
 * easily wrap a PERMISSION error, not just ENOENT). The literal
 * "(os error N)" suffix is Rust's own `std::io::Error` Display formatting,
 * NOT OS-localized (only the human-readable phrase before it is) — this is
 * why the check keys off the os-error CODE rather than which of
 * read_file's several error-message prefixes wrapped it, or the localized
 * phrase's exact English wording.
 *
 * The 20MB ceiling refusal ("read_file: '<path>' is <n> bytes, over the
 * <cap> byte read ceiling") deliberately does NOT match: the file exists
 * and is real, just too large to snapshot/read.
 */
export function isMissingFileReadError(err: unknown): boolean {
  const message = String(err).toLowerCase();
  if (message.includes('read ceiling')) return false;
  return (
    message.includes('os error 2') ||
    message.includes('os error 3') ||
    message.includes('cannot find the file') ||
    message.includes('cannot find the path') ||
    message.includes('no such file or directory')
  );
}
