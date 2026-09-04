/* managedAgentDedup — V5 identical-call dedup for the managed agent loop.

   Extracted from managedAgent.ts to keep that file under the project's
   800-line ceiling (same rationale as managedAgentPolicy.ts's own header
   comment: "Extracted from managedAgent.ts to keep that file under the
   project's 800-line ceiling — a pure code-organization split, no behavior
   change").

   Real-app QA: a managed agent mission re-read the same file 4 times in a
   row with identical args (same path, same start_line/end_line), burning 4
   of MAX_STEPS=20 with zero progress. Mirrors assistantToolLoop.ts's
   searchedQueries dedup for the assistant chat surface (same idea — track
   what has already been asked for, nudge instead of repeating — applied
   here to the managed agent's tool calls instead of brain/web directives).
*/

/** Tool names whose result is a deterministic function of (tool, args,
 *  current file/code state): repeating an IDENTICAL call within the same
 *  mission gives the model no new information and is a reliable stuck-loop
 *  signal. Deliberately EXCLUDES anything whose result can legitimately
 *  differ between two identical-looking calls — run_command/run_tests/
 *  run_build/git_status/git_diff (the agent's own prior writes may have
 *  changed what they'd report — side-effectful/state-reading), every
 *  write/mutating tool, and brain/web/LSP tools (brain and web results can
 *  change independently of this mission's own edits; LSP results depend on
 *  live server state). Only the plain file/code read-only navigation
 *  cluster is deduped. */
export const DEDUPE_ELIGIBLE_TOOLS = new Set([
  'read_file',
  'read_dir',
  'find_file',
  'glob',
  'grep_file',
  'search_code',
  'search_symbols',
]);

/** Stable JSON serialization of tool args for the dedup key: sorts object
 *  keys (recursively; arrays keep their element order) so two
 *  semantically-identical ARGS payloads with a different key order still
 *  hash to the same string. */
export function canonicalizeToolArgs(args: Record<string, unknown>): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
      const entries = Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])] as const);
      return Object.fromEntries(entries);
    }
    return value;
  };
  return JSON.stringify(sortKeys(args));
}

/** Builds the "toolName:canonicalArgs" dedup key for `action`/`args`, or
 *  `null` when `action` is not in DEDUPE_ELIGIBLE_TOOLS — exempt tools are
 *  never tracked, so a caller should skip the dedup lookup entirely for a
 *  `null` key. */
export function dedupKeyFor(action: string, args: Record<string, unknown>): string | null {
  return DEDUPE_ELIGIBLE_TOOLS.has(action) ? `${action}:${canonicalizeToolArgs(args)}` : null;
}

/** The nudge observation fed back to the model in place of re-executing an
 *  identical call. `firstStep` is the 1-based step the call first actually
 *  ran at (matches the `[${step + 1}] ...` numbering already used in the
 *  loop's onAction timeline text), so the model can see exactly which prior
 *  observation still answers its question. */
export function dedupNudgeObservation(firstStep: number): string {
  return `You already ran this exact call at step ${firstStep} — its result has not changed. Do not repeat calls; act on the information you have (write files with write_file/edit_file, or finish).`;
}
