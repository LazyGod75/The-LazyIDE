/* Lazy Cloud — public configuration.

   These values are PUBLIC by design and safe to ship in the open-source
   repo. They let anyone who clones the app sign up for a Lazy account and
   subscribe to LazyPro without leaking any server-side secret.

   Why this is safe:
   - SUPABASE_URL is just an endpoint. Knowing it grants no access.
   - SUPABASE_ANON_KEY is the publishable/anon key, enforced by Row Level
     Security. Anonymous users can only read/write what RLS policies allow
     (their own rows, never other users' data, never billing tables).
   - The Supabase service-role key, Stripe secret key, webhook secret, and
     OpenRouter key live ONLY in Supabase Edge Function env vars (server-side)
     — they are never in the client, never in this file, never in git.
*/

export const LAZY_CLOUD_CONFIG = {
  supabaseUrl: 'https://afjrltfwhksdipchwqsf.supabase.co',
  supabaseAnonKey: 'sb_publishable_5fcQFK8vEQzled0QZ2aR4g_PfA8VvBI',
} as const;
