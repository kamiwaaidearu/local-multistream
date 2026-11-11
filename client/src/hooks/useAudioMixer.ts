import { useRef, useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

export type AudioSourceKind = 'microphone' | 'desktop' | 'slides';

export interface AudioSource {
  id: string;
  label: string;
  kind: AudioSourceKind;
  /** For microphones, the input device id — lets the UI avoid offering a device that's already added. */
  deviceId?: string;
  gain: number; // user-set level, 0..2
  muted: boolean;
  /** The live capture stream, exposed so the UI can watch its tracks for silence (see useTrackWatch).
   *  A track that ENDS is auto-removed below; a track that goes `muted` stays and needs watching. */
  stream: MediaStream;
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
  /**
   * RMS of the summed mix (float samples, so it resolves down to true digital silence), refreshed with
   * `levels`. This is what goes to air, after per-source gain and mute — the signal the audio test and
   * the live silence watch judge.
   */
  mixLevel: number;
  addSource: (input: AddAudioSourceInput) => string | null;
  removeSource: (id: string) => void;
  setGain: (id: string, value: number) => void;
  setMuted: (id: string, muted: boolean) => void;
  /** Resume the AudioContext from a user gesture (it may start suspended → silent). */
  resume: () => void;
  /**
   * Resume the context and report whether it is actually running.
   *
   * Belt-and-braces before recording: a suspended context renders nothing, and MediaRecorder is always
   * handed the mix bus track, so it would stall. NOTE this is not what caused the canvas-only stream to
   * produce zero chunks — the context was already `running` in that case; the destination simply had no
   * inputs. See the silent keepalive in the setup effect for that. Both are needed: one guarantees the
   * graph is running, the other guarantees it has something to render.
   */
  ensureRunning: () => Promise<boolean>;
}

/**
 * OBS-style audio mixer. Any number of independent sources — microphones, desktop
 * audio, slide/tab audio — each with its own volume, mute, and level meter, all summed
 * into one output track for the encoder. The set of sources is fully dynamic; nothing
 * here is tied to the camera or the screen share.
 */
export function useAudioMixer(): UseAudioMixerResult {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<Map<string, InternalNode>>(new Map());
  const busRef = useRef<GainNode | null>(null);
  const levelIntervalRef = useRef<number>(0);

  const [mixedStream, setMixedStream] = useState<MediaStream | null>(null);
  const [sources, setSources] = useState<AudioSource[]>([]);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [mixLevel, setMixLevel] = useState(0);

  // Create the context + mix bus once. Every source fans into this one destination.
  useEffect(() => {
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    const destination = ctx.createMediaStreamDestination();

    // Every source sums into this bus, which feeds both the encoder (destination) and a mix meter.
    // A MediaStreamAudioDestinationNode has no output to tap, so the bus is the only place the on-air
    // signal can be measured.
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(destination);
    const mixAnalyser = ctx.createAnalyser();
    mixAnalyser.fftSize = 2048;
    bus.connect(mixAnalyser);
    busRef.current = bus;
    const mixData = new Float32Array(mixAnalyser.fftSize);

    // Keep the mix bus producing samples even with ZERO sources connected.
    //
    // A MediaStreamAudioDestinationNode with no inputs emits no samples at all — not even silence. Its
    // track exists and reports live/unmuted, but Chrome's WebM muxer then blocks forever waiting to
    // interleave audio with video, so MediaRecorder produces NO chunks whatsoever. The whole broadcast
    // silently sends nothing, and the only symptom is go-live failing 15s later complaining about video.
    //
    // Verified in the browser on the real canvas, same context and video track, only this differing:
    //   destination with no inputs        → 0 chunks
    //   destination + this silent source  → 2 chunks / 16 KB in 2.5s
    //
    // A ConstantSourceNode at offset 0 is true silence but an ACTIVE input, so the destination always
    // renders. This also protects the live case: removing the last microphone mid-broadcast would
    // otherwise leave the bus input-less and stall the entire stream, not merely mute it.
    const keepalive = ctx.createConstantSource();
    keepalive.offset.value = 0;
    keepalive.connect(bus);
    keepalive.start();

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

      mixAnalyser.getFloatTimeDomainData(mixData);
      let mixSum = 0;
      for (let i = 0; i < mixData.length; i++) mixSum += mixData[i] * mixData[i];
      setMixLevel(Math.sqrt(mixSum / mixData.length));
    }, 100);

    return () => {
      window.clearInterval(levelIntervalRef.current);
      try { keepalive.stop(); } catch { /* ignore */ }
      try { keepalive.disconnect(); } catch { /* ignore */ }
      nodesRef.current.forEach((node) => {
        try { node.sourceNode.disconnect(); } catch { /* ignore */ }
        try { node.gainNode.disconnect(); } catch { /* ignore */ }
        try { node.analyser.disconnect(); } catch { /* ignore */ }
        node.stream.getTracks().forEach((t) => t.stop());
      });
      nodesRef.current.clear();
      try { bus.disconnect(); } catch { /* ignore */ }
      try { mixAnalyser.disconnect(); } catch { /* ignore */ }
      busRef.current = null;
      void ctx.close().catch(() => {});
      audioCtxRef.current = null;
      setMixedStream(null);
    };
  }, []);

  const resume = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  }, []);

  // See UseAudioMixerResult.ensureRunning. Awaited before recording so the mix bus is genuinely
  // producing samples — a suspended context silently stalls MediaRecorder entirely.
  const ensureRunning = useCallback(async (): Promise<boolean> => {
    const ctx = audioCtxRef.current;
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    return ctx.state === 'running';
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
    const bus = busRef.current;
    if (!ctx || !bus) return null;
    if (input.stream.getAudioTracks().length === 0) return null;

    const id = crypto.randomUUID();
    const sourceNode = ctx.createMediaStreamSource(input.stream);
    const gainNode = ctx.createGain();
    gainNode.gain.value = 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    sourceNode.connect(gainNode);
    gainNode.connect(bus);
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
    //
    // Removing it silently was a real hazard: mid-broadcast, a mic dying just made the audio stop with
    // no trace anywhere — the source vanished from the UI, the encoder kept producing a full-bitrate
    // stream, and every platform reported perfect health. For a prayer broadcast that's the worst
    // failure there is, so tell the server (and thus the alert webhook) on the way out.
    input.stream.getAudioTracks().forEach((t) => {
      t.addEventListener('ended', () => {
        void api.reportStudioAlert({
          kind: 'track_ended',
          subject: input.label,
          message: `Audio source "${input.label}" ended (device disconnected or stopped) and has been ` +
            'removed from the mix. If this was the only microphone, the broadcast now has NO AUDIO.',
        }).catch(() => { /* never disturb a live stream */ });
        removeSource(id);
      });
    });

    setSources((prev) => [
      ...prev,
      { id, label: input.label, kind: input.kind, deviceId: input.deviceId, gain: 1, muted: false, stream: input.stream },
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

  return { mixedStream, sources, levels, mixLevel, addSource, removeSource, setGain, setMuted, resume, ensureRunning };
}
