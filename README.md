# Local Multistream

A cross-platform Node.js multistreaming manager that lets you go live on **YouTube**, **Facebook**, and **Twitch** simultaneously from a single OBS output.

## Features

- **Pre-create scheduled live events** on YouTube, Facebook (Page), and Twitch before going live
- **Batch creation** of recurring weekly events with per-event titles and thumbnails
- **RTMP fan-out** — accepts OBS output via a local RTMP server and fans it out to all platforms via FFmpeg (`-c copy`, no transcoding)
- **Auto-reconnect** — if a platform connection drops, FFmpeg auto-retries with exponential backoff
- **Web UI** at `http://localhost:3000` — manage streams, monitor status, view FFmpeg logs in real time
- **No system FFmpeg install needed** — bundled via `ffmpeg-static`
- **SQLite database** — all stream metadata stored locally, nothing in the cloud
- **Cross-platform** — works on Windows, Mac, and Linux

---

## Prerequisites

- **Node.js 18+** (LTS recommended for `better-sqlite3` prebuilt compatibility)
- **OBS Studio** (or any RTMP encoder)
- **Platform accounts** — see [Platform Setup](#platform-setup) below

> **Windows note:** If `better-sqlite3` fails to install, you may need C++ build tools:
> ```
> npm install --global windows-build-tools
> ```

---

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url>
cd local-multistream

# 2. Install dependencies
npm install
cd client && npm install && cd ..

# 3. Configure environment
cp .env.example .env
# Edit .env with your platform credentials (see Platform Setup below)

# 4. Start development servers
npm run dev
```

This starts:
- **Express backend** on `http://localhost:3000`
- **Vite dev server** on `http://localhost:5173` (proxies API calls to Express)

Open `http://localhost:5173` in your browser during development.

### Production

```bash
npm run build     # builds React app into client/dist/
npm start         # starts Express serving the built app at http://localhost:3000
```

---

## OBS Configuration

One-time setup in OBS:

1. Open OBS → **Settings** → **Stream**
2. Service: **Custom...**
3. Server: `rtmp://localhost:1935/live`
4. Stream Key: `multistream-live`
5. Click **OK**

**Recommended OBS output settings:**
- Resolution: 1920x1080
- Bitrate: 4500–6000 kbps
- Encoder: x264 (or NVENC)
- Keyframe Interval: 2 seconds
- Rate Control: CBR
- Profile: High
- FPS: 30

> **Windows firewall:** You may need to allow port 1935 through Windows Firewall on first run.

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

**Permissions used** (requested during OAuth):
- `publish_video` — create live streams on your Page
- `pages_read_engagement` — read Page metadata
- `pages_manage_posts` — manage Page content

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

**Scopes used** (requested during OAuth):
- `channel:manage:broadcast` — update stream title/category
- `channel:read:stream_key` — fetch stream key programmatically

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```env
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

# Server
PORT=3000
RTMP_PORT=1935
LOCAL_STREAM_KEY=multistream-live
FB_API_VERSION=v25.0
```

Leave any platform's credentials blank to disable it — the app will still work with the remaining platforms.

---

## Usage Workflow

### One-Time Setup
1. Create platform developer apps (see above) and fill in `.env`
2. Start the app (`npm run dev`)
3. Go to **Settings** page → connect each platform via OAuth
4. Configure OBS (see above)

### Each Stream Session
1. **Create** — click "New Stream" (or "New Series" for recurring events) → enter title, description, thumbnail, optional schedule time → Save
2. **Setup** — click "Setup Platforms" → YouTube broadcast + Facebook scheduled live created; Twitch title stored locally
3. **Connect OBS** — click "Start Streaming" in OBS → the app detects the connection (indicator turns green)
4. **Go Live** — click "Go Live" in the app → FFmpeg fans out to all platforms
5. **Stream** — monitor per-platform status in the app; FFmpeg auto-reconnects on transient failures
6. **End** — click "End Stream" → FFmpeg stops, YouTube/Facebook broadcasts end, VOD links appear

---

## Scheduling & Recurring Events

| Platform | Scheduling support | Behavior |
|----------|-------------------|----------|
| YouTube  | Full API scheduling | Broadcast created immediately with `scheduledStartTime` — visible in YouTube Studio |
| Facebook | Announcement post (auto) | The API can't schedule live videos or create events (both deprecated/partner-gated). The app schedules a plain **announcement post** (up to ~6 months out) for advance visibility; the live video itself is created and goes live at go-live. |
| Twitch   | No scheduling API | Title/category stored locally, applied at go-live |

**Batch creation:** "New Series" → pick start date, recurrence (weekly), number of events → enter unique title/description/thumbnail for each → "Create All" → "Setup All".

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 18+ |
| Language | TypeScript (backend + frontend) |
| Backend | Express.js + tsx |
| Frontend | React 19 + Vite + Mantine UI + React Router |
| RTMP Server | node-media-server |
| Fan-out | FFmpeg via ffmpeg-static |
| Database | SQLite via better-sqlite3 |
| YouTube API | googleapis (OAuth2) |
| Facebook API | Graph API v25.0 (native fetch) |
| Twitch API | Helix API (native fetch) |

---

## Project Structure

```
local-multistream/
├── package.json              # backend deps + scripts
├── .env.example              # environment template
├── .env                      # your credentials (gitignored)
├── server/
│   ├── index.ts              # Express + RTMP startup + graceful shutdown
│   ├── config.ts             # .env loading + validation
│   ├── types.ts              # shared TypeScript types
│   ├── db/
│   │   ├── index.ts          # SQLite singleton
│   │   └── schema.sql        # table definitions
│   ├── auth/
│   │   ├── youtube.ts        # YouTube OAuth2 + token persistence
│   │   ├── facebook.ts       # Facebook OAuth + page token exchange
│   │   └── twitch.ts         # Twitch OAuth + refresh logic
│   ├── platforms/
│   │   ├── youtube.ts        # YouTube Live API calls
│   │   ├── facebook.ts       # Facebook Graph API calls
│   │   └── twitch.ts         # Twitch Helix API calls
│   ├── stream/
│   │   └── manager.ts        # stream lifecycle: setup → go live → end
│   ├── fanout/
│   │   └── ffmpeg.ts         # FFmpeg process management + crash recovery
│   ├── rtmp/
│   │   └── server.ts         # node-media-server config
│   └── routes/
│       ├── api.ts            # /api/* REST endpoints
│       └── auth.ts           # /auth/* OAuth callback routes
├── client/                   # React app (Vite)
│   ├── src/
│   │   ├── App.tsx           # Router + layout
│   │   ├── pages/            # Dashboard, CreateStream, StreamDetail, Settings
│   │   ├── lib/api.ts        # fetch wrapper
│   │   └── main.tsx          # React entry point
│   └── vite.config.ts
├── uploads/                  # thumbnail images
└── data/                     # SQLite database (gitignored)
```

---

## Troubleshooting

### Port 1935 blocked (Windows)
Allow the port through Windows Firewall, or change `RTMP_PORT` in `.env`.

### `better-sqlite3` won't install
Install C++ build tools: `npm install --global windows-build-tools` (Windows) or `xcode-select --install` (Mac).

### YouTube quota exceeded
The app uses ~300 quota units per stream session (well within the 10,000/day default limit). If you hit limits, check [YouTube API quota usage](https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas).

### Facebook "Page must have 100+ followers"
This is a Facebook requirement for live streaming. You can still create scheduled events, but going live will fail if the Page has fewer than 100 followers.

### FFmpeg not found
The app bundles FFmpeg via `ffmpeg-static` — it should work automatically. If it doesn't, check that `node_modules/ffmpeg-static` exists and run `npm install` again.

---

## License

Private — not for distribution.
