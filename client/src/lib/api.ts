import { getAuthToken, clearAuthToken } from './authToken';

const BASE = '';

// Facebook reminder schedule (mirrors server/stream/reminders.ts)
export type ReminderWhen =
  | { kind: 'sameDayAt'; time: string }
  | { kind: 'weekdayBeforeAt'; weekday: number; time: string }
  | { kind: 'beforeStart'; minutes: number };

export interface ReminderRule {
  id: string;
  label: string;
  enabled: boolean;
  when: ReminderWhen;
  template: string;
}

export interface ReminderSettings {
  enabled: boolean;
  timezone: string;
  site: string;
  rules: ReminderRule[];
  goLivePost: { enabled: boolean; template: string };
}

/**
 * An API error that preserves the server's structured fields. The plain-Error version discarded
 * them, which made it impossible to tell a real failure from the go-live auth pre-flight (409 +
 * code 'auth_preflight') that the operator is meant to be able to acknowledge and override.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly platforms?: string[],
    /** For 'auth_preflight': false when the block cannot be overridden (a definitively dead login),
     *  true when it's only "we couldn't reach the platform to check". */
    public readonly overridable?: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Per-platform ingest health while live — what the PLATFORM says it is receiving. */
export interface PlatformIngestHealth {
  state: 'unknown' | 'healthy' | 'degraded' | 'not_receiving';
  reason: string;
  videoKbps: number | null;
  audioKbps: number | null;
  fps: number | null;
  /** What our ffmpeg is pushing, vs videoKbps which is what the platform says it receives. */
  pushKbps: number | null;
  warnings: string[];
  alarm: boolean;
  /** Video is arriving but the platform reports no audio — a silent broadcast. */
  audioAlarm: boolean;
  checkedAt: number;
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...options?.headers },
    ...options,
  });
  if (res.status === 401) {
    // Clear token and redirect to login if auth is required
    const authCheck = await fetch('/api/auth/check').then((r) => r.json()).catch(() => ({ required: false }));
    if (authCheck.required) {
      clearAuthToken();
      // Don't redirect if we're already on the login page — a 401 from a background call
      // (e.g. the header's auth-status fetch) would otherwise reload /login endlessly.
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    throw new Error('Authentication required');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(
      body.error ?? `Request failed: ${res.status}`,
      res.status,
      body.code,
      body.platforms,
      body.overridable,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });
}

export const api = {
  // Streams
  getStreams: () => request<unknown[]>('/api/streams'),
  createStream: (formData: FormData) =>
    authedFetch('/api/streams', { method: 'POST', body: formData }).then((r) => r.json()),
  getStream: (id: string) => request<unknown>(`/api/streams/${id}`),
  updateStream: (id: string, formData: FormData) =>
    authedFetch(`/api/streams/${id}`, { method: 'PATCH', body: formData }).then((r) => r.json()),
  deleteStream: (id: string) => request<void>(`/api/streams/${id}`, { method: 'DELETE' }),

  // Series
  createSeries: (formData: FormData) =>
    authedFetch('/api/series', { method: 'POST', body: formData }).then((r) => r.json()),
  getSeries: (seriesId: string) => request<unknown>(`/api/series/${seriesId}`),
  setupSeries: (seriesId: string) =>
    request<unknown>(`/api/series/${seriesId}/setup`, { method: 'POST' }),

  // Setup & Live
  setupStream: (id: string) => request<unknown>(`/api/streams/${id}/setup`, { method: 'POST' }),
  setupPlatform: (id: string, platform: string) =>
    request<unknown>(`/api/streams/${id}/setup/${platform}`, { method: 'POST' }),
  // `force` acknowledges the auth pre-flight (409 / code 'auth_preflight') and goes live on the
  // platforms whose logins do work.
  goLive: (id: string, force = false) =>
    request<unknown>(`/api/streams/${id}/go-live`, { method: 'POST', body: JSON.stringify({ force }) }),
  endStream: (id: string) => request<unknown>(`/api/streams/${id}/end`, { method: 'POST' }),
  // Per-platform auth health (go-live pre-check + live reconnect controls).
  getAuthHealth: () =>
    request<Record<string, { connected: boolean; ok: boolean; error?: string | null }>>('/api/auth/health'),
  // Per-platform INGEST health while live — the platform's own view, not just "is our process alive".
  getStreamHealth: (id: string) =>
    request<Record<string, PlatformIngestHealth>>(`/api/streams/${id}/health`),
  // Record the leg-1 (browser) encode settings + measured uplink server-side. These numbers used to
  // live only in the browser tab, which made a low-quality broadcast impossible to explain afterwards.
  reportStudioQuality: (body: {
    quality: string; videoBps: number; probeMbps: number | null; probeFailed: boolean;
  }) => request<{ ok: boolean }>('/api/studio/quality', { method: 'POST', body: JSON.stringify(body) }),
  // Report a problem only the browser can see (congested uplink, dead camera/mic track) so it reaches
  // the log and the alert webhook instead of only a banner in the presenter's own tab.
  reportStudioAlert: (body: {
    kind: 'uplink_congested' | 'track_ended';
    subject: string;
    message: string;
    resolved?: boolean;
  }) => request<{ ok: boolean }>('/api/studio/alert', { method: 'POST', body: JSON.stringify(body) }),
  // Retry one platform mid-broadcast after reconnecting its auth (leaves the stream live).
  retryPlatformLive: (id: string, platform: string) =>
    request<unknown>(`/api/streams/${id}/live/${platform}/retry`, { method: 'POST' }),

  // Auth
  getAuthStatus: () =>
    request<{ youtube: boolean; facebook: boolean; twitch: boolean }>('/api/auth/status'),
  getFacebookPages: () => request<Array<{ id: string; name: string; access_token: string }>>('/api/auth/facebook/pages'),
  getFacebookSelectedPage: () => request<{ id: string; name: string } | null>('/api/auth/facebook/selected-page'),
  getYouTubeChannel: () => request<{ id: string; title: string } | null>('/api/auth/youtube/channel'),
  getTwitchChannel: () => request<{ id: string; login: string; displayName: string } | null>('/api/auth/twitch/channel'),
  selectFacebookPage: (pageId: string, pageName: string, accessToken: string) =>
    request<unknown>('/api/auth/facebook/page', {
      method: 'POST',
      body: JSON.stringify({ page_id: pageId, page_name: pageName, access_token: accessToken }),
    }),
  disconnectPlatform: (platform: string) =>
    request<unknown>(`/api/auth/disconnect/${platform}`, { method: 'POST' }),
  // Authenticated OAuth initiation: returns the provider's consent URL to navigate to. Gating
  // this (vs. a plain anchor) is what lets the public callback safely require a server-issued
  // state nonce — see server/routes/auth.ts.
  startOAuth: (platform: 'youtube' | 'facebook' | 'twitch') =>
    request<{ url: string }>(`/auth/${platform}/start`),

  // Status
  getSourceStatus: () => request<{ connected: boolean; source: 'obs' | 'studio' | null }>('/api/studio/status'),
  getFfmpegVersion: () => request<{ version: string | null; path: string | null }>('/api/ffmpeg/version'),

  // Auth (app-wide)
  login: (secret: string) => request<{ token: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ secret }),
  }),
  checkAuth: () => request<{ required: boolean }>('/api/auth/check'),

  // Studio
  getStudioStatus: () => request<{ connected: boolean; source: string | null }>('/api/studio/status'),
  // RTMP ingest details for the OBS panel (real RTMP_PORT / LOCAL_STREAM_KEY from server config).
  getIngestInfo: () => request<{ port: number; streamKey: string }>('/api/studio/ingest-info'),
  getTemplate: () => request<{ config_json: Record<string, unknown>; id: string; name: string }>('/api/studio/template'),
  updateTemplate: (id: string, data: { name?: string; config_json?: unknown }) =>
    request<unknown>(`/api/studio/template/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  resetTemplate: () =>
    request<{ config_json: Record<string, unknown>; id: string; name: string }>('/api/studio/template/reset', { method: 'POST' }),
  uploadOverlay: (formData: FormData) =>
    authedFetch('/api/studio/overlay', { method: 'POST', body: formData }).then((r) => r.json()),

  // Settings — Facebook reminder schedule
  getReminderSettings: () => request<ReminderSettings>('/api/settings/reminders'),
  updateReminderSettings: (settings: ReminderSettings) =>
    request<ReminderSettings>('/api/settings/reminders', { method: 'PUT', body: JSON.stringify(settings) }),
};
