/* streamEvents — shared, provider-agnostic helpers for the assistant's
   structured stream (StreamEvent: thinking / tool / text).

   Kept separate from brainSearchLoop.ts (the ReAct loop that PRODUCES these
   events) and from assistantStore.tsx (the React state that CONSUMES them)
   so all three can import these small pure functions without a circular
   dependency. Nothing here talks to a provider, Tauri, or React — every
   export is a pure function, easy to unit test in isolation.
*/

import type { StreamEvent, StreamPart } from './types.js';

// ── Thinking-channel extraction ─────────────────────────────────────
//
// Mirrors brainSearchLoop.ts's OUT_OF_BAND_MARKER convention for the
// reasoning marker specifically, but — unlike that module's
// stripInvisibleLines — PRESERVES the text instead of discarding it. Kept
// as an independent regex/scan (not derived from stripInvisibleLines) so
// this addition can never change stripInvisibleLines' own well-tested
// visible-text output.
// eslint-disable-next-line no-control-regex -- intentional: matching the ANSI escape byte itself (same convention as brainSearchLoop.ts's OUT_OF_BAND_MARKER)
const REASONING_MARKER = /\x1b?\[reasoning\]/;

function extractThinkingLine(line: string): string {
  const match = line.match(REASONING_MARKER);
  if (!match || match.index === undefined) return '';
  return line.slice(match.index + match[0].length).trim();
}

/**
 * Pulls the reasoning-channel text out of a (possibly multi-line) chunk of
 * raw provider output — the counterpart to brainSearchLoop.ts's
 * stripInvisibleLines, which REMOVES this same content from the visible
 * text channel. Lines with no reasoning marker contribute nothing (most
 * providers never emit one — see the STEP 1 map in the final report for
 * which paths actually populate this today).
 */
export function extractThinkingText(text: string): string {
  return text
    .split('\n')
    .map(extractThinkingLine)
    .filter(line => line.length > 0)
    .join('\n');
}

// ── String → events adapter ───────────────────────────────────────
//
// Wraps a plain string stream (any provider WITHOUT streamChatEvents —
// mockProvider, webAnthropicProvider, index.ts's noModelProvider) into the
// structured StreamEvent shape, as a single running 'text' part. Lets
// assistantStore consume ONE uniform AsyncIterable<StreamEvent> contract
// regardless of provider capability, while these providers keep their
// existing plain-string behavior completely unchanged — the resulting
// message naturally has an empty `parts` array (see StreamPart's doc
// comment in types.ts), so it renders exactly like today's simple
// completions.

/** Stable id used for the single text part synthesized by textEventsFromStrings —
 *  matches the 'answer' id the real agentic loops use for their own text
 *  events (brainSearchLoop.ts / managedProvider.ts), so a caller that
 *  doesn't care which path produced a message can treat it uniformly. */
export const ADAPTED_TEXT_PART_ID = 'answer';

export async function* textEventsFromStrings(source: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
  for await (const chunk of source) {
    if (chunk) yield { type: 'text', id: ADAPTED_TEXT_PART_ID, text: chunk };
  }
}

// ── Immutable parts reducer ───────────────────────────────────────

/**
 * Applies one StreamEvent onto the current ordered `parts` list, returning
 * a NEW array (never mutates `parts` or any element in place — see the
 * project's immutability rule).
 *
 * - 'text' events never touch `parts` — assistantStore accumulates them
 *   directly into ChatMessage.content instead (see StreamPart's doc
 *   comment in types.ts). The same `parts` reference is returned unchanged.
 * - 'tool' events REPLACE the matching part by id: a tool status object
 *   arrives as a full snapshot each time (running → done/error), not a
 *   fragment to append.
 * - 'thinking' events APPEND text to the matching part by id, creating the
 *   part on its first arrival.
 */
export function applyStreamEvent(parts: StreamPart[], event: StreamEvent): StreamPart[] {
  if (event.type === 'text') return parts;

  const idx = parts.findIndex(p => p.type === event.type && p.id === event.id);

  if (event.type === 'tool') {
    const next: StreamPart = {
      type: 'tool',
      id: event.id,
      name: event.name,
      input: event.input,
      status: event.status,
      resultSummary: event.resultSummary,
    };
    if (idx === -1) return [...parts, next];
    return parts.map((p, i) => (i === idx ? next : p));
  }

  // 'thinking' — append text, creating the part on first arrival.
  if (idx === -1) return [...parts, { type: 'thinking', id: event.id, text: event.text }];
  return parts.map((p, i) => {
    if (i !== idx) return p;
    const prevText = p.type === 'thinking' ? p.text : '';
    return { type: 'thinking', id: event.id, text: prevText + event.text };
  });
}
