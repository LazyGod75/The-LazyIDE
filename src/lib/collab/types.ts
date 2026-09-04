/* lib/collab/types.ts — shared types for multiplayer presence + live fleet.

   One Supabase Realtime channel per org (NOT per local path — teammates
   clone the same repo to different disks, so a path-keyed topic would
   never match). Presence, fleet spectate, and lightweight canvas ops
   (move/note) share that channel. Durable canvas/brain sync stays git
   (lib/teams/canvasShare.ts).
*/

/** A teammate's live presence on the org canvas. */
export interface PresenceUser {
  userId: string;
  name: string;
  /** Stable per-user color (e.g. derived from userId) for the avatar
   *  chip + focus halo — never re-randomized between renders. */
  color: string;
  /** The canvas ref (mission/draft/node id) this teammate currently has
   *  open/focused, if any — drives the halo overlay on that node. */
  focusedRef?: string;
  /** Canvas camera center, for "jump to teammate". */
  viewportCenter?: { x: number; y: number };
  /** Epoch ms this presence payload was last tracked. */
  updatedAt: number;
}

/**
 * A live fleet-status mirror from a teammate's machine. Enough to render
 * a remote mission node + occupancy collision + shared plan + sponsor,
 * NEVER the transcript.
 */
export interface FleetDelta {
  /** Shared project key (repo basename), never a local disk path. */
  projectId: string;
  missionId: string;
  status: string;
  stage?: string;
  title?: string;
  liveAction?: string;
  model?: string;
  /** Files this mission currently claims — drives collision edges. */
  occupancy?: string[];
  fromUserId: string;
  fromName: string;
  updatedAt: number;

  // ── P2 — shared session ──────────────────────────────────────

  /** Lightweight plan-step mirror (label + state only — never the full
   *  OrchestratorPlanStep). Drives the shared plan panel + claim badges.
   *  Absent when the mission has no plan yet. */
  planSteps?: Array<{ label: string; state: 'done' | 'in_progress' | 'todo'; ownerUserId?: string }>;
  /** Session members for multi-owner lanes. Absent = solo (one owner). */
  sessionMembers?: Array<{ userId: string; name: string; role: 'owner' | 'collaborator' | 'spectator' }>;
  /** Who is paying for this mission's turns. Absent = the owner (BYOK). */
  sponsorUserId?: string;
  sponsorName?: string;
  /** Approximate cost in cents for this mission so far. Absent = unknown. */
  costCents?: number;
  /** Git worktree branch name (for 3-way sync awareness). */
  worktreeBranch?: string;
  /** Worktree HEAD commit short hash (for "2 versions" chip). */
  worktreeHead?: string;
}

/** A mission handoff — one teammate transfers mission ownership to another. */
export interface MissionTransfer {
  projectId: string;
  missionId: string;
  /** The new owner's userId. */
  toUserId: string;
  toName: string;
  /** Optional reason/note from the transferring user. */
  reason?: string;
  fromUserId: string;
  fromName: string;
  updatedAt: number;
}

/** A session event — join/leave/claim-step/spectate on a shared mission. */
export interface SessionEvent {
  projectId: string;
  missionId: string;
  kind: 'join' | 'leave' | 'claim-step' | 'spectate' | 'unspectate';
  /** For 'claim-step': the plan step label being claimed. */
  stepLabel?: string;
  /** The teammate this event is about (may differ from fromUserId for
   *  targeted invites — usually the same). */
  targetUserId?: string;
  targetName?: string;
  fromUserId: string;
  fromName: string;
  updatedAt: number;
}

/** The (userId, name, color) triple a caller tracks as "self". */
export interface SelfIdentity {
  userId: string;
  name: string;
  color: string;
}

/**
 * A live canvas editing op, broadcast over the org Realtime channel.
 *   - 'move': a node was dragged to a new position (nodeId → x/y).
 *   - 'note': a canvas note was added/updated.
 */
export interface CanvasOp {
  projectId: string;
  kind: 'move' | 'note';
  /** Canvas node id (a NodeRef string like "draft:…" / "mission:…"). */
  nodeId?: string;
  /** New node position for 'move' ops. */
  position?: { x: number; y: number };
  /** Note id for 'note' ops. */
  noteId?: string;
  /** Note payload for 'note' ops. */
  note?: { text: string; projectId?: string };
  fromUserId: string;
  fromName: string;
  updatedAt: number;
}
