import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { config } from '../config.js';
import { validateToken } from './auth.js';
import { isObsConnected } from '../rtmp/server.js';
import { handleBandwidthProbe } from './bandwidthProbe.js';
import { resolveEncoder, buildVideoArgs, shouldRuntimeFallback, type VideoEncoder } from './encoderConfig.js';

let ffmpegPath: string;
try {
  ffmpegPath = (await import('ffmpeg-static')).default as unknown as string;
} catch {
  ffmpegPath = 'ffmpeg';
}

let studioConnected = false;
let activeWs: WebSocket | null = null;
let ingestFfmpeg: ChildProcess | null = null;
// A previous ingest process that's still winding down. Tracked so a fast studio reconnect
// can hard-stop it before starting a new one — otherwise two FFmpegs would briefly publish
// to the same RTMP key and node-media-server would reject the new one.
let stoppingProc: ChildProcess | null = null;

export function isStudioConnected(): boolean {
  return studioConnected;
}

function stopIngestFfmpeg(): Promise<void> {
  const proc = ingestFfmpeg;
  ingestFfmpeg = null;
  studioConnected = false;
  if (!proc) return Promise.resolve();

  stoppingProc = proc;
  console.log('[studio] Stopping ingest FFmpeg');
  return new Promise<void>((resolve) => {
    // Give it 5s to exit gracefully (EOF on stdin), then force kill.
    const timeout = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      resolve();
    }, 5000);
    proc.on('close', () => {
      clearTimeout(timeout);
      if (stoppingProc === proc) stoppingProc = null;
      resolve();
    });
    try { proc.stdin?.end(); } catch { /* ignore */ }
  });
}

// h264_nvenc availability is probed once and cached: the bundled ffmpeg-static build may not
// include nvenc, or the host may have no NVIDIA driver. Listing the encoders is cheap and avoids
// spawning a doomed ingest FFmpeg.
let nvencSupported: boolean | null = null;
// Set once if an NVENC ingest dies at runtime (built into ffmpeg but not actually usable on this
// host) — we then drop to libx264 for the rest of the process. One-shot, so the fallback can't loop.
let nvencRuntimeFailed = false;

function detectNvenc(): boolean {
  if (nvencSupported === null) {
    try {
      const res = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], {
        encoding: 'utf8',
        timeout: 10000,
      });
      // Trust the encoder list only on a clean exit: !res.error rules out a spawn failure or the
      // 10s timeout (status is null on a signal kill), and status === 0 rules out a crash that
      // printed partial output. Any doubt → false → safe libx264 fallback.
      nvencSupported = !res.error && res.status === 0 && (res.stdout ?? '').includes('h264_nvenc');
    } catch {
      nvencSupported = false;
    }
  }
  return nvencSupported;
}

// The encoder and its preset are resolved once (and logged), then cached. The pure decision logic
// lives in encoderConfig.ts (unit-tested); here we just wire it to the real config, the NVENC
// probe, and the warnings/log. NVENC ALWAYS falls back to libx264 when unsupported so Web Studio
// streaming never breaks.
interface ResolvedEncoder {
  encoder: VideoEncoder;
  preset: string;
}
let resolved: ResolvedEncoder | null = null;

function getEncoder(): ResolvedEncoder {
  if (resolved) return resolved;

  const { encoder, preset, warnings } = resolveEncoder({
    mode: config.studioVideoEncoder,
    nvencSupported: detectNvenc(),
    nvencPreset: config.studioNvencPreset,
    x264Preset: config.studioX264Preset,
  });
  for (const warning of warnings) console.warn(`[studio] ${warning}`);
  console.log(`[studio] Ingest encoder: ${encoder === 'h264_nvenc' ? 'h264_nvenc (GPU)' : 'libx264 (CPU)'}, preset ${preset}`);

  resolved = { encoder, preset };
  return resolved;
}

function startIngestFfmpeg(): ChildProcess {
  const rtmpUrl = `rtmp://127.0.0.1:${config.rtmpPort}/live/${config.localStreamKey}`;

  const { encoder, preset } = getEncoder();
  const args = [
    '-f', 'webm',
    '-analyzeduration', '1000000',
    '-probesize', '1000000',
    '-i', 'pipe:0',
    ...buildVideoArgs(encoder, preset, config.studioVideoBitrateKbps),
    '-c:a', 'aac',
    '-b:a', `${config.studioAudioBitrateKbps}k`,
    '-ar', '48000',
    '-f', 'flv',
    rtmpUrl,
  ];

  console.log(`[studio] Starting ingest FFmpeg → ${rtmpUrl}`);
  const startedAt = Date.now();
  const child = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      // Log FFmpeg output for debugging (filter noise)
      if (line.includes('frame=') || line.includes('Error') || line.includes('error')) {
        console.log(`[studio:ffmpeg] ${line}`);
      }
    }
  });

  child.on('close', (code) => {
    console.log(`[studio] Ingest FFmpeg exited with code ${code}`);
    // Only act if THIS child was still the active ingest. A normal stop (stopIngestFfmpeg /
    // shutdown) nulls ingestFfmpeg first, so an intentional teardown skips everything below.
    if (ingestFfmpeg !== child) return;
    ingestFfmpeg = null;
    studioConnected = false;

    // NVENC is built into ffmpeg but may not actually work on this host (no driver, no free encode
    // session, a GPU reset) — which only surfaces as the encoder dying right after spawn. Rule it
    // out for the rest of the process so the next ingest uses libx264 (CPU). One-shot.
    const ranMs = Date.now() - startedAt;
    if (shouldRuntimeFallback({ encoder, ranMs, alreadyFellBack: nvencRuntimeFailed })) {
      nvencRuntimeFailed = true;
      nvencSupported = false; // detectNvenc() now returns false without re-probing
      resolved = null;        // force getEncoder() to re-resolve → libx264
      console.warn(
        `[studio] h264_nvenc exited after ${ranMs}ms — it's built into ffmpeg but not usable on ` +
        'this host. Falling back to libx264 (CPU) for the rest of this session.',
      );
    }

    // If the operator is still connected, the ingest died out from under a live session rather than
    // us stopping it. Bounce the socket so the client reconnects and a fresh ingest starts (on
    // libx264 if we just fell back) — otherwise its webm chunks are silently dropped and the
    // broadcast goes dead with no recovery. The client reconnects with backoff and gives up after a
    // few tries, so this can't loop forever; 4003 ≠ the fatal 4000/4001 codes, so it does reconnect.
    if (activeWs) {
      console.warn('[studio] Ingest FFmpeg died while the studio was connected — bouncing the socket to restart ingest');
      try { activeWs.close(4003, 'Ingest restarting'); } catch { /* ignore */ }
    }
  });

  child.on('error', (err) => {
    console.error('[studio] Ingest FFmpeg error:', err);
  });

  return child;
}

function handleConnection(ws: WebSocket): void {
  // Only one studio connection at a time
  if (activeWs) {
    console.log('[studio] Rejecting connection — another studio is already connected');
    ws.close(4000, 'Another studio session is already active');
    return;
  }

  // Don't let Studio and OBS publish to the same RTMP key at once.
  if (isObsConnected()) {
    console.log('[studio] Rejecting connection — OBS is currently publishing');
    ws.close(4001, 'OBS is currently connected. Disconnect OBS before using Web Studio.');
    return;
  }

  // If a previous ingest is still winding down (fast reconnect), hard-stop it now so we
  // never have two FFmpegs publishing to the same RTMP key.
  if (stoppingProc) {
    try { stoppingProc.kill('SIGKILL'); } catch { /* ignore */ }
    stoppingProc = null;
  }

  console.log('[studio] WebSocket connected');
  activeWs = ws;
  studioConnected = true;

  // Start ingest FFmpeg
  ingestFfmpeg = startIngestFfmpeg();

  ws.on('message', (data: Buffer) => {
    // Binary WebSocket messages are webm chunks — pipe directly to FFmpeg stdin
    if (ingestFfmpeg?.stdin?.writable) {
      try {
        ingestFfmpeg.stdin.write(data);
      } catch (err) {
        console.error('[studio] Error writing to FFmpeg stdin:', err);
      }
    }
  });

  ws.on('close', () => {
    console.log('[studio] WebSocket disconnected');
    if (activeWs === ws) {
      activeWs = null;
      stopIngestFfmpeg();
    }
  });

  ws.on('error', (err) => {
    console.error('[studio] WebSocket error:', err);
    if (activeWs === ws) {
      activeWs = null;
      stopIngestFfmpeg();
    }
  });
}

/**
 * Initialize the studio WebSocket server on existing HTTP/HTTPS servers.
 */
export function initStudioWebSocket(...servers: HttpServer[]): void {
  for (const server of servers) {
    // perMessageDeflate off: the ingest payload (webm) is already compressed, and for the
    // bandwidth probe compression would inflate the measured throughput into a fiction.
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

    server.on('upgrade', (request: IncomingMessage, socket, head) => {
      const url = new URL(request.url ?? '', `http://${request.headers.host}`);

      if (url.pathname !== '/ws/studio' && url.pathname !== '/ws/bandwidth') return;

      // Authenticate via query param
      const token = url.searchParams.get('token') ?? '';
      if (config.appSecret && !validateToken(token)) {
        console.log('[studio] WebSocket auth failed');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        if (url.pathname === '/ws/bandwidth') {
          handleBandwidthProbe(ws, { isBusy: () => studioConnected || isObsConnected() });
        } else {
          handleConnection(ws);
        }
      });
    });
  }

  console.log('[studio] WebSocket server initialized on /ws/studio and /ws/bandwidth');

  // Probe + log the ingest encoder and preset now (at startup) so the choice is visible before the
  // first studio connects; the result is cached and reused by every ingest.
  getEncoder();
}

/**
 * Clean up studio resources on shutdown.
 */
export async function shutdownStudio(): Promise<void> {
  if (activeWs) {
    try { activeWs.close(1001, 'Server shutting down'); } catch { /* ignore */ }
    activeWs = null;
  }
  await stopIngestFfmpeg();
}
