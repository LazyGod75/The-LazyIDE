/* useCanvasWebSearchSurfaces.ts — P-SEARCH (founder directive, verbatim:
   "la recherche web doit ouvrir une fenêtre liée à l'agent qui demande la
   recherche et on voit la recherche") — bridges toolRuntime.ts's
   'canvas:webSearchResult' bus event into a live SearchNode canvas surface.

   toolRuntime.ts's `web_search` tool case emits this event directly
   (before AND after the Rust call — see that case's own comment) whenever
   the call carries mission identity (ToolExecutionContext.missionId/
   projectId); it never fires for the assistant/codeur chat, which has no
   mission/project of its own. This hook is the ONE subscriber: it just
   forwards the payload into canvasStore's `reportWebSearch` action, which
   owns the actual upsert logic (find-or-create the mission's search
   surface, push/cap history) — same "thin bus-to-store bridge" shape as
   CanvasToolActivityOverlay.tsx's own subscription, just with no visual
   output of its own (the surface itself renders via nodes/SearchNode.tsx,
   reached through the normal reconcile()/nodeTypes pipeline once the store
   updates).
*/

import { useEffect } from 'react';
import { on, type BusEvents } from '../../../../lib/bus';
import { useCanvasStore } from '../canvasStore';

export function useCanvasWebSearchSurfaces(): void {
  const reportWebSearch = useCanvasStore((s) => s.reportWebSearch);

  useEffect(() => {
    return on('canvas:webSearchResult', (payload: BusEvents['canvas:webSearchResult']) => {
      reportWebSearch(payload);
    });
  }, [reportWebSearch]);
}
