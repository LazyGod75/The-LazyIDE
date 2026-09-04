/* ProvisioningPanel.tsx — Service provisioning UI (Pillar C3).

   Duplicate-heading fix (real user report, 2026-08-14): this used to render
   its own "Provisioning" <h3> directly under CockpitRailPopover's own
   "PROVISIONING" title — same redundant-nesting bug FleetMap.tsx/
   DecisionCenter.tsx already had fixed (see FleetMap.tsx's header comment:
   "the popover chrome IS the heading"). No heading rendered here now.

   Currency-leak fix (same report): cost estimates used to render as
   `$X.XX` (costEstimateCents / 100) — this app's standing rule is credits,
   never currency, for cost-of-work figures (mission cards had the same
   "$0.07" removed for the same reason). `costEstimateCents` is already
   cents-denominated, so `formatCredits` needs no unit conversion — it just
   drops the `$`/decimal formatting for the same real number. */

import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { formatCredits } from '../../../lib/billing';
import {
  provisionService,
  teardownService,
  estimateCost,
  type ServiceType,
  type ProvisionedService,
  type ProvisioningRequest,
} from '../../../lib/agents/provisioning';

const SERVICE_TYPES: ServiceType[] = ['supabase-db', 'supabase-auth', 'supabase-storage', 'api-key'];

/** Unique id for a project the operator didn't name — lives at module scope so
 *  the impure `Date.now()` call is outside any component/hook render body
 *  (react-hooks/purity). */
function defaultProjectId(projectId: string): string {
  return projectId || `proj-${Date.now()}`;
}

export function ProvisioningPanel() {
  const { t } = useI18n();
  const [services, setServices] = useState<ProvisionedService[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [serviceType, setServiceType] = useState<ServiceType>('supabase-db');
  const [projectId, setProjectId] = useState('');
  const [configText, setConfigText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const costEstimate = estimateCost(serviceType, safeParseConfig(configText));

  async function handleProvision() {
    setLoading(true);
    setError(null);
    const req: ProvisioningRequest = {
      service: serviceType,
      projectId: defaultProjectId(projectId),
      config: safeParseConfig(configText),
      costEstimateCents: costEstimate,
    };
    const result = await provisionService(req);
    if (result.ok) {
      const updated = [...services, {
        id: `${req.projectId}:${req.service}:${result.provisionedAt}`,
        service: req.service,
        provider: 'default',
        projectId: req.projectId,
        credentials: result.credentials ?? {},
        endpoint: result.endpoint,
        provisionedAt: result.provisionedAt,
        costEstimateCents: req.costEstimateCents,
      }];
      setServices(updated);
      setShowForm(false);
      setProjectId('');
      setConfigText('');
    } else {
      setError(result.error ?? 'Provisioning failed');
    }
    setLoading(false);
  }

  async function handleTeardown(id: string) {
    setLoading(true);
    setError(null);
    const result = await teardownService(id);
    if (result.ok) {
      setServices(services.filter((s) => s.id !== id));
    } else {
      setError(result.error ?? 'Teardown failed');
    }
    setLoading(false);
  }

  return (
    <div className="p-4 space-y-3">
      {error && <p className="text-xs text-red-400">{error}</p>}
      {services.length === 0 && !showForm && (
        <p className="text-xs text-slate-500">No services provisioned</p>
      )}
      {services.map((s) => (
        <div key={s.id} className="p-3 rounded bg-slate-800/60 space-y-1">
          <div className="font-medium text-slate-200">{s.service}</div>
          <div className="text-xs text-slate-400">
            {s.projectId} · {t('cockpit.manager.approxCredits', { count: formatCredits(s.costEstimateCents) })}
          </div>
          {s.endpoint && <div className="text-xs text-slate-500">{s.endpoint}</div>}
          <button
            type="button"
            disabled={loading}
            onClick={() => handleTeardown(s.id)}
            className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
          >
            Teardown
          </button>
        </div>
      ))}
      {showForm ? (
        <div className="p-3 rounded bg-slate-800/60 space-y-2">
          <select
            value={serviceType}
            onChange={(e) => setServiceType(e.target.value as ServiceType)}
            className="w-full text-xs bg-slate-900 text-slate-200 rounded px-2 py-1 border border-slate-700"
          >
            {SERVICE_TYPES.map((st) => (
              <option key={st} value={st}>{st}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Project ID (optional)"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full text-xs bg-slate-900 text-slate-200 rounded px-2 py-1 border border-slate-700"
          />
          <textarea
            placeholder='Config (JSON, optional) e.g. {"keyName":"openai","keyValue":"sk-..."}'
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
            rows={3}
            className="w-full text-xs bg-slate-900 text-slate-200 rounded px-2 py-1 border border-slate-700 font-mono"
          />
          <div className="text-xs text-slate-400">
            {t('onboarding.brain.costEstimate', { amount: formatCredits(costEstimate) })}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={handleProvision}
              className="text-xs px-3 py-1 rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50"
            >
              {loading ? 'Provisioning…' : 'Provision'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-xs px-3 py-1 rounded text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="text-xs px-3 py-1 rounded bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700"
        >
          + Provision
        </button>
      )}
    </div>
  );
}

function safeParseConfig(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
