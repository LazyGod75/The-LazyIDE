/**
 * presenceChannel.test.ts
 *
 * lib/collab/presenceChannel.ts: the core Realtime channel wrapper for
 * multiplayer presence v1. Uses a small hand-written mock satisfying
 * RealtimeChannelLike/RealtimeClientLike — no real Supabase project
 * reachable, proving the wrapper's join/track/sync/broadcast/close
 * lifecycle end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  channelName,
  createPresenceChannel,
  flattenPresenceState,
  type RealtimeChannelLike,
  type RealtimeClientLike,
} from '../lib/collab/presenceChannel';
import type { PresenceUser } from '../lib/collab/types';

// ── Mock channel/client ─────────────────────────────────────────────

type MockPresenceState = Record<string, Array<{ presence_ref: string } & PresenceUser>>;

interface MockChannel extends RealtimeChannelLike {
  __setPresenceState: (s: MockPresenceState) => void;
  __fireSync: () => void;
  __fireBroadcast: (event: string, payload: unknown) => void;
}

function createMockChannel(): MockChannel {
  const handlers: { presenceSync?: () => void; broadcast: Map<string, (msg: { payload: unknown }) => void> } = {
    broadcast: new Map(),
  };
  let presenceState: MockPresenceState = {};

  const channel: MockChannel = {
    on: vi.fn((type: string, filter: { event: string }, cb: (...args: unknown[]) => void) => {
      if (type === 'presence' && filter.event === 'sync') handlers.presenceSync = cb as () => void;
      if (type === 'broadcast') handlers.broadcast.set(filter.event, cb as (msg: { payload: unknown }) => void);
      return channel;
    }) as unknown as RealtimeChannelLike['on'],
    subscribe: vi.fn(() => channel),
    track: vi.fn(async () => ({})),
    untrack: vi.fn(async () => ({})),
    send: vi.fn(async () => ({})),
    presenceState: vi.fn(() => presenceState) as unknown as RealtimeChannelLike['presenceState'],
    __setPresenceState: (s: MockPresenceState) => {
      presenceState = s;
    },
    __fireSync: () => handlers.presenceSync?.(),
    __fireBroadcast: (event: string, payload: unknown) => handlers.broadcast.get(event)?.({ payload }),
  };
  return channel;
}

describe('channelName', () => {
  it('builds a deterministic org-wide topic (projectId ignored)', () => {
    expect(channelName('org-1', 'proj-1')).toBe('presence:org:org-1');
    expect(channelName('org-1')).toBe('presence:org:org-1');
  });
});

describe('flattenPresenceState', () => {
  it('excludes the self key and picks the most-recently-updated entry per remaining key', () => {
    const state = {
      'user-self': [{ presence_ref: 'r0', userId: 'user-self', name: 'Me', color: '#fff', updatedAt: 100 }],
      'user-a': [
        { presence_ref: 'r1', userId: 'user-a', name: 'Alice (old)', color: '#111', updatedAt: 100 },
        { presence_ref: 'r2', userId: 'user-a', name: 'Alice', color: '#111', updatedAt: 200 },
      ],
    };
    const result = flattenPresenceState(state, 'user-self');
    expect(result).toEqual([{ userId: 'user-a', name: 'Alice', color: '#111', focusedRef: undefined, viewportCenter: undefined, updatedAt: 200 }]);
  });

  it('returns an empty list for an empty state', () => {
    expect(flattenPresenceState({}, 'user-self')).toEqual([]);
  });
});

describe('createPresenceChannel', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let client: RealtimeClientLike;
  const removeChannelMock = vi.fn();

  beforeEach(() => {
    mockChannel = createMockChannel();
    removeChannelMock.mockClear();
    client = {
      channel: vi.fn(() => mockChannel),
      removeChannel: removeChannelMock,
    };
  });

  it('joins the deterministic org-wide topic and subscribes', () => {
    createPresenceChannel(client, 'org-1', 'proj-1', { userId: 'u1', name: 'Alice', color: '#111' });
    expect(client.channel).toHaveBeenCalledWith(
      'presence:org:org-1',
      expect.objectContaining({ config: expect.objectContaining({ presence: { key: 'u1' } }) }),
    );
    expect(mockChannel.subscribe).toHaveBeenCalled();
  });

  it('track() stamps updatedAt and forwards to the underlying channel', async () => {
    const presence = createPresenceChannel(client, 'org-1', 'proj-1', { userId: 'u1', name: 'Alice', color: '#111' });
    await presence.track({ userId: 'u1', name: 'Alice', color: '#111', focusedRef: 'mission-1' });
    expect(mockChannel.track).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', focusedRef: 'mission-1', updatedAt: expect.any(Number) }),
    );
  });

  it('surfaces a presence sync as a flattened, self-excluded user list', () => {
    const presence = createPresenceChannel(client, 'org-1', 'proj-1', { userId: 'self', name: 'Me', color: '#000' });
    const cb = vi.fn();
    presence.onPresenceChange(cb);

    mockChannel.__setPresenceState({
      self: [{ presence_ref: 'r0', userId: 'self', name: 'Me', color: '#000', updatedAt: 1 }],
      teammate: [{ presence_ref: 'r1', userId: 'teammate', name: 'Bob', color: '#222', updatedAt: 2 }],
    });
    mockChannel.__fireSync();

    expect(cb).toHaveBeenCalledWith([{ userId: 'teammate', name: 'Bob', color: '#222', focusedRef: undefined, viewportCenter: undefined, updatedAt: 2 }]);
  });

  it('broadcastFleetDelta sends the delta with fromUserId/fromName/updatedAt attached', async () => {
    const presence = createPresenceChannel(client, 'org-1', 'proj-1', { userId: 'u1', name: 'Alice', color: '#111' });
    await presence.broadcastFleetDelta({ projectId: 'proj-1', missionId: 'm-1', status: 'review' });
    expect(mockChannel.send).toHaveBeenCalledWith({
      type: 'broadcast',
      event: 'fleet-delta',
      payload: expect.objectContaining({ projectId: 'proj-1', missionId: 'm-1', status: 'review', fromUserId: 'u1', fromName: 'Alice' }),
    });
  });

  it('onFleetDelta receives an incoming broadcast payload', () => {
    const presence = createPresenceChannel(client, 'org-1', 'proj-1', { userId: 'u1', name: 'Alice', color: '#111' });
    const cb = vi.fn();
    presence.onFleetDelta(cb);

    const delta = { projectId: 'proj-1', missionId: 'm-2', status: 'done', fromUserId: 'u2', fromName: 'Bob', updatedAt: 123 };
    mockChannel.__fireBroadcast('fleet-delta', delta);

    expect(cb).toHaveBeenCalledWith(delta);
  });

  it('close() clears listeners and removes the channel from the client', () => {
    const presence = createPresenceChannel(client, 'org-1', 'proj-1', { userId: 'u1', name: 'Alice', color: '#111' });
    const cb = vi.fn();
    presence.onPresenceChange(cb);
    presence.close();

    mockChannel.__setPresenceState({ teammate: [{ presence_ref: 'r1', userId: 'teammate', name: 'Bob', color: '#222', updatedAt: 2 }] });
    mockChannel.__fireSync();

    expect(cb).not.toHaveBeenCalled();
    expect(removeChannelMock).toHaveBeenCalledWith(mockChannel);
  });
});
