import { useCallback, useEffect, useRef, useState } from 'react';

interface UseResizableOpts {
  initial: number;
  min: number;
  max: number;
  direction: 'horizontal' | 'vertical';
  invert?: boolean;
}

export function useResizable({ initial, min, max, direction, invert = false }: UseResizableOpts) {
  const [size, setSize] = useState(initial);
  const draggingRef = useRef(false);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);
  const pointerIdRef = useRef<number | null>(null);

  const resetDrag = useCallback(() => {
    draggingRef.current = false;
    pointerIdRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    pointerIdRef.current = e.pointerId;
    startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY;
    startSizeRef.current = size;
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    // Capture pointer so we get pointerup even if the cursor leaves the window
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }, [size, direction]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!draggingRef.current) return;
      if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) return;
      const pos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = pos - startPosRef.current;
      const effective = invert ? -delta : delta;
      const next = Math.max(min, Math.min(max, startSizeRef.current + effective));
      setSize(next);
    }
    function onUp(e: PointerEvent) {
      if (!draggingRef.current) return;
      if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) return;
      resetDrag();
    }
    function onCancel() {
      if (!draggingRef.current) return;
      resetDrag();
    }
    function onBlur() {
      if (!draggingRef.current) return;
      resetDrag();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
    };
  }, [direction, min, max, invert, resetDrag]);

  return { size, onPointerDown };
}

interface ResizeHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
  direction: 'horizontal' | 'vertical';
}

export function ResizeHandle({ onPointerDown, direction }: ResizeHandleProps) {
  const isHorizontal = direction === 'horizontal';
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        flexShrink: 0,
        width: isHorizontal ? 4 : '100%',
        height: isHorizontal ? '100%' : 4,
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
        background: 'transparent',
        position: 'relative',
        zIndex: 5,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(124,92,255,0.3)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: isHorizontal ? 1 : 16,
            height: isHorizontal ? 16 : 1,
            borderRadius: 1,
            background: 'rgba(255,255,255,0.15)',
          }}
        />
      </div>
    </div>
  );
}
