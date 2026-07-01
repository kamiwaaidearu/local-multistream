import { api } from './api';

type Platform = 'youtube' | 'facebook' | 'twitch';

/**
 * Reconnect a platform via an OAuth popup instead of a full-page redirect, so the operator's
 * current tab — which may be the live Web Studio ingest — never navigates away and the broadcast
 * keeps flowing. Resolves true when the callback reports success, false if the operator closes the
 * popup or the flow fails.
 *
 * The popup is opened synchronously inside the click gesture (browsers block popups opened after an
 * await), then navigated to the provider URL once we have it. The OAuth callback is served from our
 * own origin, so its postMessage is same-origin and we verify the origin before trusting it.
 */
export function reconnectPlatform(platform: Platform): Promise<boolean> {
  const popup = window.open('', `oauth_${platform}`, 'width=600,height=760');

  return api.startOAuth(platform).then(({ url }) => new Promise<boolean>((resolve) => {
    if (!popup) {
      // Popup blocked — fall back to the classic full-page redirect (the callback redirects back).
      window.location.href = url;
      return;
    }
    popup.location.href = url;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearInterval(closedTimer);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as { source?: string; platform?: string; ok?: boolean } | null;
      if (d?.source === 'oauth' && d.platform === platform) {
        cleanup();
        resolve(!!d.ok);
      }
    };
    window.addEventListener('message', onMessage);

    // If the operator closes the popup without finishing, treat it as cancelled.
    const closedTimer = window.setInterval(() => {
      if (popup.closed) { cleanup(); resolve(false); }
    }, 500);
  })).catch((err) => {
    popup?.close();
    throw err;
  });
}
