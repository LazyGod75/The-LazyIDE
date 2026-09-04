/* fsErrors.test.ts — isMissingFileReadError must classify by the
   locale-independent "(os error N)" code Rust's std::io::Error Display
   impl always appends, never by the human-readable phrase before it (that
   phrase is OS-localized — see fsErrors.ts's module doc comment for the
   real production bug this guards against: a French-Windows "Le fichier
   spécifié est introuvable." message that no English substring matched). */

import { describe, it, expect } from 'vitest';
import { isMissingFileReadError } from '../lib/fsErrors';

describe('isMissingFileReadError', () => {
  it('matches an English "file not found" (os error 2) message', () => {
    expect(
      isMissingFileReadError(
        new Error("read_file: metadata failed for 'C:\\x\\orchestrators.json': The system cannot find the file specified. (os error 2)"),
      ),
    ).toBe(true);
  });

  it('matches a French-localized "file not found" (os error 2) message — the real reported bug', () => {
    expect(
      isMissingFileReadError(
        new Error("read_file: metadata failed for 'C:\\x\\orchestrators.json': Le fichier spécifié est introuvable. (os error 2)"),
      ),
    ).toBe(true);
  });

  it('matches a missing-parent-directory (os error 3) message in any language', () => {
    expect(
      isMissingFileReadError(
        new Error("path canonicalize failed for 'C:\\x\\orchestrators.json': Le chemin d’accès spécifié est introuvable. (os error 3)"),
      ),
    ).toBe(true);
  });

  it('matches a raw string rejection (not wrapped in an Error), same as a Tauri invoke() rejection', () => {
    expect(isMissingFileReadError("read_file: metadata failed for 'x': not found (os error 2)")).toBe(true);
  });

  it('is case-insensitive on the os-error marker', () => {
    expect(isMissingFileReadError('Something failed (OS ERROR 2)')).toBe(true);
  });

  it('does NOT match a permission-denied failure (os error 5)', () => {
    expect(isMissingFileReadError(new Error('read_file failed: access is denied (os error 5)'))).toBe(false);
  });

  it('does NOT match the 20MB read-ceiling refusal, even though it can co-occur with path text', () => {
    expect(
      isMissingFileReadError(new Error("read_file: 'C:\\x\\big.log' is 30000000 bytes, over the 20000000 byte read ceiling")),
    ).toBe(false);
  });

  it('does NOT match an unrelated project-root containment error', () => {
    expect(
      isMissingFileReadError(new Error("access denied: 'C:\\x' is outside every registered project root (2 checked)")),
    ).toBe(false);
  });
});
