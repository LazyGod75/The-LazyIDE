/**
 * missionScopeGuard.test.ts — pure unit tests for findOutOfScopeTaskPath
 * (see missionScopeGuard.ts's own header for the full rationale: a mission
 * task naming an absolute Windows path OUTSIDE the resolved project root
 * used to launch silently against the WRONG cwd/brain — real LazyManager
 * QA gap, 2026-08-01).
 */
import { describe, it, expect } from 'vitest';
import { findOutOfScopeTaskPath, extractTaskAbsolutePaths } from '../missionScopeGuard';
import { UPSTREAM_GRAPH_INPUTS_HEADER } from '../graph/dataPlane';
import { BRAIN_RECALL_HEADER } from '../graph/brainBus';

describe('findOutOfScopeTaskPath', () => {
  it('flags a task naming a sibling project outside the active root (the real repro)', () => {
    const result = findOutOfScopeTaskPath(
      'Finish the project at C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON — add the missing export.',
      'C:\\Users\\user\\Documents\\cerveau\\LazySite-internet',
    );
    expect(result).not.toBeNull();
    expect(result?.mentionedPath).toBe('C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON');
    expect(result?.activeRoot).toBe('C:\\Users\\user\\Documents\\cerveau\\LazySite-internet');
  });

  it('returns null when the task has no absolute path at all', () => {
    expect(findOutOfScopeTaskPath('Fix the typo in the README', 'C:\\Users\\user\\Documents\\cerveau\\Lazy')).toBeNull();
  });

  it('returns null when the mentioned path IS the active root', () => {
    const root = 'C:\\Users\\user\\Documents\\cerveau\\Lazy';
    expect(findOutOfScopeTaskPath(`Work in ${root} on the README`, root)).toBeNull();
  });

  it('returns null when the mentioned path is a DESCENDANT of the active root', () => {
    expect(
      findOutOfScopeTaskPath(
        'Edit C:\\Users\\user\\Documents\\cerveau\\Lazy\\src\\components\\App.tsx',
        'C:\\Users\\user\\Documents\\cerveau\\Lazy',
      ),
    ).toBeNull();
  });

  it('returns null when the mentioned path is an ANCESTOR of the active root', () => {
    expect(
      findOutOfScopeTaskPath(
        'Look at C:\\Users\\user\\Documents for context',
        'C:\\Users\\user\\Documents\\cerveau\\Lazy',
      ),
    ).toBeNull();
  });

  it('is case-insensitive and separator-tolerant (Windows semantics)', () => {
    const result = findOutOfScopeTaskPath(
      'Finish c:/USERS/David/Documents/GameOn/BackOfficeGameON please',
      'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result).not.toBeNull();
  });

  it('ignores a shallow mention (drive + 1 segment) as too generic', () => {
    expect(findOutOfScopeTaskPath('Check C:\\Windows for reference', 'C:\\Users\\user\\Documents\\cerveau\\Lazy')).toBeNull();
  });

  it('strips trailing sentence punctuation before comparing', () => {
    const result = findOutOfScopeTaskPath(
      'The other project lives at C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON.',
      'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result?.mentionedPath).toBe('C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON');
  });

  it('never scans POSIX-style single-leading-slash paths (deliberate precision tradeoff — see header)', () => {
    expect(
      findOutOfScopeTaskPath('Fix the /api/users route and the /docs page', 'C:\\Users\\user\\Documents\\cerveau\\Lazy'),
    ).toBeNull();
  });

  it('returns null when activeRoot is unresolved ("." fallback)', () => {
    expect(
      findOutOfScopeTaskPath('Finish C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON', '.'),
    ).toBeNull();
  });

  it('returns null when activeRoot is empty/undefined', () => {
    expect(findOutOfScopeTaskPath('Finish C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON', '')).toBeNull();
    expect(findOutOfScopeTaskPath('Finish C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON', undefined)).toBeNull();
  });

  it('returns null when taskText is empty/undefined', () => {
    expect(findOutOfScopeTaskPath('', 'C:\\Users\\user\\Documents\\cerveau\\Lazy')).toBeNull();
    expect(findOutOfScopeTaskPath(undefined, 'C:\\Users\\user\\Documents\\cerveau\\Lazy')).toBeNull();
  });

  it('handles a verbatim-prefixed (\\\\?\\) active root the same as its unprefixed form', () => {
    const result = findOutOfScopeTaskPath(
      'Finish C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON',
      '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result).not.toBeNull();
    expect(result?.mentionedPath).toBe('C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON');
  });

  it('finds the first out-of-scope path when multiple are mentioned', () => {
    const result = findOutOfScopeTaskPath(
      'Compare C:\\Users\\user\\Documents\\cerveau\\Lazy with C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON',
      'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result?.mentionedPath).toBe('C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON');
  });

  // 2026-08-02 false-positive fix (missions M4/M5) ---------------------------

  it('allows a verbatim-prefixed root against a plain, differently-cased, same-directory task path', () => {
    // The exact repro shape: activeRoot is Rust canonicalize() output
    // (verbatim-prefixed), the task path is plain with a lowercase drive
    // letter. Same directory — must be allowed.
    const result = findOutOfScopeTaskPath(
      'Finish the schema work in c:\\Users\\user\\Documents\\cerveau\\lazy-backoffice',
      '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\lazy-backoffice',
    );
    expect(result).toBeNull();
  });

  it('allows a same-directory match differing only by drive-letter case', () => {
    const result = findOutOfScopeTaskPath(
      'Work in c:\\Users\\user\\Documents\\cerveau\\Lazy on the README',
      'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result).toBeNull();
  });

  it('allows a same-directory match with forward slashes on one side', () => {
    const result = findOutOfScopeTaskPath(
      'Work in C:/Users/user/Documents/cerveau/Lazy on the README',
      'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result).toBeNull();
  });

  it('still refuses a genuinely different project (sanity check the above did not weaken the guard)', () => {
    const result = findOutOfScopeTaskPath(
      'Finish the project at C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON',
      'C:\\Users\\user\\Documents\\cerveau\\lazy-backoffice',
    );
    expect(result).not.toBeNull();
  });

  it('still refuses a sibling directory sharing a name PREFIX (…\\Lazy vs …\\LazySite-internet — the exact trap that bit us)', () => {
    const result = findOutOfScopeTaskPath(
      'Port the header component from C:\\Users\\user\\Documents\\cerveau\\LazySite-internet\\src\\Header.tsx',
      'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result).not.toBeNull();
    expect(result?.mentionedPath).toContain('LazySite-internet');
  });

  it('ignores a truncated path inside an auto-injected "Upstream graph inputs" block (real repro: JSON containing an unrelated absolute path)', () => {
    const taskText = [
      'Consolider la base de code dans lazy-backoffice.',
      '',
      UPSTREAM_GRAPH_INPUTS_HEADER,
      '```json',
      '{ "merge-scaffold": { "text": "See C:\\\\Users\\\\user\\\\Documents\\\\GameOn\\\\BackOfficeGameON for reference" } }',
      '```',
    ].join('\n');
    const result = findOutOfScopeTaskPath(taskText, 'C:\\Users\\user\\Documents\\cerveau\\lazy-backoffice');
    expect(result).toBeNull();
  });

  it('ignores a path truncated mid-segment inside an auto-injected "Brain recall" block (the exact M4/M5 repro)', () => {
    // formatRecallBlock (brainBus.ts) hard-truncates note snippets to 200
    // chars, which can cut a path off mid-word — here "lazy-backoffice"
    // truncated to "lazy-backo". That truncated text is a strict TEXT
    // prefix of the active root's last segment but NOT a path ancestor (no
    // separator boundary), so before this fix it read as a different,
    // out-of-scope project and blocked a mission that correctly named no
    // path outside the active project at all.
    const taskText = [
      "Concevoir et appliquer le schema Supabase pour le backoffice.",
      '',
      BRAIN_RECALL_HEADER,
      '- [notes] outcome-queued-consolider-la-base-de-code',
      '  Project: c:\\Users\\user\\Documents\\cerveau\\lazy-backo',
      'Use these only if relevant; prefer repo truth over memory.',
    ].join('\n');
    const result = findOutOfScopeTaskPath(
      taskText,
      '\\\\?\\C:\\Users\\user\\Documents\\cerveau\\lazy-backoffice',
    );
    expect(result).toBeNull();
  });

  it('still flags a genuinely out-of-scope path mentioned BEFORE any injected context block', () => {
    const taskText = [
      'Finish C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON please.',
      '',
      BRAIN_RECALL_HEADER,
      '- [notes] unrelated note',
    ].join('\n');
    const result = findOutOfScopeTaskPath(taskText, 'C:\\Users\\user\\Documents\\cerveau\\Lazy');
    expect(result).not.toBeNull();
    expect(result?.mentionedPath).toBe('C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON');
  });

  // URL false-positive fix (2026-08-04, real repro) -------------------------
  // The drive-letter regex only requires ONE letter before ":\" or ":/" —
  // "http://localhost:3000/game/index.html" used to be misread starting at
  // its scheme's own last letter ("p://localhost:3000/...") and refused as
  // an out-of-scope path.

  it('never flags a task naming a plain http://localhost URL (the real repro)', () => {
    const result = findOutOfScopeTaskPath(
      'Open http://localhost:3000/game/index.html and check the score screen.',
      'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result).toBeNull();
  });

  it('never flags a task naming an https:// URL with a deep path', () => {
    const result = findOutOfScopeTaskPath(
      'Fetch https://example.com/docs/api/reference.html for the schema.',
      'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result).toBeNull();
  });

  it('still flags a genuine out-of-scope Windows path mentioned ALONGSIDE a URL (URL never masks the real path)', () => {
    const result = findOutOfScopeTaskPath(
      'Compare http://localhost:3000/game/index.html with the reference implementation at C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON.',
      'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result).not.toBeNull();
    expect(result?.mentionedPath).toBe('C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON');
  });

  it('never flags a task naming ONLY a URL and an in-scope path (no false positive from either)', () => {
    const result = findOutOfScopeTaskPath(
      'Open http://localhost:3000/game/index.html and update C:\\Users\\user\\Documents\\cerveau\\Lazy\\src\\App.tsx.',
      'C:\\Users\\user\\Documents\\cerveau\\Lazy',
    );
    expect(result).toBeNull();
  });

  it('extractTaskAbsolutePaths never returns a URL mention (same masking, the mention-listing sibling of findOutOfScopeTaskPath)', () => {
    const paths = extractTaskAbsolutePaths(
      'Open http://localhost:3000/game/index.html then edit C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON\\index.ts.',
    );
    expect(paths).toEqual(['C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON\\index.ts']);
  });

  // Extra-readable-roots fix (2026-08-18, real repro: M66/M67/M68, a
  // 12-step Lazy-Docs plan every step of which declared
  // extraReadableProjectIds: ["Lazy"] and was blocked anyway) -------------

  describe('extraReadableRoots', () => {
    const lazyDocsRoot = 'C:\\Users\\user\\Documents\\cerveau\\Lazy-Docs';
    const lazyRoot = 'C:\\Users\\user\\Documents\\cerveau\\Lazy';
    const thirdProjectRoot = 'C:\\Users\\user\\Documents\\GameOn\\BackOfficeGameON';

    it('does NOT flag a task path that lies under a declared extra readable root', () => {
      const result = findOutOfScopeTaskPath(
        'Lire directement sur disque l\'arbre reel de C:\\Users\\user\\Documents\\cerveau\\Lazy\\src et documenter.',
        lazyDocsRoot,
        [lazyRoot],
      );
      expect(result).toBeNull();
    });

    it('still flags the exact same task text as out of scope when NO extra readable roots are declared', () => {
      const result = findOutOfScopeTaskPath(
        'Lire directement sur disque l\'arbre reel de C:\\Users\\user\\Documents\\cerveau\\Lazy\\src et documenter.',
        lazyDocsRoot,
        // no third argument at all — matches today's call shape
      );
      expect(result).not.toBeNull();
      expect(result?.mentionedPath).toBe('C:\\Users\\user\\Documents\\cerveau\\Lazy\\src');
    });

    it('still flags the same task text as out of scope when extraReadableRoots is an empty array', () => {
      const result = findOutOfScopeTaskPath(
        'Lire directement sur disque l\'arbre reel de C:\\Users\\user\\Documents\\cerveau\\Lazy\\src et documenter.',
        lazyDocsRoot,
        [],
      );
      expect(result).not.toBeNull();
    });

    it('still flags a mention in a THIRD, undeclared project even when a DIFFERENT extra root is declared', () => {
      const result = findOutOfScopeTaskPath(
        `Compare with the approach at ${thirdProjectRoot}\\src\\index.ts`,
        lazyDocsRoot,
        [lazyRoot],
      );
      expect(result).not.toBeNull();
      expect(result?.mentionedPath).toBe(`${thirdProjectRoot}\\src\\index.ts`);
    });

    it('exempts the mentioned path itself when it IS the declared extra root (not just a descendant)', () => {
      const result = findOutOfScopeTaskPath(`Read ${lazyRoot} for reference.`, lazyDocsRoot, [lazyRoot]);
      expect(result).toBeNull();
    });

    it('does NOT exempt a mention that is only an ANCESTOR of a declared extra root (narrower grant than what was named)', () => {
      // Declared root is thirdProjectRoot ("...\\GameOn\\BackOfficeGameON");
      // the task instead names the broader parent "...\\GameOn" — naming
      // more than what was granted must still be refused (see
      // missionScopeGuard.ts header: directional on purpose, not
      // bidirectional like the activeRoot check). The mentioned path is
      // also unrelated to activeRoot (lazyDocsRoot, under \\cerveau), so
      // the pre-existing activeRoot ancestor/descendant check cannot be
      // what accidentally exempts it either.
      const result = findOutOfScopeTaskPath(
        'Look at C:\\Users\\user\\Documents\\GameOn for context',
        lazyDocsRoot,
        [thirdProjectRoot],
      );
      expect(result).not.toBeNull();
    });

    it('is case-insensitive and separator-tolerant for extra readable roots too', () => {
      const result = findOutOfScopeTaskPath(
        'Read c:/USERS/David/Documents/cerveau/Lazy/src/App.tsx for reference.',
        lazyDocsRoot,
        [lazyRoot],
      );
      expect(result).toBeNull();
    });

    it('never lets a declared extra root widen scope for an activeRoot mismatch that is genuinely unrelated', () => {
      // Sanity: declaring an extra root must never accidentally exempt a
      // mention that shares no relation with either root.
      const result = findOutOfScopeTaskPath(
        'Finish the work at C:\\Users\\user\\Documents\\GameOn\\Other\\index.ts',
        lazyDocsRoot,
        [lazyRoot],
      );
      expect(result).not.toBeNull();
    });
  });
});
