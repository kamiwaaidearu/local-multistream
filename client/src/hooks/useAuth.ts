import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';

export interface AuthStatus {
  youtube: boolean;
  facebook: boolean;
  twitch: boolean;
}

export function useAuth() {
  const [auth, setAuth] = useState<AuthStatus>({ youtube: false, facebook: false, twitch: false });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const status = await api.getAuthStatus();
      setAuth(status);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { auth, loading, refresh };
}
