/**
 * conversationTabLabel.ts — pins the fix for a real QA repro (2026-08-14):
 * at the panel's narrow docked width, 4 of 5 open conversation tabs all
 * began with the exact same first user message, so truncating each one's
 * first words independently (the old behaviour) produced 4 visually
 * IDENTICAL tabs — a user could not tell them apart, let alone find the
 * one they wanted.
 */
import { describe, it, expect } from 'vitest';
import {
  buildConversationTabLabels,
  parseConversationCreatedAtMs,
  formatConversationTimeLabel,
} from '../components/lazyManager/conversationTabLabel';

describe('parseConversationCreatedAtMs', () => {
  it('recovers the epoch-ms creation time encoded in a mintManagerSessionId()-shaped id', () => {
    expect(parseConversationCreatedAtMs('manager-1723640400000-ab12cd')).toBe(1723640400000);
  });

  it('returns undefined for an id that does not match that shape (e.g. a test fixture id)', () => {
    expect(parseConversationCreatedAtMs('conv-1')).toBeUndefined();
    expect(parseConversationCreatedAtMs('manager-not-a-number-ab12cd')).toBeUndefined();
  });
});

describe('formatConversationTimeLabel', () => {
  it('formats as a plain HH:MM string, locale-agnostic (hour12: false)', () => {
    const label = formatConversationTimeLabel(Date.UTC(2026, 7, 14, 9, 5));
    expect(label).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('buildConversationTabLabels', () => {
  it('two conversations that started with the EXACT SAME first words get DISTINGUISHABLE short labels', () => {
    const sources = [
      { id: 'manager-1723600000000-aaa111', firstUserMessage: 'Repondez uniquement en francais dans ce projet' },
      { id: 'manager-1723600600000-bbb222', firstUserMessage: 'Repondez uniquement en francais dans ce projet' },
    ];
    const labels = buildConversationTabLabels(sources);
    expect(labels).toHaveLength(2);
    const [first, second] = labels;
    expect(first.title).toBeTruthy();
    expect(second.title).toBeTruthy();
    // The whole point of the fix: no longer two copies of the same string.
    expect(first.title).not.toBe(second.title);
    // Both remain honest previews of the same underlying message — the
    // creation time is the ONLY thing that should differ between them.
    expect(first.title?.startsWith('Repondez')).toBe(true);
    expect(second.title?.startsWith('Repondez')).toBe(true);
  });

  it('a lone conversation (no collision) gets the plain truncated title, no time suffix appended', () => {
    const sources = [
      { id: 'manager-1723600000000-aaa111', firstUserMessage: 'Fix the checkout bug' },
    ];
    const labels = buildConversationTabLabels(sources);
    expect(labels[0].title).toBe('Fix the checkout bug');
  });

  it('two DIFFERENT first messages never collide, even if superficially similar in length', () => {
    const sources = [
      { id: 'manager-1723600000000-aaa111', firstUserMessage: 'Fix the checkout bug' },
      { id: 'manager-1723600600000-bbb222', firstUserMessage: 'Ship the release' },
    ];
    const labels = buildConversationTabLabels(sources);
    expect(labels[0].title).toBe('Fix the checkout bug');
    expect(labels[1].title).toBe('Ship the release');
  });

  it('collision detection is case/whitespace-insensitive', () => {
    const sources = [
      { id: 'manager-1723600000000-aaa111', firstUserMessage: '  Repondez uniquement  ' },
      { id: 'manager-1723600600000-bbb222', firstUserMessage: 'REPONDEZ UNIQUEMENT' },
    ];
    const labels = buildConversationTabLabels(sources);
    expect(labels[0].title).not.toBe(labels[1].title);
  });

  it('a still-empty conversation (no first user message yet) yields undefined title/fullTitle — the ordinal fallback stays the tab strip\'s own job', () => {
    const labels = buildConversationTabLabels([{ id: 'manager-1723600000000-aaa111' }]);
    expect(labels[0].title).toBeUndefined();
    expect(labels[0].fullTitle).toBeUndefined();
  });

  it('an id with no recoverable timestamp (test fixture ids) still produces a title on collision — just without a time suffix, never a crash', () => {
    const sources = [
      { id: 'conv-1', firstUserMessage: 'Repondez uniquement en francais' },
      { id: 'conv-2', firstUserMessage: 'Repondez uniquement en francais' },
    ];
    const labels = buildConversationTabLabels(sources);
    expect(labels[0].title).toBeTruthy();
    expect(labels[1].title).toBeTruthy();
  });

  it('fullTitle (tooltip) always carries more of the original message than the inline title', () => {
    const longMessage = 'A'.repeat(200);
    const labels = buildConversationTabLabels([{ id: 'manager-1723600000000-aaa111', firstUserMessage: longMessage }]);
    expect(labels[0].fullTitle!.length).toBeGreaterThan(labels[0].title!.length);
  });

  it('preserves input order', () => {
    const sources = [
      { id: 'manager-3-c', firstUserMessage: 'third' },
      { id: 'manager-1-a', firstUserMessage: 'first' },
      { id: 'manager-2-b', firstUserMessage: 'second' },
    ];
    const labels = buildConversationTabLabels(sources);
    expect(labels.map((l) => l.id)).toEqual(['manager-3-c', 'manager-1-a', 'manager-2-b']);
  });

  // VERIFY requirement (task brief): two prompts sharing the EXACT SAME
  // first 20 characters (TAB_LABEL_MAX_CHARS) — the label budget itself —
  // must still produce distinguishable labels.
  it('two prompts with the same 20-character prefix produce different labels', () => {
    const sharedPrefix = 'Repondez uniquement '; // exactly 20 chars
    const sources = [
      { id: 'manager-1723600000000-aaa111', firstUserMessage: `${sharedPrefix}en francais dans ce projet` },
      { id: 'manager-1723600900000-bbb222', firstUserMessage: `${sharedPrefix}en anglais pour ce module` },
    ];
    expect(sources[0].firstUserMessage.slice(0, 20)).toBe(sources[1].firstUserMessage.slice(0, 20));
    const labels = buildConversationTabLabels(sources);
    expect(labels[0].title).toBeTruthy();
    expect(labels[1].title).toBeTruthy();
    expect(labels[0].title).not.toBe(labels[1].title);
  });

  describe('customTitle (rename feature)', () => {
    it('a custom title wins over the derived first-message text', () => {
      const labels = buildConversationTabLabels([
        { id: 'manager-1723600000000-aaa111', firstUserMessage: 'Fix the checkout bug', customTitle: 'Checkout fix' },
      ]);
      expect(labels[0].title).toBe('Checkout fix');
    });

    it('two conversations independently renamed to the SAME custom title still get distinguishable labels', () => {
      const sources = [
        { id: 'manager-1723600000000-aaa111', firstUserMessage: 'unrelated A', customTitle: 'My conversation' },
        { id: 'manager-1723600600000-bbb222', firstUserMessage: 'unrelated B', customTitle: 'My conversation' },
      ];
      const labels = buildConversationTabLabels(sources);
      expect(labels[0].title).not.toBe(labels[1].title);
    });

    it('an empty/whitespace-only custom title falls back to the derived first-message label', () => {
      const labels = buildConversationTabLabels([
        { id: 'manager-1723600000000-aaa111', firstUserMessage: 'Fix the checkout bug', customTitle: '   ' },
      ]);
      expect(labels[0].title).toBe('Fix the checkout bug');
    });
  });

  describe('absolute-uniqueness floor (real-user escalation, 2026-08-15)', () => {
    it('two conversations created in the SAME MINUTE with the same first message stay distinguishable even though the HH:MM time suffix alone would tie', () => {
      // Anchored at :00 seconds (UTC offsets are always a whole number of
      // minutes, so LOCAL seconds == UTC seconds too) — a +5s offset is
      // guaranteed to stay inside the same minute regardless of the test
      // runner's timezone, unlike an arbitrary epoch-ms literal.
      const minuteStartMs = Date.UTC(2026, 7, 14, 9, 0, 0);
      const sources = [
        { id: `manager-${minuteStartMs}-aaa111`, firstUserMessage: 'Repondez uniquement en francais' },
        { id: `manager-${minuteStartMs + 5000}-bbb222`, firstUserMessage: 'Repondez uniquement en francais' },
      ];
      const labels = buildConversationTabLabels(sources);
      expect(labels[0].title).toBeTruthy();
      expect(labels[1].title).toBeTruthy();
      expect(labels[0].title).not.toBe(labels[1].title);
    });

    it('three-way collision in the same minute — every title stays pairwise distinct', () => {
      const minuteStartMs = Date.UTC(2026, 7, 14, 9, 0, 0);
      const sources = [
        { id: `manager-${minuteStartMs}-a`, firstUserMessage: 'Repondez uniquement en francais' },
        { id: `manager-${minuteStartMs + 1000}-b`, firstUserMessage: 'Repondez uniquement en francais' },
        { id: `manager-${minuteStartMs + 2000}-c`, firstUserMessage: 'Repondez uniquement en francais' },
      ];
      const labels = buildConversationTabLabels(sources);
      const titles = labels.map((l) => l.title);
      expect(new Set(titles).size).toBe(3);
    });

    it('never crashes and still guarantees uniqueness for ids with no recoverable timestamp at all (test-fixture ids)', () => {
      const sources = [
        { id: 'conv-1', firstUserMessage: 'Repondez uniquement en francais' },
        { id: 'conv-2', firstUserMessage: 'Repondez uniquement en francais' },
      ];
      const labels = buildConversationTabLabels(sources);
      expect(labels[0].title).not.toBe(labels[1].title);
    });
  });
});
