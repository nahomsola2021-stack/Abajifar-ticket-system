import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient, resetSupabaseClient } from '../lib/supabaseClient';
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

  // Fetch staff profile and overview data
  const loadStaffAndOverview = useCallback(async (token: string) => {
    setIsLoading(true);
    setAuthError(null);
    setOverviewError(null);

    try {
      // 1. Fetch Staff Identity
      const identityData = await fetchStaffIdentity(token);
      setStaff(identityData);

      // 2. Fetch Dashboard Overview
      setIsOverviewLoading(true);
      try {
        const overviewData = await fetchDashboardOverview(token);
        setOverview(overviewData);
      } catch (ovErr) {
        console.error('Failed to load overview data:', ovErr);
        setOverviewError(formatAuthError(ovErr));
        setOverview(null);
      } finally {
        setIsOverviewLoading(false);
      }
    } catch (err) {
      console.error('Failed to load staff identity:', err);
      const formatted = formatAuthError(err);
      setAuthError(formatted);
      setStaff(null);
      setOverview(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Refresh only overview metrics
  const refreshOverview = useCallback(async () => {
    if (!accessToken) return;
    setIsOverviewLoading(true);
    setOverviewError(null);
    try {
      const data = await fetchDashboardOverview(accessToken);
      setOverview(data);
    } catch (err) {
      console.error('Overview refresh failed:', err);
      setOverviewError(formatAuthError(err));
    } finally {
      setIsOverviewLoading(false);
    }
  }, [accessToken]);

  // Refresh staff profile
  const refreshIdentity = useCallback(async () => {
    if (!accessToken) return;
    try {
      const identity = await fetchStaffIdentity(accessToken);
      setStaff(identity);
    } catch (err) {
      console.error('Identity refresh failed:', err);
      setAuthError(formatAuthError(err));
    }
  }, [accessToken]);

  // Initialize session and listen for auth state changes
  useEffect(() => {
    const supabase = getSupabaseClient();

    if (!supabase) {
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    // Get initial session
    supabase.auth
      .getSession()
      .then(({ data: { session: initialSession }, error }) => {
        if (!isMounted) return;
        if (error) {
          console.error('Error fetching Supabase session:', error);
          setAuthError(formatAuthError(error));
          setIsLoading(false);
          return;
        }

        setSession(initialSession);
        if (initialSession?.access_token) {
          loadStaffAndOverview(initialSession.access_token);
        } else {
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error('Unexpected error fetching session:', err);
        setAuthError(formatAuthError(err));
        setIsLoading(false);
      });

    // Listen to auth events
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!isMounted) return;

      if (event === 'SIGNED_OUT') {
        setSession(null);
        setStaff(null);
        setOverview(null);
        setIsLoading(false);
        setOverviewError(null);
        return;
      }

      if (event === 'TOKEN_REFRESHED' && newSession) {
        setSession(newSession);
        return;
      }

      if (event === 'SIGNED_IN' && newSession) {
        setSession(newSession);
        loadStaffAndOverview(newSession.access_token);
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [config.supabaseUrl, config.supabaseAnonKey, loadStaffAndOverview]);

  // Sign in with email and password using Supabase Auth
  const signIn = async (email: string, password: string) => {
    setAuthError(null);
    setOverviewError(null);

    const supabase = getSupabaseClient();
    if (!supabase) {
      const err: AuthErrorState = {
        code: 'ENV_CONFIG_MISSING',
        message: 'Supabase credentials are not configured. Check VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
      };
      setAuthError(err);
      throw new Error(err.message);
    }

    setIsLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        const formatted = formatAuthError(error);
        setAuthError(formatted);
        setIsLoading(false);
        throw error;
      }

      if (!data.session?.access_token) {
        throw new Error('Sign in succeeded but no access token was returned.');
      }

      setSession(data.session);
      await loadStaffAndOverview(data.session.access_token);
    } catch (err) {
      setIsLoading(false);
      throw err;
    }
  };

  // Sign out
  const signOut = async () => {
    setIsLoading(true);
    try {
      const supabase = getSupabaseClient();
      if (supabase) {
        await supabase.auth.signOut();
      }
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
        session,
        accessToken,
        staff,
        overview,
        isLoading,
        isOverviewLoading,
        authError,
        overviewError,
        config,
        signIn,
        signOut,
        refreshOverview,
        refreshIdentity,
        reloadConfig,
        clearAuthError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
