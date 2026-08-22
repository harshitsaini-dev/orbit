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
  /** Re-reads the profile after it changes, so the header updates with it. */
  refresh: () => Promise<void>;
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
        // Only a refusal means "not signed in". A request that never reached
        // the server means we could not tell - and clearing the user over that
        // signs someone out for losing their connection, which with an offline
        // workspace is exactly when they need it least.
        if (err instanceof ApiError && err.status === 401) setUser(null);
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

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: PublicUser }>('/auth/me');
      setUser(me.user);
    } catch {
      // Leaves the last known profile in place rather than logging the user out
      // over a failed re-read.
    }
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, mode, loading, requestCode, verifyCode, logout, refresh }),
    [user, mode, loading, requestCode, verifyCode, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
