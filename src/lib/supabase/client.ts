import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAnonKey, supabaseUrl } from '../env.js';
import { isCloudConfigured } from '../envCloud.js';

function missingCloud(): never {
  throw new Error(
    'Lazy Cloud is not configured. Skip sign-in and use CLI/BYOK, or set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
  );
}

export const supabase: SupabaseClient = isCloudConfigured(supabaseUrl, supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : new Proxy({} as SupabaseClient, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        return missingCloud;
      },
    });
