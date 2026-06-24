# Local Multistream

A self-hosted, cross-platform multistreaming studio. Go live on **YouTube**, **Facebook**, and **Twitch** simultaneously from a single feed — either from the built-in browser-based **Web Studio** (camera + screen + mic, composited in your browser, no OBS required) or from **OBS / any RTMP encoder**. The server fans your one feed out to every platform.

## Features

- **Web Studio (browser production)** — capture your camera and screen share, mix multiple audio sources (microphone + desktop audio), composite them on a branded canvas template, and stream straight from the browser. No OBS install needed. The compositor runs on a Web Worker timer so it keeps rendering even when the tab is backgrounded.
- **Adaptive quality** — an upload-bandwidth probe measures the operator's connection and pre-selects a stream-quality preset their link can sustain.
- **OBS / RTMP input** — alternatively, publish from OBS (or any RTMP encoder) to the built-in RTMP server. *(Local network only — see [Deployment](#deployment).)*
- **RTMP fan-out** — fans your feed out to all platforms via FFmpeg with `-c copy` (no re-transcode on the fan-out leg). Auto-reconnects with exponential backoff if a platform connection drops.
- **Hardware-accelerated ingest** — the Web Studio feed is re-encoded once via NVIDIA **NVENC** (`h264_nvenc`) when available, falling back to **libx264** (CPU) automatically so streaming never breaks.
- **Pre-create scheduled live events** on YouTube and Facebook before going live; **batch-create** recurring weekly series with per-event titles and thumbnails.
- **Facebook reminder posts** — schedule advance announcement posts and an automatic "we're live now" post (the live video itself can't be scheduled via the API; see [Scheduling](#scheduling--recurring-events)).
- **App password** — optional `APP_SECRET` gates the whole app behind a login, with constant-time comparison and a per-IP login rate limiter. The limiter is disabled while a stream is live so the operator can never be locked out mid-broadcast.
- **Real-time monitoring** — per-platform status, an event log, and live FFmpeg logs streamed over SSE.
- **Local SQLite** — all stream metadata is stored locally via Node's built-in `node:sqlite`. Nothing in the cloud, no native modules to compile.
- **Runs behind a Cloudflare Tunnel** — designed so a remote operator can produce a stream from anywhere while the origin stays bound to localhost.
- **Cross-platform** — Windows, Mac, and Linux.

---

## How It Works

There are two ways to get a feed into the server; both end up fanned out to every platform the same way:

```
Web Studio (browser)  ──WebSocket──▶  server re-encode (NVENC / libx264)  ─┐
                                                                           ├─▶  local RTMP  ──FFmpeg fan-out (-c copy)──▶  YouTube
OBS / RTMP encoder  ──────RTMP───────────────────────────────────────────┘                                              Facebook
                                                                                                                          Twitch
```

- **Web Studio leg** is re-encoded once on the server (GPU if available) before fan-out.
- **OBS leg** is published as-is to the local RTMP server.
- The **fan-out** to each platform uses `-c copy`, so it never re-transcodes and auto-reconnects on transient drops.

---

## Prerequisites

- **Node.js 22+** — the app uses Node's built-in `node:sqlite` module, so there's no native build step and no `better-sqlite3`/compiler toolchain to install. (Node 24+ recommended, where `node:sqlite` is stable; on 22–23 it runs as an experimental feature.)
- **A Chromium-based browser** for Web Studio — camera/screen capture (`getUserMedia` / `getDisplayMedia`) and `MediaRecorder` require a **secure context**, i.e. served over HTTPS or via `localhost`.
- **OBS Studio** (or any RTMP encoder) — *optional*, only if you prefer the OBS input over Web Studio.
- **An NVIDIA GPU** — *optional but recommended*; enables NVENC hardware encoding for the Web Studio leg (falls back to CPU automatically).
- **Platform developer apps** — see [Platform Setup](#platform-setup) below. You don't need all three.

---

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url>
cd local-multistream

# 2. Install dependencies (root + client)
npm install
cd client && npm install && cd ..

# 3. Configure environment
cp .env.example .env
# Edit .env with your platform credentials and (optionally) an APP_SECRET — see below

# 4. Start development servers
npm run dev
```

`npm run dev` starts:
- **Express backend** on `http://localhost:3000` and **`https://localhost:3443`** (HTTPS is needed for Facebook's OAuth redirect and for a secure Web Studio context)
- **Vite dev server** on `http://localhost:5173`, which proxies `/api`, `/auth`, `/uploads`, and the `/ws` WebSocket to the backend

Open `http://localhost:5173` in your browser during development.

### Production

```bash
npm run build     # builds the React app into client/dist/
npm start         # starts Express (NODE_ENV=production) serving the built app
```

In production the single Express process serves the built client and the API on `http://localhost:3000` / `https://localhost:3443`. **Rebuild the client (`npm run build`) after any client change** — `npm start` serves the pre-built `client/dist`, not live source.

### Tests

```bash
npm test          # server unit tests (node:test) + client tests (vitest)
```

---

## Authentication

Set **`APP_SECRET`** in `.env` to require a password before anyone can use the app:

- With `APP_SECRET` set, the UI shows a **login** page. The password is checked with a constant-time compare, and on success the browser stores a bearer token sent on every API request. A **Log out** button clears it.
- Leaving `APP_SECRET` **empty disables auth** — convenient for purely local development, but anyone who can reach the app can control your streams. The server logs a warning at startup in this case.
- A **per-IP login rate limiter** throttles brute-force attempts. It is intentionally **disabled while a stream is live**, so a refreshed tab or a second device can always re-authenticate to reach "End Stream" mid-broadcast.

> **Note:** `APP_SECRET` protects the web app and API only. The **RTMP ingest is gated separately** by `LOCAL_STREAM_KEY` — keep that key non-default if the RTMP port is reachable beyond localhost.

---

## Deployment

The app is built to run on a single machine (the "origin") and be reached remotely **through a Cloudflare Tunnel**, with the origin itself bound to localhost. The recommended hardened setup:

| `.env` setting | Value | Why |
|----------------|-------|-----|
| `BIND_HOST` | `127.0.0.1` | The HTTP/HTTPS servers accept only local connections. `cloudflared` reaches them on localhost and remote admins arrive through the tunnel hostname; nothing on your LAN can hit the origin directly to spoof a client IP. |
| `TRUST_PROXY` | `true` | Honor Cloudflare's `CF-Connecting-IP` so the login rate limiter keys on the real client IP instead of the tunnel's localhost address. **Only enable this behind a proxy** — trusting the header with nothing in front lets clients spoof their IP. |
| `APP_SECRET` | *(a strong secret)* | Required once the app is reachable beyond localhost. |
| `LOCAL_STREAM_KEY` | *(a unique key)* | The RTMP ingest is gated only by this key. |

**TLS:** Behind a Cloudflare Tunnel, TLS terminates at Cloudflare — you don't need a real certificate on the origin. The app auto-generates a self-signed `localhost` cert (written to `data/`) for its local HTTPS server. For a public-domain / DDNS deployment without a tunnel, point `TLS_CERT_FILE` / `TLS_KEY_FILE` at a real cert (e.g. Let's Encrypt) to get a trusted secure context for OAuth callbacks and Web Studio.

**RTMP is not tunneled.** The Cloudflare Tunnel carries the web app (HTTP) only, so the **OBS/RTMP input works on your local network only**. Remote operators should use the **Web Studio**, which streams over the tunneled WebSocket. RTMP binds separately (via node-media-server) and is unaffected by `BIND_HOST`.

---

## OBS Configuration *(optional, local network only)*

If you use the OBS input instead of Web Studio, one-time setup in OBS:

1. Open OBS → **Settings** → **Stream**
2. Service: **Custom...**
3. Server: `rtmp://localhost:1935/live` (from another device on your LAN, replace `localhost` with this PC's local IP, e.g. `192.168.x.x`)
4. Stream Key: your `LOCAL_STREAM_KEY` (default `multistream-live`)
5. Click **OK**

The app's **OBS panel shows the real server URL and stream key** read from your server config, so they never drift if you change the key.

**Recommended OBS output settings:** 1080p · 4500–6000 kbps · H.264 (x264 or NVENC) · CBR · keyframe interval 2s · 30 fps.

> **Windows firewall:** you may need to allow port 1935 through Windows Firewall on first run.

---

## Web Studio

The default source. On a stream's page, pick **Web Studio** (vs OBS) and:

1. **Select sources** — choose a camera and microphone, toggle screen share, and add desktop audio. Multiple audio sources are mixed together.
2. **Adjust layout** (optional) — the canvas template (grid of camera/screen/footer cells, colors, overlays) is editable; "Reset to Default" restores the built-in branded layout.
3. **Test my connection** (optional) — runs the upload-bandwidth probe and recommends a quality preset. This runs automatically when the stream is *ready* (never while live, since the probe saturates the uplink).
4. **Go Live** — connects the browser feed to the server (over a WebSocket) and starts the broadcast.

---

## Platform Setup

You need to create developer apps on each platform you want to stream to. **You don't need all three** — the app works with any combination.

### YouTube

1. Go to **[Google Cloud Console](https://console.cloud.google.com/)**
2. Click **"Select a project"** → **"New Project"** → name it (e.g., "Local Multistream") → **Create**
3. Make sure the new project is selected in the top bar
4. Go to **APIs & Services** → **Library** → search **"YouTube Data API v3"** → click it → **Enable**
5. Go to **APIs & Services** → **OAuth consent screen**:
   - Choose **External** → **Create**
   - App name: "Local Multistream" (or whatever you want)
   - User support email: your email
   - Developer contact: your email
   - Click **Save and Continue** through Scopes (skip), Test Users (add your Google email), Summary
6. Go to **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**:
   - Application type: **Web application**
   - Name: "Local Multistream"
   - Authorized redirect URIs: add `http://localhost:3000/auth/youtube/callback`
   - Click **Create**
7. Copy **Client ID** and **Client Secret** → paste into `.env` as `YT_CLIENT_ID` and `YT_CLIENT_SECRET`

> **Note:** Your app starts in "Testing" mode with a 100-user cap. This is fine — you only need your own account. No need to go through Google's verification process.

**Scopes used** (configured in app code automatically):
- `youtube` — manage broadcasts
- `youtube.force-ssl` — secure API access
- `youtube.upload` — upload thumbnails

### Facebook

1. Go to **[Meta Developer Portal](https://developers.facebook.com/)**
2. Click **"My Apps"** → **"Create App"**:
   - Use case: **"Other"** → **"Business"** (or "Consumer")
   - App name: "Local Multistream"
   - Click **Create**
3. In your app dashboard, click **"Add Product"** → find **"Facebook Login"** → **Set Up**
4. Go to **Facebook Login** → **Settings**:
   - Valid OAuth Redirect URIs: add `https://localhost:3443/auth/facebook/callback` (Facebook requires HTTPS; the app runs an HTTPS server on port 3443 with a self-signed cert)
   - Click **Save Changes**
5. Go to **Settings** → **Basic**:
   - Copy **App ID** → paste into `.env` as `FB_APP_ID`
   - Click **Show** next to App Secret → copy → paste into `.env` as `FB_APP_SECRET`

**Important requirements:**
- Your Facebook account must be **60+ days old**
- Your Facebook Page must have **100+ followers** to go live
- In **Development mode** (the default), you can use the app as an admin without going through App Review
- You need a **Facebook Page** to stream to (not a personal profile) — the app will let you pick which Page after login

**Permissions requested** (during OAuth):
- `publish_video` — create live videos on your Page
- `pages_show_list` — enumerate your Pages to populate the Page picker
- `pages_read_engagement` — read Page metadata and obtain the Page access token
- `pages_manage_posts` — required by the live-videos API to create a live video on a Page (and to publish reminder posts)

> The `pages_manage_posts` permission must be enabled on your app first (Use cases / App Review → Permissions), or Facebook rejects it as an "invalid scope" during OAuth.

### Twitch

1. Go to **[Twitch Developer Console](https://dev.twitch.tv/console)**
2. Click **"Register Your Application"**:
   - Name: "Local Multistream" (must be unique on Twitch)
   - OAuth Redirect URLs: add `http://localhost:3000/auth/twitch/callback`
   - Category: **Broadcasting Suite**
   - Click **Create**
3. Click **"Manage"** on your new application:
   - Copy **Client ID** → paste into `.env` as `TWITCH_CLIENT_ID`
   - Click **"New Secret"** → copy → paste into `.env` as `TWITCH_CLIENT_SECRET`

**That's it for Twitch.** The stream key is fetched automatically via the API after you connect your account in the app — no need to copy it from the Twitch dashboard.

**Scopes requested** (during OAuth):
- `channel:manage:broadcast` — update stream title/category
- `channel:read:stream_key` — fetch the stream key programmatically

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your credentials. All recognized variables:

```env
# --- Platform OAuth ---
# YouTube (Google Cloud Console → OAuth 2.0 Client)
YT_CLIENT_ID=
YT_CLIENT_SECRET=
YT_REDIRECT_URI=http://localhost:3000/auth/youtube/callback

# Facebook (Meta Developer Portal → App Settings)
FB_APP_ID=
FB_APP_SECRET=
FB_REDIRECT_URI=https://localhost:3443/auth/facebook/callback

# Twitch (Twitch Developer Console → Application)
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_REDIRECT_URI=http://localhost:3000/auth/twitch/callback

# --- Server ---
PORT=3000                       # HTTP port
HTTPS_PORT=3443                 # HTTPS port (Facebook OAuth, secure Web Studio context)
RTMP_PORT=1935                  # OBS/RTMP ingest port
LOCAL_STREAM_KEY=multistream-live   # RTMP stream key (change before exposing RTMP)
FB_API_VERSION=v25.0

# --- Auth & networking ---
APP_SECRET=                     # app password; empty = no auth (local dev only)
TRUST_PROXY=true                # honor CF-Connecting-IP behind a proxy/tunnel (see Deployment)
BIND_HOST=127.0.0.1             # interface to bind; 127.0.0.1 = local-only origin. empty = all interfaces
TLS_CERT_FILE=                  # optional: real TLS cert (else a self-signed localhost cert is generated)
TLS_KEY_FILE=

# --- Web Studio encoding ---
STUDIO_VIDEO_ENCODER=auto       # auto | nvenc | libx264 (auto uses NVENC if available, else CPU)
STUDIO_NVENC_PRESET=p5          # NVENC preset p1 (fastest)…p7 (best), or named (hq, ll)
STUDIO_X264_PRESET=veryfast     # libx264 preset ultrafast…veryslow/placebo
STUDIO_VIDEO_BITRATE=4500       # re-encode video bitrate (kbps); total upload ≈ this × # platforms
STUDIO_AUDIO_BITRATE=160        # re-encode audio bitrate (kbps)
```

Leave any platform's credentials blank to disable it — the app still works with the remaining platforms. Invalid values for the encoder/preset settings fall back to the default (logged) rather than breaking a stream.

---

## Usage Workflow

### One-Time Setup
1. Create platform developer apps (see above) and fill in `.env` (and set `APP_SECRET` if exposing the app).
2. Start the app (`npm run dev`).
3. Go to the **Settings** page → connect each platform via OAuth. Settings shows the connected YouTube/Twitch channel and the selected Facebook Page, and lets you edit the Facebook reminder schedule.
4. *(Optional)* Configure OBS, or just use Web Studio.

### Each Stream Session
1. **Create** — "New Stream" (or "New Series" for recurring events) → enter title, description, thumbnail, optional schedule time → Save.
2. **Setup** — "Setup Platforms" → creates the YouTube broadcast, schedules any Facebook announcement posts (the Facebook live video itself is created at go-live), and stores the Twitch title. The stream moves to **ready**.
3. **Choose your source** — toggle **Web Studio** or **OBS**.
   - *Web Studio:* pick camera/mic, enable screen share, optionally test your connection.
   - *OBS:* click "Start Streaming" in OBS → the app detects the connection.
4. **Go Live** — click **Go Live**. For Web Studio this connects the browser feed and starts the broadcast; for OBS it fans out the incoming RTMP feed.
5. **Stream** — monitor per-platform status, the event log, and live FFmpeg logs. FFmpeg auto-reconnects on transient failures.
6. **End** — click **End Stream** → FFmpeg stops, YouTube/Facebook broadcasts end, and VOD links appear.

> While a Web Studio stream is live, navigating away (or closing the tab) is guarded — leaving would unmount the capture and interrupt the broadcast.

---

## Scheduling & Recurring Events

| Platform | Scheduling support | Behavior |
|----------|-------------------|----------|
| YouTube  | Full API scheduling | Broadcast created immediately with `scheduledStartTime` — visible in YouTube Studio |
| Facebook | Announcement posts (auto) | The API can't schedule live videos or create events (both deprecated/partner-gated). The app instead schedules plain **announcement posts** for advance visibility and publishes a **"we're live now"** post at go-live; the live video itself is created and goes live at go-live. |
| Twitch   | No scheduling API | Title/category stored locally, applied at go-live |

**Facebook reminder posts:** configurable in Settings — a timezone, a set of rules (e.g. "the Sunday before at 18:00", "the morning of at 08:00"), and an optional go-live post. Post text supports placeholders like `{title}`, `{datetime}`, `{page}`, and `{video}`.

**Batch creation:** "New Series" → pick start date, recurrence (weekly), number of events → enter a unique title/description/thumbnail for each → "Create All" → "Setup All".

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ |
| Language | TypeScript (backend + frontend) |
| Backend | Express.js, run via tsx |
| Frontend | React 19 + Vite + Mantine UI + React Router |
| RTMP server | node-media-server |
| Web Studio ingest | WebSocket (`ws`) → FFmpeg re-encode (NVENC `h264_nvenc` / libx264) |
| Browser compositing | Canvas + `MediaRecorder`, driven by a Web Worker timer |
| Fan-out | FFmpeg via `ffmpeg-static` (`-c copy`) |
| Real-time updates | Server-Sent Events (SSE) |
| Database | SQLite via Node's built-in `node:sqlite` |
| TLS | Auto-generated self-signed cert via `selfsigned` (or your own via `TLS_*`) |
| YouTube API | googleapis (OAuth2) |
| Facebook API | Graph API v25.0 (native fetch) |
| Twitch API | Helix API (native fetch) |
| Tests | `node:test` (server) + Vitest (client) |

---

## Project Structure

```
local-multistream/
├── package.json              # backend deps + scripts
├── .env.example              # environment template
├── .env                      # your credentials (gitignored)
├── server/
│   ├── index.ts              # Express + HTTP/HTTPS + RTMP startup, auth wiring, graceful shutdown
│   ├── config.ts             # .env loading + validation
│   ├── cert.ts               # TLS: load from TLS_* env, else self-signed localhost cert
│   ├── types.ts              # shared TypeScript types
│   ├── db/
│   │   ├── index.ts          # node:sqlite singleton + settings/template helpers
│   │   └── schema.sql        # table definitions
│   ├── auth/                 # OAuth + token persistence
│   │   ├── youtube.ts
│   │   ├── facebook.ts       # OAuth + page token exchange (granular_scopes)
│   │   └── twitch.ts         # OAuth + refresh logic
│   ├── platforms/            # platform API calls
│   │   ├── youtube.ts        # YouTube Live API
│   │   ├── facebook.ts       # Facebook Graph API (live videos, posts, VOD links)
│   │   └── twitch.ts         # Twitch Helix API
│   ├── stream/
│   │   ├── manager.ts        # stream lifecycle: setup → go live → end
│   │   └── reminders.ts      # Facebook reminder schedule composing/timing
│   ├── fanout/
│   │   └── ffmpeg.ts         # fan-out FFmpeg process management + crash recovery
│   ├── rtmp/
│   │   └── server.ts         # node-media-server (OBS ingest)
│   ├── studio/               # Web Studio + auth + encoding
│   │   ├── ingest.ts         # WebSocket ingest → re-encode → local RTMP
│   │   ├── encoderConfig.ts  # NVENC/libx264 selection + ffmpeg args
│   │   ├── auth.ts           # APP_SECRET middleware, login, token validation
│   │   ├── authCrypto.ts     # constant-time compare + token hashing
│   │   ├── loginRateLimiter.ts  # per-IP login throttle
│   │   ├── clientIp.ts       # resolve real client IP behind a proxy/tunnel
│   │   └── bandwidthProbe.ts # server side of the upload-bandwidth probe
│   └── routes/
│       ├── api.ts            # /api/* REST endpoints
│       ├── auth.ts           # /auth/* OAuth callback routes
│       └── studio.ts         # /api/studio/* (status, ingest-info, template, overlay upload)
├── client/                   # React app (Vite)
│   ├── src/
│   │   ├── App.tsx           # router, layout, auth gate, logout, live-navigation guard
│   │   ├── main.tsx          # React entry point
│   │   ├── pages/            # Dashboard, CreateStream, StreamPage, Settings, Login
│   │   ├── components/       # StudioSourcePanel, ObsSourcePanel, TemplateEditor,
│   │   │                     #   LiveNavigationGuard, ReminderSettingsCard, PlatformStatusCard, …
│   │   ├── hooks/            # useCanvasCompositor, useAudioMixer, useStudioStream, useSSE, …
│   │   └── lib/              # api.ts, ws.ts, authToken.ts, bandwidthProbe.ts, studioLive.ts, gridTemplate.ts
│   └── vite.config.ts        # dev server + proxy to backend (/api, /auth, /uploads, /ws)
├── uploads/                  # thumbnail + overlay images
└── data/                     # SQLite database + self-signed cert (gitignored)
```

---

## Troubleshooting

### Port 1935 blocked (Windows)
Allow the port through Windows Firewall, or change `RTMP_PORT` in `.env`.

### Camera/screen capture unavailable in Web Studio
`getUserMedia`/`getDisplayMedia` require a **secure context**. Use `http://localhost:5173` (dev) or serve over HTTPS — a plain `http://<LAN-IP>` origin will block capture. Behind a Cloudflare Tunnel the public `https://` hostname satisfies this.

### `node:sqlite` not found / errors on startup
You're on an older Node. The app requires **Node.js 22+** (24+ recommended). Check with `node --version`.

### NVENC isn't being used
NVENC needs an NVIDIA GPU/driver *and* an FFmpeg build that includes `h264_nvenc`. The app probes for it and **falls back to libx264 (CPU) automatically** — streaming still works, just on the CPU. Force a mode with `STUDIO_VIDEO_ENCODER`.

### YouTube quota exceeded
The app uses ~300 quota units per stream session (well within the 10,000/day default limit). If you hit limits, check [YouTube API quota usage](https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas).

### Facebook "Page must have 100+ followers"
This is a Facebook requirement for live streaming. You can still create scheduled announcement posts, but going live will fail if the Page has fewer than 100 followers.

### FFmpeg not found
The app bundles FFmpeg via `ffmpeg-static` — it should work automatically. If it doesn't, check that `node_modules/ffmpeg-static` exists and run `npm install` again.

---

## License

Private — not for distribution.
