/** True when Lazy Cloud (Supabase) client config is present. */
export function isCloudConfigured(
  url?: string | null,
  anonKey?: string | null,
): boolean {
  return Boolean(url?.trim() && anonKey?.trim());
}
