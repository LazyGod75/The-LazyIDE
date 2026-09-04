/* managerLazyBotCreate — pure assembly of a BotConfig from a manager
 * create_lazybot / update_lazybot patch. Keeps agentsStore's executor thin
 * and mirrors botsStore.createBot's rich fields (profileIds, routines,
 * avatar, budgetCapUsd) without forcing empty profileIds.
 */

import type { BotCapabilities, BotConfig, BotRoutine } from '../bots/botTypes.js';
import { DEFAULT_CAPABILITIES } from '../bots/botTypes.js';

export type CreateLazyBotFields = {
  name: string;
  description?: string;
  systemPrompt?: string;
  autonomy?: BotConfig['autonomy'];
  capabilities?: { browser?: boolean; desktop?: boolean; sandbox?: boolean };
  profileIds?: string[];
  routines?: unknown;
  avatar?: string;
  budgetCapUsd?: number;
};

function generateBotId(): string {
  return `bot_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Coerce model-emitted profile id lists — drop blanks / non-strings. */
export function normalizeProfileIds(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim());
  return ids;
}

/** Coerce model-emitted routines into BotRoutine shapes; skip junk entries. */
export function normalizeRoutines(raw: unknown): BotRoutine[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: BotRoutine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const r = entry as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const schedule = typeof r.schedule === 'string' ? r.schedule.trim() : '';
    const task = typeof r.task === 'string' ? r.task.trim() : '';
    if (!name || !schedule || !task) continue;
    const id =
      typeof r.id === 'string' && r.id.trim()
        ? r.id.trim()
        : `rtn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    out.push({
      id,
      name,
      schedule,
      task,
      enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
      lastRunAt: typeof r.lastRunAt === 'string' ? r.lastRunAt : null,
    });
  }
  return out;
}

function normalizeCapabilities(
  cap: CreateLazyBotFields['capabilities'] | undefined,
): BotCapabilities {
  const boolOr = (v: unknown, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  return {
    browser: boolOr(cap?.browser, DEFAULT_CAPABILITIES.browser),
    desktop: boolOr(cap?.desktop, DEFAULT_CAPABILITIES.desktop),
    sandbox: boolOr(cap?.sandbox, DEFAULT_CAPABILITIES.sandbox),
    maxConcurrentSessions: DEFAULT_CAPABILITIES.maxConcurrentSessions,
  };
}

/**
 * Build a full BotConfig from a create_lazybot action payload.
 * Optional rich fields pass through when present; omitted profileIds /
 * routines become [] only as the BotConfig default — never forced over a
 * provided non-empty list.
 */
export function buildBotConfigFromCreateLazybot(fields: CreateLazyBotFields): BotConfig {
  const now = new Date().toISOString();
  const autonomy = fields.autonomy;
  const resolvedAutonomy: BotConfig['autonomy'] =
    autonomy === 'manual' || autonomy === 'supervised' || autonomy === 'yolo' ? autonomy : 'supervised';

  const profileIds = normalizeProfileIds(fields.profileIds) ?? [];
  const routines = normalizeRoutines(fields.routines) ?? [];
  const avatar = typeof fields.avatar === 'string' && fields.avatar.trim() ? fields.avatar.trim() : undefined;
  const budgetCapUsd =
    typeof fields.budgetCapUsd === 'number' && Number.isFinite(fields.budgetCapUsd) && fields.budgetCapUsd >= 0
      ? fields.budgetCapUsd
      : undefined;

  return {
    id: generateBotId(),
    name: fields.name.trim(),
    description: String(fields.description ?? ''),
    systemPrompt: String(fields.systemPrompt ?? ''),
    autonomy: resolvedAutonomy,
    capabilities: normalizeCapabilities(fields.capabilities),
    routines,
    profileIds,
    ...(avatar ? { avatar } : {}),
    ...(budgetCapUsd !== undefined ? { budgetCapUsd } : {}),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Sanitize an update_lazybot patch so only real BotConfig fields land, and
 * rich arrays are coerced. Never invents empty profileIds when the patch
 * omitted them.
 */
export function sanitizeLazyBotPatch(patch: Partial<BotConfig> | Record<string, unknown>): Partial<BotConfig> {
  const src = patch as Record<string, unknown>;
  const out: Partial<BotConfig> = {};

  if (typeof src.name === 'string') out.name = src.name;
  if (typeof src.description === 'string') out.description = src.description;
  if (typeof src.systemPrompt === 'string') out.systemPrompt = src.systemPrompt;
  if (src.autonomy === 'manual' || src.autonomy === 'supervised' || src.autonomy === 'yolo') {
    out.autonomy = src.autonomy;
  }
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (typeof src.avatar === 'string') out.avatar = src.avatar.trim() || undefined;
  if (typeof src.budgetCapUsd === 'number' && Number.isFinite(src.budgetCapUsd) && src.budgetCapUsd >= 0) {
    out.budgetCapUsd = src.budgetCapUsd;
  }
  if (src.capabilities && typeof src.capabilities === 'object' && !Array.isArray(src.capabilities)) {
    const c = src.capabilities as Record<string, unknown>;
    out.capabilities = {
      ...DEFAULT_CAPABILITIES,
      ...(typeof c.browser === 'boolean' ? { browser: c.browser } : {}),
      ...(typeof c.desktop === 'boolean' ? { desktop: c.desktop } : {}),
      ...(typeof c.sandbox === 'boolean' ? { sandbox: c.sandbox } : {}),
      ...(typeof c.maxConcurrentSessions === 'number' ? { maxConcurrentSessions: c.maxConcurrentSessions } : {}),
    };
  }

  if ('profileIds' in src) {
    const ids = normalizeProfileIds(src.profileIds);
    if (ids) out.profileIds = ids;
  }
  if ('routines' in src) {
    const routines = normalizeRoutines(src.routines);
    if (routines) out.routines = routines;
  }

  return out;
}
