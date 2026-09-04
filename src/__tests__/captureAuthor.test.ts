/**
 * captureAuthor.test.ts
 *
 * Tests for the author cache lifecycle:
 *   1. resolveCaptureIdentity returns author + authorId.
 *   2. After invalidateCaptureAuthor, the next call re-fetches (cache cleared).
 *   3. withCaptureAuthor stamps both author and authorId.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── supabase client mock ──────────────────────────────────────────────
const getUserMock = vi.fn();
const fromMock = vi.fn();

function queryChain(result: { data: unknown; error: unknown }) {
  const chain: {
    select: () => unknown;
    eq: () => unknown;
    limit: () => Promise<unknown>;
  } = {
    select: () => chain,
    eq: () => chain,
    limit: () => Promise.resolve(result),
  };
  return chain;
}

vi.mock('../lib/supabase/client.js', () => ({
  supabase: {
    auth: {
      getUser: (...args: unknown[]) => getUserMock(...args),
    },
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import {
  resolveCaptureIdentity,
  resolveCaptureAuthor,
  resolveCaptureAuthorId,
  invalidateCaptureAuthor,
  withCaptureAuthor,
  enrichCaptureAuthor,
} from '../lib/brain/captureAuthor.js';
import type { CaptureEvent } from '../lib/platform/types.js';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateCaptureAuthor();
  getUserMock.mockResolvedValue({
    data: {
      user: {
        id: 'user-uuid-abc',
        email: 'alice@example.com',
        user_metadata: { display_name: 'Alice' },
      },
    },
  });
  fromMock.mockImplementation((table: string) => {
    if (table === 'org_members') {
      return queryChain({ data: [{ dept_id: 'dept-eng' }], error: null });
    }
    if (table === 'departments') {
      return queryChain({ data: [{ slug: 'engineering' }], error: null });
    }
    return queryChain({ data: [], error: null });
  });
});

describe('resolveCaptureIdentity', () => {
  it('returns author + authorId from the Supabase session', async () => {
    const identity = await resolveCaptureIdentity();

    expect(identity.author).toBe('Alice');
    expect(identity.authorId).toBe('user-uuid-abc');
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it('caches the result — a second call does not re-fetch', async () => {
    await resolveCaptureIdentity();
    await resolveCaptureIdentity();

    expect(getUserMock).toHaveBeenCalledTimes(1);
  });
});

describe('invalidateCaptureAuthor', () => {
  it('clears the cache so the next call re-fetches', async () => {
    await resolveCaptureIdentity();
    expect(getUserMock).toHaveBeenCalledTimes(1);

    invalidateCaptureAuthor();

    await resolveCaptureIdentity();
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });

  it('clears the cache for resolveCaptureAuthor and resolveCaptureAuthorId too', async () => {
    await resolveCaptureAuthor();
    await resolveCaptureAuthorId();
    expect(getUserMock).toHaveBeenCalledTimes(1);

    invalidateCaptureAuthor();

    await resolveCaptureAuthor();
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });
});

describe('withCaptureAuthor', () => {
  function makeEvent(overrides: Partial<CaptureEvent> = {}): CaptureEvent {
    return {
      kind: 'episodic',
      title: 'Test',
      text: 'content',
      source: 'test',
      ...overrides,
    };
  }

  it('stamps both author and authorId when neither is already set', () => {
    const event = makeEvent();
    const stamped = withCaptureAuthor(event, 'Alice', 'user-uuid-abc');

    expect(stamped.author).toBe('Alice');
    expect(stamped.authorId).toBe('user-uuid-abc');
  });

  it('does not overwrite an existing author but still stamps authorId', () => {
    const event = makeEvent({ author: 'Bob' });
    const stamped = withCaptureAuthor(event, 'Alice', 'user-uuid-abc');

    expect(stamped.author).toBe('Bob');
    expect(stamped.authorId).toBe('user-uuid-abc');
  });

  it('stamps author even when authorId is absent', () => {
    const event = makeEvent();
    const stamped = withCaptureAuthor(event, 'Alice');

    expect(stamped.author).toBe('Alice');
    expect(stamped.authorId).toBeUndefined();
  });

  it('returns the event unchanged when author is empty', () => {
    const event = makeEvent();
    const stamped = withCaptureAuthor(event, '', 'user-uuid-abc');

    expect(stamped).toBe(event);
  });
});

describe('department stamp (team brains)', () => {
  it('resolveCaptureIdentity includes the org member dept slug', async () => {
    const identity = await resolveCaptureIdentity();
    expect(identity.dept).toBe('engineering');
  });

  it('enrichCaptureAuthor stamps dept when the event has none', async () => {
    const event: CaptureEvent = {
      kind: 'episodic',
      title: 'Test',
      text: 'content',
      source: 'test',
    };
    const stamped = await enrichCaptureAuthor(event);
    expect(stamped.dept).toBe('engineering');
    expect(stamped.author).toBe('Alice');
  });

  it('does not overwrite an event that already carries dept', async () => {
    const event: CaptureEvent = {
      kind: 'episodic',
      title: 'Test',
      text: 'content',
      source: 'test',
      dept: 'design',
    };
    const stamped = await enrichCaptureAuthor(event);
    expect(stamped.dept).toBe('design');
  });
});
