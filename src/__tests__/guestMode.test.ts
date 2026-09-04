import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearGuestMode, isGuestMode, GUEST_MODE_KEY, setGuestMode } from '../lib/auth/guestMode';

describe('guestMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('is off by default', () => {
    expect(isGuestMode()).toBe(false);
  });

  it('persists a skip so the next launch does not show the auth gate', () => {
    setGuestMode(true);
    expect(localStorage.getItem(GUEST_MODE_KEY)).toBe('1');
    expect(isGuestMode()).toBe(true);
  });

  it('clears when the user later signs in', () => {
    setGuestMode(true);
    clearGuestMode();
    expect(isGuestMode()).toBe(false);
  });
});
