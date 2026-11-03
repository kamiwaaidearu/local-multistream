# CLAUDE.md

Guidance for Claude Code (and anyone else) working in this repository. See `README.md` for what the app does and how to set it up.

## Commands

- `npm run dev` — Express server (`tsx watch`) and the Vite client together, with HMR.
- `npm run build` — builds the client into `client/dist/`.
- `npm start` — production server; serves the pre-built `client/dist/`.
- `npm test` — server unit tests (Node's built-in runner via tsx) plus the client's typecheck and vitest suite. New server test files must be added to the list in `package.json`.
- Server typecheck: `npx tsc -p server/tsconfig.json --noEmit`.

## Workflow

- **Rebuild the client after client changes.** Outside `npm run dev`, Express serves static files from `client/dist/`, so source edits do nothing until `npm run build` runs. A stale bundle has already cost a long debugging session over a "black canvas".
- **The running server is the main checkout.** Edits made only in a `.claude/worktrees/...` worktree never reach the running app. Land the change on `main` and rebuild `client/dist` there (it is gitignored, so a merge does not carry it), then restart the server unless it is on `tsx watch`.
- **Branch worktrees from the current `main`.** Harness worktrees can be cut from an older tip; check `git merge-base --is-ancestor main HEAD` at the start and before wrapping up, and bring the branch onto `main` if it has advanced.
- **Read today's log.** Server logs are daily files at `data/logs/server-YYYY-MM-DD.log`; analysing an older file has produced confident wrong conclusions.

## Rules for a live broadcast system

- **Never lock out the operator mid-stream.** No auth, session or rate-limit change may be able to fire while a stream is live. Session tokens have no TTL; keep it that way. Token validation (API calls, the SSE feed, the studio WebSocket) stays un-throttled, and the login limiter is gated off while a stream is live. Before adding any time- or attempt-based gate, ask whether it can fire during a broadcast, and carve that case out if so.
- **Verify, then report.** Do not call something working or diagnosed from reading code or from an API response alone. Measure it: run it in the browser, query the platform API, sample the bitrate, and quote the numbers. Keep what we send separate from what the platform receives, and check for a playable artifact (an advancing playhead, a manifest with segments). When a hypothesis is disproved, correct any comments or commit messages that asserted it.
- **Prefer composable systems over presets.** Lean toward general building blocks (grid layouts, configurable templates) over narrow dropdowns of fixed options.

## Live recovery model

A live studio broadcast recovers from drops through two independent halves:

- **Studio ingest** (client `useStudioStream`): reconnects indefinitely at capped backoff while live. Media survives a network blip but not a page reload; reopening after a reload is deliberately manual, since an automatic reconnect would push empty content.
- **Fan-out relays** (`server/fanout/retryPolicy.ts`): if the local RTMP source is absent, every leg lost input together, so retry steadily and never give up. If the source is present but one leg keeps dying, treat it as a per-platform fault: back off, then mark it `error` for a manual retry.

Platform reconnect windows:

- **Twitch:** 90 s disconnect protection; past that a second VOD starts.
- **Facebook:** a few minutes of grace after an abrupt drop, then the live video closes for good. A *clean* RTMP unpublish ends the broadcast at once, so relay legs are SIGKILLed on source loss and on health restarts.
- **YouTube:** most forgiving; broadcasts use `enableAutoStop: false` and a reusable stream key, so they resume on reconnect even after a long gap. Enabling `enableAutoStart` was measured to make go-live less reliable and was reverted.

The abandoned-stream watchdog (`server/stream/sourceWatchdog.ts`) ends a stream after 5 minutes without a source. It is intentionally longer than Facebook's window, because YouTube and Twitch can recover past it and a router reboot takes 1–3 minutes. Session takeover (`server/studio/sessionTakeover.ts`) lets a new connection claim the studio only when the existing session is stale, so a second tab cannot hijack a live broadcast.

## Facebook API limits (verified June 2026)

- Creating Page events via the API is partner-gated and unavailable.
- Scheduled live videos are deprecated in the Graph API.
- Scheduled Page posts (`published=false` + `scheduled_publish_time`) work, as do immediate live videos.

So the app schedules an announcement post at setup and creates the live video at go-live. Do not propose scheduled live videos or API event creation.
