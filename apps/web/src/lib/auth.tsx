import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AppMode, PublicUser } from '@orbit/shared-types';
import { api, ApiError } from './api.js';

interface AuthContextValue {
  user: PublicUser | null;
  mode: AppMode | null;
  loading: boolean;
  requestCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [mode, setMode] = useState<AppMode | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const { mode: appMode } = await api<{ mode: AppMode }>('/auth/mode', {
          signal: controller.signal,
        });
        setMode(appMode);

        const me = await api<{ user: PublicUser }>('/auth/me', { signal: controller.signal });
        setUser(me.user);
      } catch (err) {
        // A 401 just means "not signed in" - not an error worth surfacing.
        if (!(err instanceof ApiError) || err.status !== 401) {
          if ((err as Error).name !== 'AbortError') setMode((current) => current);
        }
        setUser(null);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, []);

  const requestCode = useCallback(async (email: string) => {
    await api('/auth/request-otp', { method: 'POST', body: { email } });
  }, []);

  const verifyCode = useCallback(async (email: string, code: string) => {
    const { user: signedIn } = await api<{ user: PublicUser }>('/auth/verify-otp', {
      method: 'POST',
      body: { email, code },
    });
    setUser(signedIn);
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, mode, loading, requestCode, verifyCode, logout }),
    [user, mode, loading, requestCode, verifyCode, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
