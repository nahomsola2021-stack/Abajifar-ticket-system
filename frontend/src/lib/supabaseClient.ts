import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getAppConfig } from './config';

let cachedClient: SupabaseClient | null = null;
let lastUsedConfig: { url: string; key: string } | null = null;

/**
 * Returns a configured Supabase client instance or null if credentials are missing.
 */
export function getSupabaseClient(): SupabaseClient | null {
  const { supabaseUrl, supabaseAnonKey } = getAppConfig();

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  // Reuse existing client if credentials match
  if (
    cachedClient &&
    lastUsedConfig &&
    lastUsedConfig.url === supabaseUrl &&
    lastUsedConfig.key === supabaseAnonKey
  ) {
    return cachedClient;
  }

  try {
    cachedClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    });
    lastUsedConfig = { url: supabaseUrl, key: supabaseAnonKey };
    return cachedClient;
  } catch (err) {
    console.error('Failed to initialize Supabase client:', err);
    return null;
  }
}

/**
 * Forces recreation of Supabase client (e.g. after config update)
 */
export function resetSupabaseClient(): void {
  cachedClient = null;
  lastUsedConfig = null;
}
