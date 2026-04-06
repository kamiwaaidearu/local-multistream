const BASE = '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  // Streams
  getStreams: () => request<unknown[]>('/api/streams'),
  createStream: (formData: FormData) =>
    fetch('/api/streams', { method: 'POST', body: formData }).then((r) => r.json()),
  getStream: (id: string) => request<unknown>(`/api/streams/${id}`),
  updateStream: (id: string, formData: FormData) =>
    fetch(`/api/streams/${id}`, { method: 'PATCH', body: formData }).then((r) => r.json()),
  deleteStream: (id: string) => request<void>(`/api/streams/${id}`, { method: 'DELETE' }),

  // Series
  createSeries: (formData: FormData) =>
    fetch('/api/series', { method: 'POST', body: formData }).then((r) => r.json()),
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
  getFfmpegVersion: () => request<{ version: string | null; path: string | null }>('/api/ffmpeg/version'),
};
