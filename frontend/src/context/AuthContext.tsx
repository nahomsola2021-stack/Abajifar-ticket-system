import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient, resetSupabaseClient, getAuthStore } from '../lib/supabaseClient';
import { getAppConfig } from '../lib/config';
import type { AppConfig } from '../lib/config';
import { fetchStaffIdentity, fetchDashboardOverview, formatAuthError } from '../lib/api';
import type { StaffIdentity, DashboardOverview, AuthErrorState } from '../types/auth';

interface AuthContextType {
  session: Session | null;
  accessToken: string | null;
  staff: StaffIdentity | null;
  overview: DashboardOverview | null;
  isLoading: boolean;
  isOverviewLoading: boolean;
  authError: AuthErrorState | null;
  overviewError: AuthErrorState | null;
  config: AppConfig;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshOverview: () => Promise<void>;
  refreshIdentity: () => Promise<void>;
  reloadConfig: () => void;
  clearAuthError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const BACKUP_KEY = 'sb-abajifar-auth-backup';

const extractLocalSession = async (): Promise<Session | null> => {
  try {
    const store = await getAuthStore();
    const backupString = await store.get<string>(BACKUP_KEY);
    if (backupString) {
      return JSON.parse(backupString) as Session;
    }
  } catch (e) {
    console.warn('Failed to extract local session from native store:', e);
  }
  return null;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfig] = useState<AppConfig>(() => getAppConfig());
  const [session, setSession] = useState<Session | null>(null);
  const [staff, setStaff] = useState<StaffIdentity | null>(null);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isOverviewLoading, setIsOverviewLoading] = useState<boolean>(false);
  const [authError, setAuthError] = useState<AuthErrorState | null>(null);
  const [overviewError, setOverviewError] = useState<AuthErrorState | null>(null);

  const accessToken = session?.access_token || null;

  const reloadConfig = useCallback(() => {
    resetSupabaseClient();
    const newConfig = getAppConfig();
    setConfig(newConfig);
    setAuthError(null);
    setOverviewError(null);
  }, []);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  const loadStaffAndOverview = useCallback(async (token: string) => {
    setIsLoading(true);
    setAuthError(null);
    setOverviewError(null);

    try {
      const identityData = await fetchStaffIdentity(token);
      setStaff(identityData);
      setIsOverviewLoading(true);
      try {
        const overviewData = await fetchDashboardOverview(token);
        setOverview(overviewData);
      } catch (ovErr) {
        setOverviewError(formatAuthError(ovErr));
        setOverview(null);
      } finally {
        setIsOverviewLoading(false);
      }
    } catch (err) {
      const formatted = formatAuthError(err);
      const status = (err as { status?: number })?.status;
      if (status === 401 || status === 403) {
        const supabase = getSupabaseClient();
        await supabase?.auth.signOut();
        const store = await getAuthStore();
        await store.delete(BACKUP_KEY);
        await store.save();
        setSession(null);
        setStaff(null);
        setOverview(null);
        setAuthError(formatted);
      } else {
        setOverviewError(formatted);
        setAuthError({
          code: 'BACKEND_CONNECTION_ERROR',
          message: 'The server is unreachable or waking up. Please wait a moment and click Retry Verification.',
          details: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshOverview = useCallback(async () => {
    if (!accessToken) return;
    setIsOverviewLoading(true);
    setOverviewError(null);
    try {
      const data = await fetchDashboardOverview(accessToken);
      setOverview(data);
    } catch (err) {
      setOverviewError(formatAuthError(err));
    } finally {
      setIsOverviewLoading(false);
    }
  }, [accessToken]);

  const refreshIdentity = useCallback(async () => {
    if (!accessToken) return;
    try {
      setAuthError(null);
      const identity = await fetchStaffIdentity(accessToken);
      setStaff(identity);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 401 || status === 403) {
        const supabase = getSupabaseClient();
        await supabase?.auth.signOut();
        const store = await getAuthStore();
        await store.delete(BACKUP_KEY);
        await store.save();
        setSession(null);
        setStaff(null);
        setOverview(null);
      }
      setAuthError(formatAuthError(err));
    }
  }, [accessToken]);

  useEffect(() => {
    const supabase = getSupabaseClient();
    if (!supabase) {
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    const initializeAuth = async () => {
      if (!isMounted) return;
      setIsLoading(true);
      
      try {
        const localSession = await extractLocalSession();
        if (localSession) {
          setSession(localSession);
          const { data, error } = await supabase.auth.setSession({
            access_token: localSession.access_token,
            refresh_token: localSession.refresh_token,
          });

          if (!error && data.session) {
            const store = await getAuthStore();
            await store.set(BACKUP_KEY, JSON.stringify(data.session));
            await store.save();
            setSession(data.session);
            await loadStaffAndOverview(data.session.access_token);
            return;
          }
        }

        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;
        
        if (session) {
          const store = await getAuthStore();
          await store.set(BACKUP_KEY, JSON.stringify(session));
          await store.save();
          setSession(session);
          await loadStaffAndOverview(session.access_token);
        } else {
          setIsLoading(false);
        }
      } catch (error) {
        setAuthError(formatAuthError(error));
        setIsLoading(false);
      }
    };
    
    initializeAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!isMounted) return;

      if (event === 'SIGNED_OUT') {
        const localToken = await extractLocalSession();
        if (localToken) return;
        
        const store = await getAuthStore();
        await store.delete(BACKUP_KEY);
        await store.save();
        setSession(null);
        setStaff(null);
        setOverview(null);
        setIsLoading(false);
        setOverviewError(null);
        return;
      }

      if (event === 'TOKEN_REFRESHED' && newSession) {
        const store = await getAuthStore();
        await store.set(BACKUP_KEY, JSON.stringify(newSession));
        await store.save();
        setSession(newSession);
        return;
      }

      if (event === 'SIGNED_IN' && newSession) {
        const store = await getAuthStore();
        await store.set(BACKUP_KEY, JSON.stringify(newSession));
        await store.save();
        setSession(newSession);
        loadStaffAndOverview(newSession.access_token);
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [config.supabaseUrl, config.supabaseAnonKey, loadStaffAndOverview]);

  const signIn = async (email: string, password: string) => {
    setAuthError(null);
    setOverviewError(null);
    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('Supabase credentials are not configured.');

    setIsLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setAuthError(formatAuthError(error));
        setIsLoading(false);
        throw error;
      }

      if (data.session) {
        const store = await getAuthStore();
        await store.set(BACKUP_KEY, JSON.stringify(data.session));
        await store.save();
        setSession(data.session);
        await loadStaffAndOverview(data.session.access_token);
      }
    } catch (err) {
      setIsLoading(false);
      throw err;
    }
  };

  const signOut = async () => {
    setIsLoading(true);
    try {
      const store = await getAuthStore();
      await store.delete(BACKUP_KEY);
      await store.save();
      const supabase = getSupabaseClient();
      if (supabase) await supabase.auth.signOut();
    } catch (err) {
      console.warn('Error during Supabase signOut:', err);
    } finally {
      setSession(null);
      setStaff(null);
      setOverview(null);
      setAuthError(null);
      setOverviewError(null);
      setIsLoading(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        session, accessToken, staff, overview, isLoading, isOverviewLoading,
        authError, overviewError, config, signIn, signOut, refreshOverview,
        refreshIdentity, reloadConfig, clearAuthError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};