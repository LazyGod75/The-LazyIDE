/* botTypes — core types for the LazyBot surface.

   A LazyBot is a persistent, shareable agent persona with cloud capabilities
   (Solari browser/desktop/sandbox). Bots are stored locally (.lazy/bots.json)
   and optionally in Supabase for sharing. Each bot run launches a managed agent
   mission with a bot-specific system prompt, tool policy, and autonomy mode
   that wires into the approval gate.

   See botEngine.ts for the launch/stop logic and botStorage.ts for persistence.
*/

/** A LazyBot configuration. */
export interface BotConfig {
  id: string;
  name: string;
  avatar?: string;
  description: string;
  /** The system prompt that defines the bot's persona and instructions.
   *  Injected as agentSystemPrompt into planAndActManaged. */
  systemPrompt: string;
  /** Autonomy mode for the approval gate. */
  autonomy: 'manual' | 'supervised' | 'yolo';
  /** Cloud capabilities the bot is allowed to use. */
  capabilities: BotCapabilities;
  /** Recurring routines (cron-like schedules). Empty = manual-only bot. */
  routines: BotRoutine[];
  /** Solari browser profiles this bot can attach to. */
  profileIds: string[];
  /** Optional USD spend cap for this bot (0 / undefined = unlimited). */
  budgetCapUsd?: number;
  /** Whether the bot is currently enabled (paused bots don't run routines). */
  enabled: boolean;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last modification. */
  updatedAt: string;
}

export interface BotCapabilities {
  browser: boolean;
  desktop: boolean;
  sandbox: boolean;
  /** Maximum concurrent cloud sessions (budget guard). Default 1. */
  maxConcurrentSessions: number;
}

export interface BotRoutine {
  id: string;
  name: string;
  /** Cron expression (e.g. "0 9 * * 1-5" = weekdays at 9am). Empty when the
   *  routine is purely event-driven (see `trigger`). */
  schedule: string;
  /** The task prompt to run on each tick. */
  task: string;
  /** Whether this routine is enabled. */
  enabled: boolean;
  /** Last run timestamp (ISO), or null if never run. */
  lastRunAt: string | null;
  /** Optional event trigger — the routine fires when the event happens,
   *  independent of (or instead of) the cron schedule. Deduped via
   *  `lastTriggerToken` so the same event never fires twice. */
  trigger?: BotRoutineTrigger;
  /** Token of the last event that fired this routine (e.g. a commit SHA for
   *  git triggers, a mission id for mission triggers). Persisted so a
   *  restart never re-fires an already-seen event. */
  lastTriggerToken?: string | null;
}

/** Event-driven trigger (Cursor Projects "subscriptions" parity, local-first):
 *  the routine fires when something HAPPENS, not only on a clock tick.
 *  - git_commit: a new HEAD lands on the project's current branch
 *  - mission_done: a mission of this project reaches a terminal status
 *    (arg = optional status filter 'done'|'failed', default both) */
export type BotRoutineTrigger =
  | { kind: 'git_commit' }
  | { kind: 'mission_done'; status?: 'done' | 'failed' };

/** A bot run — a mission launched by a bot (manual or routine). */
export interface BotRun {
  id: string;
  botId: string;
  missionId: string;
  routineId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  summary?: string;
}

/** The runtime state of a bot — tracked in-memory while the app is open. */
export interface BotRuntimeState {
  botId: string;
  activeRuns: string[];
  lastError?: string;
}

/** The mission input a bot run needs created in the agents store. Mirrors
 *  the subset of NewMissionInput (agentsStore.tsx) that carries the bot's
 *  identity — the store's addMission does the real creation (visible card,
 *  worktree, journal, engine routing). */
export interface BotMissionInput {
  title: string;
  agentTask: string;
  /** The bot's display name — shown on the mission card / timeline as the
   *  acting agent. Display only: the persona below is already resolved, so
   *  the loop never looks this name up in the local agents registry. */
  agentName?: string;
  /** Bot persona + policy (buildBotSystemPrompt) — becomes the managed
   *  loop's agentSystemPrompt via Mission.agentSystemPrompt. */
  agentSystemPrompt: string;
  /** Exhaustive list of tools the bot may execute: its enabled cloud_*
   *  families plus BOT_LOCAL_TOOLS (buildBotToolPolicy). Never the local
   *  code-agent toolbox — a LazyBot is a Solari cloud computer. */
  allowedTools?: string[];
  /** Cloud tools denied by the bot's capabilities (buildBotToolPolicy). */
  deniedTools: string[];
  /** The bot's own autonomy mode — threads into the cloud approval gate. */
  botAutonomy: BotConfig['autonomy'];
  /** The owning bot's id — marks the mission as a LazyBot run. */
  botId: string;
  /** Resolved model label for the mission. */
  modelLabel: string;
}

/** Options for launching a bot run. The caller provides `createMission`
 *  (the agents store's addMission, or an equivalent) so the run becomes a
 *  REAL, visible mission — the engine never spins a headless loop itself
 *  (the original design did exactly that and the run was invisible to the
 *  canvas, the manager's mission digest, and stop/retire paths). */
export interface BotRunLaunchOpts {
  /** Creates the visible mission and returns its real mission id. */
  createMission: (input: BotMissionInput) => Promise<string>;
  model: string;
  routineId?: string;
}

/** Default capabilities for a new bot. */
export const DEFAULT_CAPABILITIES: BotCapabilities = {
  browser: true,
  desktop: false,
  sandbox: false,
  maxConcurrentSessions: 1,
};
