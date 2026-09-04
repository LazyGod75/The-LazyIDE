/* memoryPressureReservedHeight.ts — split out of MemoryPressureIndicator.tsx
   (QA fix, bottom-left overlap) for the same reason ToastContext.ts is split
   out of Toast.tsx: react-refresh/only-export-components warns when a file
   exports both a component and a plain function/constant — Fast Refresh
   then can't hot-reload that module reliably. MemoryPressureIndicator.tsx
   keeps its own doc comment explaining the WHY of this reservation; this
   file is just the number and the hook that reads it, importable from
   AppShellInner without importing the component too.
*/

import { useEffect, useState } from 'react';
import { getSystemPressure, subscribeSystemPressure, type SystemPressureSnapshot } from '../lib/agents/systemPressure';

/** MemoryPressureIndicator's pill footprint from the viewport's bottom
 *  edge: 20px offset + ~30px pill height (7px vertical padding * 2 + ~14px
 *  line box + 2px border) + 6px clearance so content never touches the
 *  pill's edge. Single source of truth `useMemoryPressureReservedHeight`
 *  (below) reads to reserve the same space. */
export const MEMORY_PRESSURE_INDICATOR_RESERVED_HEIGHT = 56;

/** Live "is the pill currently on screen" height, in px — 0 when pressure
 *  is not 'high' (pill hidden), `MEMORY_PRESSURE_INDICATOR_RESERVED_HEIGHT`
 *  while it is. AppShellInner (see AppShell.tsx) applies this as `<main>`'s
 *  paddingBottom so every space's content box shrinks by exactly the pill's
 *  footprint instead of the pill floating over whatever a space already
 *  renders in that corner. Its own hook (rather than inlined in AppShell)
 *  so the reservation math has one real, directly-testable unit instead of
 *  only being reachable through a full AppShell render. */
export function useMemoryPressureReservedHeight(): number {
  const [snapshot, setSnapshot] = useState<SystemPressureSnapshot>(getSystemPressure);
  useEffect(() => subscribeSystemPressure(setSnapshot), []);
  return snapshot.level === 'high' ? MEMORY_PRESSURE_INDICATOR_RESERVED_HEIGHT : 0;
}
