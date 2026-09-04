/* useDryRunPreview.ts — W8a deliverable #3: preview-mode session state for
   the dry-run overlay. Owns start/replay/stop + the elapsed-time tick;
   NEVER mutates canvasStore/agentsStore or touches the chain engine
   (markChainFired stays untouched — the traveling-dot firing look is
   reproduced with LOCAL state only, per the brief).

   Lives in CanvasToolbar (inside <ReactFlow>), so `useReactFlow()` gives
   it the live nodes/edges without any new CanvasView prop. The context
   menu's pane entry triggers it through dryRunSignal.ts.
*/

import { useCallback, useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { ChainCondition } from '../canvasTypes';
import type { ChainEdgeData } from '../edges/ChainEdge';
import { computeDryRunTimeline, type DryRunTimeline } from './dryRunWalk';
import { onDryRunRequest } from './dryRunSignal';

const TICK_MS = 120;

export interface DryRunSession {
  timeline: DryRunTimeline;
  /** ms since the session (re)started — drives which steps are visible. */
  elapsedMs: number;
}

export interface UseDryRunPreviewResult {
  session: DryRunSession | null;
  start: () => void;
  replay: () => void;
  stop: () => void;
}

export function useDryRunPreview(): UseDryRunPreviewResult {
  const { getNodes, getEdges } = useReactFlow();
  const [timeline, setTimeline] = useState<DryRunTimeline | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef(0);

  const start = useCallback(() => {
    const nodes = getNodes().map((node) => ({ id: node.id, type: node.type }));
    const edges = getEdges()
      .filter((edge) => edge.type === 'chain')
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        condition: ((edge.data as ChainEdgeData | undefined)?.condition ?? 'success') as ChainCondition,
      }));
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setTimeline(computeDryRunTimeline(nodes, edges));
  }, [getNodes, getEdges]);

  const replay = useCallback(() => {
    startedAtRef.current = Date.now();
    setElapsedMs(0);
  }, []);

  const stop = useCallback(() => {
    setTimeline(null);
    setElapsedMs(0);
  }, []);

  // Elapsed tick — only while a session is active; stops advancing once the
  // timeline's steady state is reached (every step already visible).
  useEffect(() => {
    if (!timeline) return;
    const interval = setInterval(() => {
      const next = Date.now() - startedAtRef.current;
      setElapsedMs((prev) => (prev >= timeline.totalMs ? prev : next));
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [timeline]);

  // Context-menu trigger (pane « Simuler » — see dryRunSignal.ts).
  useEffect(() => onDryRunRequest(start), [start]);

  // Escape exits (capture phase so the canvas's own Escape handling —
  // filter clear / chain-arm cancel — doesn't also fire mid-preview).
  useEffect(() => {
    if (!timeline) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      stop();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [timeline, stop]);

  return {
    session: timeline ? { timeline, elapsedMs } : null,
    start,
    replay,
    stop,
  };
}
