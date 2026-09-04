/**
 * terminalActivity.test.ts — the ephemeral (never persisted) per-terminal
 * activity registry backing fleetHygiene.ts's rule (h) (idle-terminal
 * auto-close, Fix 2). See terminalActivity.ts's own doc comment for why
 * this lives outside canvasStore.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordTerminalOutputActivity,
  recordTerminalFocus,
  getTerminalActivity,
  clearTerminalActivity,
  resetTerminalActivityForTests,
} from '../lib/agents/terminalActivity';

beforeEach(() => {
  resetTerminalActivityForTests();
});

describe('getTerminalActivity', () => {
  it('returns both fields undefined for a surface never observed', () => {
    expect(getTerminalActivity('never-seen')).toEqual({ lastOutputAtMs: undefined, lastFocusedAtMs: undefined });
  });

  it('reflects a recorded output timestamp', () => {
    recordTerminalOutputActivity('t1', 1000);
    expect(getTerminalActivity('t1')).toEqual({ lastOutputAtMs: 1000, lastFocusedAtMs: undefined });
  });

  it('reflects a recorded focus timestamp', () => {
    recordTerminalFocus('t1', 2000);
    expect(getTerminalActivity('t1')).toEqual({ lastOutputAtMs: undefined, lastFocusedAtMs: 2000 });
  });

  it('tracks output and focus independently for the same surface', () => {
    recordTerminalOutputActivity('t1', 1000);
    recordTerminalFocus('t1', 2000);
    expect(getTerminalActivity('t1')).toEqual({ lastOutputAtMs: 1000, lastFocusedAtMs: 2000 });
  });

  it('overwrites with the latest recorded value on repeated calls', () => {
    recordTerminalOutputActivity('t1', 1000);
    recordTerminalOutputActivity('t1', 5000);
    expect(getTerminalActivity('t1').lastOutputAtMs).toBe(5000);
  });

  it('defaults to Date.now() when no explicit timestamp is passed', () => {
    const before = Date.now();
    recordTerminalOutputActivity('t1');
    const after = Date.now();
    const recorded = getTerminalActivity('t1').lastOutputAtMs!;
    expect(recorded).toBeGreaterThanOrEqual(before);
    expect(recorded).toBeLessThanOrEqual(after);
  });

  it('keeps different surfaces fully independent', () => {
    recordTerminalOutputActivity('t1', 1000);
    recordTerminalOutputActivity('t2', 2000);
    expect(getTerminalActivity('t1').lastOutputAtMs).toBe(1000);
    expect(getTerminalActivity('t2').lastOutputAtMs).toBe(2000);
  });
});

describe('clearTerminalActivity', () => {
  it('drops both fields for the given surface — the registry never outlives a removed surface', () => {
    recordTerminalOutputActivity('t1', 1000);
    recordTerminalFocus('t1', 2000);

    clearTerminalActivity('t1');

    expect(getTerminalActivity('t1')).toEqual({ lastOutputAtMs: undefined, lastFocusedAtMs: undefined });
  });

  it('never touches a different surface', () => {
    recordTerminalOutputActivity('t1', 1000);
    recordTerminalOutputActivity('t2', 2000);

    clearTerminalActivity('t1');

    expect(getTerminalActivity('t2').lastOutputAtMs).toBe(2000);
  });

  it('is a safe no-op for a surface that was never tracked', () => {
    expect(() => clearTerminalActivity('does-not-exist')).not.toThrow();
  });
});

describe('resetTerminalActivityForTests', () => {
  it('clears every tracked surface', () => {
    recordTerminalOutputActivity('t1', 1000);
    recordTerminalFocus('t2', 2000);

    resetTerminalActivityForTests();

    expect(getTerminalActivity('t1')).toEqual({ lastOutputAtMs: undefined, lastFocusedAtMs: undefined });
    expect(getTerminalActivity('t2')).toEqual({ lastOutputAtMs: undefined, lastFocusedAtMs: undefined });
  });
});
