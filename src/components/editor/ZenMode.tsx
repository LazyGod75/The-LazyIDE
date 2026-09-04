import { useEffect } from 'react';

interface ZenModeProps {
  children: React.ReactNode;
  onExit: () => void;
}

export function ZenMode({ children, onExit }: ZenModeProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onExit();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onExit]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#0E0E12', display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'absolute', top: 8, right: 12, fontSize: 11, color: 'rgba(255,255,255,0.15)', pointerEvents: 'none' }}>
        Press Esc to exit Zen Mode
      </div>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}
