/**
 * brainTimelinePlural.test.tsx — regression coverage for a real, observed
 * Brain-space UI bug: the "new items since your last visit" header strip
 * read "1 new items since your last visit" for a single new note — no
 * singular agreement. BrainTimeline.tsx (and LateJoinerTour.tsx, which
 * shares the same brain.timeline.decisions/bugs keys) now pick a
 * singular/plural key pair via i18n/plural.ts's pluralKey, same convention
 * as the team-header fix (see teamHeaderPlural.test.ts). This pins those
 * keys across every locale — a missing/typo'd key in one locale would fall
 * back to French silently — and proves the actual rendered text is
 * grammatically correct for count === 1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { fr } from '../i18n/locales/fr';
import { en } from '../i18n/locales/en';
import { es } from '../i18n/locales/es';
import { de } from '../i18n/locales/de';
import { ja } from '../i18n/locales/ja';
import { zh } from '../i18n/locales/zh';
import { I18nProvider } from '../i18n';
import { BrainTimeline } from '../components/brain/BrainTimeline';
import type { AdaptedNode } from '../lib/brain/brainAdapter';

const ALL_LOCALE_DICTS = { fr, en, es, de, ja, zh };

const PLURAL_KEYS = [
  'brain.timeline.newSinceOne',
  'brain.timeline.newSinceMany',
  'brain.timeline.decisionsOne',
  'brain.timeline.decisionsMany',
  'brain.timeline.bugsOne',
  'brain.timeline.bugsMany',
] as const;

describe('Brain timeline pluralization keys', () => {
  it('every singular/plural key exists in all six locale dicts', () => {
    for (const [name, dict] of Object.entries(ALL_LOCALE_DICTS)) {
      for (const key of PLURAL_KEYS) {
        expect(dict[key], `${name}.${key} present`).toBeDefined();
        expect(typeof dict[key], `${name}.${key} is a string`).toBe('string');
      }
    }
  });

  it('singular and plural forms differ in inflecting languages (fr, en, es, de)', () => {
    expect(en['brain.timeline.newSinceOne']).toBe('new item since your last visit');
    expect(en['brain.timeline.newSinceMany']).toBe('new items since your last visit');
    expect(fr['brain.timeline.newSinceOne']).not.toBe(fr['brain.timeline.newSinceMany']);
    expect(es['brain.timeline.newSinceOne']).not.toBe(es['brain.timeline.newSinceMany']);
    expect(de['brain.timeline.decisionsOne']).toBe('Entscheidung');
    expect(de['brain.timeline.decisionsMany']).toBe('Entscheidungen');
  });

  it('the old flat newSince key is gone (its only caller now uses the plural pair)', () => {
    for (const dict of Object.values(ALL_LOCALE_DICTS)) {
      expect(dict['brain.timeline.newSince']).toBeUndefined();
    }
  });
});

function makeNode(id: string, name: string, created: string): AdaptedNode {
  return { id, name, type: 'concept', cluster: 'editor', val: 1, dateIdx: 0, created };
}

describe('BrainTimeline — real rendering with the live i18n provider', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('renders the SINGULAR form for exactly one new item ("1 new item", not "1 new items")', () => {
    localStorage.setItem('lazy:brain-last-seen:solo', String(Date.parse('2026-08-01T00:00:00.000Z')));
    const nodes = [makeNode('n1', 'Fresh neuron', '2026-08-10T00:00:00.000Z')];

    render(
      <I18nProvider>
        <BrainTimeline nodes={nodes} />
      </I18nProvider>,
    );

    expect(screen.getByText('1 new item since your last visit')).toBeInTheDocument();
    expect(screen.queryByText(/1 new items/)).toBeNull();
  });

  it('renders the PLURAL form for more than one new item', () => {
    localStorage.setItem('lazy:brain-last-seen:solo', String(Date.parse('2026-08-01T00:00:00.000Z')));
    const nodes = [
      makeNode('n1', 'Fresh neuron A', '2026-08-10T00:00:00.000Z'),
      makeNode('n2', 'Fresh neuron B', '2026-08-11T00:00:00.000Z'),
    ];

    render(
      <I18nProvider>
        <BrainTimeline nodes={nodes} />
      </I18nProvider>,
    );

    expect(screen.getByText('2 new items since your last visit')).toBeInTheDocument();
  });
});
