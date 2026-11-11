import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Group, Progress, Stack, Text } from '@mantine/core';
import type { AudioSource } from '../hooks/useAudioMixer';
import { api } from '../lib/api';
import {
  evaluateAudioCheck,
  isAudioStillConfirmed,
  sourcesHeard,
  TEST_DURATION_MS,
  type AudioCheckResult,
} from '../lib/audioCheck';

const SAMPLE_MS = 100;

type Phase = 'idle' | 'recording' | 'review';

interface AudioTestCardProps {
  /** The mix bus — exactly what the encoder sends. The test records this, not a raw device. */
  mixedStream: MediaStream | null;
  /** Live RMS of the mix bus. */
  mixLevel: number;
  /** Per-source RMS, keyed by source id — decides which sources the test actually heard. */
  levels: Record<string, number>;
  sources: AudioSource[];
  ensureRunning: () => Promise<boolean>;
  /** Lifted so the parent can hold Go Live until a presenter has heard themselves. */
  onConfirmedChange: (confirmed: boolean) => void;
  /**
   * The broadcast is on air. The test plays the recording back through the speakers, which a live
   * microphone would pick up and send to viewers, so it is not offered once live.
   */
  streamIsLive: boolean;
}

function pickMimeType(): string | undefined {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

/**
 * "Test audio": record five seconds of the on-air mix, measure it, play it back, and have the presenter
 * confirm they heard themselves. Go-live waits on that confirmation (see StreamPage).
 *
 * Both halves matter. The level measurement catches the silent case outright — no mic added, the wrong
 * device, a hardware mute. The playback catches what a meter cannot: a webcam mic across the room, a
 * loopback device picked by mistake, distortion. A failed measurement does not lock the presenter out —
 * they can still listen and confirm deliberately — because a false negative an hour before a scheduled
 * broadcast would be its own outage.
 */
export function AudioTestCard({ mixedStream, mixLevel, levels: sourceLevels, sources, ensureRunning, onConfirmedChange, streamIsLive }: AudioTestCardProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<AudioCheckResult | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [testedIds, setTestedIds] = useState<Set<string>>(new Set());
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());

  const mixLevelRef = useRef(mixLevel);
  mixLevelRef.current = mixLevel;
  const sourceLevelsRef = useRef(sourceLevels);
  sourceLevelsRef.current = sourceLevels;
  const cancelRef = useRef<(() => void) | null>(null);

  const confirmed = isAudioStillConfirmed(confirmedIds, sources);
  useEffect(() => { onConfirmedChange(confirmed); }, [confirmed, onConfirmedChange]);

  // Release the recording's blob URL when replaced or on unmount, and stop an in-flight test.
  useEffect(() => () => { if (playbackUrl) URL.revokeObjectURL(playbackUrl); }, [playbackUrl]);
  useEffect(() => () => cancelRef.current?.(), []);

  const audible = sources.filter((s) => !s.muted && s.gain > 0);

  const runTest = useCallback(async () => {
    const track = mixedStream?.getAudioTracks()[0];
    if (!track) return;
    await ensureRunning();

    const ids = audible.map((s) => s.id);
    const perSource = new Map<string, number[]>(ids.map((id) => [id, []]));
    setTestedIds(new Set(ids));
    setResult(null);
    setPlaybackUrl(null);
    setElapsedMs(0);
    setPhase('recording');

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(new MediaStream([track]), mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const levels: number[] = [];
    const started = performance.now();
    const sampler = window.setInterval(() => {
      levels.push(mixLevelRef.current);
      for (const [id, arr] of perSource) arr.push(sourceLevelsRef.current[id] ?? 0);
      setElapsedMs(performance.now() - started);
    }, SAMPLE_MS);

    let cancelled = false;
    const finish = window.setTimeout(() => recorder.stop(), TEST_DURATION_MS);
    cancelRef.current = () => {
      cancelled = true;
      window.clearInterval(sampler);
      window.clearTimeout(finish);
      if (recorder.state !== 'inactive') recorder.stop();
    };

    recorder.onstop = () => {
      window.clearInterval(sampler);
      cancelRef.current = null;
      if (cancelled) return;
      const evaluated = evaluateAudioCheck(levels, SAMPLE_MS);
      setResult(evaluated);
      setTestedIds(sourcesHeard(perSource, SAMPLE_MS));
      setPlaybackUrl(chunks.length ? URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType })) : null);
      setPhase('review');
      void api.reportStudioAudioCheck({
        outcome: evaluated.heard ? 'heard' : 'silent',
        peak: evaluated.peak,
        soundMs: evaluated.soundMs,
        sources: audible.map((s) => s.label),
      }).catch(() => { /* telemetry must never block the presenter */ });
    };

    recorder.start();
  }, [mixedStream, ensureRunning, audible]);

  const confirm = useCallback((override: boolean) => {
    // Only the sources the test heard (see sourcesHeard) count as confirmed.
    setConfirmedIds(new Set(testedIds));
    setPhase('idle');
    void api.reportStudioAudioCheck({
      outcome: override ? 'confirmed_override' : 'confirmed',
      peak: result?.peak ?? 0,
      soundMs: result?.soundMs ?? 0,
      sources: sources.filter((s) => testedIds.has(s.id)).map((s) => s.label),
    }).catch(() => {});
  }, [testedIds, result, sources]);

  const testedLabels = sources.filter((s) => testedIds.has(s.id)).map((s) => s.label).join(', ');

  return (
    <Stack gap={6} mt={4}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm" fw={500}>Audio check</Text>
        <Badge size="sm" variant="light" color={confirmed ? 'green' : 'orange'}>
          {confirmed ? 'Confirmed' : 'Not tested'}
        </Badge>
      </Group>

      {phase === 'idle' && !confirmed && !streamIsLive && (
        <Text size="xs" c="dimmed">
          {audible.length === 0
            ? 'Add your microphone above, then test it. You can’t go live until your audio is confirmed.'
            : 'Click Test audio and say a few words. We’ll play it back so you can hear exactly what viewers will hear.'}
        </Text>
      )}

      {phase === 'idle' && confirmed && (
        <Text size="xs" c="dimmed">Viewers will hear you. Changing or muting the tested microphone resets this.</Text>
      )}

      {phase === 'recording' && (
        <Stack gap={4}>
          <Text size="xs" fw={600}>Say a few words now — “Hail Mary, full of grace…”</Text>
          <Progress value={(elapsedMs / TEST_DURATION_MS) * 100} size="xs" color="gray" />
          <Progress value={Math.min(100, mixLevel * 400)} size="sm" color={mixLevel > 0.016 ? 'green' : 'gray'} />
        </Stack>
      )}

      {phase === 'review' && result && (
        <Stack gap={6}>
          {result.heard ? (
            <Alert color="green" variant="light" p="xs">
              <Text size="xs">We heard you. Listen back — is it clear and at a normal volume?</Text>
            </Alert>
          ) : (
            <Alert color="red" variant="light" p="xs" title="We didn’t hear anything">
              <Text size="xs">
                Nothing came through from {testedLabels || 'your audio sources'}. Check that the right
                microphone is selected, that it isn’t muted (on the device or in Windows), and that no
                other app (Zoom, Teams) is using it. Then try again.
              </Text>
            </Alert>
          )}
          {playbackUrl && <audio src={playbackUrl} controls autoPlay style={{ width: '100%', height: 32 }} />}
          <Group gap="xs">
            {result.heard ? (
              <>
                <Button size="xs" color="green" onClick={() => confirm(false)}>Sounds good</Button>
                <Button size="xs" variant="light" onClick={() => void runTest()}>Try again</Button>
              </>
            ) : (
              <>
                <Button size="xs" onClick={() => void runTest()}>Try again</Button>
                <Button size="xs" variant="subtle" color="gray" onClick={() => confirm(true)}>
                  I heard myself clearly — use it anyway
                </Button>
              </>
            )}
          </Group>
        </Stack>
      )}

      {phase === 'idle' && !streamIsLive && (
        <Group gap="xs">
          <Button
            size="xs"
            variant={confirmed ? 'light' : 'filled'}
            color={confirmed ? 'gray' : 'orange'}
            disabled={audible.length === 0 || !mixedStream}
            onClick={() => void runTest()}
          >
            {confirmed ? 'Test again' : 'Test audio'}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
