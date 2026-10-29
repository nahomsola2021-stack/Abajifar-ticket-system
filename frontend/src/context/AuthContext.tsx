import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient, resetSupabaseClient, hybridStorage } from '../lib/supabaseClient';
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
const STAFF_BACKUP_KEY = 'sb-abajifar-staff-backup';
const OVERVIEW_BACKUP_KEY = 'sb-abajifar-overview-backup';

const extractLocalSession = async (): Promise<Session | null> => {
  try {
    const backupString = await hybridStorage.get(BACKUP_KEY);
    if (backupString) {
      return JSON.parse(backupString) as Session;
    }
  } catch (e) {
    console.warn('Failed to extract backup session:', e);
  }
  return null;
};

const getInitialStaff = (): StaffIdentity | null => {
  try {
    const raw = localStorage.getItem(STAFF_BACKUP_KEY);
    return raw ? (JSON.parse(raw) as StaffIdentity) : null;
  } catch {
    return null;
  }
};

const getInitialOverview = (): DashboardOverview | null => {
  try {
    const raw = localStorage.getItem(OVERVIEW_BACKUP_KEY);
    return raw ? (JSON.parse(raw) as DashboardOverview) : null;
  } catch {
    return null;
  }
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [config, setConfig] = useState<AppConfig>(() => getAppConfig());
  const [session, setSession] = useState<Session | null>(null);

  // Optimistic initial states from local storage for 0ms instant render
  const [staff, setStaff] = useState<StaffIdentity | null>(() => getInitialStaff());
  const [overview, setOverview] = useState<DashboardOverview | null>(() => getInitialOverview());

  // Only show the blocking screen if there is NO cached staff profile
  const [isLoading, setIsLoading] = useState<boolean>(() => {
    try {
      const hasStaff = Boolean(localStorage.getItem(STAFF_BACKUP_KEY));
      const hasSession = Boolean(localStorage.getItem(BACKUP_KEY));
      return !(hasStaff && hasSession);
    } catch {
      return true;
    }
  });

  const [isOverviewLoading, setIsOverviewLoading] = useState<boolean>(false);
  const [authError, setAuthError] = useState<AuthErrorState | null>(null);
  const [overviewError, setOverviewError] = useState<AuthErrorState | null>(null);

  const inFlightTokenRef = useRef<string | null>(null);
  const accessToken = session?.access_token || null;

  const reloadConfig = useCallback(() => {
    resetSupabaseClient();
    setConfig(getAppConfig());
    setAuthError(null);
    setOverviewError(null);
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  /**
   * Loads staff identity and overview without blocking the entire app if data is already cached.
   */
  const loadStaffAndOverview = useCallback(
    async (token: string, silent: boolean = false) => {
      if (inFlightTokenRef.current === token) return;
      inFlightTokenRef.current = token;

      if (!silent && !staff && !localStorage.getItem(STAFF_BACKUP_KEY)) {
        setIsLoading(true);
      }
      setAuthError(null);

      try {
        // 1. Fetch Staff Profile (1 argument)
        const identityData = await fetchStaffIdentity(token);
        setStaff(identityData);
        try {
          localStorage.setItem(STAFF_BACKUP_KEY, JSON.stringify(identityData));
        } catch {
          // Ignore storage quota
        }

        // Unblock main UI immediately
        setIsLoading(false);

        // 2. Fetch Dashboard Overview in background
        setIsOverviewLoading(true);
        try {
          const overviewData = await fetchDashboardOverview(token);
          setOverview(overviewData);
          try {
            localStorage.setItem(OVERVIEW_BACKUP_KEY, JSON.stringify(overviewData));
          } catch {
            // Ignore storage quota
          }
        } catch (ovErr) {
          setOverviewError(formatAuthError(ovErr));
        } finally {
          setIsOverviewLoading(false);
        }
      } catch (err) {
        const formatted = formatAuthError(err);
        const status = (err as { status?: number })?.status;
        if (status === 401 || status === 403) {
          const supabase = getSupabaseClient();
          await supabase?.auth.signOut();
          await hybridStorage.remove(BACKUP_KEY);
          try {
            localStorage.removeItem(STAFF_BACKUP_KEY);
            localStorage.removeItem(OVERVIEW_BACKUP_KEY);
          } catch {
            // Ignore storage quota
          }
          setSession(null);
          setStaff(null);
          setOverview(null);
          setAuthError(formatted);
        } else {
          setOverviewError(formatted);
          if (!staff) {
            setAuthError({
              code: 'BACKEND_CONNECTION_ERROR',
              message: 'The server is unreachable or waking up.',
              details: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } finally {
        setIsLoading(false);
        inFlightTokenRef.current = null;
      }
    },
    [staff],
  );

  const refreshOverview = useCallback(async () => {
    if (!accessToken) return;
    setIsOverviewLoading(true);
    setOverviewError(null);
    try {
      const data = await fetchDashboardOverview(accessToken);
      setOverview(data);
      try {
        localStorage.setItem(OVERVIEW_BACKUP_KEY, JSON.stringify(data));
      } catch {
        // Ignore storage quota
      }
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
      // Fixed: only 1 argument passed here
      const data = await fetchStaffIdentity(accessToken);
      setStaff(data);
      try {
        localStorage.setItem(STAFF_BACKUP_KEY, JSON.stringify(data));
      } catch {
        // Ignore storage quota
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 401 || status === 403) {
        const supabase = getSupabaseClient();
        await supabase?.auth.signOut();
        await hybridStorage.remove(BACKUP_KEY);
        try {
          localStorage.removeItem(STAFF_BACKUP_KEY);
          localStorage.removeItem(OVERVIEW_BACKUP_KEY);
        } catch {
          // Ignore storage quota
        }
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

      try {
        const localSession = await extractLocalSession();
        if (localSession) {
          setSession(localSession);
          const { data, error } = await supabase.auth.setSession({
            access_token: localSession.access_token,
            refresh_token: localSession.refresh_token,
          });
          if (!error && data.session) {
            await hybridStorage.set(BACKUP_KEY, JSON.stringify(data.session));
            setSession(data.session);
            await loadStaffAndOverview(data.session.access_token, Boolean(getInitialStaff()));
            return;
          }
        }

        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();
        if (error) throw error;

        if (session) {
          await hybridStorage.set(BACKUP_KEY, JSON.stringify(session));
          setSession(session);
          await loadStaffAndOverview(session.access_token, Boolean(getInitialStaff()));
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

        await hybridStorage.remove(BACKUP_KEY);
        try {
          localStorage.removeItem(STAFF_BACKUP_KEY);
          localStorage.removeItem(OVERVIEW_BACKUP_KEY);
        } catch {
          // Ignore storage quota
        }
        setSession(null);
        setStaff(null);
        setOverview(null);
        setIsLoading(false);
        setOverviewError(null);
        return;
      }

      if (event === 'TOKEN_REFRESHED' && newSession) {
        await hybridStorage.set(BACKUP_KEY, JSON.stringify(newSession));
        setSession(newSession);
        loadStaffAndOverview(newSession.access_token, true);
        return;
      }

      if (event === 'SIGNED_IN' && newSession) {
        await hybridStorage.set(BACKUP_KEY, JSON.stringify(newSession));
        setSession(newSession);
        const isSilent = Boolean(getInitialStaff());
        loadStaffAndOverview(newSession.access_token, isSilent);
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
        await hybridStorage.set(BACKUP_KEY, JSON.stringify(data.session));
        setSession(data.session);
        await loadStaffAndOverview(data.session.access_token, false);
      }
    } catch (err) {
      setIsLoading(false);
      throw err;
    }
  };

  const signOut = async () => {
    setIsLoading(true);
    try {
      await hybridStorage.remove(BACKUP_KEY);
      try {
        localStorage.removeItem(STAFF_BACKUP_KEY);
        localStorage.removeItem(OVERVIEW_BACKUP_KEY);
      } catch {
        // Ignore storage quota
      }
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
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};