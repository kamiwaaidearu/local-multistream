import { WebSocket } from 'ws';

export interface BandwidthProbeOptions {
  /** Refuse the probe when a stream is live, so it can't steal the operator's uplink. */
  isBusy?: () => boolean;
  /** Hard cap on bytes accepted before the socket is closed — bounds a misbehaving client. */
  maxBytes?: number;
}

/**
 * Upload-bandwidth probe handler. The client streams incompressible random bytes over this socket
 * for a few seconds; we count what actually arrives and echo the running byte total back ~5x/sec.
 * The client divides server-confirmed bytes by elapsed wall-clock time to get true end-to-end
 * upload throughput (operator -> Cloudflare edge -> tunnel -> here) — the one leg that limits Web
 * Studio ingest. Deliberately separate from /ws/studio so a probe never touches the live ingest
 * FFmpeg or the single-session lock. Bytes are counted and discarded — never buffered.
 */
export function handleBandwidthProbe(ws: WebSocket, opts: BandwidthProbeOptions = {}): void {
  const isBusy = opts.isBusy ?? (() => false);
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;

  // Never run a probe while a stream is live — it would flood the operator's constrained uplink
  // and degrade the broadcast. The UI also hides the button, but this is the authoritative guard.
  if (isBusy()) {
    try { ws.close(4002, 'A stream is live — run the bandwidth test before going live'); } catch { /* ignore */ }
    return;
  }

  let bytes = 0;

  const ackTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ bytes })); } catch { /* ignore */ }
    }
  }, 200);

  // Safety cap: a probe is a few seconds. Never let one run forever.
  const maxTimer = setTimeout(() => {
    try { ws.close(1000, 'probe complete'); } catch { /* ignore */ }
  }, 15000);

  const cleanup = () => {
    clearInterval(ackTimer);
    clearTimeout(maxTimer);
  };

  ws.on('message', (data: Buffer) => {
    bytes += data.length;
    // Don't rely on the client to bound its own upload — close once the cap is reached.
    if (bytes >= maxBytes) {
      try { ws.close(1000, 'probe size limit reached'); } catch { /* ignore */ }
    }
  });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}
