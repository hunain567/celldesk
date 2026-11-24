import type { Permission, SessionUser, SetupState } from '@nexodesk/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { call, SESSION_ENDED_EVENT } from './api';

interface AuthContextValue {
  setup: SetupState | null;
  user: SessionUser | null;
  /** Re-reads setup state and the session from the main process. */
  refresh: () => Promise<void>;
  signedIn: (user: SessionUser) => void;
  lock: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Watches for activity and locks the screen after the shop's idle limit. */
function useIdleLock(active: boolean, minutes: number, lock: () => void): void {
  useEffect(() => {
    if (!active) return undefined;
    let timer = window.setTimeout(lock, minutes * 60000);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, minutes * 60000);
    };
    const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'];
    for (const name of events) window.addEventListener(name, reset, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, reset);
    };
  }, [active, minutes, lock]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);

  const refresh = useCallback(async () => {
    const [nextSetup, nextUser] = await Promise.all([call('setup:state'), call('auth:session')]);
    setSetup(nextSetup);
    setUser(nextUser);
  }, []);

  const lock = useCallback(async () => {
    setUser(null);
    try {
      await call('auth:lock');
    } finally {
      void refresh();
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const onEnded = () => setUser(null);
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    const unsubscribe = window.nexodesk.onEvent((event) => {
      if (event.type === 'session.ended') setUser(null);
    });
    return () => {
      window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
      unsubscribe();
    };
  }, [refresh]);

  const idleLock = useCallback(() => void lock(), [lock]);
  useIdleLock(user !== null, setup?.autoLockMinutes ?? 15, idleLock);

  const value: AuthContextValue = {
    setup,
    user,
    refresh,
    signedIn: (next) => {
      setUser(next);
      void call('setup:state').then(setSetup);
    },
    lock,
    can: (permission) => user?.permissions.includes(permission) ?? false,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
