/* streamEvents.test.ts
   Unit tests for the assistant's structured-stream helpers:
   extractThinkingText, textEventsFromStrings, applyStreamEvent.
*/

import { describe, it, expect } from 'vitest';
import { extractThinkingText, textEventsFromStrings, applyStreamEvent } from '../lib/models/streamEvents';
import type { StreamEvent, StreamPart } from '../lib/models/types';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iter) out.push(value);
  return out;
}

async function* fromArray<T>(values: T[]): AsyncGenerator<T> {
  for (const v of values) yield v;
}

// ── extractThinkingText ─────────────────────────────────────────────

describe('extractThinkingText', () => {
  it('returns empty string for plain text with no reasoning marker', () => {
    expect(extractThinkingText('Hello, world!')).toBe('');
  });

  it('extracts text after a \\x1b[reasoning] marker', () => {
    expect(extractThinkingText('\x1b[reasoning]I should check the docs first.')).toBe(
      'I should check the docs first.',
    );
  });

  it('extracts text after a bare "[reasoning]" tag with no ANSI escape byte', () => {
    expect(extractThinkingText('[reasoning] internal notes here')).toBe('internal notes here');
  });

  it('only pulls reasoning-marked lines out of a multi-line chunk, in order', () => {
    const input = '\x1b[reasoning]First thought.\nVisible prose.\n\x1b[reasoning]Second thought.';
    expect(extractThinkingText(input)).toBe('First thought.\nSecond thought.');
  });

  it('trims surrounding whitespace from the extracted text', () => {
    expect(extractThinkingText('\x1b[reasoning]   padded thought   ')).toBe('padded thought');
  });

  it('returns empty string for an empty input', () => {
    expect(extractThinkingText('')).toBe('');
  });

  it('does not extract anything from a BRAIN_SEARCH directive line (no reasoning marker)', () => {
    expect(extractThinkingText('BRAIN_SEARCH: how is auth built')).toBe('');
  });
});

// ── textEventsFromStrings ────────────────────────────────────────────

describe('textEventsFromStrings', () => {
  it('wraps each non-empty chunk into a text StreamEvent with id "answer"', async () => {
    const events = await collect(textEventsFromStrings(fromArray(['Hello ', 'world'])));
    expect(events).toEqual([
      { type: 'text', id: 'answer', text: 'Hello ' },
      { type: 'text', id: 'answer', text: 'world' },
    ]);
  });

  it('skips empty-string chunks', async () => {
    const events = await collect(textEventsFromStrings(fromArray(['a', '', 'b'])));
    expect(events).toEqual([
      { type: 'text', id: 'answer', text: 'a' },
      { type: 'text', id: 'answer', text: 'b' },
    ]);
  });

  it('yields nothing for an empty source stream', async () => {
    const events = await collect(textEventsFromStrings(fromArray([])));
    expect(events).toEqual([]);
  });
});

// ── applyStreamEvent — immutable parts reducer ──────────────────────

describe('applyStreamEvent', () => {
  it('returns the exact same array reference for a text event (parts untouched)', () => {
    const parts: StreamPart[] = [];
    const event: StreamEvent = { type: 'text', id: 'answer', text: 'hello' };
    const result = applyStreamEvent(parts, event);
    expect(result).toBe(parts);
  });

  it('does not mutate the input array when appending a new tool part', () => {
    const parts: StreamPart[] = [];
    const event: StreamEvent = { type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth' }, status: 'running' };
    const result = applyStreamEvent(parts, event);
    expect(parts).toEqual([]); // original untouched
    expect(result).not.toBe(parts); // new array returned
    expect(result).toEqual([{ type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth' }, status: 'running', resultSummary: undefined }]);
  });

  it('replaces (not duplicates) a tool part sharing the same id on a status transition', () => {
    let parts: StreamPart[] = [];
    parts = applyStreamEvent(parts, { type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth' }, status: 'running' });
    parts = applyStreamEvent(parts, { type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth' }, status: 'done', resultSummary: 'found 3 notes' });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth' }, status: 'done', resultSummary: 'found 3 notes' });
  });

  it('preserves step order across multiple distinct tool ids', () => {
    let parts: StreamPart[] = [];
    parts = applyStreamEvent(parts, { type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth' }, status: 'done' });
    parts = applyStreamEvent(parts, { type: 'tool', id: 't2', name: 'brain_search', input: { query: 'billing' }, status: 'running' });

    expect(parts.map(p => p.id)).toEqual(['t1', 't2']);
  });

  it('creates a thinking part on first arrival', () => {
    const parts: StreamPart[] = [];
    const result = applyStreamEvent(parts, { type: 'thinking', id: 'thinking', text: 'Let me consider this.' });
    expect(result).toEqual([{ type: 'thinking', id: 'thinking', text: 'Let me consider this.' }]);
  });

  it('appends (not replaces) text onto an existing thinking part with the same id', () => {
    let parts: StreamPart[] = [];
    parts = applyStreamEvent(parts, { type: 'thinking', id: 'thinking', text: 'First. ' });
    parts = applyStreamEvent(parts, { type: 'thinking', id: 'thinking', text: 'Second.' });

    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'thinking', id: 'thinking', text: 'First. Second.' });
  });

  it('keeps thinking and tool parts as separate entries even when interleaved', () => {
    let parts: StreamPart[] = [];
    parts = applyStreamEvent(parts, { type: 'thinking', id: 'thinking', text: 'Checking memory...' });
    parts = applyStreamEvent(parts, { type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth' }, status: 'running' });
    parts = applyStreamEvent(parts, { type: 'thinking', id: 'thinking', text: ' Done checking.' });
    parts = applyStreamEvent(parts, { type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth' }, status: 'done' });

    expect(parts).toHaveLength(2);
    const thinking = parts.find(p => p.type === 'thinking');
    const tool = parts.find(p => p.type === 'tool');
    expect(thinking).toEqual({ type: 'thinking', id: 'thinking', text: 'Checking memory... Done checking.' });
    expect(tool).toEqual({ type: 'tool', id: 't1', name: 'brain_search', input: { query: 'auth' }, status: 'done', resultSummary: undefined });
  });
});
