import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamTimeout, StreamTimeoutError } from '../lib/models/streamTimeout';

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('streamTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes chunks through when the source is prompt', async () => {
    async function* src() { yield 'a'; yield 'b'; }
    const out = await collect(streamTimeout(src(), { firstTokenMs: 1000, idleMs: 1000 }));
    expect(out).toEqual(['a', 'b']);
  });

  it('throws StreamTimeoutError(first-token) when no first chunk in time', async () => {
    async function* src() {
      await new Promise<void>(r => setTimeout(r, 60_000));
      yield 'late';
    }
    const p = collect(streamTimeout(src(), { firstTokenMs: 15_000, idleMs: 30_000 }));
    // Attach rejection handlers BEFORE advancing timers, so the rejection is
    // never momentarily unhandled (avoids Vitest unhandled-rejection noise).
    const isError = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
    const hasPhase = expect(p).rejects.toMatchObject({ phase: 'first-token' });
    await vi.advanceTimersByTimeAsync(15_001);
    await isError;
    await hasPhase;
  });

  it('throws StreamTimeoutError(idle) when the stream stalls after first chunk', async () => {
    async function* src() {
      yield 'first';
      await new Promise<void>(r => setTimeout(r, 60_000));
      yield 'second';
    }
    const p = collect(streamTimeout(src(), { firstTokenMs: 15_000, idleMs: 30_000 }));
    const hasPhase = expect(p).rejects.toMatchObject({ phase: 'idle' });
    await vi.advanceTimersByTimeAsync(30_001);
    await hasPhase;
  });

  it('stops cleanly when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    async function* src() { yield 'x'; }
    const out = await collect(streamTimeout(src(), { signal: ac.signal }));
    expect(out).toEqual([]);
  });

  it('returns promptly when aborted mid-wait, without throwing a timeout', async () => {
    vi.useRealTimers();
    const ac = new AbortController();
    async function* src() {
      yield 'first';
      await new Promise<void>(() => {}); // never resolves -> blocks the next pull
      yield 'second';
    }
    const out: string[] = [];
    const p = (async () => {
      for await (const c of streamTimeout(src(), { firstTokenMs: 5_000, idleMs: 5_000, signal: ac.signal })) {
        out.push(c);
      }
    })();
    // Abort after the consumer is blocked waiting for the second chunk.
    setTimeout(() => ac.abort(), 10);
    await p;
    expect(out).toEqual(['first']);
  });
});
