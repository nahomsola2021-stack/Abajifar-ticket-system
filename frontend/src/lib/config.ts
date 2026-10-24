/**
 * Runtime Configuration Helper
 * Reads configuration from Vite environment variables (VITE_*)
 * with optional local overrides for development testing.
 */

const STORAGE_KEY_SUPABASE_URL = 'ticket_office_supabase_url';
const STORAGE_KEY_SUPABASE_ANON_KEY = 'ticket_office_supabase_anon_key';
const STORAGE_KEY_API_URL = 'ticket_office_api_url';

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  apiUrl: string;
  isConfigured: boolean;
  missingKeys: string[];
}

export function getAppConfig(): AppConfig {
  // Read from Vite environment variables
  const envSupabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
  const envSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
  const envApiUrl = import.meta.env.VITE_API_URL || '';

  // Check localStorage for overrides if env vars are empty
  const localSupabaseUrl = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY_SUPABASE_URL) || '' : '';
  const localSupabaseAnonKey = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY_SUPABASE_ANON_KEY) || '' : '';
  const localApiUrl = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY_API_URL) || '' : '';

  const supabaseUrl = (envSupabaseUrl || localSupabaseUrl).trim();
  const supabaseAnonKey = (envSupabaseAnonKey || localSupabaseAnonKey).trim();
  const apiUrl = (envApiUrl || localApiUrl).trim().replace(/\/+$/, ''); // Strip trailing slash

  const missingKeys: string[] = [];
  if (!supabaseUrl) missingKeys.push('VITE_SUPABASE_URL');
  if (!supabaseAnonKey) missingKeys.push('VITE_SUPABASE_ANON_KEY');
  if (!apiUrl) missingKeys.push('VITE_API_URL');

  return {
    supabaseUrl,
    supabaseAnonKey,
    apiUrl,
    isConfigured: missingKeys.length === 0,
    missingKeys,
  };
}

export function saveLocalOverrides(config: { supabaseUrl?: string; supabaseAnonKey?: string; apiUrl?: string }) {
  if (typeof window === 'undefined') return;
  if (config.supabaseUrl !== undefined) {
    if (config.supabaseUrl) localStorage.setItem(STORAGE_KEY_SUPABASE_URL, config.supabaseUrl.trim());
    else localStorage.removeItem(STORAGE_KEY_SUPABASE_URL);
  }
  if (config.supabaseAnonKey !== undefined) {
    if (config.supabaseAnonKey) localStorage.setItem(STORAGE_KEY_SUPABASE_ANON_KEY, config.supabaseAnonKey.trim());
    else localStorage.removeItem(STORAGE_KEY_SUPABASE_ANON_KEY);
  }
  if (config.apiUrl !== undefined) {
    if (config.apiUrl) localStorage.setItem(STORAGE_KEY_API_URL, config.apiUrl.trim().replace(/\/+$/, ''));
    else localStorage.removeItem(STORAGE_KEY_API_URL);
  }
}

export function clearLocalOverrides() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY_SUPABASE_URL);
  localStorage.removeItem(STORAGE_KEY_SUPABASE_ANON_KEY);
  localStorage.removeItem(STORAGE_KEY_API_URL);
}
