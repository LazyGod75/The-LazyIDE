/* usePaletteState — local state for query and highlight index.
   Separated to keep CommandPalette.tsx concise.
*/

import { useState, useCallback } from 'react';

interface PaletteState {
  query: string;
  highlightedIndex: number;
}

interface PaletteStateActions {
  query: string;
  setQuery: (q: string) => void;
  highlightedIndex: number;
  setHighlightedIndex: (idx: number | ((prev: number) => number)) => void;
  reset: () => void;
}

export function usePaletteState(): PaletteStateActions {
  const [state, setState] = useState<PaletteState>({ query: '', highlightedIndex: 0 });

  const setQuery = useCallback((q: string) => {
    setState(prev => ({ ...prev, query: q }));
  }, []);

  const setHighlightedIndex = useCallback((idx: number | ((prev: number) => number)) => {
    setState(prev => ({
      ...prev,
      highlightedIndex: typeof idx === 'function' ? idx(prev.highlightedIndex) : idx,
    }));
  }, []);

  const reset = useCallback(() => {
    setState({ query: '', highlightedIndex: 0 });
  }, []);

  return {
    query: state.query,
    setQuery,
    highlightedIndex: state.highlightedIndex,
    setHighlightedIndex,
    reset,
  };
}
