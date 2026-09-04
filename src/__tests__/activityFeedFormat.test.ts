/**
 * Tests for activityFeedFormat.ts's humanizeActivityItem/buildFeedEntries/
 * buildActivityTicker — F3 fix (post-e2e fix wave): the FLUX footer used to
 * render the raw (often truncated) payload_preview JSON verbatim, e.g.
 * `M9 {"mission":{"id":"M9","title":"QA pricing — tests unitaires",
 * "status":"running","createdAt":1783807078305,"model...`.
 *
 * Sweep #7 / audit P07 fix: timestamps must never be re-derived at render
 * time (only `item.ts_ms` — see makeItem's default and the dedicated test
 * below), consecutive identical rows must dedupe, and every event_type in
 * eventTypes.ts's vocabulary must resolve to a real human label in every
 * locale — not the raw dotted type string, not the composed i18n key.
 *
 * `translateFrom` below mirrors i18n/index.tsx's own `t()` exactly (dict
 * lookup + `{param}` interpolation) against the REAL locale dictionaries —
 * so these tests double as an audit that every key this module looks up
 * actually exists in fr/en, not just that some mock returns a string.
 */

import { describe, it, expect } from 'vitest';
import {
  humanizeActivityItem,
  buildActivityTicker,
  buildFeedEntries,
  type Translate,
} from '../lib/journal/activityFeedFormat';
import type { ActivityFeedItem } from '../lib/journal/projections';
import { JOURNAL_EVENT_TYPES } from '../lib/journal/journalEventTypeList';
import { fr } from '../i18n/locales/fr';
import { en } from '../i18n/locales/en';
import { es } from '../i18n/locales/es';
import { zh } from '../i18n/locales/zh';
import { de } from '../i18n/locales/de';
import { ja } from '../i18n/locales/ja';
import type { Locale } from '../i18n/types';

function translateFrom(dict: Record<string, string>): Translate {
  return (key, params) => {
    let str = dict[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }
    return str;
  };
}

const t = translateFrom(fr);

/** All 6 locale dictionaries, keyed by Locale — see the exhaustive
 *  `feed.eventType.*` coverage check below (`JOURNAL_EVENT_TYPES` ×
 *  `ALL_LOCALE_DICTS`), which supersedes this file's old hand-maintained
 *  `previouslyUncoveredTypes` array (fr/en only, and easy to forget to
 *  update — six real event types slipped through it: agent.message_read,
 *  loop.stopped, scheduler.stalled, scheduler.throttled, tools.context,
 *  frontend.error). */
const ALL_LOCALE_DICTS: Record<Locale, Record<string, string>> = { fr, en, es, zh, de, ja };

function makeItem(overrides: Partial<ActivityFeedItem> & { event_type: string }): ActivityFeedItem {
  return {
    seq: 1,
    ts_ms: Date.UTC(2026, 6, 11, 0, 4, 0),
    project_id: 'demo-shop',
    mission_id: null,
    actor: 'agent',
    payload_preview: '{}',
    ...overrides,
  };
}

describe('humanizeActivityItem', () => {
  it('renders a mission snapshot event as "HH:MM <id> · <status> · <title>", never raw JSON', () => {
    const item = makeItem({
      event_type: 'mission.updated',
      mission_id: 'M9',
      payload_preview: '{"mission":{"id":"M9","title":"QA pricing — tests unitaires","status":"running","createdAt":1783807078305,"model":"sonnet"}}',
    });
    const line = humanizeActivityItem(item, t);
    expect(line).not.toContain('{');
    expect(line).not.toContain('}');
    expect(line).not.toContain('createdAt');
    expect(line).toContain('M9');
    expect(line).toContain('running');
    expect(line).toContain('QA pricing — tests unitaires');
    expect(line).toMatch(/^\d{2}:\d{2} /);
  });

  it('renders a project.opened event as "HH:MM projet ouvert · <basename>", never the full path', () => {
    const item = makeItem({
      event_type: 'project.opened',
      payload_preview: '{"root":"C:\\\\Users\\\\David\\\\Documents\\\\cerveau\\\\LazySite-internet"}',
    });
    const line = humanizeActivityItem(item, t);
    expect(line).not.toContain('{');
    expect(line).not.toContain('C:\\Users');
    expect(line).toContain('projet ouvert');
    expect(line).toContain('LazySite-internet');
  });

  it('falls back to the humanized event type + mission id when the payload is truncated/unparsable', () => {
    const item = makeItem({
      event_type: 'mission.step',
      mission_id: 'M9',
      payload_preview: '{"text":"Bash: Bash {\\"command":"node --te', // truncated mid-JSON
    });
    const line = humanizeActivityItem(item, t);
    expect(line).not.toContain('{');
    expect(line).toContain('M9');
    expect(line).toMatch(/^\d{2}:\d{2} /);
  });

  it('falls back to the humanized event type alone when there is no mission id and no recognized payload shape', () => {
    const item = makeItem({ event_type: 'brain.recalled', payload_preview: '{"query":"auth flow","nodeIds":["n1"]}' });
    const line = humanizeActivityItem(item, t);
    expect(line).not.toContain('{');
    expect(line.toLowerCase()).toContain('brain');
  });

  it('never throws on a malformed payload_preview', () => {
    const item = makeItem({ event_type: 'tool.called', payload_preview: 'not json at all {{{' });
    expect(() => humanizeActivityItem(item, t)).not.toThrow();
    expect(humanizeActivityItem(item, t)).not.toContain('{{{');
  });

  // ── W-MODES-ui safety legibility — auto-merge FLUX line ───────────────
  it('renders a mission.approved event with actor:"auto" as "<id> mergée automatiquement (auto)"', () => {
    const item = makeItem({
      event_type: 'mission.approved',
      mission_id: 'M42',
      payload_preview: '{"actor":"auto","mode":"auto_green"}',
    });
    const line = humanizeActivityItem(item, t);
    expect(line).toContain('M42');
    expect(line).toContain('mergée automatiquement');
    expect(line).toContain('(auto)');
    expect(line).not.toContain('{');
  });

  it('renders an ordinary human mission.approved event (no actor field) as the plain "approuvée" label, never "(auto)"', () => {
    const item = makeItem({
      event_type: 'mission.approved',
      mission_id: 'M43',
      payload_preview: '{}',
    });
    const line = humanizeActivityItem(item, t);
    expect(line).toContain('M43');
    expect(line).not.toContain('(auto)');
    expect(line.toLowerCase()).toContain('approuvée');
  });

  // ── P58 (automatic fleet hygiene) ─────────────────────────────────────
  it('renders a fleet.hygiene event with real counts, never raw JSON', () => {
    const item = makeItem({
      event_type: 'fleet.hygiene',
      mission_id: null,
      payload_preview: '{"archived":3,"purged":2,"deduped":1}',
    });
    const line = humanizeActivityItem(item, t);
    expect(line.toLowerCase()).toContain('hygiène');
    expect(line).toContain('3');
    expect(line).toContain('2');
    expect(line).toContain('1');
    expect(line).not.toContain('{');
  });

  it('falls back to the generic fleet.hygiene label when the payload is missing/malformed, never raw JSON', () => {
    const item = makeItem({ event_type: 'fleet.hygiene', mission_id: null, payload_preview: '{}' });
    const line = humanizeActivityItem(item, t);
    expect(line).not.toContain('{');
    expect(line).not.toContain('feed.eventType.fleet.hygiene');
  });

  // ── In-place WebView2 crash recovery ───────────────────────────────────
  describe('app.recovered — in-place WebView2 recovery', () => {
    it('renders mode:"in_place" as the friendly "display restored" line, never raw JSON', () => {
      const item = makeItem({ event_type: 'app.recovered', mission_id: null, payload_preview: '{"mode":"in_place"}' });
      const line = humanizeActivityItem(item, t);
      expect(line.toLowerCase()).toContain('rétabli');
      expect(line).not.toContain('{');
      expect(line).toMatch(/^\d{2}:\d{2} /);
    });

    it('renders mode:"restart" as a distinct, honest "app restarted" line, never the in-place message', () => {
      const item = makeItem({ event_type: 'app.recovered', mission_id: null, payload_preview: '{"mode":"restart"}' });
      const line = humanizeActivityItem(item, t);
      expect(line.toLowerCase()).toContain('redémarré');
      expect(line).not.toContain('{');
    });

    it('falls back to the generic label when the payload is missing/malformed, never raw JSON', () => {
      const item = makeItem({ event_type: 'app.recovered', mission_id: null, payload_preview: '{}' });
      const line = humanizeActivityItem(item, t);
      expect(line).not.toContain('{');
      expect(line).not.toContain('feed.eventType.app.recovered');
    });
  });

  // ── Sweep #7 / audit P07 fix — timestamps NEVER re-stamped ────────────
  describe('timestamps are preserved from the journal, never re-derived at render time', () => {
    it('derives HH:MM strictly from the item\'s own (old) ts_ms, not from "now"', () => {
      const oldMs = Date.UTC(2020, 0, 1, 10, 30, 0); // long in the past
      const item = makeItem({ event_type: 'mission.started', mission_id: 'M1', ts_ms: oldMs, payload_preview: '{}' });
      const line = humanizeActivityItem(item, t);
      const d = new Date(oldMs);
      const expectedTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      expect(line.startsWith(expectedTime)).toBe(true);
    });

    it('two items with different ts_ms render different HH:MM prefixes, never collapsing to one "boot time"', () => {
      const early = makeItem({ event_type: 'mission.started', mission_id: 'M1', ts_ms: Date.UTC(2026, 0, 1, 9, 0, 0) });
      const late = makeItem({ event_type: 'mission.started', mission_id: 'M2', ts_ms: Date.UTC(2026, 0, 1, 21, 48, 0) });
      const earlyLine = humanizeActivityItem(early, t);
      const lateLine = humanizeActivityItem(late, t);
      expect(earlyLine.slice(0, 5)).not.toBe(lateLine.slice(0, 5));
    });
  });

  // ── Sweep #7 / audit P07 fix — truncation recovery ────────────────────
  describe('mission snapshot truncation recovery', () => {
    it('recovers status/title from a mid-object truncated mission.updated payload instead of the bare "mission" fallback', () => {
      const item = makeItem({
        event_type: 'mission.updated',
        mission_id: 'M9',
        // Truncated exactly like the Rust 200-char preview cap would do —
        // status/title both survive, the rest (createdAt, model...) is cut.
        payload_preview: '{"mission":{"id":"M9","title":"QA pricing — tests unitaires","status":"running","createdAt":178',
      });
      const line = humanizeActivityItem(item, t);
      expect(line).not.toContain('{');
      expect(line).toContain('M9');
      expect(line).toContain('running');
      expect(line).toContain('QA pricing — tests unitaires');
    });

    it('still shows at least the mission id, never raw JSON, when truncation cuts before status/title ever appear', () => {
      const item = makeItem({
        event_type: 'mission.updated',
        mission_id: 'M9',
        payload_preview: '{"mission":{"id":"M9"', // cut before status/title
      });
      const line = humanizeActivityItem(item, t);
      expect(line).not.toContain('{');
      expect(line).toContain('M9');
    });

    it('falls back to the generic event-type label when there is no mission id at all and nothing recoverable', () => {
      const item = makeItem({
        event_type: 'mission.updated',
        mission_id: null,
        payload_preview: '{"mission":{"unrelatedField":"x"', // truncated, no id/status/title
      });
      const line = humanizeActivityItem(item, t);
      expect(line).not.toContain('{');
      expect(line.toLowerCase()).toContain('mission');
    });
  });

  // ── Sweep #7 / audit P07 fix — loop iteration detail ──────────────────
  describe('loop.tick / loop.iteration render the real iteration number', () => {
    it('renders loop.tick as "Mission <id> — itération <n>" instead of the opaque "loop" label', () => {
      const item = makeItem({
        event_type: 'loop.tick',
        mission_id: 'M28',
        payload_preview: '{"iteration":3}',
      });
      const line = humanizeActivityItem(item, t);
      expect(line).toContain('Mission M28');
      expect(line).toContain('itération 3');
      expect(line).not.toContain('{');
    });

    it('renders loop.iteration as "Mission <id> — itération <n>", extracting the number from its free-text summary', () => {
      const item = makeItem({
        event_type: 'loop.iteration',
        mission_id: 'M28',
        payload_preview: '{"summary":"iteration 3 -> mission M28-child"}',
      });
      const line = humanizeActivityItem(item, t);
      expect(line).toContain('Mission M28');
      expect(line).toContain('itération 3');
    });

    it('falls back to the generic "itération loop" label when no iteration number is recoverable', () => {
      const item = makeItem({ event_type: 'loop.iteration', mission_id: 'M28', payload_preview: '{}' });
      const line = humanizeActivityItem(item, t);
      expect(line).toContain('M28');
      expect(line.toLowerCase()).toContain('itération loop');
    });
  });

  // ── Exhaustive feed.eventType.* coverage — derived, not hand-maintained.
  //
  // This supersedes the OLD `previouslyUncoveredTypes` array (a 15-string
  // hand-maintained list, fr/en only) that this exact gap slipped through:
  // six real event types — agent.message_read, loop.stopped,
  // scheduler.stalled, scheduler.throttled, tools.context, frontend.error —
  // shipped in eventTypes.ts's `JournalEventInput` union and were never
  // added to that array, so nothing ever caught their missing locale
  // entries (frontend.error doubly so: it's Rust-only, emitted by
  // journal.rs's `journal_frontend_error` with no TS `emitEvent` call site,
  // which is why it's now an explicit `JournalEventInput` member too — see
  // `FrontendErrorPayload`'s doc comment in eventTypes.ts).
  //
  // `JOURNAL_EVENT_TYPES` (eventTypes.ts) is derived from — and
  // type-checked against — the union itself, so a future event type added
  // there is automatically covered here with zero extra list to remember to
  // touch; omitting it from `JOURNAL_EVENT_TYPE_MAP` is a compile error.
  describe.each(JOURNAL_EVENT_TYPES)('feed.eventType.%s', (eventType) => {
    const key = `feed.eventType.${eventType}`;

    it('has a non-empty translation in every one of the 6 locales', () => {
      for (const locale of Object.keys(ALL_LOCALE_DICTS) as Locale[]) {
        const value = ALL_LOCALE_DICTS[locale][key];
        expect(value, `${locale} is missing "${key}"`).toBeDefined();
        expect(value?.trim().length ?? 0, `${locale}'s "${key}" is empty`).toBeGreaterThan(0);
      }
    });

    it('resolves through humanizeActivityItem without leaking the raw type, the i18n key, or raw JSON, in any locale', () => {
      const item = makeItem({ event_type: eventType, mission_id: 'M1', payload_preview: '{}' });
      for (const locale of Object.keys(ALL_LOCALE_DICTS) as Locale[]) {
        const translate = translateFrom(ALL_LOCALE_DICTS[locale]);
        const line = humanizeActivityItem(item, translate);
        expect(line, `locale ${locale}`).not.toContain(key);
        expect(line, `locale ${locale}`).not.toContain('{');
      }
    });
  });
});

describe('buildFeedEntries', () => {
  it('dedupes consecutive rows that render to the exact same line', () => {
    const items: ActivityFeedItem[] = [
      makeItem({ seq: 1, event_type: 'mission.step', mission_id: 'M9', ts_ms: 1000, payload_preview: '{}' }),
      makeItem({ seq: 2, event_type: 'mission.step', mission_id: 'M9', ts_ms: 1000, payload_preview: '{}' }),
      makeItem({ seq: 3, event_type: 'mission.step', mission_id: 'M9', ts_ms: 1000, payload_preview: '{}' }),
    ];
    const entries = buildFeedEntries(items, t);
    expect(entries).toHaveLength(1);
    expect(entries[0].missionId).toBe('M9');
  });

  it('does NOT dedupe two identical lines separated by unrelated activity — both are real history', () => {
    const items: ActivityFeedItem[] = [
      makeItem({ seq: 1, event_type: 'mission.step', mission_id: 'M9', ts_ms: 1000, payload_preview: '{}' }),
      makeItem({ seq: 2, event_type: 'mission.step', mission_id: 'M10', ts_ms: 1000, payload_preview: '{}' }),
      makeItem({ seq: 3, event_type: 'mission.step', mission_id: 'M9', ts_ms: 1000, payload_preview: '{}' }),
    ];
    const entries = buildFeedEntries(items, t);
    expect(entries).toHaveLength(3);
  });

  it('caps the entry count to maxItems — "the last ~50 real events", never an unbounded replay burst', () => {
    const items: ActivityFeedItem[] = Array.from({ length: 100 }, (_, i) =>
      makeItem({ seq: i, event_type: 'mission.step', mission_id: `M${i}`, ts_ms: i, payload_preview: '{}' }),
    );
    const entries = buildFeedEntries(items, t, 50);
    expect(entries.length).toBeLessThanOrEqual(50);
  });

  it('carries the mission id through for click-to-focus, and null for entries with none', () => {
    const items: ActivityFeedItem[] = [
      makeItem({ seq: 1, event_type: 'project.opened', mission_id: null, payload_preview: '{"root":"/x/demo-shop"}' }),
      makeItem({ seq: 2, event_type: 'mission.started', mission_id: 'M9', payload_preview: '{}' }),
    ];
    const entries = buildFeedEntries(items, t);
    expect(entries[0].missionId).toBeNull();
    expect(entries[1].missionId).toBe('M9');
  });
});

describe('buildActivityTicker', () => {
  it('joins multiple humanized items and truncates to maxChars', () => {
    const items: ActivityFeedItem[] = [
      makeItem({ event_type: 'project.opened', payload_preview: '{"root":"/x/demo-shop"}' }),
      makeItem({ event_type: 'mission.updated', mission_id: 'M9', payload_preview: '{"mission":{"id":"M9","title":"QA pricing","status":"review"}}' }),
    ];
    const ticker = buildActivityTicker(items, 340, t);
    expect(ticker).not.toContain('{');
    expect(ticker).toContain('demo-shop');
    expect(ticker).toContain('M9');
  });

  it('truncates an overly long ticker line with an ellipsis', () => {
    const items: ActivityFeedItem[] = Array.from({ length: 50 }, (_, i) =>
      makeItem({ event_type: 'mission.step', mission_id: `M${i}`, payload_preview: '{}' }),
    );
    const ticker = buildActivityTicker(items, 50, t);
    expect(ticker.length).toBeLessThanOrEqual(51);
    expect(ticker.endsWith('…')).toBe(true);
  });
});
