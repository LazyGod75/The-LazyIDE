/**
 * Provisioning adapter tests (Pillar C3).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  provisionService,
  teardownService,
  getCredentials,
  getProvisionedServices,
  clearProvisionedServices,
  estimateCost,
  registerAdapter,
  resetAdapters,
  setSecureStorageBackend,
  resetSecureStorageBackend,
  type ProvisioningRequest,
  type ProvisioningResult,
} from '../lib/agents/provisioning';
import { on } from '../lib/bus';

beforeEach(() => {
  clearProvisionedServices();
  resetSecureStorageBackend();
  resetAdapters();
});

describe('provisionService', () => {
  it('provisions a supabase-db service', async () => {
    const req: ProvisioningRequest = {
      service: 'supabase-db',
      projectId: 'proj-a',
      config: {},
      costEstimateCents: 0,
    };
    const result = await provisionService(req);
    expect(result.ok).toBe(true);
    expect(result.service).toBe('supabase-db');
    expect(result.credentials).toBeDefined();
    expect(result.credentials!.SUPABASE_URL).toBeDefined();
    expect(result.credentials!.SUPABASE_ANON_KEY).toBeDefined();
    expect(result.endpoint).toBeDefined();
  });

  it('provisions an api-key service', async () => {
    const req: ProvisioningRequest = {
      service: 'api-key',
      projectId: 'proj-b',
      config: { keyName: 'OPENAI_KEY', keyValue: 'sk-test-123' },
      costEstimateCents: 0,
    };
    const result = await provisionService(req);
    expect(result.ok).toBe(true);
    expect(result.credentials!.OPENAI_KEY).toBe('sk-test-123');
  });

  it('fails for missing keyValue in api-key', async () => {
    const req: ProvisioningRequest = {
      service: 'api-key',
      projectId: 'proj-c',
      config: { keyName: 'MY_KEY' },
      costEstimateCents: 0,
    };
    const result = await provisionService(req);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Missing keyValue');
  });

  it('fails for unregistered service type', async () => {
    // Temporarily override with a custom adapter that we remove
    const req: ProvisioningRequest = {
      service: 'unknown-service' as never,
      projectId: 'proj-d',
      config: {},
      costEstimateCents: 0,
    };
    const result = await provisionService(req);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No adapter');
  });

  it('emits provisioning.provisioned event', async () => {
    let emitted = false;
    const off = on('provisioning.provisioned', () => { emitted = true; });
    await provisionService({
      service: 'supabase-auth',
      projectId: 'proj-e',
      config: {},
      costEstimateCents: 0,
    });
    expect(emitted).toBe(true);
    off();
  });
});

describe('teardownService', () => {
  it('tears down a provisioned service', async () => {
    const result = await provisionService({
      service: 'supabase-db',
      projectId: 'proj-f',
      config: {},
      costEstimateCents: 0,
    });
    expect(result.ok).toBe(true);

    const services = getProvisionedServices('proj-f');
    expect(services.length).toBe(1);

    const teardown = await teardownService(services[0].id);
    expect(teardown.ok).toBe(true);
    expect(getProvisionedServices('proj-f')).toHaveLength(0);
  });

  it('fails for unknown service id', async () => {
    const result = await teardownService('nonexistent-id');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No provisioned service');
  });

  it('emits provisioning.teardown event', async () => {
    let emitted = false;
    const off = on('provisioning.teardown', () => { emitted = true; });

    await provisionService({
      service: 'supabase-storage',
      projectId: 'proj-g',
      config: {},
      costEstimateCents: 0,
    });
    const services = getProvisionedServices('proj-g');
    await teardownService(services[0].id);

    expect(emitted).toBe(true);
    off();
  });
});

describe('getCredentials', () => {
  it('retrieves credentials after provisioning', async () => {
    await provisionService({
      service: 'api-key',
      projectId: 'proj-h',
      config: { keyName: 'STRIPE_KEY', keyValue: 'sk-stripe-xyz' },
      costEstimateCents: 0,
    });

    const creds = await getCredentials('proj-h', 'api-key');
    expect(creds).toBeDefined();
    expect(creds!.STRIPE_KEY).toBe('sk-stripe-xyz');
  });

  it('returns null for unprovisioned service', async () => {
    const creds = await getCredentials('proj-i', 'api-key');
    expect(creds).toBeNull();
  });
});

describe('getProvisionedServices', () => {
  it('lists services filtered by project', async () => {
    await provisionService({ service: 'supabase-db', projectId: 'a', config: {}, costEstimateCents: 0 });
    await provisionService({ service: 'supabase-auth', projectId: 'b', config: {}, costEstimateCents: 0 });

    const all = getProvisionedServices();
    expect(all.length).toBe(2);

    const forA = getProvisionedServices('a');
    expect(forA).toHaveLength(1);
    expect(forA[0].service).toBe('supabase-db');
  });
});

describe('estimateCost', () => {
  it('returns 0 for free-tier services', () => {
    expect(estimateCost('supabase-db', {})).toBe(0);
    expect(estimateCost('supabase-auth', {})).toBe(0);
    expect(estimateCost('api-key', {})).toBe(0);
  });
});

describe('custom adapters', () => {
  it('registers and uses a custom adapter', async () => {
    registerAdapter('api-key', async (req): Promise<ProvisioningResult> => {
      return {
        ok: true,
        service: 'api-key',
        projectId: req.projectId,
        credentials: { CUSTOM: 'custom-value' },
        provisionedAt: Date.now(),
      };
    });

    const result = await provisionService({
      service: 'api-key',
      projectId: 'proj-custom',
      config: {},
      costEstimateCents: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.credentials!.CUSTOM).toBe('custom-value');
  });
});

describe('secure storage backend', () => {
  it('uses custom storage backend', async () => {
    const stored = new Map<string, string>();
    setSecureStorageBackend({
      async store(key, value) { stored.set(key, value); },
      async retrieve(key) { return stored.get(key) ?? null; },
      async remove(key) { stored.delete(key); },
    });

    await provisionService({
      service: 'api-key',
      projectId: 'proj-secure',
      config: { keyName: 'SECRET', keyValue: 'super-secret' },
      costEstimateCents: 0,
    });

    expect(stored.has('proj-secure:api-key:SECRET')).toBe(true);
    expect(stored.get('proj-secure:api-key:SECRET')).toBe('super-secret');
  });
});
