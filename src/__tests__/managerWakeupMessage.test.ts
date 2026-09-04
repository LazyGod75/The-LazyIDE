/**
 * managerWakeupMessage.test.ts — defect C2 (proactive wakeups must be rare
 * and legible).
 *
 * Two independent halves of the fix, both covered here against the REAL
 * shipped fr dictionary (not a reimplementation of the composition rule):
 *   1. classifyWakeupEvent (managerWakeup.ts, covered in its own test file)
 *      now only classifies a gate.passed/gate.failed row as a review
 *      verdict for the judge role — tester/reviewer/security gate events
 *      never reach formatWakeupMessage in the first place.
 *   2. formatWakeupMessage (agentsStore.tsx) must never flatten several
 *      judge verdicts for the SAME mission into a "rejected · rejected ·
 *      rejected · passed" enumeration — it groups them into one readable,
 *      role-mentioning fact instead.
 */
import { describe, it, expect } from 'vitest';
import { formatWakeupMessage, formatWakeupDisplayMessage } from '../components/agents/agentsStore';
import type { WakeupCandidate } from '../lib/agents/managerWakeup';
import { WAKEUP_MARKER_PREFIX } from '../lib/agents/managerWakeup';
import { fr } from '../i18n/locales/fr';

// Mirrors i18n/index.tsx's own `t()` substitution rule exactly (`{key}` →
// param) so this test exercises the real shipped fr copy, not a stand-in.
function t(key: string, params?: Record<string, string | number>): string {
  let str = fr[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return str;
}

describe('formatWakeupMessage — judge-only review verdicts, grouped by mission', () => {
  it('a single judge verdict reads as one plain, role-bearing fact', () => {
    const candidates: WakeupCandidate[] = [
      { kind: 'review_failed', tsMs: 1000, missionId: 'M48', role: 'judge' },
    ];
    const message = formatWakeupMessage(candidates, t);

    expect(message).toContain('juge');
    expect(message).toContain('M48');
    // Exactly one fact — no separator produced for a lone candidate.
    expect(message.split(' · ')).toHaveLength(1);
  });

  it('several judge verdicts for the SAME mission collapse into ONE grouped, readable fact', () => {
    // Real repro shape: a mission gets judged, rejected, auto-retried, and
    // re-judged multiple times before the debounce window settles.
    const candidates: WakeupCandidate[] = [
      { kind: 'review_failed', tsMs: 1000, missionId: 'M48', role: 'judge' },
      { kind: 'review_failed', tsMs: 2000, missionId: 'M48', role: 'judge' },
      { kind: 'review_failed', tsMs: 3000, missionId: 'M48', role: 'judge' },
      { kind: 'review_passed', tsMs: 4000, missionId: 'M48', role: 'judge' },
    ];
    const message = formatWakeupMessage(candidates, t);

    // Never the old flat enumeration of 4 near-identical facts.
    expect(message).not.toContain('rejeté) · ');
    expect(message.split(' · ')).toHaveLength(1);

    // Readable, count-based, mentions the judge role and both outcomes.
    expect(message).toContain('M48');
    expect(message).toContain('3 rejets');
    expect(message).toContain('1 validation');
    expect(message).toContain('juge');
  });

  it('verdicts for DIFFERENT missions still produce one fact per mission, never merged together', () => {
    const candidates: WakeupCandidate[] = [
      { kind: 'review_failed', tsMs: 1000, missionId: 'M48', role: 'judge' },
      { kind: 'review_failed', tsMs: 2000, missionId: 'M48', role: 'judge' },
      { kind: 'review_passed', tsMs: 3000, missionId: 'M50', role: 'judge' },
    ];
    const message = formatWakeupMessage(candidates, t);
    const facts = message.split(' · ');

    // One grouped fact for M48 (2 verdicts) + one plain fact for M50 (1 verdict).
    expect(facts).toHaveLength(2);
    expect(message).toContain('M48');
    expect(message).toContain('M50');
    expect(message).toContain('2 rejets');
  });

  it('a non-review candidate (e.g. merge_landed) is never swept into the review-verdict grouping', () => {
    const candidates: WakeupCandidate[] = [
      { kind: 'merge_landed', tsMs: 1000, missionId: 'M10' },
      { kind: 'review_failed', tsMs: 2000, missionId: 'M48', role: 'judge' },
    ];
    const message = formatWakeupMessage(candidates, t);
    const facts = message.split(' · ');

    expect(facts).toHaveLength(2);
  });
});

// ── displayContent fix (real user report, 2026-08-01 QA): a wakeup turn's
// `content` (what the MODEL receives) must keep the internal "reply in
// French" directive intact, but the human-facing `displayContent`
// (formatWakeupDisplayMessage) must never show it — see
// ManagerMessage.displayContent's own doc comment / LazyManagerMessageList
// .tsx's wakeup-chip rendering. ──
describe('formatWakeupDisplayMessage — same facts as formatWakeupMessage, without the internal LLM directive', () => {
  const candidates: WakeupCandidate[] = [
    { kind: 'review_failed', tsMs: 1000, missionId: 'M60', role: 'judge' },
  ];

  it('keeps the wakeup marker prefix and the facts', () => {
    const display = formatWakeupDisplayMessage(candidates, t);
    expect(display.startsWith(WAKEUP_MARKER_PREFIX)).toBe(true);
    expect(display).toContain('M60');
    expect(display).toContain('juge');
  });

  it('never includes the instruction clause the model-only message ends with', () => {
    const full = formatWakeupMessage(candidates, t);
    const display = formatWakeupDisplayMessage(candidates, t);

    // The full (model-facing) message DOES carry the instruction — sanity
    // check the fixture is actually exercising the thing being stripped.
    expect(full).toContain(t('lazyManager.wakeup.instruction'));
    expect(full).toContain('Réponds en français');

    expect(display).not.toContain(t('lazyManager.wakeup.instruction'));
    expect(display).not.toContain('Réponds en français');
    // The display text is a strict prefix of the full text, minus the
    // " — {instruction}" suffix — never a divergent reformulation.
    expect(full.startsWith(display)).toBe(true);
  });

  it('matches the exact "{marker}{label} : {fact}" composition, with no instruction suffix', () => {
    const label = t('lazyManager.wakeup.label');
    expect(formatWakeupDisplayMessage(candidates, t)).toBe(
      `${WAKEUP_MARKER_PREFIX}${label} : ${t('lazyManager.wakeup.fact.judgeVerdictFailed', { id: 'M60' })}`,
    );
  });
});

// ── LazyBot completion (live QA 2026-09-02): the bot's own report is the
// answer the user asked for — it must be inlined in the wakeup fact so the
// manager can relay it without a query_mission round-trip. ──
describe('formatWakeupMessage — bot_completed carries the bot name and its report', () => {
  it('names the bot, the mission and the report', () => {
    const message = formatWakeupMessage(
      [{ kind: 'bot_completed', tsMs: 1000, missionId: 'M96', botName: 'SolariTest', report: 'Titre : Example Domain' }],
      t,
    );
    expect(message).toContain('SolariTest');
    expect(message).toContain('M96');
    expect(message).toContain('Example Domain');
    expect(message).not.toContain('bot_completed');
  });

  it('never leaves a dangling separator when the bot produced no report', () => {
    const message = formatWakeupMessage([{ kind: 'bot_completed', tsMs: 1000, missionId: 'M97', botName: 'Scraper' }], t);
    expect(message).toContain('Scraper');
    expect(message).not.toMatch(/—\s*—/);
    expect(message).not.toContain('undefined');
  });
});
