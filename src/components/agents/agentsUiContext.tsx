/* agentsUiContext — lightweight context to signal "open new mission modal"
   across the component tree (palette → AgentsSpace).
   Separate from agentsStore to avoid coupling global shell to Agents data.
*/

import React, { createContext, useCallback, useContext, useState } from 'react';

interface AgentsUiContextValue {
  newMissionPending: boolean;
  requestNewMission: () => void;
  clearNewMissionPending: () => void;
}

const AgentsUiContext = createContext<AgentsUiContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useAgentsUiContext(): AgentsUiContextValue {
  const ctx = useContext(AgentsUiContext);
  if (!ctx) throw new Error('useAgentsUiContext must be inside AgentsUiProvider');
  return ctx;
}

interface Props {
  children: React.ReactNode;
}

export function AgentsUiProvider({ children }: Props) {
  const [newMissionPending, setNewMissionPending] = useState(false);

  const requestNewMission = useCallback(() => setNewMissionPending(true), []);
  const clearNewMissionPending = useCallback(() => setNewMissionPending(false), []);

  return (
    <AgentsUiContext.Provider
      value={{ newMissionPending, requestNewMission, clearNewMissionPending }}
    >
      {children}
    </AgentsUiContext.Provider>
  );
}
