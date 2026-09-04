/* runMissionRoute — CLI rail + branch slug for a mission.

   Extracted because these ternaries lived in runMission's own body and
   counted toward its measured cyclomatic complexity (31, 2026-08-28).
*/

import { getProviderMode } from '../models/index.js';
import {
  classifyMissionModel,
  isManagedAgentAvailable,
  NATIVE_DEFAULT_MAX_DURATION_MS,
} from './runtime.js';
import type { Mission } from './types.js';

export function missionBranchName(mission: Mission): string {
  const slug = mission.title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return `agent/${mission.id}-${slug}`;
}

export function cliModelFamily(model: string | undefined): 'haiku' | 'sonnet' | 'opus' {
  const id = model?.toLowerCase() ?? '';
  if (id.includes('haiku')) return 'haiku';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('opus')) return 'opus';
  return 'haiku';
}

export function resolveMissionCliRoute(mission: Mission, isTauri: boolean): {
  willRunManaged: boolean;
  isNativeRail: boolean;
  tool: 'codex' | 'claude';
  model: 'haiku' | 'sonnet' | 'opus';
  managedModel: string | undefined;
  maxDurationMs: number | undefined;
  budgetCapUsd: number | undefined;
} {
  const missionRouteKind = isTauri ? classifyMissionModel(mission.model) : undefined;
  const willRunManaged = missionRouteKind === 'managed' || (!missionRouteKind && isManagedAgentAvailable());
  const isNativeRail = missionRouteKind === 'native';
  const providerMode = isTauri ? getProviderMode() : 'mock';
  return {
    willRunManaged,
    isNativeRail,
    tool: providerMode === 'codex' ? 'codex' : 'claude',
    model: cliModelFamily(mission.model),
    managedModel: mission.model ?? undefined,
    maxDurationMs: mission.contract?.maxDurationMs ?? NATIVE_DEFAULT_MAX_DURATION_MS,
    budgetCapUsd: mission.contract?.budgetCapUsd,
  };
}
