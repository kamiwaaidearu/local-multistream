import { useRef, useState, useCallback, useEffect } from 'react';
import { wsUrl } from '../lib/ws';
import { QUALITY_PRESETS, DEFAULT_QUALITY } from '../lib/bandwidthProbe';
import { nextReconnectStep, isFatalCloseCode } from '../lib/studioReconnect';
import { getAuthToken } from '../lib/authToken';
import { api } from '../lib/api';

type StudioStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface UseStudioStreamOptions {
  compositeVideoStream: MediaStream | null;
  mixedAudioStream: MediaStream | null;
  timeslice?: number; // ms between chunks, default 1000
  videoBitsPerSecond?: number; // MediaRecorder video target; defaults to the DEFAULT_QUALITY preset
  // While true, never stop auto-reconnecting (capped backoff) — set by the caller while the
  // broadcast is live server-side so a longer network dip self-heals instead of going terminal.
  keepReconnecting?: boolean;
}

interface UseStudioStreamResult {
  status: StudioStatus;
  connect: () => void;
  disconnect: () => void;
  error: string | null;
  backpressureWarning: boolean;
}

/** Best-effort: a report must never disturb the stream it's describing. */
function reportDrop(message: string, resolved: boolean): void {
  void api.reportStudioAlert({ kind: 'studio_dropped', subject: 'studio', message, resolved })
    .catch(() => { /* telemetry must never disturb a live stream */ });
}

export function useStudioStream({
  compositeVideoStream,
  mixedAudioStream,
  timeslice = 1000,
  videoBitsPerSecond = QUALITY_PRESETS[DEFAULT_QUALITY].videoBps,
  keepReconnecting = false,
}: UseStudioStreamOptions): UseStudioStreamResult {
  const [status, setStatus] = useState<StudioStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [backpressureWarning, setBackpressureWarning] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const backpressureIntervalRef = useRef<number>(0);
  // Last congestion state reported to the server, so we only report transitions rather than every tick.
  const backpressureReportedRef = useRef(false);
  const reconnectTimerRef = useRef<number>(0);
  const reconnectAttemptsRef = useRef<number>(0);
  const shouldReconnectRef = useRef<boolean>(false);
  const fatalRef = useRef<boolean>(false);

  // Keep the latest streams in refs so a reconnect captures the current tracks.
  const videoStreamRef = useRef(compositeVideoStream);
  videoStreamRef.current = compositeVideoStream;
  const audioStreamRef = useRef(mixedAudioStream);
  audioStreamRef.current = mixedAudioStream;

  // Read the latest selected bitrate at connect time. MediaRecorder's bitrate is fixed at
  // construction, so a change only takes effect on the next connect — which is the intended UX:
  // the operator picks quality before going live.
  const videoBitrateRef = useRef(videoBitsPerSecond);
  videoBitrateRef.current = videoBitsPerSecond;

  // Latest "stay live" intent, read at reconnect time so flipping it takes effect immediately.
  const keepReconnectingRef = useRef(keepReconnecting);
  keepReconnectingRef.current = keepReconnecting;

  // Identifies this page to the server, so a reconnect after our own socket dies replaces it at once
  // instead of being rejected as a second tab. New per page load: a reloaded tab has lost its
  // camera/slides and must still go through the deliberate-reopen path.
  const sessionIdRef = useRef(
    typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
  );

  // An unexpected drop in progress: when it started and the attempts since that never connected.
  const dropRef = useRef<{ at: number; failedAttempts: string[] } | null>(null);

  // Breaks the openSocket <-> scheduleReconnect dependency cycle.
  const openSocketRef = useRef<() => void>(() => {});

  // Stop the recorder + backpressure monitor for the current socket (without tearing
  // down reconnection intent).
  const teardownSocket = useCallback(() => {
    window.clearInterval(backpressureIntervalRef.current);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    setBackpressureWarning(false);
  }, []);

  // Full stop: no more reconnects, close everything.
  const cleanup = useCallback(() => {
    shouldReconnectRef.current = false;
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = 0;
    }
    teardownSocket();
    if (wsRef.current) {
      try { wsRef.current.close(1000); } catch { /* ignore */ }
    }
    wsRef.current = null;
  }, [teardownSocket]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  const scheduleReconnect = useCallback(() => {
    if (!shouldReconnectRef.current) return;
    const attempt = reconnectAttemptsRef.current;
    const { giveUp, delayMs } = nextReconnectStep(attempt, keepReconnectingRef.current);
    if (giveUp) {
      shouldReconnectRef.current = false;
      fatalRef.current = true;
      setError('Connection lost — could not reconnect after several attempts');
      setStatus('error');
      return;
    }
    reconnectAttemptsRef.current += 1;
    setStatus('connecting');
    console.log(`[studio] Reconnecting in ${delayMs / 1000}s (attempt ${attempt + 1}${keepReconnectingRef.current ? ', staying live' : ''})`);
    reconnectTimerRef.current = window.setTimeout(() => {
      openSocketRef.current();
    }, delayMs);
  }, []);

  const openSocket = useCallback(() => {
    const video = videoStreamRef.current;
    if (!video) {
      setError('No video source available');
      setStatus('error');
      return;
    }

    setStatus('connecting');

    // Combine the composite video with the mixed audio into a single stream.
    const tracks = [...video.getVideoTracks()];
    const audio = audioStreamRef.current;
    if (audio) tracks.push(...audio.getAudioTracks());
    const combinedStream = new MediaStream(tracks);

    const token = getAuthToken();
    const ws = new WebSocket(
      `${wsUrl('/ws/studio')}?token=${token}&session=${encodeURIComponent(sessionIdRef.current)}`,
    );
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      reconnectAttemptsRef.current = 0; // a successful connect resets the backoff

      let mimeType = 'video/webm;codecs=vp8,opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm';
      }

      const recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: videoBitrateRef.current,
        audioBitsPerSecond: 160_000,
      });
      recorderRef.current = recorder;

      // If MediaRecorder never produces a chunk, nothing downstream can tell you why: the socket looks
      // connected, the ingest FFmpeg blocks on an empty stdin at 0% CPU, and the only symptom is
      // go-live failing 15s later with "no video has started flowing yet". The known cause is an audio
      // track whose graph renders nothing, which makes the WebM muxer block waiting to interleave (see
      // useAudioMixer's silent keepalive). Surface it as a real error instead of hanging silently.
      let producedData = false;
      const stallTimer = window.setTimeout(() => {
        if (producedData) return;
        fatalRef.current = true;
        setError(
          'The browser is not producing any video. Check that the preview below shows a picture, then ' +
          'reconnect. (If you have no camera or microphone added, reconnect once more — the audio ' +
          'engine needs a click to start.)',
        );
        setStatus('error');
        cleanup();
      }, 6000);

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          if (!producedData) {
            producedData = true;
            window.clearTimeout(stallTimer);
            // Recovered from a drop: report only once video is actually flowing again, so a socket
            // that opens and dies at once isn't mistaken for a recovery.
            const drop = dropRef.current;
            if (drop) {
              dropRef.current = null;
              const failed = drop.failedAttempts.length
                ? `; ${drop.failedAttempts.length} attempt(s) never connected (${drop.failedAttempts.join(', ')})`
                : '';
              reportDrop(
                `Studio reconnected after ${((Date.now() - drop.at) / 1000).toFixed(1)}s${failed}.`,
                true,
              );
            }
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
        }
      };

      recorder.onerror = () => {
        window.clearTimeout(stallTimer);
        // A recorder error is local and fatal — don't try to reconnect.
        fatalRef.current = true;
        setError('MediaRecorder error');
        setStatus('error');
        cleanup();
      };

      recorder.start(timeslice);
      setStatus('connected');
      setError(null);

      // Monitor backpressure. A congested uplink means webm is queueing in the browser faster than it
      // can be sent: latency grows, the server-side encoder starves, and every platform's quality
      // suffers. This used to be a banner and nothing more — but the operator is on camera and cannot
      // see it, so state CHANGES are also reported to the server, where they reach the log and the
      // alert webhook. Reported on change only; a 2s poll would otherwise spam both.
      window.clearInterval(backpressureIntervalRef.current);
      backpressureIntervalRef.current = window.setInterval(() => {
        const congested = ws.bufferedAmount > 5 * 1024 * 1024; // 5MB queued
        setBackpressureWarning(congested);
        if (congested === backpressureReportedRef.current) return;
        backpressureReportedRef.current = congested;
        void api.reportStudioAlert({
          kind: 'uplink_congested',
          subject: 'uplink',
          message: congested
            ? `Upload is falling behind — ${Math.round(ws.bufferedAmount / 1024 / 1024)} MB queued in the browser. ` +
              'Video may stutter or lag on every platform.'
            : 'Upload has caught up.',
          resolved: !congested,
        }).catch(() => { /* telemetry must never disturb a live stream */ });
      }, 2000);
    };

    ws.onerror = () => {
      // 'close' always follows 'error' — handle reconnect/cleanup there.
    };

    ws.onclose = (e) => {
      // A late close from a socket we've already replaced must not tear down its successor — e.g.
      // the server's 4004 to our own old socket after a same-page takeover.
      if (wsRef.current && wsRef.current !== ws) return;
      teardownSocket();
      wsRef.current = null;

      // Tell the server what the BROWSER saw. The server only sees its own end of the socket, and
      // on 2026-10-14 that left two drops unexplained. An HTTP report can get through even when the
      // socket can't, as the page's regular polling did throughout those drops.
      if (shouldReconnectRef.current && e.code !== 1000) {
        const what = `code ${e.code}${e.reason ? ` "${e.reason}"` : ''}${e.wasClean ? '' : ', unclean'}`;
        if (opened) {
          if (!dropRef.current) dropRef.current = { at: Date.now(), failedAttempts: [] };
          reportDrop(
            `Studio connection dropped (${what}) — ${Math.round(ws.bufferedAmount / 1024)} KB was still ` +
            'queued in the browser. Reconnecting.',
            false,
          );
        } else if (dropRef.current && dropRef.current.failedAttempts.length < 20) {
          dropRef.current.failedAttempts.push(what);
        }
      }

      // Don't reconnect on codes that mean another owner holds the slot (see isFatalCloseCode).
      // Notably 4000 is retryable while live — it may be our own stale socket, and the next attempt
      // takes it over once the server's staleness window elapses.
      if (isFatalCloseCode(e.code, keepReconnectingRef.current)) {
        shouldReconnectRef.current = false;
        fatalRef.current = true;
        setError(e.reason || 'Studio session was rejected');
        setStatus('error');
        return;
      }

      // Intentional/normal close (user stop, unmount, or a prior fatal error).
      if (e.code === 1000 || !shouldReconnectRef.current) {
        setStatus(fatalRef.current ? 'error' : 'disconnected');
        return;
      }

      // Unexpected drop while we still intend to be live → reconnect with backoff.
      console.log('[studio] Connection dropped, attempting reconnect:', e.code, e.reason);
      scheduleReconnect();
    };
  }, [timeslice, cleanup, teardownSocket, scheduleReconnect]);

  // Expose the latest openSocket to the reconnect scheduler without a dependency cycle.
  useEffect(() => {
    openSocketRef.current = openSocket;
  }, [openSocket]);

  const connect = useCallback(() => {
    // Ignore if a connection is already open or in progress (avoids leaking a socket).
    if (wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (!videoStreamRef.current) {
      setError('No video source available');
      return;
    }
    shouldReconnectRef.current = true;
    fatalRef.current = false;
    reconnectAttemptsRef.current = 0;
    dropRef.current = null;
    setError(null);
    openSocket();
  }, [openSocket]);

  const disconnect = useCallback(() => {
    fatalRef.current = false;
    cleanup();
    setStatus('disconnected');
    setError(null);
  }, [cleanup]);

  return { status, connect, disconnect, error, backpressureWarning };
}
