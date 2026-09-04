/* agentSessionGate — unified preflight per access rail.

   Manager turns have managerSessionGate.ts; mission launches used to
   dispatch first and fail mid-run (JWT missing on free/Pro, CLI absent,
   BYOK key missing). This module is the agent-side equivalent: classify
   the rail from the chosen model, then refuse with a precise reason
   BEFORE planAndAct spends a worktree.
*/

import type { ProviderMode } from '../models/index.js';
import { isOpenRouterFreeModel } from '../models/openrouterCatalog.js';
import { BYOK_PROVIDER_DEFS, hasByokKey } from '../models/byokProviders.js';
import { supabase } from '../supabase/client.js';

export type AgentRail = 'free' | 'pro' | 'byok' | 'cli';

export interface AgentSessionGateOk {
  ok: true;
  rail: AgentRail;
}

export interface AgentSessionGateBlocked {
  ok: false;
  rail: AgentRail;
  reasonKey: string;
  reason: string;
}

export type AgentSessionGateResult = AgentSessionGateOk | AgentSessionGateBlocked;

function byokDefForModel(model: string | undefined) {
  if (!model) return undefined;
  for (const def of BYOK_PROVIDER_DEFS) {
    if (def.id === 'anthropic') continue;
    if (def.models.some((m) => m.id === model)) return def;
  }
  return undefined;
}

export function classifyAgentRail(model: string | undefined, mode: ProviderMode): AgentRail {
  if (model && isOpenRouterFreeModel(model)) return 'free';
  // Managed/Pro ai-proxy owns OpenRouter-format ids — the BYOK openrouter
  // catalog lists the same id strings and must not steal managed routing.
  if (mode === 'managed' && model?.includes('/')) return 'pro';
  if (byokDefForModel(model)) return 'byok';
  if (model?.includes('/')) return 'pro';
  if (mode === 'managed') return 'pro';
  if (mode === 'live-key') return 'byok';
  if (mode === 'claude-code' || mode === 'codex') return 'cli';
  return 'cli';
}

export async function hasManagedAuthSession(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    return Boolean(data.session?.access_token);
  } catch {
    return false;
  }
}

const REASONS: Record<AgentRail, { key: string; fallback: string }> = {
  free: {
    key: 'agents.sessionGate.needSession',
    fallback: 'Sign in to use the free model rail.',
  },
  pro: {
    key: 'agents.sessionGate.needPro',
    fallback: 'Sign in with an active Pro plan to run this model.',
  },
  byok: {
    key: 'agents.sessionGate.needByok',
    fallback: 'Add the provider API key in Settings > Models.',
  },
  cli: {
    key: 'agents.sessionGate.needCli',
    fallback: 'Install or connect the Claude / Codex CLI in Settings > Models.',
  },
};

function blocked(rail: AgentRail): AgentSessionGateBlocked {
  const r = REASONS[rail];
  return { ok: false, rail, reasonKey: r.key, reason: r.fallback };
}

/**
 * Async preflight: free/Pro need a real JWT (ai-proxy authenticates even
 * $0 models). BYOK needs the matching key. CLI is allowed without a
 * session — the native binary is the credential.
 *
 * `cliReady` / `proReady` are injected so tests do not have to mock the
 * whole models/index graph; production callers pass isNativeModelReady /
 * isManagedModelReady.
 */
export async function gateAgentSession(opts: {
  model?: string;
  mode: ProviderMode;
  cliReady?: boolean;
  proReady?: boolean;
}): Promise<AgentSessionGateResult> {
  const rail = classifyAgentRail(opts.model, opts.mode);

  if (rail === 'free' || rail === 'pro') {
    if (!(await hasManagedAuthSession())) return blocked(rail);
    if (rail === 'pro' && opts.proReady === false) return blocked('pro');
    return { ok: true, rail };
  }

  if (rail === 'byok') {
    const def = byokDefForModel(opts.model);
    if (!def || !hasByokKey(def.id)) return blocked('byok');
    return { ok: true, rail };
  }

  if (opts.cliReady === false) return blocked('cli');
  return { ok: true, rail: 'cli' };
}
