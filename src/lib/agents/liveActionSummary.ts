/* liveActionSummary.ts — humanizes a FleetMission/Mission's `liveAction`
   field into a short mono phrase for the Cockpit's mission cards
   (CompactMissionCard / UrgentMissionCard).

   Pure, no I/O. `liveAction` is set verbatim from the native agent runner's
   raw step text (see runtime.ts's stepHandler: `${toolName}: ${summary}`,
   where `summary` already repeats the tool name followed by its raw JSON
   args, e.g. `Bash: Bash {"command":"node --test src/lib/pricing.test.js"}`)
   — rendered as-is, this is exactly the kind of raw tool-call JSON dump a
   reader has to parse by eye instead of reading (F2 fix, post-e2e wave).

   Many liveAction values are ALREADY human-readable French sentences with no
   JSON at all (`"Worktree prêt — démarrage du loop…"`, `"Stoppé"`,
   `"Évaluation en cours…"`, `"Retry: <reason>"`) — those pass through
   completely unchanged; only a recognized `<Tool>: ... {json}` shape is
   rewritten.

   i18n note (2026-08 pass): the tool VERB (bash/lit/écrit/…) is translated
   via an optional `t: TFunc` param, same "optional everywhere, falls back to
   the ORIGINAL hardcoded French" contract runtime.ts's own TFunc doc
   comment establishes — UrgentMissionCard.tsx/CompactMissionCard.tsx (both
   already have useI18n's real `t`) now pass it through; the canvas mission
   node (MissionNode.tsx/LoopNode.tsx, both currently off-limits — separate
   WIP) still calls this with no `t`, so it keeps rendering the same French
   verb it always has, never a behavior change for that caller.
*/

import { basename } from '../paths.js';
import type { TFunc } from './runtime.js';

/** Matches `<ToolName>: [<ToolName> ]{...json...}` — the native CLI runner's
 *  raw step text (see module header). The tool name may appear once or
 *  twice (it currently always repeats, but this tolerates either). */
const TOOL_JSON_RE = /^([A-Za-z][\w.]*)\s*:\s*(?:[A-Za-z][\w.]*\s+)?(\{[\s\S]*\})\s*$/;

const MAX_DETAIL_LENGTH = 24;

/** Short French verb per tool name (case-insensitive) — covers the native
 *  CLI tool registry (Bash/PowerShell/Read/Write/Edit/Glob/Grep/...).
 *  Falls back to the lowercased tool name itself for anything unlisted, so a
 *  future/unknown tool still renders a short, JSON-free phrase. */
const TOOL_VERB: Readonly<Record<string, string>> = {
  bash: 'bash',
  powershell: 'commande',
  read: 'lit',
  write: 'écrit',
  edit: 'édite',
  multiedit: 'édite',
  notebookedit: 'édite',
  glob: 'cherche',
  grep: 'cherche',
  websearch: 'recherche web',
  webfetch: 'lit une page web',
  task: 'délègue',
  agent: 'délègue',
  todowrite: 'met à jour le plan',
};

/** Same tool names as {@link TOOL_VERB} above, mapped to their i18n key
 *  instead of a hardcoded French word — used whenever a caller supplies a
 *  real `t`. `agent` reuses `task`'s key (both mean "delegates to a
 *  sub-agent") and multiedit/notebookedit reuse `edit`'s — same grouping
 *  {@link TOOL_VERB} already uses. */
const TOOL_VERB_KEYS: Readonly<Record<string, string>> = {
  bash: 'cockpit.liveAction.verb.bash',
  powershell: 'cockpit.liveAction.verb.command',
  read: 'cockpit.liveAction.verb.read',
  write: 'cockpit.liveAction.verb.write',
  edit: 'cockpit.liveAction.verb.edit',
  multiedit: 'cockpit.liveAction.verb.edit',
  notebookedit: 'cockpit.liveAction.verb.edit',
  glob: 'cockpit.liveAction.verb.glob',
  grep: 'cockpit.liveAction.verb.grep',
  websearch: 'cockpit.liveAction.verb.webSearch',
  webfetch: 'cockpit.liveAction.verb.webFetch',
  task: 'cockpit.liveAction.verb.task',
  agent: 'cockpit.liveAction.verb.task',
  todowrite: 'cockpit.liveAction.verb.todoWrite',
};

/** Resolves the short verb for a lowercased tool name — the translated key
 *  when `t` is supplied and recognized, else the ORIGINAL hardcoded French
 *  word (never a behavior change for a caller that omits `t`). An unknown
 *  tool always falls back to its own lowercased name, in both cases. */
function resolveVerb(toolNameLower: string, t?: TFunc): string {
  if (t) {
    const key = TOOL_VERB_KEYS[toolNameLower];
    return key ? t(key) : toolNameLower;
  }
  return TOOL_VERB[toolNameLower] ?? toolNameLower;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Best-effort short detail extracted from a tool call's JSON args — the
 *  first recognized field, truncated. Returns '' when nothing recognized
 *  (the caller still shows the tool verb alone, never raw JSON). */
function extractDetail(args: unknown): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return '';
  const obj = args as Record<string, unknown>;
  if (typeof obj.command === 'string') return truncate(obj.command, MAX_DETAIL_LENGTH);
  if (typeof obj.file_path === 'string') return truncate(basename(obj.file_path), MAX_DETAIL_LENGTH);
  if (typeof obj.path === 'string') return truncate(basename(obj.path), MAX_DETAIL_LENGTH);
  if (typeof obj.pattern === 'string') return truncate(obj.pattern, MAX_DETAIL_LENGTH);
  if (typeof obj.query === 'string') return truncate(obj.query, MAX_DETAIL_LENGTH);
  if (typeof obj.url === 'string') return truncate(obj.url, MAX_DETAIL_LENGTH);
  return '';
}

/** Structured pieces of a recognized `<Tool>: {json}` live action: a short
 *  French `verb` plus an optional `detail` (file/command/query, already
 *  truncated). Node visual language (P2, cockpit-redesign mockup) — a card's
 *  monospace action line colors the verb distinctly from its target, which
 *  needs these two pieces separately rather than the single pre-joined
 *  string {@link humanizeLiveAction} returns. */
export interface LiveActionParts {
  verb: string;
  detail: string;
}

/** Shared recognition logic behind both {@link humanizeLiveAction} and
 *  {@link humanizeLiveActionParts} — `null` for text with no recognized
 *  `<Tool>: {json}` shape (an already-human passthrough sentence, e.g.
 *  "Stoppé"): never guessed apart into a fake verb/detail pair. */
function computeLiveActionParts(trimmed: string, t?: TFunc): LiveActionParts | null {
  const match = TOOL_JSON_RE.exec(trimmed);
  if (!match) return null;
  const [, toolNameRaw, argsJson] = match;
  const verb = resolveVerb(toolNameRaw.toLowerCase(), t);
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    // Unparsable payload — never guess, never leak raw JSON: fall back to
    // just the tool verb with no detail.
    return { verb, detail: '' };
  }
  return { verb, detail: extractDetail(args) };
}

/**
 * Humanizes a mission's raw `liveAction` into a short mono phrase for the
 * Cockpit's mission cards — e.g. `▊ bash node --test…`, `▊ lit pricing.js…`,
 * `▊ écrit auth.ts…`. Never renders `{`/JSON. Already-human text (no
 * recognized tool-call JSON shape) passes through unchanged.
 */
export function humanizeLiveAction(liveAction: string | undefined, t?: TFunc): string {
  if (!liveAction) return '';
  const trimmed = liveAction.trim();
  const parts = computeLiveActionParts(trimmed, t);
  if (!parts) return trimmed;
  return parts.detail ? `▊ ${parts.verb} ${parts.detail}…` : `▊ ${parts.verb}…`;
}

/**
 * Same recognition as {@link humanizeLiveAction}, but returns the verb and
 * detail as separate strings (never the `▊`/`…` decoration) — for a caller
 * that renders the verb in its own accent color and the detail in a muted
 * one (canvas node cards' action line, cockpit-redesign mockup §"VERB
 * ACTION LINE"). Returns `null` for an already-human passthrough sentence —
 * the caller falls back to plain {@link humanizeLiveAction} text as one flat
 * line in that case, never a fabricated split.
 */
export function humanizeLiveActionParts(liveAction: string | undefined, t?: TFunc): LiveActionParts | null {
  if (!liveAction) return null;
  return computeLiveActionParts(liveAction.trim(), t);
}
