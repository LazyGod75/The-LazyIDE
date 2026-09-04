export const GUEST_MODE_KEY = 'lazy.guestMode';

export function isGuestMode(): boolean {
  try {
    return localStorage.getItem(GUEST_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setGuestMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(GUEST_MODE_KEY, '1');
    else localStorage.removeItem(GUEST_MODE_KEY);
  } catch {
    // localStorage unavailable — ignore
  }
}

export function clearGuestMode(): void {
  setGuestMode(false);
}
