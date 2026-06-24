import 'dotenv/config';
import { DEFAULT_NVENC_PRESET, DEFAULT_X264_PRESET, ENCODER_MODES } from './studio/encoderConfig.js';

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

// Parse TRUST_PROXY into an Express `trust proxy` value. null = disabled (the safe default).
function parseTrustProxy(raw: string | undefined): boolean | number | string | null {
  const v = (raw ?? '').trim();
  if (!v || ['false', 'off', 'no', '0'].includes(v.toLowerCase())) return null;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v; // subnet / IP list
}

function envEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[key];
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  const match = allowed.find((a) => a === value);
  if (!match) {
    throw new Error(`Invalid ${key}: "${raw}" (expected one of: ${allowed.join(', ')})`);
  }
  return match;
}

export const config = Object.freeze({
  port: envInt('PORT', 3000),
  httpsPort: envInt('HTTPS_PORT', 3443),
  rtmpPort: envInt('RTMP_PORT', 1935),
  localStreamKey: env('LOCAL_STREAM_KEY', 'multistream-live'),
  fbApiVersion: env('FB_API_VERSION', 'v25.0'),
  appSecret: process.env.APP_SECRET ?? '',
  // Express `trust proxy`, parsed from TRUST_PROXY. null = trust no proxy (req.ip is the direct
  // socket address — the safe default). Set it when behind a reverse proxy / Cloudflare Tunnel so
  // the login limiter keys on the real client IP instead of every request collapsing to the
  // proxy's address. Enabling it without a proxy would let clients spoof their IP. Accepts 'true',
  // a hop count (e.g. '1'), or a subnet/IP; 'false'/'off'/'0'/empty disable it.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Web Studio re-encode quality (kbps). Tunable for your upload bandwidth — note the
  // server fans this out to EACH platform, so total upload ≈ videoBitrate × (# platforms).
  studioVideoBitrateKbps: envInt('STUDIO_VIDEO_BITRATE', 4500),
  studioAudioBitrateKbps: envInt('STUDIO_AUDIO_BITRATE', 160),
  // Web Studio ingest video encoder:
  //   auto    — use NVIDIA NVENC (h264_nvenc) when this ffmpeg build supports it, else libx264 (CPU)
  //   nvenc   — prefer NVENC; still falls back to libx264 if it's unavailable, so streaming never breaks
  //   libx264 — always encode on the CPU
  studioVideoEncoder: envEnum('STUDIO_VIDEO_ENCODER', ENCODER_MODES, 'auto'),
  // Encode preset (speed↔quality) for whichever ingest encoder is active. Defaults are sensible;
  // override only to trade encode load for quality. An unknown value falls back to the default
  // (logged) so a typo never breaks streaming.
  //   STUDIO_NVENC_PRESET — NVENC: p1 (fastest) … p7 (best), or named (hq, ll, …). Default p5.
  //   STUDIO_X264_PRESET  — libx264: ultrafast … veryslow/placebo. Default veryfast.
  studioNvencPreset: env('STUDIO_NVENC_PRESET', DEFAULT_NVENC_PRESET),
  studioX264Preset: env('STUDIO_X264_PRESET', DEFAULT_X264_PRESET),

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
