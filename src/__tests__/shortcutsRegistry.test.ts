import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createShortcutRegistry, type ShortcutRegistry } from '../lib/shortcuts/registry';

function dispatchKeyDown(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

describe('shortcutRegistry', () => {
  let registry: ShortcutRegistry;

  beforeEach(() => {
    registry = createShortcutRegistry();
  });

  afterEach(() => {
    registry.destroy();
  });

  it('invokes the handler when the combo matches', () => {
    const handler = vi.fn();
    registry.register({ id: 'a', combo: 'Mod+K', handler });

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the handler for a non-matching combo', () => {
    const handler = vi.fn();
    registry.register({ id: 'a', combo: 'Mod+K', handler });

    dispatchKeyDown({ key: 'p', ctrlKey: true });

    expect(handler).not.toHaveBeenCalled();
  });

  it('calls preventDefault by default when a shortcut fires', () => {
    registry.register({ id: 'a', combo: 'Mod+K', handler: vi.fn() });

    const event = dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
  });

  it('does not call preventDefault when preventDefault:false', () => {
    registry.register({ id: 'a', combo: 'Mod+K', handler: vi.fn(), preventDefault: false });

    const event = dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
  });

  it('unsubscribe stops the handler from firing', () => {
    const handler = vi.fn();
    const unsubscribe = registry.register({ id: 'a', combo: 'Mod+K', handler });
    unsubscribe();

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribe is idempotent (calling twice does not throw or affect others)', () => {
    const handler = vi.fn();
    const other = vi.fn();
    const unsubscribe = registry.register({ id: 'a', combo: 'Mod+K', handler });
    registry.register({ id: 'b', combo: 'Mod+J', handler: other });

    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();

    dispatchKeyDown({ key: 'j', ctrlKey: true });
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('filters out a shortcut whose scope predicate returns false', () => {
    const handler = vi.fn();
    registry.register({ id: 'a', combo: 'Mod+K', handler, when: () => false });

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(handler).not.toHaveBeenCalled();
  });

  it('fires a shortcut whose scope predicate returns true', () => {
    const handler = vi.fn();
    registry.register({ id: 'a', combo: 'Mod+K', handler, when: () => true });

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("treats an explicit when: 'global' the same as omitting when", () => {
    const handler = vi.fn();
    registry.register({ id: 'a', combo: 'Mod+K', handler, when: 'global' });

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('resolves same-combo conflicts by priority — higher priority wins and the loser does not fire', () => {
    const low = vi.fn();
    const high = vi.fn();
    registry.register({ id: 'low', combo: 'Mod+K', handler: low, priority: 0 });
    registry.register({ id: 'high', combo: 'Mod+K', handler: high, priority: 10 });

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
  });

  it('priority resolution is independent of registration order', () => {
    const low = vi.fn();
    const high = vi.fn();
    registry.register({ id: 'high', combo: 'Mod+K', handler: high, priority: 10 });
    registry.register({ id: 'low', combo: 'Mod+K', handler: low, priority: 0 });

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(high).toHaveBeenCalledTimes(1);
    expect(low).not.toHaveBeenCalled();
  });

  it('breaks same-priority ties deterministically by registration order (first registered wins)', () => {
    // This registration pair is itself the same-combo/same-priority/
    // overlapping-scope case the dev-mode warning below is designed to
    // catch, so it legitimately triggers one — silence it here since this
    // test is only asserting the tie-break outcome, not the warning.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = vi.fn();
    const second = vi.fn();
    registry.register({ id: 'first', combo: 'Mod+K', handler: first });
    registry.register({ id: 'second', combo: 'Mod+K', handler: second });

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('only the eligible (scope-passing) shortcut competes on priority — an ineligible higher-priority one does not block a lower one', () => {
    const ineligibleHigh = vi.fn();
    const eligibleLow = vi.fn();
    registry.register({ id: 'high', combo: 'Mod+K', handler: ineligibleHigh, priority: 10, when: () => false });
    registry.register({ id: 'low', combo: 'Mod+K', handler: eligibleLow, priority: 0 });

    dispatchKeyDown({ key: 'k', ctrlKey: true });

    expect(eligibleLow).toHaveBeenCalledTimes(1);
    expect(ineligibleHigh).not.toHaveBeenCalled();
  });

  it('getAll reflects current registrations and drops unsubscribed ones', () => {
    const unsubscribe = registry.register({ id: 'a', combo: 'Mod+K', handler: vi.fn() });
    expect(registry.getAll().map((s) => s.id)).toEqual(['a']);

    unsubscribe();
    expect(registry.getAll()).toHaveLength(0);
  });

  describe('dev-mode duplicate-combo warning', () => {
    it('warns on same-combo/same-priority/overlapping-scope duplicates', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      registry.register({ id: 'first', combo: 'Mod+K', handler: vi.fn() });
      registry.register({ id: 'second', combo: 'Mod+K', handler: vi.fn() });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('second');
      expect(warnSpy.mock.calls[0][0]).toContain('first');
      warnSpy.mockRestore();
    });

    it('does not warn when priorities differ (the intentional-precedence escape hatch)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      registry.register({ id: 'first', combo: 'Mod+K', handler: vi.fn(), priority: 0 });
      registry.register({ id: 'second', combo: 'Mod+K', handler: vi.fn(), priority: 10 });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not warn when scopes are distinct custom predicates', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      registry.register({ id: 'first', combo: 'Mod+K', handler: vi.fn(), when: () => true });
      registry.register({ id: 'second', combo: 'Mod+K', handler: vi.fn(), when: () => false });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('does not warn for different combos', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      registry.register({ id: 'first', combo: 'Mod+K', handler: vi.fn() });
      registry.register({ id: 'second', combo: 'Mod+P', handler: vi.fn() });

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
