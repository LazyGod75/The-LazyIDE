/* botEngine — orchestrates LazyBot runs.

   Bridges between a BotConfig and the REAL mission machinery: builds the bot
   system prompt and tool policy, delegates mission creation to the agents
   store's addMission (via the caller-provided createMission callback — the
   mission is visible on the canvas, journaled, engine-routed, and stoppable
   exactly like any other mission), and tracks runtime state keyed by the
   REAL mission id so the canvas bot node, the LazyManager's query/stop
   actions, and the inline approval gate all resolve against it.

   The original design called planAndActManaged directly with no-op
   callbacks — the run existed only in this module's memory: no mission card,
   no canvas node, invisible to the manager's mission digest (query_mission
   honestly reported "nothing matches"), and unstoppable except through this
   module's private abort map. Delegating to addMission fixes the whole chain.

   Solari session cleanup (releaseAll) is called on finish/stop to avoid
   orphaned cloud sessions.
*/

import type { BotConfig, BotRun, BotRunLaunchOpts, BotRuntimeState, BotMissionInput } from './botTypes.js';
import { emit } from '../bus.js';
import { releaseAll, takeBrowserArtifacts, registerRunArtifactStamper } from '../solari/solariSessions.js';
import { checkBotBudgetExceeded, checkBotBudgetWarning, setBotBudgetCap } from './budgetGuard.js';
import {
  appendBotRunHistory,
  formatBotLastTime,
  loadBotLastTime,
  loadPersistedRuns,
  persistActiveRuns,
  removePersistedRuns,
} from './botRuntimeStore.js';

// ── Cloud tool name constants ──────────────────────────────────────

const CLOUD_BROWSER_TOOLS = [
  'cloud_browser_open', 'cloud_browser_close', 'cloud_browser_navigate',
  'cloud_browser_read_page', 'cloud_browser_click', 'cloud_browser_type',
  'cloud_browser_screenshot', 'cloud_browser_scroll', 'cloud_browser_wait',
  'cloud_browser_replay_url', 'cloud_browser_profiles_list', 'cloud_browser_profile_save',
  'cloud_browser_press_key', 'cloud_browser_profile_create',
] as const;

const CLOUD_DESKTOP_TOOLS = [
  'cloud_desktop_open', 'cloud_desktop_close', 'cloud_desktop_screenshot',
  'cloud_desktop_stream_url', 'cloud_desktop_mouse_click', 'cloud_desktop_mouse_move',
  'cloud_desktop_mouse_scroll', 'cloud_desktop_app_open', 'cloud_desktop_process_list',
  'cloud_desktop_keyboard_type', 'cloud_desktop_keyboard_hotkey', 'cloud_desktop_keyboard_press',
  'cloud_desktop_exec', 'cloud_desktop_clipboard_get', 'cloud_desktop_clipboard_set',
  'cloud_desktop_file_write', 'cloud_desktop_file_read', 'cloud_desktop_file_list',
  'cloud_desktop_snapshot', 'cloud_desktop_revert',
] as const;

const CLOUD_SANDBOX_TOOLS = [
  'cloud_sandbox_open', 'cloud_sandbox_close', 'cloud_sandbox_read_file',
  'cloud_sandbox_file_list', 'cloud_sandbox_write_file', 'cloud_sandbox_exec',
  'cloud_sandbox_preview_url', 'cloud_sandbox_run_code', 'cloud_sandbox_file_search',
  'cloud_sandbox_download', 'cloud_sandbox_upload',
  'cloud_sandbox_command_start', 'cloud_sandbox_command_poll',
] as const;

// ── System prompt builder ──────────────────────────────────────────

const AUTONOMY_DESCRIPTIONS: Record<BotConfig['autonomy'], string> = {
  manual: 'MANUAL: every non-readonly cloud action requires explicit human approval before it executes. You will be blocked until the user approves, denies, or edits your action.',
  supervised: 'SUPERVISED: consequential actions (payments, deletions, credentials, publishing) require human approval; safe actions (browsing, reading, typing) proceed automatically.',
  yolo: 'YOLO: only credential-related actions require approval; everything else proceeds automatically. Use with caution.',
};

/** Builds the system prompt for a bot run. Composes the bot's persona with a
 *  BOT_POLICY_BLOCK and a CLOUD_TOOL_INDEX listing available cloud_* tools. */
export function buildBotSystemPrompt(bot: BotConfig, lastTimeNote?: string): string {
  const lines: string[] = [];

  // 1. Bot persona
  lines.push(bot.systemPrompt);
  lines.push('');

  // 2. Bot policy block
  lines.push('=== BOT POLICY ===');
  lines.push(`Autonomy mode: ${bot.autonomy.toUpperCase()}`);
  lines.push(AUTONOMY_DESCRIPTIONS[bot.autonomy]);
  lines.push('');
  lines.push('You have access to cloud computer tools (Solari). Use them to browse the web, control a desktop VM, or run code in sandboxes.');
  if (bot.capabilities.browser) {
    lines.push('- Use cloud_browser_open to start a browser session, then cloud_browser_navigate to go to a URL.');
  }
  if (bot.capabilities.desktop) {
    lines.push('- Use cloud_desktop_open to acquire the shared Agent Computer (desktop VM), then cloud_desktop_* tools to interact.');
  }
  if (bot.capabilities.sandbox) {
    lines.push('- Use cloud_sandbox_open to start a code sandbox, then cloud_sandbox_* tools to run code.');
  }
  const closeTools: string[] = [];
  if (bot.capabilities.browser) closeTools.push('cloud_browser_close');
  if (bot.capabilities.desktop) closeTools.push('cloud_desktop_close');
  if (bot.capabilities.sandbox) closeTools.push('cloud_sandbox_close');
  lines.push(`- Sessions are per-mission and managed automatically — you do not need to manage session lifecycle, but you SHOULD close sessions when done (${closeTools.join(', ')}).`);
  if (bot.capabilities.browser && bot.profileIds.length > 0) {
    lines.push(`- You have persistent logins via Solari profiles: ${bot.profileIds.join(', ')}. Pass profile_id to cloud_browser_open to attach a profile.`);
  }
  lines.push('- The approval gate will intercept consequential actions and may block until the user approves. If blocked, wait for the outcome — do not retry the same action.');
  lines.push('- Login, 2FA, captcha, payment, or anything only a human can complete: ACTION: bot_wait_for_human with {"reason":"login|2fa|captcha|payment","detail":"what the human must do"} — it PAUSES your run until the human resolves it, then resumes you automatically. Use bot_request_intervention instead only when you can keep working without the answer. Never guess passwords or 2FA codes.');
  lines.push('- To delegate to another LazyBot: ACTION: bot_handoff {"to":"bot_id_or_name","task":"...","context":"optional","blocking":true} — with blocking:true you get the child bot\'s report back; without it the handoff is fire-and-forget.');
  if (bot.capabilities.desktop) {
    lines.push('- Desktop pro tips: cloud_desktop_mouse_click/move accept {"humanize":true} for natural motion (less bot-detectable); cloud_desktop_snapshot checkpoints the VM before a risky step, cloud_desktop_revert restores it.');
  }
  if (bot.capabilities.sandbox) {
    lines.push('- Sandbox pro tips: cloud_sandbox_run_code keeps a stateful kernel (variables persist across calls) and renders charts; cloud_sandbox_command_start launches a long-running process you poll with cloud_sandbox_command_poll.');
  }
  if (bot.capabilities.browser) {
    lines.push('- Browser pro tips: cloud_browser_open accepts profile_id OR profile_name (auto-created), proxy_country/proxy_tier (residential|static|mobile|smart), proxy_session (sticky IP), captcha:true, recording:true. cloud_browser_profile_save persists your logins into the attached profile — call it AFTER a successful login so next run stays logged in.');
  }
  lines.push('- write_file saves under .lazy/bot-deliverables/<botId>/ (local project silo).');
  const cloudWriters = [
    bot.capabilities.desktop ? 'cloud_desktop_file_write' : null,
    bot.capabilities.sandbox ? 'cloud_sandbox_write_file' : null,
  ].filter(Boolean).join(' / ');
  if (cloudWriters) {
    lines.push(`- ${cloudWriters} save under /workspace/bot-deliverables/<botId>/ (same relative suffix as local).`);
  }
  lines.push('- Cloud files live on the Solari Agent Computer /workspace volume — NOT the same disk as write_file. Copy results deliberately (local write_file vs cloud_*_file_write).');
  lines.push('');

  // 3. Cloud tool index
  lines.push('=== AVAILABLE CLOUD TOOLS ===');
  if (bot.capabilities.browser) {
    lines.push('Browser: ' + CLOUD_BROWSER_TOOLS.join(', '));
  }
  if (bot.capabilities.desktop) {
    lines.push('Desktop: ' + CLOUD_DESKTOP_TOOLS.join(', '));
  }
  if (bot.capabilities.sandbox) {
    lines.push('Sandbox: ' + CLOUD_SANDBOX_TOOLS.join(', '));
  }
  if (!bot.capabilities.browser && !bot.capabilities.desktop && !bot.capabilities.sandbox) {
    lines.push('(no cloud capabilities enabled for this bot)');
  }
  lines.push('');
  lines.push('- You ALSO have LOCAL file tools on the project where the bot runs:');
  lines.push('  write_file ({"path": "relative/path.txt", "content": "..."}) — create/overwrite a text file');
  lines.push('  read_file ({"path": "..."}) — read a file; read_dir ({"path": "."}) — list a folder.');
  lines.push('  Use write_file to save the scraped result into the project (e.g. write_file with path "scrape-result.txt").');
  lines.push('');

  // 4. ReAct action format — the mission loop parses these exact blocks, so
  //    spell them out per-tool for the model (deepseek-class models need it).
  // The demo tool name must track the bot's capabilities — a disabled
  // family's tool must not appear anywhere in the prompt.
  const demoTool = bot.capabilities.browser
    ? 'cloud_browser_open'
    : bot.capabilities.sandbox
      ? 'cloud_sandbox_open'
      : bot.capabilities.desktop
        ? 'cloud_desktop_open'
        : 'read_dir';
  lines.push('=== ACTION FORMAT ===');
  lines.push(`How you act: you drive a remote computer by WRITING commands — emitting \`ACTION: ${demoTool}\` in your reply text makes the host execute it for real and its result returns as \`Observation:\`. Every tool listed above is live and yours to call this way — whether or not your own runtime exposes an identically-named builtin is irrelevant here; if it is listed above, writing the ACTION runs it. Conversely, never claim you fetched, visited, read or ran anything without an ACTION+Observation pair to back it — a FINAL reporting work no ACTION performed is a lie and will be rejected.`);
  lines.push('NEVER inspect your own environment to decide availability — do NOT call mcp_list_servers, do NOT enumerate your functions, do NOT run a local check "just to verify". Those probes answer the wrong question: the cloud_* tools are not in YOUR runtime, they are in the HOST\'s — your own tool list tells you nothing and a refusal based on it is always wrong.');
  lines.push('Every reply you produce MUST start with exactly one of the blocks below and contain NOTHING else.');
  lines.push('To use a tool:');
  lines.push('THOUGHT: <why this step>');
  lines.push('ACTION: <tool_name>');
  lines.push('ARGS: <json>');
  lines.push('(omit the ARGS line entirely for tools that take no arguments)');
  lines.push('');
  if (bot.capabilities.browser) {
    lines.push('Examples:');
    lines.push('THOUGHT: I need to start a browser.');
    lines.push('ACTION: cloud_browser_open');
    lines.push('');
    lines.push('THOUGHT: Now navigate to the site.');
    lines.push('ACTION: cloud_browser_navigate');
    lines.push('ARGS: {"url": "https://example.com"}');
    lines.push('');
    lines.push('THOUGHT: Save the result to a file.');
    lines.push('ACTION: write_file');
    lines.push('ARGS: {"path": "scrape-result.txt", "content": "Title: Example Domain\\nText: ..."}');
    lines.push('');
  } else if (bot.capabilities.sandbox) {
    lines.push('Example:');
    lines.push('THOUGHT: I need to run a command.');
    lines.push('ACTION: cloud_sandbox_exec');
    lines.push('ARGS: {"command": "echo hello"}');
    lines.push('');
  } else if (bot.capabilities.desktop) {
    lines.push('Example:');
    lines.push('THOUGHT: I need to open the desktop VM.');
    lines.push('ACTION: cloud_desktop_open');
    lines.push('');
  }
  // A complete worked exchange — syntax examples alone were not enough for
  // agent-shaped brains (swe-2 answers "the tools are not in MY session" in
  // prose); showing the host's Observation replies demonstrates the bridge.
  lines.push('=== A REAL EXCHANGE (this is exactly how it works) ===');
  lines.push('you → THOUGHT: I need my remote computer.');
  lines.push(`      ACTION: ${demoTool}`);
  lines.push('host → Observation: Session opened (id: sess_abc123).');
  lines.push('you → THOUGHT: The session is up — now I do the task.');
  lines.push('      ACTION: <next tool>');
  lines.push('      ARGS: {...}');
  lines.push('host → Observation: <real result>');
  lines.push('you → FINAL: <structured report>');
  lines.push('Your FIRST reply must already be an ACTION — never a preamble claiming the tools are unavailable. They are: the host just proved it above. Verifying availability by inspecting your own toolset is forbidden — it answers a different question (what YOUR runtime has, not what the HOST will run).');
  lines.push('');
  lines.push('When the task is done, your reply is a STRUCTURED report so the human can review it:');
  lines.push('FINAL:');
  lines.push('RESULT: <one-line outcome>');
  lines.push('FACTS:');
  lines.push('- <verified fact with source url/path>');
  lines.push('ACTIONS:');
  lines.push('- <what you actually did (clicks, files written, sessions used)>');
  lines.push('PENDING:');
  lines.push('- <approvals/handoffs still outstanding, or "none">');
  lines.push('OPEN QUESTIONS:');
  lines.push('- <what you could not verify or decide, or "none">');
  lines.push('EVIDENCE:');
  lines.push('- <deliverable paths (.lazy/bot-deliverables/...), replay/session ids, screenshot notes>');
  lines.push('Keep every section even when empty ("none") — reviewers rely on the structure.');
  lines.push('');
  if (lastTimeNote) {
    lines.push('=== LAST TIME ===');
    lines.push(lastTimeNote);
    lines.push('');
  }
  lines.push('CRITICAL LOOP RULES:');
  lines.push('- After EVERY tool call you receive a line "Observation: ...". Read it, then reply with the NEXT block.');
  lines.push('- Never narrate in prose, never explain, never apologize, never ask — ONLY the next THOUGHT/ACTION/FINAL block.');
  if (bot.capabilities.browser) {
    lines.push('- After cloud_browser_open, immediately emit the navigate step (do not stop).');
  }
  lines.push('- Do NOT repeat an ACTION that already succeeded in a previous step.');
  lines.push('- If the same tool fails twice with a service-side error, stop retrying it — report the failure in your FINAL report (OPEN QUESTIONS) and, if it blocks the task, escalate via bot_request_intervention or ask_user before ending the run.');

  return lines.join('\n');
}

// ── Tool policy builder ────────────────────────────────────────────

/** The only LOCAL tools a LazyBot may use — exactly the ones its system
 *  prompt documents (save/read a result file, list a folder) plus ask_user
 *  for the "I need a human" case (login, captcha, ambiguous choice). A bot
 *  is a Solari cloud computer, not a local code agent: edit_file,
 *  run_command, run_tests, git_* and the rest of the code-agent toolbox are
 *  deliberately absent (see runLazyBotMission.ts). */
export const BOT_LOCAL_TOOLS = [
  'write_file', 'read_file', 'read_dir', 'ask_user',
  'bot_request_intervention', 'bot_wait_for_human', 'bot_handoff',
] as const;

/** Returns the tool allow/deny lists based on the bot's capabilities.
 *  `allowedTools` is the exhaustive list the loop may execute (enabled
 *  cloud_* families + BOT_LOCAL_TOOLS); `deniedTools` keeps listing the
 *  disabled cloud families explicitly so a disabled family stays blocked
 *  even for a caller that only forwards the deny list. */
export function buildBotToolPolicy(bot: BotConfig): { allowedTools: string[]; deniedTools: string[] } {
  const allowed: string[] = [];
  const denied: string[] = [];
  (bot.capabilities.browser ? allowed : denied).push(...CLOUD_BROWSER_TOOLS);
  (bot.capabilities.desktop ? allowed : denied).push(...CLOUD_DESKTOP_TOOLS);
  (bot.capabilities.sandbox ? allowed : denied).push(...CLOUD_SANDBOX_TOOLS);
  allowed.push(...BOT_LOCAL_TOOLS);
  return { allowedTools: allowed, deniedTools: denied };
}

// ── Runtime state ──────────────────────────────────────────────────
// Pinned on globalThis to survive Vite dev-mode double module instances.
type BotRuntimeStateMap = Map<string, BotRuntimeState>;
const _g = globalThis as typeof globalThis & { __lazyBotRuntimeStates?: BotRuntimeStateMap; __lazyActiveBotRuns?: Map<string, BotRun>; };
const runtimeStates: BotRuntimeStateMap = (_g.__lazyBotRuntimeStates ??= new Map());

function getOrCreateState(botId: string): BotRuntimeState {
  let state = runtimeStates.get(botId);
  if (!state) {
    state = { botId, activeRuns: [] };
    runtimeStates.set(botId, state);
  }
  return state;
}

/** Returns the in-memory runtime state for a bot. */
export function getBotRuntimeState(botId: string): BotRuntimeState {
  return getOrCreateState(botId);
}

// ── Launch / stop ──────────────────────────────────────────────────

/** Live BotRun objects for every launched run, keyed by missionId (the REAL
 *  agents-store mission id — the same key the cloud approval gate and the
 *  manager's mission digest use). Entries are removed the instant a run
 *  finishes (finishBotRun — wired by agentsStore's runMission chain) or is
 *  stopped (stopBotRun), so the values here are exactly the bot's currently
 *  active runs. Powers the `listActiveRunsForBot` helper (the LazyManager's
 *  stop_lazybot action) and the canvas bot node's working/waiting halo. */
const activeBotRuns: Map<string, BotRun> = (_g.__lazyActiveBotRuns ??= new Map());

/** Registers an ALREADY-CREATED mission as a bot's active run (runtime
 *  state + run bookkeeping, keyed by the real mission id). Used by
 *  launchBotRun after createMission, and by agentsStore's retryMission when
 *  a botrun mission's clone relaunches outside the addMission input path. */
export function registerBotRun(botId: string, missionId: string, routineId?: string): BotRun {
  const state = getOrCreateState(botId);
  state.activeRuns.push(missionId);
  const run: BotRun = {
    id: `run_${missionId}`,
    botId,
    missionId,
    routineId,
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  activeBotRuns.set(missionId, run);
  persistRunning();
  emit('lazybots:runtimeChanged', { botId });
  return run;
}

/** The bot that owns a live mission, if any. */
export function botIdForMission(missionId: string | undefined): string | undefined {
  if (!missionId) return undefined;
  return activeBotRuns.get(missionId)?.botId;
}

/** Maps a bot run's BotMissionInput onto the agents store's NewMissionInput
 *  shape — the ONE place the launch sites (the manager's run_lazybot, the
 *  Bots space, the routine scheduler) agree on what a LazyBot mission is:
 *  no repo/worktree of its own (`repo: '.'`, `worktree: ''` — the LazyBot
 *  runtime never creates a git worktree, see runLazyBotMission.ts), the bot
 *  persona + exhaustive tool allowlist, and the bot identity fields that
 *  make runMission divert it to that runtime. */
export function toBotNewMissionInput(
  input: BotMissionInput,
  extra?: { originConversationId?: string },
): {
  title: string;
  agentTask: string;
  agentName?: string;
  agentSystemPrompt: string;
  allowedTools?: string[];
  deniedTools: string[];
  botAutonomy: BotConfig['autonomy'];
  botId: string;
  repo: string;
  worktree: string;
  modelLabel: string;
  mode: 'agent';
  orchestrator: boolean;
  permissionMode: 'acceptEdits';
  originConversationId?: string;
} {
  return {
    title: input.title,
    agentTask: input.agentTask,
    agentName: input.agentName,
    agentSystemPrompt: input.agentSystemPrompt,
    allowedTools: input.allowedTools,
    deniedTools: input.deniedTools,
    botAutonomy: input.botAutonomy,
    botId: input.botId,
    repo: '.',
    worktree: '',
    modelLabel: input.modelLabel,
    mode: 'agent',
    orchestrator: false,
    permissionMode: 'acceptEdits',
    ...(extra?.originConversationId ? { originConversationId: extra.originConversationId } : {}),
  };
}

function assertBotCanLaunch(bot: BotConfig): void {
  if (typeof bot.budgetCapUsd === 'number' && bot.budgetCapUsd > 0) {
    setBotBudgetCap(bot.id, bot.budgetCapUsd);
  }
  const exceeded = checkBotBudgetExceeded(bot.id);
  if (exceeded) throw new Error(exceeded);
  const warning = checkBotBudgetWarning(bot.id);
  if (warning) console.warn(`[lazybot] ${warning}`);
  const max = bot.capabilities.maxConcurrentSessions || 1;
  const state = getOrCreateState(bot.id);
  // Count REAL running runs from activeBotRuns (the source of truth),
  // not activeRuns which can hold stale ids after HMR/crash. Pending
  // launch slots (__pending_) still count to prevent double-launch races.
  // A reservation is idempotent and persists for the entire launch phase:
  // it is released ONLY on a confirmed result (success, definitive
  // failure, or explicit cancellation via abortLaunchSlot) — never by a
  // wall-clock timeout, which would let a slow createMission leak a slot
  // and admit a second run past the concurrency cap.
  const realRunning = [...activeBotRuns.values()].filter(
    (r) => r.botId === bot.id && r.status === 'running',
  ).length;
  const pendingSlots = state.activeRuns.filter((id) => id.startsWith('__pending_')).length;
  // Sync activeRuns to reality so listActiveRunsForBot and the UI stay honest.
  state.activeRuns = [
    ...[...activeBotRuns.values()].filter((r) => r.botId === bot.id && r.status === 'running').map((r) => r.missionId),
    ...state.activeRuns.filter((id) => id.startsWith('__pending_')),
  ];
  const active = realRunning + pendingSlots;
  if (active >= max) {
    throw new Error(`Bot "${bot.name}" already has ${active} concurrent run(s) (max ${max}).`);
  }
}

function beginLaunchSlot(bot: BotConfig): string {
  assertBotCanLaunch(bot);
  const slot = `__pending_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  getOrCreateState(bot.id).activeRuns.push(slot);
  emit('lazybots:runtimeChanged', { botId: bot.id });
  return slot;
}

function abortLaunchSlot(botId: string, slot: string): void {
  const state = runtimeStates.get(botId);
  if (!state) return;
  state.activeRuns = state.activeRuns.filter((id) => id !== slot);
  emit('lazybots:runtimeChanged', { botId });
}

function snapshotRunning(): BotRun[] {
  return [...activeBotRuns.values()].filter((r) => r.status === 'running');
}

function persistRunning(): void {
  void persistActiveRuns(snapshotRunning());
}

// Replay artifacts captured mid-run (browser close before mission settle)
// must outlive a renderer reload: the in-memory browserArtifacts map is
// wiped on reload, but this stamper writes them onto the PERSISTED run —
// pruneBotRunsNotLive's `{...run}` append then still carries replayUrl/
// replayPath into the history entry (real M138 incident). Registered at
// module init; a no-op for missions whose run already left activeBotRuns
// (finish/stop still read the in-memory map via takeBrowserArtifacts).
registerRunArtifactStamper((missionId, artifact) => {
  const run = activeBotRuns.get(missionId);
  if (!run) return;
  if (artifact.replayUrl) run.replayUrl = artifact.replayUrl;
  if (artifact.replayPath) run.replayPath = artifact.replayPath;
  persistRunning();
});

/** Launches a bot run as a REAL, visible managed mission. The mission is
 *  created through `opts.createMission` (the agents store's addMission) so
 *  it gets a canvas card, journal rows, engine routing (managed/BYOK/native
 *  via classifyMissionModel — no duplicated routing here), and the store's
 *  stop/pause/intervene paths. This function then only tracks the run's
 *  runtime state keyed by the real mission id. */
export async function launchBotRun(
  bot: BotConfig,
  task: string,
  opts: BotRunLaunchOpts,
): Promise<BotRun> {
  const slot = beginLaunchSlot(bot);
  try {
    const last = await loadBotLastTime(bot.id);
    const policy = buildBotToolPolicy(bot);
    const missionId = await opts.createMission({
      title: `${bot.name}: ${task.slice(0, 60)}`,
      agentTask: task,
      agentName: bot.name,
      agentSystemPrompt: buildBotSystemPrompt(bot, last ? formatBotLastTime(last) : undefined),
      allowedTools: policy.allowedTools,
      deniedTools: policy.deniedTools,
      botAutonomy: bot.autonomy,
      botId: bot.id,
      modelLabel: opts.model,
    });

    abortLaunchSlot(bot.id, slot);
    return registerBotRun(bot.id, missionId, opts.routineId);
  } catch (err) {
    abortLaunchSlot(bot.id, slot);
    throw err;
  }
}

/** Marks a bot run finished and releases its Solari sessions. Called by the
 *  agents store when a bot mission reaches its end (runMission resolved or
 *  threw — see addMission's launch chain). Idempotent: an unknown/already
 *  finished missionId is a no-op, so both the resolve and catch paths can
 *  call it safely. Never throws — cleanup is best-effort. */
export async function finishBotRun(missionId: string, summary?: string): Promise<void> {
  const run = activeBotRuns.get(missionId);
  if (!run) return;
  const state = runtimeStates.get(run.botId);
  if (state) {
    state.activeRuns = state.activeRuns.filter((id) => id !== missionId);
  }
  run.status = 'completed';
  run.completedAt = new Date().toISOString();
  if (summary) run.summary = summary;
  activeBotRuns.delete(missionId);
  persistRunning();
  emit('lazybots:runtimeChanged', { botId: run.botId });
  // releaseAll → releaseBrowser captures the replay BEFORE we snapshot the
  // run into history, so the recording URL lands on the persisted record.
  await releaseAll(missionId).catch(() => {});
  const artifacts = takeBrowserArtifacts(missionId);
  if (artifacts?.replayUrl) run.replayUrl = artifacts.replayUrl;
  if (artifacts?.replayPath) run.replayPath = artifacts.replayPath;
  void appendBotRunHistory({ ...run });
}

/** Stops a running bot run's bookkeeping and releases its cloud sessions.
 *  The REAL abort belongs to the agents store (stopMission aborts the
 *  mission's own stopFlag/controller); this only clears the bot-engine
 *  tracking so the runtime state stays honest. Idempotent. */
export async function stopBotRun(run: BotRun): Promise<void> {
  const state = runtimeStates.get(run.botId);
  if (state) {
    state.activeRuns = state.activeRuns.filter((id) => id !== run.missionId);
  }
  run.status = 'cancelled';
  run.completedAt = new Date().toISOString();
  activeBotRuns.delete(run.missionId);
  persistRunning();
  emit('lazybots:runtimeChanged', { botId: run.botId });
  await releaseAll(run.missionId).catch(() => {});
  const artifacts = takeBrowserArtifacts(run.missionId);
  if (artifacts?.replayUrl) run.replayUrl = artifacts.replayUrl;
  if (artifacts?.replayPath) run.replayPath = artifacts.replayPath;
  void appendBotRunHistory({ ...run });
}

/** Attach a summary onto a still-tracked (or just-finished) run — called from
 *  the LazyBot runtime once the FINAL report is known (C53). */
export function setBotRunSummary(missionId: string, summary: string): void {
  const run = activeBotRuns.get(missionId);
  if (run) run.summary = summary;
}

/** Returns every currently active BotRun for a bot (additive helper used by
 *  the LazyManager's `stop_lazybot` action). Never throws — unknown bot ids
 *  simply yield an empty array. */
export function listActiveRunsForBot(botId: string): BotRun[] {
  return [...activeBotRuns.values()].filter((r) => r.botId === botId && r.status === 'running');
}

// ── Boot serialization lock ────────────────────────────────────────
// restoreBotRuntime and pruneBotRunsNotLive both mutate activeBotRuns and
// the persisted runtime file. Without serialization they race: prune
// snapshots [...activeBotRuns.values()] while restore is mid-set, or
// restore rehydrates a run prune just removed from disk — leaving a zombie
// in memory that blocks all future launches (M105-class lockout). This
// promise-chain lock makes the two operations mutually exclusive. Callers
// are unchanged (both are async and already awaited or fire-and-forget).
let bootLock: Promise<unknown> = Promise.resolve();
function withBootLock<T>(op: () => Promise<T>): Promise<T> {
  const run = bootLock.then(op, op);
  bootLock = run.then(() => undefined, () => undefined);
  return run;
}

/** Boot-time zombie prune (root-cause fix for the "already has N concurrent
 *  run(s)" lockout). When the app restarts mid-run, the runMission chain that
 *  would have called finishBotRun dies with the process: the boot recovery
 *  pass (applyReplayRecovery / the legacy missions.json fallback, both in
 *  agentsStore) force-fails the mission, but `.lazy/bot-runtime.json` keeps
 *  its run marked 'running' — sometimes since a PREVIOUS boot (the mission is
 *  already 'failed' now, so no interrupted-id list mentions it again).
 *  restoreBotRuntime then rehydrates that zombie on every boot, so the bot is
 *  blocked forever: max 1 concurrent run is already "taken" by a mission that
 *  no longer exists (M105-class incident). This ends bookkeeping for every
 *  run whose mission is NOT in `liveMissionIds` (the missions the recovery
 *  pass left genuinely live: native-runner-reattached 'running' + queued
 *  relaunch candidates). Idempotent and order-independent — it prunes BOTH
 *  the in-memory maps (restoreBotRuntime may already have run) AND the
 *  persisted file (restoreBotRuntime may not have run yet), so no later
 *  restore can resurrect the zombie. Best-effort, never throws. Returns how
 *  many runs were cleared (in-memory + disk, each logical run counted once).
 *  Serialized against restoreBotRuntime via bootLock to prevent the
 *  concurrent-mutation race. */
export async function pruneBotRunsNotLive(liveMissionIds: ReadonlySet<string>): Promise<number> {
  return withBootLock(async () => {
    const isLive = (missionId: string) => liveMissionIds.has(missionId);
    let cleared = 0;
    const inMemoryClearedIds = new Set<string>();
    // 1. In-memory runs — restoreBotRuntime may already have rehydrated the
    //    persisted zombies by the time agentsStore's recovery pass runs.
    for (const run of [...activeBotRuns.values()]) {
      if (run.status !== 'running' || isLive(run.missionId)) continue;
      inMemoryClearedIds.add(run.missionId);
      cleared += 1;
      const state = runtimeStates.get(run.botId);
      if (state) {
        state.activeRuns = state.activeRuns.filter((id) => id !== run.missionId);
      }
      run.status = 'cancelled';
      run.completedAt = new Date().toISOString();
      activeBotRuns.delete(run.missionId);
      // Visible in the bot's RunHistory (same shape stopBotRun uses) — a swept
      // run must not vanish without a trace.
      void appendBotRunHistory({ ...run });
      await releaseAll(run.missionId).catch(() => {});
    }
    // 2. Persisted runs — without this a later restoreBotRuntime would re-add
    //    exactly the zombie we just cleared (restore may not have run yet).
    const persistedRuns = await loadPersistedRuns();
    const diskZombies = persistedRuns.filter((r) => !isLive(r.missionId));
    if (diskZombies.length > 0) {
      await removePersistedRuns(new Set(diskZombies.map((r) => r.missionId)));
      for (const run of diskZombies) {
        if (inMemoryClearedIds.has(run.missionId)) continue; // already counted above
        cleared += 1;
        const cancelled = { ...run, status: 'cancelled' as const, completedAt: new Date().toISOString() };
        void appendBotRunHistory(cancelled);
        await releaseAll(run.missionId).catch(() => {});
      }
    }
    return cleared;
  });
}

/** Clear all runtime state — tests and hot-reload only. */
export function resetBotEngineState(): void {
  runtimeStates.clear();
  activeBotRuns.clear();
}

/** Rehydrate in-memory maps from `.lazy/bot-runtime.json` after a crash.
 *  Serialized against pruneBotRunsNotLive via bootLock to prevent the
 *  concurrent-mutation race (restore re-adding a run prune is clearing, or
 *  prune snapshotting mid-restore). */
export async function restoreBotRuntime(): Promise<number> {
  return withBootLock(async () => {
    const runs = await loadPersistedRuns();
    for (const run of runs) {
      if (run.status !== 'running') continue;
      activeBotRuns.set(run.missionId, run);
      const state = getOrCreateState(run.botId);
      if (!state.activeRuns.includes(run.missionId)) state.activeRuns.push(run.missionId);
    }
    return activeBotRuns.size;
  });
}
