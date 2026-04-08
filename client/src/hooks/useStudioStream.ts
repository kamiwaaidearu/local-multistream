import { useRef, useState, useCallback, useEffect } from 'react';

type StudioStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface UseStudioStreamOptions {
  compositeVideoStream: MediaStream | null;
  mixedAudioStream: MediaStream | null;
  timeslice?: number; // ms between chunks, default 1000
}

interface UseStudioStreamResult {
  status: StudioStatus;
  connect: () => void;
  disconnect: () => void;
  error: string | null;
  backpressureWarning: boolean;
}

function getWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/studio`;
}

export function useStudioStream({
  compositeVideoStream,
  mixedAudioStream,
  timeslice = 1000,
}: UseStudioStreamOptions): UseStudioStreamResult {
  const [status, setStatus] = useState<StudioStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [backpressureWarning, setBackpressureWarning] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const backpressureIntervalRef = useRef<number>(0);

  const cleanup = useCallback(() => {
    window.clearInterval(backpressureIntervalRef.current);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop(); } catch { /* ignore */ }
    }
    recorderRef.current = null;
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
    }
    wsRef.current = null;
    setBackpressureWarning(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  const connect = useCallback(() => {
    if (!compositeVideoStream) {
      setError('No video source available');
      return;
    }

    setStatus('connecting');
    setError(null);

    // Combine video and audio tracks into a single MediaStream
    const tracks = [...compositeVideoStream.getVideoTracks()];
    if (mixedAudioStream) {
      tracks.push(...mixedAudioStream.getAudioTracks());
    }
    const combinedStream = new MediaStream(tracks);

    // Open WebSocket
    const token = sessionStorage.getItem('auth_token') ?? '';
    const ws = new WebSocket(`${getWsUrl()}?token=${token}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[studio] WebSocket connected');

      // Start MediaRecorder
      let mimeType = 'video/webm;codecs=vp8,opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'video/webm';
      }

      const recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 4_500_000,
      });
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data);
        }
      };

      recorder.onerror = () => {
        setError('MediaRecorder error');
        setStatus('error');
        cleanup();
      };

      recorder.start(timeslice);
      setStatus('connected');

      // Monitor backpressure
      backpressureIntervalRef.current = window.setInterval(() => {
        if (ws.bufferedAmount > 5 * 1024 * 1024) { // 5MB queued
          setBackpressureWarning(true);
        } else {
          setBackpressureWarning(false);
        }
      }, 2000);
    };

    ws.onerror = () => {
      setError('WebSocket connection failed');
      setStatus('error');
      cleanup();
    };

    ws.onclose = (e) => {
      if (status === 'connected' || status === 'connecting') {
        console.log('[studio] WebSocket closed:', e.code, e.reason);
        if (e.code === 4000) {
          setError(e.reason || 'Another studio session is already active');
        } else if (e.code !== 1000) {
          setError('Connection lost');
        }
        setStatus('disconnected');
        cleanup();
      }
    };
  }, [compositeVideoStream, mixedAudioStream, timeslice, cleanup, status]);

  const disconnect = useCallback(() => {
    cleanup();
    setStatus('disconnected');
    setError(null);
  }, [cleanup]);

  return { status, connect, disconnect, error, backpressureWarning };
}
