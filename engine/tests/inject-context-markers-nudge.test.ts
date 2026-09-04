/**
 * Coverage for markers.ts's highlightsRecallNudge — item 4 of the
 * startup-injection spec ("the skill explaining how to use the brain
 * correctly"), scoped to NudgeStyle 'tool' only.
 *
 * 'tool' style is the only caller of `--mode highlights` (LazyManager's
 * startup context, brain_fetch_startup_context in search.rs — verified by
 * grep: no other caller ever passes `--mode highlights`), so this text was
 * rewritten to name LazyManager's REAL action vocabulary — brain_query_css /
 * brain_query (managerCorePrompt.ts) — instead of the brain_search
 * ChatTool / BRAIN_SEARCH: directive, which belongs to a different surface
 * (the assistant chat's ReAct loop) and does not exist for LazyManager.
 *
 * 'skill' and 'none' MUST stay byte-identical to before this change: other
 * callers (the Claude Code plugin path, which never passes --nudge and so
 * gets the 'skill' default) depend on the exact original wording.
 */
import { describe, expect, it } from 'vitest';
import { highlightsRecallNudge } from '../src/commands/inject-context/markers.js';

describe('highlightsRecallNudge', () => {
  it("'skill' style is byte-identical to its original wording", () => {
    expect(highlightsRecallNudge('skill')).toBe(
      '\n[RECALL] For any question about prior work or "how is X built": INVOKE the lazybrain-recall skill (Skill tool) before answering. CLI fallback: `lazybrain search "<topic>" --top 5`',
    );
  });

  it("'none' style is byte-identical (empty string) to its original behavior", () => {
    expect(highlightsRecallNudge('none')).toBe('');
  });

  it("'tool' style names brain_query_css / brain_query — LazyManager's real actions", () => {
    const text = highlightsRecallNudge('tool');
    expect(text).toContain('brain_query_css');
    expect(text).toContain('brain_query');
    expect(text).toContain('[TAGS]');
  });

  it("'tool' style no longer references the nonexistent brain_search tool / BRAIN_SEARCH directive", () => {
    const text = highlightsRecallNudge('tool');
    expect(text).not.toContain('brain_search');
    expect(text).not.toContain('BRAIN_SEARCH');
  });

  it("'tool' style tells the model not to re-query what is already injected", () => {
    expect(highlightsRecallNudge('tool')).toMatch(/do not re-query/i);
  });
});
