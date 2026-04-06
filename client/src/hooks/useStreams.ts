import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';

export interface Stream {
  id: string;
  name: string;
  description: string | null;
  thumbnail_path: string | null;
  scheduled_start: number | null;
  status: string;
  series_id: string | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

export function useStreams() {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getStreams();
      setStreams(data as Stream[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { streams, loading, refresh };
}
