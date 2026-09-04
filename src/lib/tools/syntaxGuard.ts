/* syntaxGuard — reject-before-write.

   Tree-sitter check on candidate content BEFORE persist. Stronger than
   write-then-revert: no window where a broken file can be read by a
   concurrent tool. SWE-agent ablation (arXiv:2405.15793, SWE-bench Lite):
   skipping this guardrail costs -3.0 points (18.0% -> 15.0%).
*/

import { checkSyntax } from '../codegraph/treeSitterScanner.js';

/** WASM grammar fetch stalling must never stall a mission indefinitely. */
const SYNTAX_CHECK_TIMEOUT_MS = 4000;

type TimedOutCheck = { supported: false; ok: true; errors: never[] };

export async function rejectIfSyntaxBroken(relPath: string, content: string): Promise<string | null> {
  try {
    const result = await Promise.race([
      checkSyntax(relPath, content),
      new Promise<TimedOutCheck>((resolve) =>
        setTimeout(() => resolve({ supported: false, ok: true, errors: [] }), SYNTAX_CHECK_TIMEOUT_MS),
      ),
    ]);
    if (result.supported && !result.ok) {
      const details = result.errors.map((e) => `  line ${e.line}: ${e.snippet}`).join('\n');
      return `ERROR: edit REJECTED — syntax error detected, ${relPath} was NOT modified.\n${details}\nFix the code and try again.`;
    }
  } catch {
    // Best-effort — never block a write we cannot validate.
  }
  return null;
}
