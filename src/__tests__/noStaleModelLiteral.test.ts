import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Regression guard for DEFECT #1 (real-app QA): four prod files hardcoded
   the stale, inaccessible model id 'claude-sonnet-4-20250514', which the
   Claude Code CLI subscription path rejects outright — breaking inline-edit
   (Ctrl+K), auto-fix, AI code review, and (cosmetically) the legacy settings
   form. All four now resolve through getActiveModel() (see
   src/lib/models/index.ts) instead of a literal. This test reads the actual
   shipped source so the literal can never quietly return.

   The forbidden id is assembled at runtime (not typed as one contiguous
   string literal) so this file's own full-tree scan below does not flag
   itself. */
const STALE_MODEL_ID = ['claude', 'sonnet', '4', '20250514'].join('-');

const PROD_FILES = [
  'src/components/editor/InlineEditBar.tsx',
  'src/lib/ai/autoFix.ts',
  'src/components/git/AiReview.tsx',
  'src/components/platform/SettingsPanel.tsx',
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

/** Recursively lists .ts/.tsx files under `dir`, skipping test and
 *  dependency directories. */
function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('no stale hardcoded model literal', () => {
  it.each(PROD_FILES)('%s does not contain the stale literal', (relPath) => {
    const content = readFileSync(join(REPO_ROOT, relPath), 'utf-8');
    expect(content).not.toContain(STALE_MODEL_ID);
  });

  it('no file under src/ (excluding tests) contains the stale literal', () => {
    const offenders = listSourceFiles(join(REPO_ROOT, 'src')).filter((file) =>
      readFileSync(file, 'utf-8').includes(STALE_MODEL_ID),
    );
    expect(offenders).toEqual([]);
  });
});
