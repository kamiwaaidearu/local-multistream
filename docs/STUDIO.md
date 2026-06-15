# Web Studio — decisions & roadmap

Living notes for the browser-based stream production feature ("Web Studio"). Updated as we go so anyone (or a future session) can pick up the thread.

## Goal

Let non-expert admins run RosaryMen livestreams from a browser, removing the dependency on Michael + OBS. The operator experience must be dead simple; the layout-authoring experience is rare and expert-only.

## Architecture (built & working)

The studio is **source-agnostic with OBS** — it injects into the same local RTMP endpoint, so the entire platform fan-out is reused:

```
Webcam + screen tab
  → canvas compositor (renders the active template @30fps)   client/src/hooks/useCanvasCompositor.ts
  → canvas.captureStream()
  → MediaRecorder (WebM / VP8 + Opus, ~4.5 Mbps)             client/src/hooks/useStudioStream.ts
  → WebSocket /ws/studio
  → server ingest FFmpeg (transcode → H.264 / AAC / FLV)     server/studio/ingest.ts
  → rtmp://127.0.0.1:1935/live/multistream-live  (same endpoint OBS uses)
  → fan-out FFmpeg (-c copy) → YouTube + Facebook + Twitch   server/fanout/ffmpeg.ts
```

Audio: webcam mic + shared-tab audio are mixed in `useAudioMixer.ts` and muxed into the recorder.

## Michael's six requirements — status

1. Chrome/Edge tab share — **done** (`getDisplayMedia`; tab *audio* is Chrome/Edge only).
2. Share the webcam (with audio) — **done**.
3. Template shows tab + webcam + image + solid color (+ text) — **done**.
4. Simple, Figma-ish editor — **deferred** (see decisions).
5. Save template + load for modification — **partial** (single template; multi-template library deferred).
6. Usable in the actual live stream — **done**, full pipeline verified.

## Key decisions (2026-06-15)

- The "three templates" Michael wants (Intro / Main / Clean) are really **OBS-style scenes** switched live — not separately-authored templates.
- The keystone feature for delegation is **one-click live scene switching**, not the editor. Authoring is rare; operating happens every stream.
- **v1 scope:** a simple "easy Go Live" operator flow for the **Main scene only**. No scene switcher yet, no new editor yet. Keep the model scene-ready so switching is a small add later.
- **Editor direction (when built):** free-form drag/resize canvas with alignment snapping — *not* the current grid/CSS-form editor (row/col/span, fr units are too technical). Hard constraint: simple enough that infrequent edits need zero relearning. Per-element `x/y/w/h` (fractions of canvas) also simplifies the compositor.
- **Slides into the canvas = Chrome tab share.** You can't composite an embedded Google Slides iframe (cross-origin canvas taint); tab capture mirrors OBS window capture and is the reliable path.

## Done this session (v1)

- Rebuilt `client/src/components/StudioSourcePanel.tsx` into a guided operator flow: live preview → "Share your slides" → "Camera & microphone" (with a live mic level meter) → advanced sections ("Adjust audio levels", "Edit layout") collapsed by default. The grid editor is no longer front-and-center.
- Hardened `client/src/hooks/useAudioMixer.ts`: the `AudioContext` could start suspended (created without a user gesture) → silent stream. Now exposes `resume()` and resumes on the Start Camera / Share Slides clicks and on source connect.
- Confirmed the Main scene is the existing seeded default template (slides + webcam PiP + footer logo + "Join us at RosaryMen.com").
- Removed the duplicated default-template literal. The canonical layout now lives in exactly one place — `server/db/index.ts` (`DEFAULT_GRID_TEMPLATE`, seed + "Reset to Default"). The client carries only a blank `FALLBACK_TEMPLATE` for pre-load/offline state, so the two can no longer silently drift.

## Live-streaming reliability pass (2026-06-15)

Audited the whole go-live path end to end and fixed:

- **Startup reconciliation** — streams left `live` by a crash/restart are marked `ended` on boot (`reconcileLiveStreams`), so a crash mid-stream no longer permanently blocks all future go-lives via the concurrent-stream guard.
- **Graceful shutdown** — `shutdown()` now ends any live stream (bounded to 8s) and awaits FFmpeg/ingest teardown, so Ctrl+C no longer leaves YouTube/Facebook broadcasts dangling "live."
- **YouTube** — `enableAutoStart` set to `false` so it no longer conflicts with our explicit poll-then-transition (the conflict was causing `redundantTransition` errors every stream).
- **Facebook** — now explicitly transitions the UNPUBLISHED/SCHEDULED_UNPUBLISHED live video to `LIVE_NOW` at go-live (delayed + retried so the fan-out is already pushing data first, which FB requires), instead of assuming it auto-publishes. Confirmed against the [Live Video API docs](https://developers.facebook.com/docs/live-video-api): an unpublished video is "not visible to other users" until a `LIVE_NOW` transition, and that transition needs the stream to be receiving data.
- **Studio reconnect** — the studio→server WebSocket now auto-reconnects with backoff (6 attempts), and the server hard-stops a lingering ingest FFmpeg so two never publish the same RTMP key.
- **Go-live source guard** — refuses to go live unless OBS or the Studio is actually publishing.
- **Fan-out stop** — a `stopping` flag stops the close-handler from respawning a zombie process during teardown; stop is now parallel across platforms (was sequential, up to 15s).
- **SSE auth** — live events authenticate via a query-param token (EventSource can't send headers), so the FFmpeg log works on password-protected instances.
- **Misc** — background Twitch VOD fetch (no more 5s blocking End Stream); OBS/Studio dual-publish guard; safe Facebook error parsing.

## Backlog (rough priority)

1. **Live scene switching (OBS scenes).** Seed Intro + Clean scenes; add a scenes data model (array + active id, or a scenes table); one-click switcher in the operator view. Switching just swaps the active template object — the compositor hot-swaps with no stream teardown because the canvas size is constant (`useCanvasCompositor.ts` only re-creates the stream on width/height/fps change).
2. **Free-form drag/resize editor with snapping** (replaces the grid editor). Migrate the saved template to the per-element model.
3. **Template library:** save / save-as / pick from list. The `studio_templates` table already supports multiple rows; only the single-default route + UI exist today.
4. ~~**Resilience:** studio→server WebSocket auto-reconnect.~~ ✅ Done (2026-06-15) — see the reliability pass above.
5. **Remote-admin HTTPS.** `getUserMedia`/`getDisplayMedia` need a secure context. Admins reaching the box over the LAN at `http://<ip>:3000` are silently blocked — they must use the HTTPS server and accept the self-signed cert. Decide on a clean path (or document localhost-only).
6. **Misc:** mic device picker; avoid changing canvas dimensions mid-stream (recreates the recorder); test transcode CPU cost on the actual streaming machine.

## Open questions

- How scenes get authored initially — seed as data vs. wait for the editor.
- Should "Go Live" hard-gate on having at least one video source, or stay flexible?
