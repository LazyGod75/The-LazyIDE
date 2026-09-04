/* PaletteContext — provides open/close state for the command palette.
   Wired at AppShell level so Omnibar and global keydown both access it.
*/

import React, { createContext, useContext, useState, useCallback } from 'react';

interface PaletteContextValue {
  isOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function usePaletteContext(): PaletteContextValue {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('usePaletteContext must be used inside PaletteProvider');
  return ctx;
}

interface PaletteProviderProps {
  children: React.ReactNode;
}

export function PaletteProvider({ children }: PaletteProviderProps) {
  const [isOpen, setIsOpen] = useState(false);

  const openPalette = useCallback(() => setIsOpen(true), []);
  const closePalette = useCallback(() => setIsOpen(false), []);

  return (
    <PaletteContext.Provider value={{ isOpen, openPalette, closePalette }}>
      {children}
    </PaletteContext.Provider>
  );
}
