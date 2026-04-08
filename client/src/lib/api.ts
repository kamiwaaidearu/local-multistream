const BASE = '';

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem('auth_token');
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
      sessionStorage.removeItem('auth_token');
      window.location.href = '/login';
    }
    throw new Error('Authentication required');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
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
  goLive: (id: string) => request<unknown>(`/api/streams/${id}/go-live`, { method: 'POST' }),
  endStream: (id: string) => request<unknown>(`/api/streams/${id}/end`, { method: 'POST' }),

  // Auth
  getAuthStatus: () =>
    request<{ youtube: boolean; facebook: boolean; twitch: boolean }>('/api/auth/status'),
  getFacebookPages: () => request<Array<{ id: string; name: string; access_token: string }>>('/api/auth/facebook/pages'),
  selectFacebookPage: (pageId: string, pageName: string, accessToken: string) =>
    request<unknown>('/api/auth/facebook/page', {
      method: 'POST',
      body: JSON.stringify({ page_id: pageId, page_name: pageName, access_token: accessToken }),
    }),
  disconnectPlatform: (platform: string) =>
    request<unknown>(`/api/auth/disconnect/${platform}`, { method: 'POST' }),

  // Status
  getObsStatus: () => request<{ connected: boolean }>('/api/stream/obs-status'),
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
  getTemplate: () => request<{ config_json: Record<string, unknown>; id: string; name: string }>('/api/studio/template'),
  updateTemplate: (id: string, data: { name?: string; config_json?: unknown }) =>
    request<unknown>(`/api/studio/template/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  uploadOverlay: (formData: FormData) =>
    authedFetch('/api/studio/overlay', { method: 'POST', body: formData }).then((r) => r.json()),
};
