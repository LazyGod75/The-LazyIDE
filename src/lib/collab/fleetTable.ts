/* fleetTable.ts — durable heartbeat on public.org_fleet_missions.

   Best-effort. Missing table / RLS denial / offline: silent no-op.
   Realtime broadcast is the live path; this table lets a late joiner
   see teammates' missions without waiting for the next delta.
*/

import { supabase } from '../supabase/client.js';
import type { FleetDelta } from './types.js';

interface FleetRow {
  org_id: string;
  project_key: string;
  mission_id: string;
  owner_user_id: string;
  owner_name: string;
  title: string;
  status: string;
  stage: string | null;
  live_action: string | null;
  model: string | null;
  occupancy: string[] | null;
  updated_at: string;
}

function rowToDelta(row: FleetRow): FleetDelta {
  return {
    projectId: row.project_key,
    missionId: row.mission_id,
    status: row.status,
    stage: row.stage ?? undefined,
    title: row.title,
    liveAction: row.live_action ?? undefined,
    model: row.model ?? undefined,
    occupancy: row.occupancy ?? undefined,
    fromUserId: row.owner_user_id,
    fromName: row.owner_name,
    updatedAt: Date.parse(row.updated_at) || Date.now(),
  };
}

export async function fetchOrgFleet(orgId: string): Promise<FleetDelta[]> {
  try {
    const { data, error } = await supabase
      .from('org_fleet_missions')
      .select('org_id, project_key, mission_id, owner_user_id, owner_name, title, status, stage, live_action, model, occupancy, updated_at')
      .eq('org_id', orgId);
    if (error || !data) return [];
    return (data as FleetRow[]).map(rowToDelta);
  } catch {
    return [];
  }
}

export interface FleetHeartbeat {
  projectKey: string;
  missionId: string;
  title: string;
  status: string;
  stage?: string;
  liveAction?: string;
  model?: string;
  occupancy: string[];
}

export async function upsertFleetHeartbeats(
  orgId: string,
  ownerUserId: string,
  ownerName: string,
  rows: readonly FleetHeartbeat[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    const payload = rows.map((row) => ({
      org_id: orgId,
      project_key: row.projectKey,
      mission_id: row.missionId,
      owner_user_id: ownerUserId,
      owner_name: ownerName,
      title: row.title,
      status: row.status,
      stage: row.stage ?? null,
      live_action: row.liveAction ?? null,
      model: row.model ?? null,
      occupancy: row.occupancy,
      updated_at: new Date().toISOString(),
    }));
    await supabase.from('org_fleet_missions').upsert(payload, {
      onConflict: 'org_id,project_key,mission_id',
    });
  } catch {
    // table missing / offline / RLS — live broadcast still works
  }
}
