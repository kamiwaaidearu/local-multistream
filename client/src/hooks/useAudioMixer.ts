import { useRef, useEffect, useState, useCallback } from 'react';

interface UseAudioMixerOptions {
  micStream: MediaStream | null;
  tabAudioStream: MediaStream | null;
}

interface UseAudioMixerResult {
  mixedStream: MediaStream | null;
  micGain: number;
  tabGain: number;
  setMicGain: (value: number) => void;
  setTabGain: (value: number) => void;
  audioLevel: number; // 0-1 RMS level for metering
  resume: () => void; // resume the AudioContext from a user gesture (it may start suspended)
}

export function useAudioMixer({ micStream, tabAudioStream }: UseAudioMixerOptions): UseAudioMixerResult {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const micGainNodeRef = useRef<GainNode | null>(null);
  const tabGainNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const tabSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const levelIntervalRef = useRef<number>(0);

  const [mixedStream, setMixedStream] = useState<MediaStream | null>(null);
  const [micGain, setMicGainState] = useState(1);
  const [tabGain, setTabGainState] = useState(1);
  const [audioLevel, setAudioLevel] = useState(0);

  // Initialize AudioContext and nodes
  useEffect(() => {
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    const destination = ctx.createMediaStreamDestination();
    destinationRef.current = destination;

    const micGainNode = ctx.createGain();
    micGainNodeRef.current = micGainNode;
    micGainNode.connect(destination);

    const tabGainNode = ctx.createGain();
    tabGainNodeRef.current = tabGainNode;
    tabGainNode.connect(destination);

    const analyser = ctx.createAnalyser();
    analyserRef.current = analyser;
    analyser.fftSize = 256;
    micGainNode.connect(analyser);
    tabGainNode.connect(analyser);

    setMixedStream(destination.stream);

    // Level metering
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    levelIntervalRef.current = window.setInterval(() => {
      analyser.getByteTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = (dataArray[i] - 128) / 128;
        sum += normalized * normalized;
      }
      setAudioLevel(Math.sqrt(sum / dataArray.length));
    }, 100);

    return () => {
      window.clearInterval(levelIntervalRef.current);
      ctx.close();
      audioCtxRef.current = null;
      setMixedStream(null);
    };
  }, []);

  // Connect/disconnect mic source
  useEffect(() => {
    const ctx = audioCtxRef.current;
    const gainNode = micGainNodeRef.current;
    if (!ctx || !gainNode) return;

    // Disconnect previous
    if (micSourceRef.current) {
      try { micSourceRef.current.disconnect(); } catch { /* ignore */ }
      micSourceRef.current = null;
    }

    if (micStream && micStream.getAudioTracks().length > 0) {
      const source = ctx.createMediaStreamSource(micStream);
      source.connect(gainNode);
      micSourceRef.current = source;
      // A context created without a user gesture starts suspended → silent output.
      void ctx.resume().catch(() => {});
    }
  }, [micStream]);

  // Connect/disconnect tab audio source
  useEffect(() => {
    const ctx = audioCtxRef.current;
    const gainNode = tabGainNodeRef.current;
    if (!ctx || !gainNode) return;

    if (tabSourceRef.current) {
      try { tabSourceRef.current.disconnect(); } catch { /* ignore */ }
      tabSourceRef.current = null;
    }

    if (tabAudioStream && tabAudioStream.getAudioTracks().length > 0) {
      const source = ctx.createMediaStreamSource(tabAudioStream);
      source.connect(gainNode);
      tabSourceRef.current = source;
      void ctx.resume().catch(() => {});
    }
  }, [tabAudioStream]);

  const setMicGain = useCallback((value: number) => {
    setMicGainState(value);
    if (micGainNodeRef.current) {
      micGainNodeRef.current.gain.value = value;
    }
  }, []);

  const setTabGain = useCallback((value: number) => {
    setTabGainState(value);
    if (tabGainNodeRef.current) {
      tabGainNodeRef.current.gain.value = value;
    }
  }, []);

  const resume = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
  }, []);

  return { mixedStream, micGain, tabGain, setMicGain, setTabGain, audioLevel, resume };
}
