import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the modules that readiness.ts reads from so we can control their output.
vi.mock('../lib/models/cliBackendProvider', () => ({
  isCliBackendAvailable: vi.fn().mockReturnValue(null),
  CLI_BACKENDS: [],
  detectAllCliBackends: vi.fn(),
  cliBackendProvider: vi.fn(),
}));

vi.mock('../lib/models/anthropicProvider', () => ({
  hasAnthropicKey: vi.fn().mockReturnValue(false),
  anthropicProvider: {},
}));

vi.mock('../lib/models/index', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...orig,
    isManagedActive: vi.fn().mockReturnValue(false),
  };
});

import { isCliBackendAvailable } from '../lib/models/cliBackendProvider';
import { hasAnthropicKey } from '../lib/models/anthropicProvider';
import { isManagedActive } from '../lib/models/index';
import {
  claudeCliReadiness,
  codexCliReadiness,
  byokAnthropicReadiness,
  byokReadiness,
  managedProReadiness,
  getAllBackendsReadiness,
  activeBackendId,
} from '../lib/models/readiness';
import { resolveByokDef } from '../lib/models/byokProviders';

const mockIsCliBackendAvailable = isCliBackendAvailable as ReturnType<typeof vi.fn>;
const mockHasAnthropicKey = hasAnthropicKey as ReturnType<typeof vi.fn>;
const mockIsManagedActive = isManagedActive as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockIsCliBackendAvailable.mockReturnValue(null);
  mockHasAnthropicKey.mockReturnValue(false);
  mockIsManagedActive.mockReturnValue(false);
});

// ── claudeCliReadiness ─────────────────────────────────────────────

describe('claudeCliReadiness', () => {
  it('is ready when claude CLI is detected', () => {
    mockIsCliBackendAvailable.mockReturnValue(true);
    const r = claudeCliReadiness();
    expect(r.ready).toBe(true);
    expect(r.id).toBe('claude-code');
    expect(r.reason).toBeUndefined();
    expect(r.howToEnable).toBeUndefined();
  });

  it('is not ready when claude CLI is absent', () => {
    mockIsCliBackendAvailable.mockReturnValue(false);
    const r = claudeCliReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/introuvable/i);
    expect(r.howToEnable).toMatch(/claude\.ai\/download/i);
  });

  it('is not ready (pending) when detection has not run yet (null)', () => {
    mockIsCliBackendAvailable.mockReturnValue(null);
    const r = claudeCliReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/en cours/i);
  });
});

// ── codexCliReadiness ─────────────────────────────────────────────

describe('codexCliReadiness', () => {
  it('is ready when codex CLI is detected', () => {
    mockIsCliBackendAvailable.mockImplementation((tool: string) =>
      tool === 'codex' ? true : null
    );
    const r = codexCliReadiness();
    expect(r.ready).toBe(true);
    expect(r.id).toBe('codex');
  });

  it('is not ready when codex CLI is absent', () => {
    mockIsCliBackendAvailable.mockReturnValue(false);
    const r = codexCliReadiness();
    expect(r.ready).toBe(false);
    expect(r.howToEnable).toMatch(/codex/i);
  });
});

// ── byokAnthropicReadiness ────────────────────────────────────────

describe('byokAnthropicReadiness', () => {
  it('is ready when an Anthropic key is configured', () => {
    localStorage.setItem('lazy.apikey.anthropic', 'sk-ant-test');
    const r = byokAnthropicReadiness();
    expect(r.ready).toBe(true);
    expect(r.id).toBe('live-key');
    expect(r.reason).toBeUndefined();
  });

  it('is not ready when no key is configured', () => {
    localStorage.removeItem('lazy.apikey.anthropic');
    const r = byokAnthropicReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/clé API/i);
    expect(r.howToEnable).toMatch(/Réglages/i);
  });
});

// ── other BYOK providers (BYOK wave) ───────────────────────────────

describe('byokReadiness (BYOK wave)', () => {
  it('reports one card per provider with a distinct id', () => {
    const deepseek = byokReadiness(resolveByokDef('deepseek')!);
    expect(deepseek.id).toBe('byok-deepseek');
    expect(deepseek.ready).toBe(false);

    localStorage.setItem('lazy.apikey.deepseek', 'sk-test');
    const ready = byokReadiness(resolveByokDef('deepseek')!);
    expect(ready.ready).toBe(true);
  });
});

// ── managedProReadiness ───────────────────────────────────────────

describe('managedProReadiness', () => {
  it('is ready when the Pro subscription is active', () => {
    mockIsManagedActive.mockReturnValue(true);
    const r = managedProReadiness();
    expect(r.ready).toBe(true);
    expect(r.id).toBe('managed');
    expect(r.reason).toBeUndefined();
  });

  it('is not ready when the subscription is inactive', () => {
    mockIsManagedActive.mockReturnValue(false);
    const r = managedProReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/abonnement Pro/i);
    expect(r.howToEnable).toMatch(/Compte/i);
  });

  it('includes a note about server-side proxy check', () => {
    mockIsManagedActive.mockReturnValue(false);
    const r = managedProReadiness();
    expect(r.reason).toMatch(/503/i);
  });
});

// ── getAllBackendsReadiness ────────────────────────────────────────

describe('getAllBackendsReadiness', () => {
  it('returns one descriptor per backend (2 CLI + 7 BYOK + managed)', () => {
    const all = getAllBackendsReadiness();
    expect(all).toHaveLength(10);
  });

  it('returns descriptors with distinct ids', () => {
    const all = getAllBackendsReadiness();
    const ids = all.map(r => r.id);
    expect(new Set(ids).size).toBe(10);
    expect(ids).toContain('byok-deepseek');
    expect(ids).toContain('byok-openrouter');
  });
});

// ── activeBackendId ───────────────────────────────────────────────

describe('activeBackendId', () => {
  it.each([
    ['claude-code', 'claude-code'],
    ['codex', 'codex'],
    ['live-key', 'live-key'],
    ['managed', 'managed'],
    ['pro', 'managed'],
    ['mock', 'mock'],
  ] as const)('maps mode %s to backend id %s', (mode, expected) => {
    expect(activeBackendId(mode)).toBe(expected);
  });

  it('maps live-key to the SELECTED BYOK provider card when not anthropic', () => {
    localStorage.setItem('lazy.accessSettings', JSON.stringify({ accessMode: 'byok', byokProvider: 'deepseek' }));
    expect(activeBackendId('live-key')).toBe('byok-deepseek');
  });
});
