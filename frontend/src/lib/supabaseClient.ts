import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { load, Store } from '@tauri-apps/plugin-store';
import { getAppConfig } from './config';

// Safely detect if the app is running inside the Tauri Desktop wrapper
const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let cachedClient: SupabaseClient | null = null;
let lastUsedConfig: { url: string; key: string } | null = null;

let authStorePromise: Promise<Store> | null = null;
const getAuthStore = (): Promise<Store | null> => {
  if (!isDesktop()) return Promise.resolve(null);
  if (!authStorePromise) {
    authStorePromise = load('abajifar_auth.json', { autoSave: false });
  }
  return authStorePromise;
};

// Hybrid Storage Adapter: Uses Native Rust on PC, and LocalStorage on Vercel Web
export const hybridStorage = {
  get: async (key: string): Promise<string | null> => {
    if (!isDesktop()) return localStorage.getItem(key);
    try {
      const store = await getAuthStore();
      return store ? (await store.get<string>(key)) || null : localStorage.getItem(key);
    } catch (err) {
      console.error('Storage get error:', err);
      return null;
    }
  },
  set: async (key: string, value: string): Promise<void> => {
    if (!isDesktop()) {
      localStorage.setItem(key, value);
      return;
    }
    try {
      const store = await getAuthStore();
      if (store) {
        await store.set(key, value);
        await store.save(); // Physically writes to C: drive
      }
    } catch (err) {
      console.error('Storage set error:', err);
    }
  },
  remove: async (key: string): Promise<void> => {
    if (!isDesktop()) {
      localStorage.removeItem(key);
      return;
    }
    try {
      const store = await getAuthStore();
      if (store) {
        await store.delete(key);
        await store.save();
      }
    } catch (err) {
      console.error('Storage remove error:', err);
    }
  },
};

const renderAwareFetch = async (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
  const maxRetries = 3;
  const delayMs = 15000; 

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        if (i === maxRetries - 1) return response;
        console.warn(`[Supabase Fetch] Backend waking up... Retrying in ${delayMs / 1000}s`);
        await new Promise(res => setTimeout(res, delayMs));
        continue;
      }
      return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
  throw new Error("Backend failed to wake up.");
};

// Supabase Auth Adapter maps to our hybrid functions
const tauriStoreAdapter = {
  getItem: hybridStorage.get,
  setItem: hybridStorage.set,
  removeItem: hybridStorage.remove,
};

export function getSupabaseClient(): SupabaseClient | null {
  const { supabaseUrl, supabaseAnonKey } = getAppConfig();
  if (!supabaseUrl || !supabaseAnonKey) return null;

  if (cachedClient && lastUsedConfig && lastUsedConfig.url === supabaseUrl && lastUsedConfig.key === supabaseAnonKey) {
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
      global: { fetch: renderAwareFetch }
    });
    lastUsedConfig = { url: supabaseUrl, key: supabaseAnonKey };
    return cachedClient;
  } catch (err) {
    return null;
  }
}

export function resetSupabaseClient(): void {
  cachedClient = null;
  lastUsedConfig = null;
}