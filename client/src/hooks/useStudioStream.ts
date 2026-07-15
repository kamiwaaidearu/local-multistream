import { useRef, useState, useCallback, useEffect } from 'react';
import { wsUrl } from '../lib/ws';
import { QUALITY_PRESETS, DEFAULT_QUALITY } from '../lib/bandwidthProbe';
import { nextReconnectStep } from '../lib/studioReconnect';
import { getAuthToken } from '../lib/authToken';

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
    const ws = new WebSocket(`${wsUrl('/ws/studio')}?token=${token}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
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

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      recorder.onerror = () => {
        // A recorder error is local and fatal — don't try to reconnect.
        fatalRef.current = true;
        setError('MediaRecorder error');
        setStatus('error');
        cleanup();
      };

      recorder.start(timeslice);
      setStatus('connected');
      setError(null);

      // Monitor backpressure
      window.clearInterval(backpressureIntervalRef.current);
      backpressureIntervalRef.current = window.setInterval(() => {
        setBackpressureWarning(ws.bufferedAmount > 5 * 1024 * 1024); // 5MB queued
      }, 2000);
    };

    ws.onerror = () => {
      // 'close' always follows 'error' — handle reconnect/cleanup there.
    };

    ws.onclose = (e) => {
      teardownSocket();
      wsRef.current = null;

      // Fatal: another studio session is active (4000) or took over this one (4004), or OBS is
      // publishing (4001). Don't reconnect — retrying would just fight the other session.
      if (e.code === 4000 || e.code === 4001 || e.code === 4004) {
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
