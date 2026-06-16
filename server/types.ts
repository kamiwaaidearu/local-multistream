export interface Credentials {
  platform: 'youtube' | 'facebook' | 'twitch';
  access_token: string | null;
  refresh_token: string | null;
  token_expiry: number | null;
  extra_json: string | null;
}

export interface Stream {
  id: string;
  series_id: string | null;
  name: string;
  description: string | null;
  thumbnail_path: string | null;
  scheduled_start: number | null;
  status: 'draft' | 'ready' | 'live' | 'ended' | 'error';
  fb_reminders_enabled: number; // 0/1 — schedule Facebook announcement posts for this stream
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

export interface PlatformStream {
  id: string;
  stream_id: string;
  platform: 'youtube' | 'facebook' | 'twitch';
  broadcast_id: string | null;
  stream_key: string | null;
  rtmp_url: string | null;
  status: 'pending' | 'created' | 'live' | 'reconnecting' | 'ended' | 'error';
  error_message: string | null;
  extra_json: string | null;
}

export interface EventLog {
  id: number;
  stream_id: string | null;
  platform: string | null;
  event: string;
  detail: string | null;
  ts: number;
}

export type Platform = 'youtube' | 'facebook' | 'twitch';

export interface AuthStatus {
  youtube: boolean;
  facebook: boolean;
  twitch: boolean;
}

export interface SSEEvent {
  type: string;
  platform?: Platform;
  data?: Record<string, unknown>;
}
