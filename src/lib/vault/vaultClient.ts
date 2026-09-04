/* vaultClient.ts — thin wrapper around the Rust OS-credential-store
   commands (secret_set/secret_get/secret_presence/secret_delete in
   src-tauri/src/commands/vault.rs), plus the one-time migration that moves
   legacy plaintext BYOK API keys out of localStorage and into the vault.

   Desktop (Tauri) only — every export here goes through `invoke`, so it
   only makes sense to call these when `isTauri()` is true. See
   byokProviders.ts for the browser-only localStorage fallback used when
   there is no Tauri IPC (no OS credential vault exists inside a browser
   tab — that fallback is explicit and documented there, not silent).

   Security contract:
   - getSecretRaw returns the RAW secret. Only call it from code that needs
     the actual value to do something with it (e.g. an Authorization
     header for a BYOK provider request). NEVER log its return value.
   - getSecretPresence returns a masked `{ present, hint }` — use this for
     any "is a key configured?" UI check. It never exposes enough of the
     secret to reconstruct it.
*/

import { invoke } from '@tauri-apps/api/core';

export interface SecretPresence {
  present: boolean;
  hint?: string;
}

/** Raw secret value for `key`, or `undefined` if nothing is stored.
 *  ONLY for callers that need the value to make a request. */
export async function getSecretRaw(key: string): Promise<string | undefined> {
  const value = await invoke<string | null>('secret_get', { key });
  return value ?? undefined;
}

/** Masked presence check — for anything that just needs to know a secret
 *  is configured, never the value itself. */
export function getSecretPresence(key: string): Promise<SecretPresence> {
  return invoke<SecretPresence>('secret_presence', { key });
}

export function setSecret(key: string, value: string): Promise<void> {
  return invoke<void>('secret_set', { key, value });
}

export function deleteSecret(key: string): Promise<void> {
  return invoke<void>('secret_delete', { key });
}

// ── BYOK migration (localStorage → vault) ──────────────────────────

const BYOK_LOCALSTORAGE_PREFIX = 'lazy.apikey.';

/** Every provider id ever persisted under `lazy.apikey.<id>` in
 *  localStorage — a plain string list (not importing ByokProvider /
 *  BYOK_PROVIDER_DEFS from byokProviders.ts) so this migration has zero
 *  dependency on that module and can run standalone, before anything else
 *  reads a BYOK key. Includes 'google', which has no active provider def
 *  today but may still have a leftover localStorage entry from an older
 *  build — migrating (rather than ignoring) it is the honest cleanup. */
export const ALL_BYOK_PROVIDER_IDS = [
  'anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'xai', 'groq', 'mistral',
] as const;

/** Vault key a BYOK provider's API key is stored under. */
export function byokVaultKey(provider: string): string {
  return `apikey.${provider}`;
}

/**
 * One-time, silent migration: for every `lazy.apikey.<provider>` value
 * still sitting in localStorage (pre-vault installs), move it into the OS
 * vault and remove the plaintext copy. Idempotent — a provider with no
 * localStorage entry (already migrated, or never configured) is a no-op
 * for that provider; calling this again after a full migration is a
 * complete no-op (returns an empty list, touches nothing).
 *
 * Returns the provider ids actually migrated in this call — used by
 * byokProviders.ts to know which vault entries to warm into its
 * synchronous in-memory cache, and by this module's own tests.
 */
export async function migrateByokKeysToVault(): Promise<string[]> {
  const migrated: string[] = [];
  for (const provider of ALL_BYOK_PROVIDER_IDS) {
    const lsKey = `${BYOK_LOCALSTORAGE_PREFIX}${provider}`;
    let raw: string | null;
    try {
      raw = localStorage.getItem(lsKey);
    } catch {
      continue; // localStorage unavailable — nothing to migrate
    }
    if (!raw || !raw.trim()) continue;
    try {
      await setSecret(byokVaultKey(provider), raw);
    } catch (err) {
      // One provider's vault write failing (transient IPC/OS-store error)
      // must not stop the loop from attempting every other provider — a
      // whole-migration abort here used to also skip the caller's
      // subsequent cache-warm step for every provider, not just this one.
      // Never log `raw`. The localStorage copy is deliberately left in
      // place on failure (not removed below) so this provider is retried
      // on the next call instead of silently losing the key.
      console.error(`[vaultClient] migration: vault write failed for ${provider}`, err instanceof Error ? err.message : String(err));
      continue;
    }
    try {
      localStorage.removeItem(lsKey);
    } catch {
      // Best-effort: the vault write already succeeded even if the old
      // localStorage copy couldn't be removed (e.g. storage disabled
      // mid-session) — the secret is safe in the vault either way, so this
      // is not re-thrown.
    }
    migrated.push(provider);
  }
  return migrated;
}
