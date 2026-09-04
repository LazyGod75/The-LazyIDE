/* presenceChannel.ts — core Supabase Realtime channel wrapper for
   multiplayer presence + live fleet.

   One channel per org (see channelName()). A path-keyed topic would
   never match across machines (Alice's C:/work/acme vs Bob's
   /Users/bob/acme). Project identity travels in the payload
   (FleetDelta.projectId = repo basename) instead.

   Accepts a narrow RealtimeClientLike interface so this module is
   unit-testable with a hand-written mock. Realtime presence/broadcast
   work without a new table; org_fleet_missions is an additive durable
   heartbeat, not required for the channel itself.
*/

import type { PresenceUser, FleetDelta, CanvasOp, SelfIdentity, MissionTransfer, SessionEvent } from './types.js';

// ── Narrow client/channel interfaces (see module doc comment) ──────

export interface RealtimeChannelLike {
  on(
    type: 'presence',
    filter: { event: 'sync' },
    callback: () => void,
  ): RealtimeChannelLike;
  on(
    type: 'broadcast',
    filter: { event: string },
    callback: (message: { payload: unknown }) => void,
  ): RealtimeChannelLike;
  subscribe(callback?: (status: string, err?: Error) => void): RealtimeChannelLike;
  track(payload: Record<string, unknown>): Promise<unknown>;
  untrack(): Promise<unknown>;
  send(args: { type: 'broadcast'; event: string; payload: Record<string, unknown> }): Promise<unknown>;
  // Hardwired to PresenceUser (unlike @supabase/realtime-js's own generic
  // RealtimeChannel.presenceState<T>()) — this narrow interface only ever
  // tracks presence-user payloads, and a concrete type here avoids an
  // `any`-constrained generic just to satisfy TS's structural check.
  presenceState(): Record<string, Array<{ presence_ref: string } & PresenceUser>>;
}

export interface RealtimeClientLike {
  channel(name: string, opts?: Record<string, unknown>): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): void;
}

const FLEET_DELTA_EVENT = 'fleet-delta';
const CANVAS_OP_EVENT = 'canvas-op';
const MISSION_TRANSFER_EVENT = 'mission-transfer';
const SESSION_EVENT = 'session-event';

/** Deterministic channel topic for one org — every teammate in the
 *  same org joins this topic. `_projectId` is accepted for call-site
 *  compat and ignored (project identity lives on the payload). */
export function channelName(orgId: string, _projectId?: string): string {
  return `presence:org:${orgId}`;
}

export interface OrgPresenceChannel {
  /** Tracks (or re-tracks) this client's presence payload. */
  track(payload: Omit<PresenceUser, 'updatedAt'>): Promise<void>;
  /** Stops broadcasting this client's presence (e.g. canvas unmounted). */
  untrack(): Promise<void>;
  /** Broadcasts a fleet-status delta to every other subscriber on this
   *  (orgId, projectId) channel. */
  broadcastFleetDelta(delta: Omit<FleetDelta, 'fromUserId' | 'fromName' | 'updatedAt'>): Promise<void>;
  /** Broadcasts a live canvas editing op (move/note) to teammates. */
  broadcastCanvasOp(op: Omit<CanvasOp, 'fromUserId' | 'fromName' | 'updatedAt'>): Promise<void>;
  /** Broadcasts a mission handoff (owner transfer) to teammates. */
  broadcastMissionTransfer(transfer: Omit<MissionTransfer, 'fromUserId' | 'fromName' | 'updatedAt'>): Promise<void>;
  /** Broadcasts a session event (join/leave/claim-step/spectate). */
  broadcastSessionEvent(event: Omit<SessionEvent, 'fromUserId' | 'fromName' | 'updatedAt'>): Promise<void>;
  /** Subscribes to the flattened remote-presence list (self excluded).
   *  Returns an unsubscribe function. */
  onPresenceChange(callback: (users: PresenceUser[]) => void): () => void;
  /** Subscribes to incoming fleet deltas from teammates. Returns an
   *  unsubscribe function. */
  onFleetDelta(callback: (delta: FleetDelta) => void): () => void;
  /** Subscribes to incoming live canvas ops from teammates. Returns an
   *  unsubscribe function. */
  onCanvasOp(callback: (op: CanvasOp) => void): () => void;
  /** Subscribes to incoming mission transfers from teammates. */
  onMissionTransfer(callback: (transfer: MissionTransfer) => void): () => void;
  /** Subscribes to incoming session events (join/leave/claim/spectate). */
  onSessionEvent(callback: (event: SessionEvent) => void): () => void;
  /** Leaves the channel entirely (component unmount / org changed). */
  close(): void;
}

/**
 * Flattens Supabase's { [presenceKey]: Presence<T>[] } shape into one
 * PresenceUser per key, excluding `selfUserId`. When a key somehow has
 * more than one tracked entry (e.g. two tabs), the most recently
 * updated one wins — never silently picks an arbitrary array index.
 */
export function flattenPresenceState(
  state: Record<string, Array<{ presence_ref: string } & PresenceUser>>,
  selfUserId: string,
): PresenceUser[] {
  const users: PresenceUser[] = [];
  for (const [key, entries] of Object.entries(state)) {
    if (key === selfUserId || entries.length === 0) continue;
    const latest = entries.reduce((best, entry) =>
      entry.updatedAt > best.updatedAt ? entry : best,
    );
    users.push({
      userId: latest.userId,
      name: latest.name,
      color: latest.color,
      focusedRef: latest.focusedRef,
      viewportCenter: latest.viewportCenter,
      updatedAt: latest.updatedAt,
    });
  }
  return users;
}

/**
 * Creates (and subscribes) an OrgPresenceChannel for one (orgId,
 * projectId). Caller owns the lifecycle: call close() when the canvas
 * is no longer visible or the org/project changes (see
 * useFleetPresence.ts, the sole production call site).
 */
export function createPresenceChannel(
  client: RealtimeClientLike,
  orgId: string,
  _projectId: string,
  self: SelfIdentity,
): OrgPresenceChannel {
  const channel = client.channel(channelName(orgId), {
    config: {
      presence: { key: self.userId },
      // Broadcasts never echo back to their own sender — every
      // subscriber (including a second tab of the same user) still
      // gets the presence sync path for self-awareness.
      broadcast: { self: false },
    },
  });

  const presenceListeners = new Set<(users: PresenceUser[]) => void>();
  const deltaListeners = new Set<(delta: FleetDelta) => void>();
  const canvasOpListeners = new Set<(op: CanvasOp) => void>();
  const transferListeners = new Set<(transfer: MissionTransfer) => void>();
  const sessionListeners = new Set<(event: SessionEvent) => void>();

  // Defensive registration (dev StrictMode double-effects): Supabase throws
  // "cannot add presence callbacks ... after subscribe()" when `.on()` runs
  // against an already-subscribed channel object (a duplicate mount racing
  // the previous one's async teardown). Registering the same listeners on a
  // fresh channel is harmless; the throw only loses THIS mount's listeners.
  // Fail-safe: each registration is independent, and the presence `sync`
  // event re-fires on the surviving mount, so remote users still render.
  try {
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const users = flattenPresenceState(state, self.userId);
      for (const listener of presenceListeners) listener(users);
    });
  } catch (err) {
    console.warn('[presence] duplicate presence registration skipped:', err);
  }

  try {
    channel.on('broadcast', { event: FLEET_DELTA_EVENT }, (message) => {
      const delta = message.payload as FleetDelta;
      for (const listener of deltaListeners) listener(delta);
    });
  } catch (err) {
    console.warn('[presence] duplicate fleet-delta registration skipped:', err);
  }

  try {
    channel.on('broadcast', { event: CANVAS_OP_EVENT }, (message) => {
      const op = message.payload as CanvasOp;
      for (const listener of canvasOpListeners) listener(op);
    });
  } catch (err) {
    console.warn('[presence] duplicate canvas-op registration skipped:', err);
  }

  try {
    channel.on('broadcast', { event: MISSION_TRANSFER_EVENT }, (message) => {
      const transfer = message.payload as MissionTransfer;
      for (const listener of transferListeners) listener(transfer);
    });
  } catch (err) {
    console.warn('[presence] duplicate mission-transfer registration skipped:', err);
  }

  try {
    channel.on('broadcast', { event: SESSION_EVENT }, (message) => {
      const event = message.payload as SessionEvent;
      for (const listener of sessionListeners) listener(event);
    });
  } catch (err) {
    console.warn('[presence] duplicate session-event registration skipped:', err);
  }

  try {
    channel.subscribe();
  } catch (err) {
    // A channel that already errored mid-subscribe must not crash the canvas.
    console.warn('[presence] subscribe failed (best-effort):', err);
  }

  return {
    async track(payload) {
      await channel.track({ ...payload, updatedAt: Date.now() });
    },
    async untrack() {
      await channel.untrack();
    },
    async broadcastFleetDelta(delta) {
      await channel.send({
        type: 'broadcast',
        event: FLEET_DELTA_EVENT,
        payload: { ...delta, fromUserId: self.userId, fromName: self.name, updatedAt: Date.now() },
      });
    },
    async broadcastCanvasOp(op) {
      await channel.send({
        type: 'broadcast',
        event: CANVAS_OP_EVENT,
        payload: { ...op, fromUserId: self.userId, fromName: self.name, updatedAt: Date.now() },
      });
    },
    async broadcastMissionTransfer(transfer) {
      await channel.send({
        type: 'broadcast',
        event: MISSION_TRANSFER_EVENT,
        payload: { ...transfer, fromUserId: self.userId, fromName: self.name, updatedAt: Date.now() },
      });
    },
    async broadcastSessionEvent(event) {
      await channel.send({
        type: 'broadcast',
        event: SESSION_EVENT,
        payload: { ...event, fromUserId: self.userId, fromName: self.name, updatedAt: Date.now() },
      });
    },
    onPresenceChange(callback) {
      presenceListeners.add(callback);
      return () => presenceListeners.delete(callback);
    },
    onFleetDelta(callback) {
      deltaListeners.add(callback);
      return () => deltaListeners.delete(callback);
    },
    onCanvasOp(callback) {
      canvasOpListeners.add(callback);
      return () => canvasOpListeners.delete(callback);
    },
    onMissionTransfer(callback) {
      transferListeners.add(callback);
      return () => transferListeners.delete(callback);
    },
    onSessionEvent(callback) {
      sessionListeners.add(callback);
      return () => sessionListeners.delete(callback);
    },
    close() {
      presenceListeners.clear();
      deltaListeners.clear();
      canvasOpListeners.clear();
      transferListeners.clear();
      sessionListeners.clear();
      client.removeChannel(channel);
    },
  };
}
