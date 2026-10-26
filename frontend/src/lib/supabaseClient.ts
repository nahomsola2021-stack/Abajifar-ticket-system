import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { load, Store } from '@tauri-apps/plugin-store';
import { getAppConfig } from './config';

let cachedClient: SupabaseClient | null = null;
let lastUsedConfig: { url: string; key: string } | null = null;

// Tauri v2 requires using the async `load` function instead of `new Store()`
let authStorePromise: Promise<Store> | null = null;
export const getAuthStore = (): Promise<Store> => {
  if (!authStorePromise) {
    authStorePromise = load('abajifar_auth.json', { autoSave: false });
  }
  return authStorePromise;
};

const renderAwareFetch = async (
  url: RequestInfo | URL,
  options?: RequestInit
): Promise<Response> => {
  const maxRetries = 3;
  const delayMs = 15000; 

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        if (i === maxRetries - 1) return response;
        console.warn(`[Supabase Fetch] Backend waking up (Status: ${response.status}). Retrying in ${delayMs / 1000}s...`);
        await new Promise(res => setTimeout(res, delayMs));
        continue;
      }
      return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.warn(`[Supabase Fetch] Network error, backend likely asleep. Retrying in ${delayMs / 1000}s...`);
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
  throw new Error("Backend failed to wake up after multiple attempts.");
};

const tauriStoreAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    try {
      const store = await getAuthStore();
      return (await store.get<string>(key)) || null;
    } catch (err) {
      console.error('Tauri Store getItem error:', err);
      return null;
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    try {
      const store = await getAuthStore();
      await store.set(key, value);
      await store.save(); // Physically writes to the C: drive instantly
    } catch (err) {
      console.error('Tauri Store setItem error:', err);
    }
  },
  removeItem: async (key: string): Promise<void> => {
    try {
      const store = await getAuthStore();
      await store.delete(key);
      await store.save();
    } catch (err) {
      console.error('Tauri Store removeItem error:', err);
    }
  },
};

export function getSupabaseClient(): SupabaseClient | null {
  const { supabaseUrl, supabaseAnonKey } = getAppConfig();

  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }

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
        storage: tauriStoreAdapter,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
      global: {
        fetch: renderAwareFetch,
      }
    });
    lastUsedConfig = { url: supabaseUrl, key: supabaseAnonKey };
    return cachedClient;
  } catch (err) {
    console.error('Failed to initialize Supabase client:', err);
    return null;
  }
}

export function resetSupabaseClient(): void {
  cachedClient = null;
  lastUsedConfig = null;
}