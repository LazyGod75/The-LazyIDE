/**
 * approvalMode.test.ts — CRUD/persistence coverage for approvalMode.ts
 * (W-MODES). Non-Tauri (web/mock) mode only, mirroring this codebase's
 * convention for objectivesStore's own sibling tests — isTauriRuntime() is
 * false in the jsdom test environment (no window.__TAURI_INTERNALS__ set),
 * so these exercise the localStorage fallback path; the Tauri fs path is
 * structurally identical to objectivesStore.ts's own (already covered by
 * that module's real-world usage) and isn't re-proven here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_APPROVAL_MODE,
  ensureApprovalModesLoaded,
  getApprovalMode,
  getApprovalModeConfig,
  setApprovalMode,
  subscribeApprovalModes,
  _resetApprovalModesForTests,
} from '../lib/agents/approvalMode';

beforeEach(() => {
  _resetApprovalModesForTests();
  localStorage.clear();
});

describe('approvalMode — defaults', () => {
  it('defaults to manual for any project before anything is set', () => {
    expect(getApprovalMode()).toBe('manual');
    expect(getApprovalMode('proj-1')).toBe('manual');
    expect(DEFAULT_APPROVAL_MODE).toBe('manual');
  });

  it('getApprovalModeConfig starts empty', () => {
    const config = getApprovalModeConfig();
    expect(config.defaultMode).toBe('manual');
    expect(config.perProject).toEqual({});
  });
});

describe('approvalMode — setApprovalMode', () => {
  it('sets the GLOBAL default when projectId is omitted', async () => {
    await setApprovalMode('auto_green');
    expect(getApprovalMode()).toBe('auto_green');
    // A project with no override inherits the new global default.
    expect(getApprovalMode('proj-1')).toBe('auto_green');
  });

  it('sets a PER-PROJECT override without touching the global default', async () => {
    await setApprovalMode('full_auto', 'proj-1');
    expect(getApprovalMode('proj-1')).toBe('full_auto');
    expect(getApprovalMode('proj-2')).toBe('manual');
    expect(getApprovalMode()).toBe('manual');
  });

  it('a per-project override takes precedence over a later global default change', async () => {
    await setApprovalMode('full_auto', 'proj-1');
    await setApprovalMode('auto_green'); // global default change
    expect(getApprovalMode('proj-1')).toBe('full_auto');
    expect(getApprovalMode('proj-2')).toBe('auto_green');
  });

  it('persists across a reload (localStorage round-trip)', async () => {
    await setApprovalMode('auto_green', 'proj-1');
    _resetApprovalModesForTests();
    await ensureApprovalModesLoaded();
    expect(getApprovalMode('proj-1')).toBe('auto_green');
  });

  it('notifies subscribers on every change', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeApprovalModes((config) => seen.push(config.defaultMode));
    await setApprovalMode('auto_green');
    await setApprovalMode('full_auto');
    unsubscribe();
    await setApprovalMode('manual');
    expect(seen).toEqual(['auto_green', 'full_auto']);
  });
});

describe('approvalMode — malformed storage is honestly ignored', () => {
  it('falls back to defaults when localStorage holds invalid JSON', async () => {
    localStorage.setItem('lazy.agents.approvalModes', '{not json');
    await ensureApprovalModesLoaded();
    expect(getApprovalMode()).toBe('manual');
  });

  it('drops an invalid per-project mode value instead of trusting it', async () => {
    localStorage.setItem(
      'lazy.agents.approvalModes',
      JSON.stringify({ defaultMode: 'manual', perProject: { 'proj-1': 'yolo' } }),
    );
    await ensureApprovalModesLoaded();
    expect(getApprovalMode('proj-1')).toBe('manual');
  });
});
