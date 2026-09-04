/**
 * memoryPressureReservedHeight.test.ts
 *
 * QA fix (bottom-left overlap): MemoryPressureIndicator.tsx used to be a
 * bare `position: fixed` pill with nothing reserving its footprint, so it
 * floated on top of whatever a space already renders in that corner — the
 * Brain space's cluster filter list and the Cockpit's FluxFooter activity
 * bar both live there. The fix is AppShellInner applying
 * `useMemoryPressureReservedHeight()`'s return value as `<main>`'s
 * paddingBottom, so every space's content box shrinks by exactly the
 * pill's own footprint whenever it is visible.
 *
 * This covers the hook in isolation (0 while pressure is normal/elevated,
 * MEMORY_PRESSURE_INDICATOR_RESERVED_HEIGHT while 'high', back to 0 on
 * drop) rather than only through a full AppShell render, which would need
 * every context provider AppShellInner sits under.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useMemoryPressureReservedHeight,
  MEMORY_PRESSURE_INDICATOR_RESERVED_HEIGHT,
} from '../components/memoryPressureReservedHeight';
import { setSystemPressureForTests, resetSystemPressureForTests } from '../lib/agents/systemPressure';

afterEach(() => {
  resetSystemPressureForTests();
});

describe('useMemoryPressureReservedHeight', () => {
  it('reserves 0 while pressure is normal', () => {
    setSystemPressureForTests({ level: 'normal' });
    const { result } = renderHook(() => useMemoryPressureReservedHeight());
    expect(result.current).toBe(0);
  });

  it('reserves 0 while pressure is elevated (indicator itself only shows on "high")', () => {
    setSystemPressureForTests({ level: 'elevated' });
    const { result } = renderHook(() => useMemoryPressureReservedHeight());
    expect(result.current).toBe(0);
  });

  it('reserves the pill footprint once pressure goes high', () => {
    setSystemPressureForTests({ level: 'normal' });
    const { result } = renderHook(() => useMemoryPressureReservedHeight());
    expect(result.current).toBe(0);

    act(() => {
      setSystemPressureForTests({ level: 'high' });
    });
    expect(result.current).toBe(MEMORY_PRESSURE_INDICATOR_RESERVED_HEIGHT);
  });

  it('goes back to 0 when pressure drops back below high', () => {
    setSystemPressureForTests({ level: 'high' });
    const { result } = renderHook(() => useMemoryPressureReservedHeight());
    expect(result.current).toBe(MEMORY_PRESSURE_INDICATOR_RESERVED_HEIGHT);

    act(() => {
      setSystemPressureForTests({ level: 'normal' });
    });
    expect(result.current).toBe(0);
  });

  it('stops updating once the consuming component unmounts (no leaked subscription)', () => {
    setSystemPressureForTests({ level: 'normal' });
    const { result, unmount } = renderHook(() => useMemoryPressureReservedHeight());
    expect(result.current).toBe(0);

    unmount();

    // Notifying after unmount must not throw (React would warn/error on a
    // setState-after-unmount if the effect's cleanup failed to unsubscribe).
    expect(() => {
      act(() => {
        setSystemPressureForTests({ level: 'high' });
      });
    }).not.toThrow();
  });
});
