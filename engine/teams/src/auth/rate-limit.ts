/**
 * In-memory login throttle.
 *
 * Rules:
 * - 5 consecutive failures per username OR per IP → 60-second lockout.
 * - Counter resets on successful login.
 * - Uses an injectable clock for deterministic testing.
 * - Pure data structure — no I/O, no side effects beyond the Map.
 *
 * This module is process-local (no persistence). On restart, the state resets.
 * For production multi-process deployments, replace with a shared store.
 */

export interface RateLimitClock {
  now(): number; // Unix ms
}

const realClock: RateLimitClock = { now: () => Date.now() };

interface FailureRecord {
  count: number;
  lockedUntil: number; // Unix ms; 0 = not locked
}

const MAX_FAILURES = 5;
const LOCK_DURATION_MS = 60 * 1000; // 60 seconds

export class RateLimiter {
  private readonly _byUsername = new Map<string, FailureRecord>();
  private readonly _byIp = new Map<string, FailureRecord>();
  private readonly _clock: RateLimitClock;

  constructor(clock: RateLimitClock = realClock) {
    this._clock = clock;
  }

  /**
   * Check whether a login attempt is allowed.
   * Returns true if the attempt is permitted, false if locked out.
   */
  isAllowed(username: string, ip: string): boolean {
    const now = this._clock.now();
    return (
      this._checkRecord(this._byUsername, username, now) && this._checkRecord(this._byIp, ip, now)
    );
  }

  /**
   * Record a failed login attempt.
   * If failure count reaches MAX_FAILURES, sets a lockout.
   */
  recordFailure(username: string, ip: string): void {
    const now = this._clock.now();
    this._incrementFailure(this._byUsername, username, now);
    this._incrementFailure(this._byIp, ip, now);
  }

  /**
   * Reset counters on successful login.
   */
  recordSuccess(username: string, ip: string): void {
    this._byUsername.delete(username);
    this._byIp.delete(ip);
  }

  /**
   * How many milliseconds until the lockout for a key expires.
   * Returns 0 if not locked.
   */
  lockoutRemainingMs(key: string, byField: 'username' | 'ip'): number {
    const map = byField === 'username' ? this._byUsername : this._byIp;
    const record = map.get(key);
    if (!record || record.lockedUntil === 0) return 0;
    const remaining = record.lockedUntil - this._clock.now();
    return remaining > 0 ? remaining : 0;
  }

  private _checkRecord(map: Map<string, FailureRecord>, key: string, now: number): boolean {
    const record = map.get(key);
    if (!record) return true;
    if (record.lockedUntil > 0 && now < record.lockedUntil) return false;
    if (record.lockedUntil > 0 && now >= record.lockedUntil) {
      // Lockout expired — clear it
      map.delete(key);
    }
    return true;
  }

  private _incrementFailure(map: Map<string, FailureRecord>, key: string, now: number): void {
    const existing = map.get(key);
    const count = (existing?.count ?? 0) + 1;
    const lockedUntil = count >= MAX_FAILURES ? now + LOCK_DURATION_MS : 0;
    map.set(key, { count, lockedUntil });
  }
}

// Shared singleton for the server process
export const globalRateLimiter = new RateLimiter();
