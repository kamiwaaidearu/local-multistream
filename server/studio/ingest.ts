import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn, ChildProcess } from 'child_process';
import { config } from '../config.js';
import { validateToken } from './auth.js';
import { isObsConnected } from '../rtmp/server.js';

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

function startIngestFfmpeg(): ChildProcess {
  const rtmpUrl = `rtmp://127.0.0.1:${config.rtmpPort}/live/${config.localStreamKey}`;

  const vb = `${config.studioVideoBitrateKbps}k`;
  const args = [
    '-f', 'webm',
    '-analyzeduration', '1000000',
    '-probesize', '1000000',
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    // Constant bitrate so the encoder actually spends the budget (sharp image) rather than
    // undershooting on low-motion slides. Dropped -tune zerolatency — it disabled b-frames
    // and lookahead, which hurt quality; a second or two of extra latency is fine for a
    // one-way broadcast.
    '-b:v', vb, '-minrate', vb, '-maxrate', vb, '-bufsize', `${config.studioVideoBitrateKbps * 2}k`,
    '-g', '120',
    '-c:a', 'aac',
    '-b:a', `${config.studioAudioBitrateKbps}k`,
    '-ar', '48000',
    '-f', 'flv',
    rtmpUrl,
  ];

  console.log(`[studio] Starting ingest FFmpeg → ${rtmpUrl}`);
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
    if (ingestFfmpeg === child) {
      ingestFfmpeg = null;
      studioConnected = false;
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
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request: IncomingMessage, socket, head) => {
      const url = new URL(request.url ?? '', `http://${request.headers.host}`);

      if (url.pathname !== '/ws/studio') return;

      // Authenticate via query param
      const token = url.searchParams.get('token') ?? '';
      if (config.appSecret && !validateToken(token)) {
        console.log('[studio] WebSocket auth failed');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        handleConnection(ws);
      });
    });
  }

  console.log('[studio] WebSocket server initialized on /ws/studio');
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
