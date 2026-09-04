/* Provider readiness model — pure, typed, testable.

   Returns a structured readiness descriptor for each backend so the UI can
   render actionable states rather than opaque error strings.

   Design notes:
   - All functions are pure (no React, no side effects).
   - Runtime checks (CLI detection, key presence) are resolved before calling
     these helpers; the helpers only interpret the already-known values.
   - "managed" (Pro) readiness is soft: the server-side key cannot be checked
     from the client. We report ready=true when the subscription is active and
     note that actual availability is determined by the proxy response (503 =
     managed_unavailable is caught by managedWithFallback).
*/

import type { ProviderMode } from './index.js';
import { isCliBackendAvailable } from './cliBackendProvider.js';
import { isManagedActive } from './index.js';
import { BYOK_PROVIDER_DEFS, hasByokKey, resolveByokDef } from './byokProviders.js';
import type { ByokProviderDef } from './byokProviders.js';
import { loadAccessSettings } from './accessSettings.js';

// ── Types ─────────────────────────────────────────────────────────

/** Translator function shape — matches useI18n().t so callers can pass the
 *  hook's `t` directly. Defaults to `fr` (DEFAULT_LOCALE) copy when no
 *  translator is supplied, e.g. from tests that call these pure functions
 *  directly without an I18nProvider. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  let str = template;
  for (const [k, v] of Object.entries(params)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return str;
}

// Fallback dictionary (fr, matching the app's DEFAULT_LOCALE) — used when a
// caller does not supply a translator. Mirrors the fr.ts entries under the
// settings.readiness.* namespace so behavior stays identical to the
// pre-i18n hardcoded French this module used to return unconditionally.
const FALLBACK_FR: Record<string, string> = {
  'settings.readiness.claudeCode.label':       'Claude Code (abonnement)',
  'settings.readiness.claudeCode.notFound':    'Binaire claude introuvable sur PATH.',
  'settings.readiness.claudeCode.howToEnable': 'Installe Claude Code : https://claude.ai/download, puis redémarre Lazy.',
  'settings.readiness.codex.label':            'Codex CLI (OpenAI)',
  'settings.readiness.codex.notFound':         'Binaire codex introuvable sur PATH.',
  'settings.readiness.codex.howToEnable':      'Installe OpenAI Codex CLI (npm i -g @openai/codex), puis redémarre Lazy.',
  'settings.readiness.detectingCli':           'Détection CLI en cours...',
  'settings.readiness.byok.label':             'Clé API {provider} (BYOK)',
  'settings.readiness.byok.noKey':             'Aucune clé API {provider} configurée.',
  'settings.readiness.byok.howToEnable':       'Ajoute ta clé dans Réglages > Modèles, puis clique « Utiliser {provider} ».',
  'settings.readiness.managed.label':          'Pro · géré par Lazy',
  'settings.readiness.managed.inactive':       "Abonnement Pro inactif ou crédits épuisés. Note : la disponibilité côté serveur est vérifiée à l'envoi — une erreur 503 provoque un basculement automatique.",
  'settings.readiness.managed.howToEnable':    'Active un abonnement Pro dans Réglages > Compte.',
};

const defaultTranslate: Translate = (key, params) => interpolate(FALLBACK_FR[key] ?? key, params);

export interface BackendReadiness {
  /** Unique backend id — matches ProviderMode values. */
  id: string;
  /** Human-readable backend name, localized via the translator passed in. */
  label: string;
  /** Whether this backend can accept requests right now. */
  ready: boolean;
  /** Why it is not ready (absent when ready === true). */
  reason?: string;
  /** Actionable fix instructions (absent when ready === true). */
  howToEnable?: string;
}

// ── Per-backend descriptors ───────────────────────────────────────
//
// Every function below accepts an optional `t` translator (defaults to the
// fr fallback above) so UI callers can pass useI18n().t() to render these
// cards in the active interface language.

export function claudeCliReadiness(t: Translate = defaultTranslate): BackendReadiness {
  const available = isCliBackendAvailable('claude');
  // null = detection not yet run (treat as not-ready for display purposes)
  const ready = available === true;
  return {
    id: 'claude-code',
    label: t('settings.readiness.claudeCode.label'),
    ready,
    reason: ready
      ? undefined
      : available === null
        ? t('settings.readiness.detectingCli')
        : t('settings.readiness.claudeCode.notFound'),
    howToEnable: ready
      ? undefined
      : t('settings.readiness.claudeCode.howToEnable'),
  };
}

export function codexCliReadiness(t: Translate = defaultTranslate): BackendReadiness {
  const available = isCliBackendAvailable('codex');
  const ready = available === true;
  return {
    id: 'codex',
    label: t('settings.readiness.codex.label'),
    ready,
    reason: ready
      ? undefined
      : available === null
        ? t('settings.readiness.detectingCli')
        : t('settings.readiness.codex.notFound'),
    howToEnable: ready
      ? undefined
      : t('settings.readiness.codex.howToEnable'),
  };
}

export function byokReadiness(def: ByokProviderDef, t: Translate = defaultTranslate): BackendReadiness {
  const ready = hasByokKey(def.id);
  return {
    // The Anthropic card keeps its historical id 'live-key' (existing tests
    // and the active-backend mapping rely on it); every other BYOK provider
    // gets a distinct `byok-<id>` card id.
    id: def.id === 'anthropic' ? 'live-key' : `byok-${def.id}`,
    label: t('settings.readiness.byok.label', { provider: def.label }),
    ready,
    reason: ready ? undefined : t('settings.readiness.byok.noKey', { provider: def.label }),
    howToEnable: ready
      ? undefined
      : t('settings.readiness.byok.howToEnable', { provider: def.label }),
  };
}

export function byokAnthropicReadiness(t: Translate = defaultTranslate): BackendReadiness {
  return byokReadiness(resolveByokDef('anthropic')!, t);
}

export function managedProReadiness(t: Translate = defaultTranslate): BackendReadiness {
  const active = isManagedActive();
  return {
    id: 'managed',
    label: t('settings.readiness.managed.label'),
    ready: active,
    reason: active
      ? undefined
      : t('settings.readiness.managed.inactive'),
    howToEnable: active
      ? undefined
      : t('settings.readiness.managed.howToEnable'),
  };
}

// ── Aggregate helper ──────────────────────────────────────────────

/** Return readiness descriptors for every backend in display order:
 *  the two CLI rails, then one card per BYOK provider, then managed Pro. */
export function getAllBackendsReadiness(t: Translate = defaultTranslate): BackendReadiness[] {
  return [
    claudeCliReadiness(t),
    codexCliReadiness(t),
    ...BYOK_PROVIDER_DEFS.map(def => byokReadiness(def, t)),
    managedProReadiness(t),
  ];
}

/** Return the backend id that corresponds to the currently active ProviderMode. */
export function activeBackendId(mode: ProviderMode): string {
  // 'claude-code' mode maps to 'claude-code' backend id
  // 'codex' → 'codex', 'live-key' → the SELECTED BYOK provider's card id
  // ('live-key' for Anthropic, 'byok-<id>' otherwise),
  // 'managed'/'pro' → 'managed', 'mock' → 'mock'
  if (mode === 'pro' || mode === 'managed') return 'managed';
  if (mode === 'mock') return 'mock';
  if (mode === 'live-key') {
    const def = resolveByokDef(loadAccessSettings().byokProvider);
    return def && def.id !== 'anthropic' ? `byok-${def.id}` : 'live-key';
  }
  return mode;
}
