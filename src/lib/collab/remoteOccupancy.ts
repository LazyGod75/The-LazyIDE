/* remoteOccupancy.ts — module-level snapshot of teammate file occupancy.

   scheduler.ts and agentsStore cannot call React hooks. CollabProvider
   pushes the latest remote occupancy here on every fleet-delta sync;
   dispatch() reads it as extraScopes for checkConflicts. Fail-closed:
   empty array until the first push, and after logout.
*/

export interface RemoteOccupancyScope {
  id: string;
  scope: string[];
}

let _scopes: readonly RemoteOccupancyScope[] = [];

export function setRemoteOccupancySnapshot(scopes: readonly RemoteOccupancyScope[]): void {
  _scopes = scopes;
}

export function getRemoteOccupancySnapshot(): readonly RemoteOccupancyScope[] {
  return _scopes;
}

export function _resetRemoteOccupancyForTests(): void {
  _scopes = [];
}
