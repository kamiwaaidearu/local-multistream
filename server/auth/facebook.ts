import { config } from '../config.js';
import { getDb } from '../db/index.js';

// publish_video: create/manage (incl. live) videos on the Page
// pages_show_list: enumerate the user's Pages via /me/accounts (needed to populate the picker)
// pages_read_engagement: read Page metadata + obtain the Page access token
// (pages_manage_posts was rejected by FB as an invalid scope for this app and isn't needed.)
const PERMISSIONS = ['publish_video', 'pages_show_list', 'pages_read_engagement'];

export function getFacebookAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: config.facebook.appId,
    redirect_uri: config.facebook.redirectUri,
    scope: PERMISSIONS.join(','),
    response_type: 'code',
  });
  return `https://www.facebook.com/${config.fbApiVersion}/dialog/oauth?${params}`;
}

export async function handleFacebookCallback(code: string): Promise<void> {
  // Exchange code for short-lived user token
  const tokenParams = new URLSearchParams({
    client_id: config.facebook.appId,
    client_secret: config.facebook.appSecret,
    redirect_uri: config.facebook.redirectUri,
    code,
  });

  const tokenRes = await fetch(
    `https://graph.facebook.com/${config.fbApiVersion}/oauth/access_token?${tokenParams}`,
  );
  if (!tokenRes.ok) {
    const err = await tokenRes.json();
    throw new Error(`Facebook token exchange failed: ${err.error?.message ?? tokenRes.statusText}`);
  }
  const { access_token: shortLivedToken } = await tokenRes.json() as { access_token: string };

  // Exchange for long-lived user token (60-day)
  const llParams = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: config.facebook.appId,
    client_secret: config.facebook.appSecret,
    fb_exchange_token: shortLivedToken,
  });

  const llRes = await fetch(
    `https://graph.facebook.com/${config.fbApiVersion}/oauth/access_token?${llParams}`,
  );
  if (!llRes.ok) {
    const err = await llRes.json();
    throw new Error(`Facebook long-lived token exchange failed: ${err.error?.message ?? llRes.statusText}`);
  }
  const { access_token: longLivedToken } = await llRes.json() as { access_token: string };

  // Store long-lived user token temporarily (will be replaced by page token)
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO credentials (platform, access_token, refresh_token, token_expiry, extra_json)
    VALUES ('facebook', ?, NULL, NULL, ?)
  `).run(longLivedToken, JSON.stringify({ type: 'user_token', needs_page_selection: true }));
}

export async function getFacebookPages(): Promise<Array<{ id: string; name: string; access_token: string }>> {
  const db = getDb();
  const cred = db.prepare('SELECT access_token FROM credentials WHERE platform = ?').get('facebook') as {
    access_token: string | null;
  } | undefined;

  if (!cred?.access_token) throw new Error('Facebook not connected');
  const userToken = cred.access_token;
  const API = `https://graph.facebook.com/${config.fbApiVersion}`;

  // Classic apps: /me/accounts lists the user's managed Pages with their access tokens.
  const accRes = await fetch(`${API}/me/accounts?fields=id,name,access_token&access_token=${userToken}`);
  if (accRes.ok) {
    const body = await accRes.json() as { data?: Array<{ id: string; name: string; access_token: string }> };
    if (body.data && body.data.length > 0) return body.data;
  }

  // Facebook Login for Business: /me/accounts comes back empty because Pages are granted as
  // business assets, not classic page roles. The granted Page IDs live in the token's
  // granular_scopes — resolve each to a Page access token directly. (debug_token needs an
  // app access token.)
  const appToken = `${config.facebook.appId}|${config.facebook.appSecret}`;
  const dbgRes = await fetch(`${API}/debug_token?input_token=${userToken}&access_token=${appToken}`);
  if (!dbgRes.ok) throw new Error('Failed to inspect Facebook token');
  const dbg = await dbgRes.json() as {
    data?: { granular_scopes?: Array<{ scope: string; target_ids?: string[] }> };
  };

  const ids = new Set<string>();
  for (const gs of dbg.data?.granular_scopes ?? []) {
    for (const id of gs.target_ids ?? []) ids.add(id);
  }

  const pages: Array<{ id: string; name: string; access_token: string }> = [];
  for (const id of ids) {
    const pRes = await fetch(`${API}/${id}?fields=name,access_token&access_token=${userToken}`);
    if (!pRes.ok) continue;
    const p = await pRes.json() as { id: string; name?: string; access_token?: string };
    if (p.access_token) pages.push({ id: p.id, name: p.name ?? id, access_token: p.access_token });
  }
  return pages;
}

export function selectFacebookPage(pageId: string, pageName: string, pageAccessToken: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE credentials SET access_token = ?, extra_json = ? WHERE platform = 'facebook'
  `).run(pageAccessToken, JSON.stringify({ page_id: pageId, page_name: pageName }));
}

export function getFacebookPageToken(): { accessToken: string; pageId: string } | null {
  const db = getDb();
  const cred = db.prepare('SELECT access_token, extra_json FROM credentials WHERE platform = ?').get('facebook') as {
    access_token: string | null;
    extra_json: string | null;
  } | undefined;

  if (!cred?.access_token || !cred.extra_json) return null;

  const extra = JSON.parse(cred.extra_json);
  if (!extra.page_id || extra.needs_page_selection) return null;

  return { accessToken: cred.access_token, pageId: extra.page_id };
}

export function disconnectFacebook(): void {
  const db = getDb();
  db.prepare('DELETE FROM credentials WHERE platform = ?').run('facebook');
}
