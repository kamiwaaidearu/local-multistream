import 'dotenv/config';

function env(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Invalid integer for ${key}: ${raw}`);
  return parsed;
}

export const config = Object.freeze({
  port: envInt('PORT', 3000),
  httpsPort: envInt('HTTPS_PORT', 3443),
  rtmpPort: envInt('RTMP_PORT', 1935),
  localStreamKey: env('LOCAL_STREAM_KEY', 'multistream-live'),
  fbApiVersion: env('FB_API_VERSION', 'v25.0'),
  appSecret: process.env.APP_SECRET ?? '',
  // Web Studio re-encode quality (kbps). Tunable for your upload bandwidth — note the
  // server fans this out to EACH platform, so total upload ≈ videoBitrate × (# platforms).
  studioVideoBitrateKbps: envInt('STUDIO_VIDEO_BITRATE', 4500),
  studioAudioBitrateKbps: envInt('STUDIO_AUDIO_BITRATE', 160),

  youtube: {
    clientId: process.env.YT_CLIENT_ID ?? '',
    clientSecret: process.env.YT_CLIENT_SECRET ?? '',
    redirectUri: env('YT_REDIRECT_URI', 'http://localhost:3000/auth/youtube/callback'),
  },

  facebook: {
    appId: process.env.FB_APP_ID ?? '',
    appSecret: process.env.FB_APP_SECRET ?? '',
    redirectUri: env('FB_REDIRECT_URI', 'https://localhost:3443/auth/facebook/callback'),
  },

  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID ?? '',
    clientSecret: process.env.TWITCH_CLIENT_SECRET ?? '',
    redirectUri: env('TWITCH_REDIRECT_URI', 'http://localhost:3000/auth/twitch/callback'),
  },
});

// Startup validation
export function validateConfig(): void {
  const { port, rtmpPort } = config;

  if (port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${port}`);
  }
  if (rtmpPort < 1 || rtmpPort > 65535) {
    throw new Error(`Invalid RTMP_PORT: ${rtmpPort}`);
  }

  const platforms = ['youtube', 'facebook', 'twitch'] as const;
  const configured = platforms.filter((p) => {
    if (p === 'youtube') return config.youtube.clientId && config.youtube.clientSecret;
    if (p === 'facebook') return config.facebook.appId && config.facebook.appSecret;
    if (p === 'twitch') return config.twitch.clientId && config.twitch.clientSecret;
    return false;
  });

  if (configured.length === 0) {
    console.warn('[config] No platform credentials configured. Connect platforms in Settings after startup.');
  } else {
    console.log(`[config] Configured platforms: ${configured.join(', ')}`);
  }

  if (!config.appSecret) {
    console.warn(
      '[config] APP_SECRET is not set — the app has no password. Anyone who can reach it can ' +
      'control your streams. Set APP_SECRET before exposing it beyond localhost.',
    );
  }

  if (config.localStreamKey === 'multistream-live') {
    console.warn(
      '[config] LOCAL_STREAM_KEY is the public default. The RTMP ingest is gated only by this ' +
      'key (APP_SECRET does not protect it), so anyone who can reach the RTMP port and knows ' +
      'the default can publish to your stream. Set a unique LOCAL_STREAM_KEY before exposing ' +
      'the RTMP port beyond localhost.',
    );
  }
}
