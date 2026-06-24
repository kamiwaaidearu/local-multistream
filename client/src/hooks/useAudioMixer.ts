import { useRef, useEffect, useState, useCallback } from 'react';

export type AudioSourceKind = 'microphone' | 'desktop' | 'slides';

export interface AudioSource {
  id: string;
  label: string;
  kind: AudioSourceKind;
  /** For microphones, the input device id — lets the UI avoid offering a device that's already added. */
  deviceId?: string;
  gain: number; // user-set level, 0..2
  muted: boolean;
}

export interface AddAudioSourceInput {
  stream: MediaStream;
  label: string;
  kind: AudioSourceKind;
  deviceId?: string;
}

interface InternalNode {
  stream: MediaStream;
  sourceNode: MediaStreamAudioSourceNode;
  gainNode: GainNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
  gain: number;
  muted: boolean;
}

interface UseAudioMixerResult {
  /** Single mixed audio track (sum of every source) — stable for the life of the hook. */
  mixedStream: MediaStream | null;
  sources: AudioSource[];
  /** Per-source RMS levels (0..1), keyed by source id, refreshed ~10×/s for metering. */
  levels: Record<string, number>;
  addSource: (input: AddAudioSourceInput) => string | null;
  removeSource: (id: string) => void;
  setGain: (id: string, value: number) => void;
  setMuted: (id: string, muted: boolean) => void;
  /** Resume the AudioContext from a user gesture (it may start suspended → silent). */
  resume: () => void;
}

/**
 * OBS-style audio mixer. Any number of independent sources — microphones, desktop
 * audio, slide/tab audio — each with its own volume, mute, and level meter, all summed
 * into one output track for the encoder. The set of sources is fully dynamic; nothing
 * here is tied to the camera or the screen share.
 */
export function useAudioMixer(): UseAudioMixerResult {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const nodesRef = useRef<Map<string, InternalNode>>(new Map());
  const levelIntervalRef = useRef<number>(0);

  const [mixedStream, setMixedStream] = useState<MediaStream | null>(null);
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [levels, setLevels] = useState<Record<string, number>>({});

  // Create the context + mix bus once. Every source fans into this one destination.
  useEffect(() => {
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    const destination = ctx.createMediaStreamDestination();
    destinationRef.current = destination;
    setMixedStream(destination.stream);

    // Per-source metering: read each source's analyser and publish an RMS level.
    levelIntervalRef.current = window.setInterval(() => {
      const next: Record<string, number> = {};
      nodesRef.current.forEach((node, id) => {
        node.analyser.getByteTimeDomainData(node.data);
        let sum = 0;
        for (let i = 0; i < node.data.length; i++) {
          const normalized = (node.data[i] - 128) / 128;
          sum += normalized * normalized;
        }
        next[id] = Math.sqrt(sum / node.data.length);
      });
      setLevels(next);
    }, 100);

    return () => {
      window.clearInterval(levelIntervalRef.current);
      nodesRef.current.forEach((node) => {
        try { node.sourceNode.disconnect(); } catch { /* ignore */ }
        try { node.gainNode.disconnect(); } catch { /* ignore */ }
        try { node.analyser.disconnect(); } catch { /* ignore */ }
        node.stream.getTracks().forEach((t) => t.stop());
      });
      nodesRef.current.clear();
      void ctx.close().catch(() => {});
      audioCtxRef.current = null;
      destinationRef.current = null;
      setMixedStream(null);
    };
  }, []);

  const resume = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  }, []);

  const removeSource = useCallback((id: string) => {
    const node = nodesRef.current.get(id);
    if (!node) return;
    try { node.sourceNode.disconnect(); } catch { /* ignore */ }
    try { node.gainNode.disconnect(); } catch { /* ignore */ }
    try { node.analyser.disconnect(); } catch { /* ignore */ }
    node.stream.getTracks().forEach((t) => t.stop());
    nodesRef.current.delete(id);
    setSources((prev) => prev.filter((s) => s.id !== id));
    setLevels((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const addSource = useCallback((input: AddAudioSourceInput): string | null => {
    const ctx = audioCtxRef.current;
    const destination = destinationRef.current;
    if (!ctx || !destination) return null;
    if (input.stream.getAudioTracks().length === 0) return null;

    const id = crypto.randomUUID();
    const sourceNode = ctx.createMediaStreamSource(input.stream);
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    sourceNode.connect(gainNode);
    gainNode.connect(destination);
    gainNode.connect(analyser);

    nodesRef.current.set(id, {
      stream: input.stream,
      sourceNode,
      gainNode,
      analyser,
      data: new Uint8Array(analyser.frequencyBinCount),
      gain: 1,
      muted: false,
    });

    // Auto-remove if the track ends on its own: a device unplugged, or the operator
    // clicking the browser's "Stop sharing" bar on a desktop/tab capture.
    input.stream.getAudioTracks().forEach((t) => {
      t.addEventListener('ended', () => removeSource(id));
    });

    setSources((prev) => [
      ...prev,
      { id, label: input.label, kind: input.kind, deviceId: input.deviceId, gain: 1, muted: false },
    ]);

    // The add button is a user gesture — safe to (re)start a suspended context here.
    void ctx.resume().catch(() => {});
    return id;
  }, [removeSource]);

  const setGain = useCallback((id: string, value: number) => {
    const node = nodesRef.current.get(id);
    if (node) {
      node.gain = value;
      node.gainNode.gain.value = node.muted ? 0 : value;
    }
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, gain: value } : s)));
  }, []);

  const setMuted = useCallback((id: string, muted: boolean) => {
    const node = nodesRef.current.get(id);
    if (node) {
      node.muted = muted;
      node.gainNode.gain.value = muted ? 0 : node.gain;
    }
    setSources((prev) => prev.map((s) => (s.id === id ? { ...s, muted } : s)));
  }, []);

  return { mixedStream, sources, levels, addSource, removeSource, setGain, setMuted, resume };
}
