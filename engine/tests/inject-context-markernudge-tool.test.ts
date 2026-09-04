/**
 * Coverage for markers.ts's markerNudge — the `[BRAIN] N notes available.`
 * marker line's trailing action-clause, used by BOTH `--mode marker` and
 * `--mode highlights`.
 *
 * `--nudge tool` is used by exactly one caller for `--mode highlights`:
 * LazyManager's startup context (`brain_fetch_startup_context`, search.rs) —
 * see highlightsRecallNudge's doc comment for the verified single-caller
 * claim, which applies identically here since both nudge formatters are
 * driven by the same `--nudge` flag on the same command. commit b0fef98
 * already corrected `highlightsRecallNudge('tool')` to stop naming a
 * `brain_search` tool this caller does not have; `markerNudge('tool')` had
 * the exact same inaccuracy and was missed — this is that follow-up fix
 * (2026-08-16).
 *
 * 'skill' and 'none' MUST stay byte-identical to before this change: other
 * callers (the Claude Code plugin path, `--mode marker` with no `--nudge`
 * flag, defaulting to 'skill') depend on the exact original wording.
 */
import { describe, expect, it } from 'vitest';
import { markerNudge } from '../src/commands/inject-context/markers.js';

describe('markerNudge', () => {
  it("'skill' style is byte-identical to its original wording", () => {
    expect(markerNudge('skill')).toBe(
      ' INVOKE the lazybrain-recall skill (Skill tool) before answering questions about prior work. CLI fallback: `lazybrain search <query>` / `lazybrain query #<id>`.',
    );
  });

  it("'none' style is byte-identical (empty string) to its original behavior", () => {
    expect(markerNudge('none')).toBe('');
  });

  it("'tool' style names brain_query_css / brain_query — LazyManager's real actions", () => {
    const text = markerNudge('tool');
    expect(text).toContain('brain_query_css');
    expect(text).toContain('brain_query');
  });

  it("'tool' style no longer references the nonexistent brain_search tool / BRAIN_SEARCH directive", () => {
    const text = markerNudge('tool');
    expect(text).not.toContain('brain_search');
    expect(text).not.toContain('BRAIN_SEARCH');
  });

  it("'tool' style does not reference the Skill tool / lazybrain-recall (LazyManager has neither)", () => {
    const text = markerNudge('tool');
    expect(text).not.toMatch(/lazybrain-recall/i);
    expect(text).not.toMatch(/Skill tool/);
  });
});
