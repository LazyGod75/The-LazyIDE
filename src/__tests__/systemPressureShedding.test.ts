/**
 * systemPressureShedding.test.ts — Fix 5 (release valve). The shed-decision
 * logic (shouldShed) and the wiring (startSystemPressureShedding) are
 * exercised purely against systemPressure.ts's test-only setter, mirroring
 * scheduler.test.ts's own convention for testing a systemPressure.ts
 * consumer without a real Tauri event round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setSystemPressureForTests,
  resetSystemPressureForTests,
} from '../lib/agents/systemPressure';
import { shouldShed, startSystemPressureShedding, type ShedActions } from '../lib/agents/systemPressureShedding';

beforeEach(() => {
  resetSystemPressureForTests();
});

afterEach(() => {
  resetSystemPressureForTests();
});

describe('shouldShed', () => {
  it('is true on a transition from normal to high', () => {
    expect(shouldShed('normal', 'high')).toBe(true);
  });

  it('is true on a transition from elevated to high', () => {
    expect(shouldShed('elevated', 'high')).toBe(true);
  });

  it('is false when already high (never re-fires while pressure STAYS high)', () => {
    expect(shouldShed('high', 'high')).toBe(false);
  });

  it('is false for a transition to elevated (only high triggers shedding)', () => {
    expect(shouldShed('normal', 'elevated')).toBe(false);
  });

  it('is false for a transition to normal', () => {
    expect(shouldShed('high', 'normal')).toBe(false);
  });

  it('re-arms after dropping back below high — a later re-trip sheds again', () => {
    // Simulated as two independent calls (the real sequence normal -> high
    // -> elevated -> high): the middle step resets the "previous" state
    // startSystemPressureShedding tracks internally.
    expect(shouldShed('normal', 'high')).toBe(true);
    expect(shouldShed('high', 'elevated')).toBe(false);
    expect(shouldShed('elevated', 'high')).toBe(true);
  });
});

describe('startSystemPressureShedding', () => {
  function makeActions(): ShedActions & { sweepCalls: number; cacheDropCalls: number } {
    const actions = {
      sweepCalls: 0,
      cacheDropCalls: 0,
      runHygieneSweepNow: () => { actions.sweepCalls += 1; },
      dropReclaimableCaches: () => { actions.cacheDropCalls += 1; },
    };
    return actions;
  }

  it('runs both actions on a transition to high pressure', () => {
    const actions = makeActions();
    const unsub = startSystemPressureShedding(actions);

    setSystemPressureForTests({ level: 'high' });

    expect(actions.sweepCalls).toBe(1);
    expect(actions.cacheDropCalls).toBe(1);
    unsub();
  });

  it('does NOT shed for elevated pressure', () => {
    const actions = makeActions();
    const unsub = startSystemPressureShedding(actions);

    setSystemPressureForTests({ level: 'elevated' });

    expect(actions.sweepCalls).toBe(0);
    expect(actions.cacheDropCalls).toBe(0);
    unsub();
  });

  it('sheds only ONCE while pressure stays high across repeated samples', () => {
    const actions = makeActions();
    const unsub = startSystemPressureShedding(actions);

    setSystemPressureForTests({ level: 'high' });
    setSystemPressureForTests({ level: 'high' });
    setSystemPressureForTests({ level: 'high' });

    expect(actions.sweepCalls).toBe(1);
    expect(actions.cacheDropCalls).toBe(1);
    unsub();
  });

  it('sheds again on a LATER re-trip after pressure drops back down', () => {
    const actions = makeActions();
    const unsub = startSystemPressureShedding(actions);

    setSystemPressureForTests({ level: 'high' });
    setSystemPressureForTests({ level: 'normal' });
    setSystemPressureForTests({ level: 'high' });

    expect(actions.sweepCalls).toBe(2);
    expect(actions.cacheDropCalls).toBe(2);
    unsub();
  });

  it('stops reacting once unsubscribed', () => {
    const actions = makeActions();
    const unsub = startSystemPressureShedding(actions);
    unsub();

    setSystemPressureForTests({ level: 'high' });

    expect(actions.sweepCalls).toBe(0);
    expect(actions.cacheDropCalls).toBe(0);
  });
});
