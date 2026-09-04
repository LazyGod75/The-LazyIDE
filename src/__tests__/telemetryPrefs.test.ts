/**
 * telemetryPrefs.test.ts
 *
 * Unit tests for src/lib/billing/telemetryPrefs.ts — the persisted
 * opt-out backing the Settings > General "Report app version" toggle
 * (SettingsSpace.tsx's TelemetrySection) and consulted by
 * reportAppVersion() (see reportAppVersion.test.ts's "telemetry opt-out"
 * describe block for the gating behavior itself).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadVersionTelemetryEnabled,
  saveVersionTelemetryEnabled,
} from '../lib/billing/telemetryPrefs';

const STORAGE_KEY = 'lazy.telemetry.appVersionEnabled';

beforeEach(() => {
  localStorage.clear();
});

describe('telemetryPrefs', () => {
  it('defaults to enabled when nothing has been saved yet', () => {
    expect(loadVersionTelemetryEnabled()).toBe(true);
  });

  it('persists false across loads once disabled', () => {
    saveVersionTelemetryEnabled(false);
    expect(loadVersionTelemetryEnabled()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('persists true again once re-enabled', () => {
    saveVersionTelemetryEnabled(false);
    saveVersionTelemetryEnabled(true);
    expect(loadVersionTelemetryEnabled()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('treats a corrupted/unexpected stored value as enabled (fail open to the default)', () => {
    localStorage.setItem(STORAGE_KEY, 'garbage');
    expect(loadVersionTelemetryEnabled()).toBe(true);
  });
});
