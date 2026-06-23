/** Build a ws(s):// URL to the app's own origin for the given path (e.g. '/ws/studio'). */
export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}
