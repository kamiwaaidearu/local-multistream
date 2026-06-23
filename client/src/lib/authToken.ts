const KEY = 'auth_token';

/** The app's auth token, or '' when not logged in (handy for query strings and truthy checks). */
export function getAuthToken(): string {
  return sessionStorage.getItem(KEY) ?? '';
}

export function setAuthToken(token: string): void {
  sessionStorage.setItem(KEY, token);
}

export function clearAuthToken(): void {
  sessionStorage.removeItem(KEY);
}
