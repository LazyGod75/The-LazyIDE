/* CollabContext — ONE useFleetPresence mount for the canvas.

   PresenceOverlay + CanvasLiveSync used to each call the hook, which
   opened two Realtime channels for the same org. This provider is the
   single join; consumers read the shared result.
*/

import { createContext, useContext, type ReactNode } from 'react';
import {
  useFleetPresence,
  type UseFleetPresenceOptions,
  type UseFleetPresenceResult,
} from './useFleetPresence.js';

const INACTIVE: UseFleetPresenceResult = {
  active: false,
  self: null,
  remoteUsers: [],
  remoteDeltasByMission: new Map(),
  projectId: null,
  remoteCanvasOps: new Map(),
  broadcastCanvasOp: () => {},
  reportFocus: () => {},
  broadcastMissionTransfer: () => {},
  broadcastSessionEvent: () => {},
  remoteTransfersByMission: new Map(),
  remoteSessionEvents: new Map(),
};

const CollabContext = createContext<UseFleetPresenceResult>(INACTIVE);

export function CollabProvider({ enabled, children }: UseFleetPresenceOptions & { children: ReactNode }) {
  const value = useFleetPresence({ enabled });
  return <CollabContext.Provider value={value}>{children}</CollabContext.Provider>;
}

/** Honest degrade: outside a provider this is the inactive solo result. */
export function useCollab(): UseFleetPresenceResult {
  return useContext(CollabContext);
}
