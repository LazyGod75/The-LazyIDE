/* provisioning.ts — Provisioning Adapter (Pillar C3).
 *
 * Provides service provisioning capabilities for the orchestrator.
 * When the manager detects a project needs infrastructure (database,
 * auth, storage, API keys), it can request provisioning through this
 * module. The action gate checks the autonomy mode before executing.
 *
 * Adapters:
 *   - Supabase: DB/Auth/Storage provisioning via management API
 *   - Generic API key: request/store/retrieve arbitrary API keys
 *
 * Credentials are stored in-memory (test-safe) with a pluggable
 * secure storage backend for production (Tauri secure storage).
 */

import { emit } from '../bus.js';

// ── Types ──────────────────────────────────────────────────────────

export type ServiceType = 'supabase-db' | 'supabase-auth' | 'supabase-storage' | 'api-key';

export interface ProvisioningRequest {
  service: ServiceType;
  provider?: string;
  config: Record<string, unknown>;
  projectId: string;
  costEstimateCents: number;
}

export interface ProvisioningResult {
  ok: boolean;
  service: ServiceType;
  projectId: string;
  credentials?: Record<string, string>;
  endpoint?: string;
  error?: string;
  provisionedAt: number;
}

export interface TeardownResult {
  ok: boolean;
  service: ServiceType;
  projectId: string;
  error?: string;
}

export interface ProvisionedService {
  id: string;
  service: ServiceType;
  provider: string;
  projectId: string;
  credentials: Record<string, string>;
  endpoint?: string;
  provisionedAt: number;
  costEstimateCents: number;
}

// ── Module state ───────────────────────────────────────────────────

const provisionedServices = new Map<string, ProvisionedService>();

/** Pluggable secure storage backend. Default: in-memory. */
export interface SecureStorageBackend {
  store(key: string, value: string): Promise<void>;
  retrieve(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
}

const inMemoryStorage = new Map<string, string>();

const defaultBackend: SecureStorageBackend = {
  async store(key, value) { inMemoryStorage.set(key, value); },
  async retrieve(key) { return inMemoryStorage.get(key) ?? null; },
  async remove(key) { inMemoryStorage.delete(key); },
};

let storageBackend: SecureStorageBackend = defaultBackend;

export function setSecureStorageBackend(backend: SecureStorageBackend): void {
  storageBackend = backend;
}

export function resetSecureStorageBackend(): void {
  storageBackend = defaultBackend;
  inMemoryStorage.clear();
}

// ── Cost estimation ────────────────────────────────────────────────

const COST_ESTIMATES: Record<ServiceType, number> = {
  'supabase-db': 0,      // free tier
  'supabase-auth': 0,    // free tier
  'supabase-storage': 0, // free tier
  'api-key': 0,          // depends on provider
};

export function estimateCost(service: ServiceType, _config: Record<string, unknown>): number {
  return COST_ESTIMATES[service] ?? 0;
}

// ── Adapters ───────────────────────────────────────────────────────

type ProvisioningAdapter = (req: ProvisioningRequest) => Promise<ProvisioningResult>;

const adapters = new Map<ServiceType, ProvisioningAdapter>();

/** Supabase adapter — provisions DB/Auth/Storage via management API. */
async function supabaseAdapter(req: ProvisioningRequest): Promise<ProvisioningResult> {
  const { service, projectId, config } = req;

  // In production, this would call the Supabase management API
  // For now, we simulate provisioning with config-based credentials
  const projectRef = config.projectRef as string ?? `lazy-${projectId}-${Date.now()}`;
  const anonKey = config.anonKey as string ?? `sb-anon-${Math.random().toString(36).slice(2)}`;
  const serviceKey = config.serviceKey as string ?? `sb-service-${Math.random().toString(36).slice(2)}`;
  const url = config.url as string ?? `https://${projectRef}.supabase.co`;

  const credentials: Record<string, string> = {
    SUPABASE_URL: url,
    SUPABASE_ANON_KEY: anonKey,
    SUPABASE_SERVICE_KEY: serviceKey,
  };

  // Store credentials securely
  for (const [key, value] of Object.entries(credentials)) {
    await storageBackend.store(`${projectId}:${service}:${key}`, value);
  }

  return {
    ok: true,
    service,
    projectId,
    credentials,
    endpoint: url,
    provisionedAt: Date.now(),
  };
}

/** Generic API key adapter — stores arbitrary API keys. */
async function apiKeyAdapter(req: ProvisioningRequest): Promise<ProvisioningResult> {
  const { service, projectId, config } = req;
  const keyName = config.keyName as string ?? 'default';
  const keyValue = config.keyValue as string;

  if (!keyValue) {
    return {
      ok: false,
      service,
      projectId,
      error: 'Missing keyValue in provisioning config',
      provisionedAt: Date.now(),
    };
  }

  await storageBackend.store(`${projectId}:api-key:${keyName}`, keyValue);

  return {
    ok: true,
    service,
    projectId,
    credentials: { [keyName]: keyValue },
    provisionedAt: Date.now(),
  };
}

// Register default adapters
adapters.set('supabase-db', supabaseAdapter);
adapters.set('supabase-auth', supabaseAdapter);
adapters.set('supabase-storage', supabaseAdapter);
adapters.set('api-key', apiKeyAdapter);

export function registerAdapter(service: ServiceType, adapter: ProvisioningAdapter): void {
  adapters.set(service, adapter);
}

/** Reset all adapters to defaults (for tests). */
export function resetAdapters(): void {
  adapters.clear();
  adapters.set('supabase-db', supabaseAdapter);
  adapters.set('supabase-auth', supabaseAdapter);
  adapters.set('supabase-storage', supabaseAdapter);
  adapters.set('api-key', apiKeyAdapter);
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Provision a service for a project.
 * Stores credentials securely and emits a provisioning event.
 */
export async function provisionService(req: ProvisioningRequest): Promise<ProvisioningResult> {
  const adapter = adapters.get(req.service);
  if (!adapter) {
    return {
      ok: false,
      service: req.service,
      projectId: req.projectId,
      error: `No adapter registered for service type '${req.service}'`,
      provisionedAt: Date.now(),
    };
  }

  const result = await adapter(req);

  if (result.ok && result.credentials) {
    const id = `${req.projectId}:${req.service}:${Date.now()}`;
    const provisioned: ProvisionedService = {
      id,
      service: req.service,
      provider: req.provider ?? 'default',
      projectId: req.projectId,
      credentials: result.credentials,
      endpoint: result.endpoint,
      provisionedAt: result.provisionedAt,
      costEstimateCents: req.costEstimateCents,
    };
    provisionedServices.set(id, provisioned);

    emit('provisioning.provisioned', {
      service: req.service,
      projectId: req.projectId,
      endpoint: result.endpoint,
    });
  }

  return result;
}

/**
 * Teardown a previously provisioned service.
 * Removes credentials from secure storage.
 */
export async function teardownService(serviceId: string): Promise<TeardownResult> {
  const service = provisionedServices.get(serviceId);
  if (!service) {
    return {
      ok: false,
      service: 'api-key' as ServiceType,
      projectId: '',
      error: `No provisioned service with id '${serviceId}'`,
    };
  }

  // Remove credentials from secure storage
  for (const key of Object.keys(service.credentials)) {
    await storageBackend.remove(`${service.projectId}:${service.service}:${key}`);
  }

  provisionedServices.delete(serviceId);

  emit('provisioning.teardown', {
    service: service.service,
    projectId: service.projectId,
  });

  return {
    ok: true,
    service: service.service,
    projectId: service.projectId,
  };
}

/**
 * Retrieve credentials for a provisioned service.
 */
export async function getCredentials(projectId: string, service: ServiceType): Promise<Record<string, string> | null> {
  const services = getProvisionedServices(projectId, service);
  if (services.length === 0) return null;
  return services[0].credentials;
}

/**
 * List all provisioned services for a project.
 */
export function getProvisionedServices(projectId?: string, service?: ServiceType): ProvisionedService[] {
  const all = Array.from(provisionedServices.values());
  return all.filter((s) => {
    if (projectId && s.projectId !== projectId) return false;
    if (service && s.service !== service) return false;
    return true;
  });
}

/**
 * Clear all provisioned services (for tests).
 */
export function clearProvisionedServices(): void {
  provisionedServices.clear();
  inMemoryStorage.clear();
}
