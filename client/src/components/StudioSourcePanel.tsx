import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Stack,
  Group,
  Card,
  Button,
  Select,
  Badge,
  Text,
  Progress,
  Alert,
  Slider,
  Collapse,
  ThemeIcon,
  Box,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCanvasCompositor, type GridTemplate } from '../hooks/useCanvasCompositor';
import { useSegmentedStream } from '../hooks/useSegmentedStream';
import { useAudioMixer, type AudioSourceKind } from '../hooks/useAudioMixer';
import { useTrackWatch } from '../hooks/useTrackWatch';
import { useStudioStream } from '../hooks/useStudioStream';
import { measureUploadMbps, MIN_VIABLE_MBPS, QUALITY_PRESETS, recommendQuality, DEFAULT_QUALITY, type QualityKey } from '../lib/bandwidthProbe';
import { FALLBACK_TEMPLATE } from '../lib/gridTemplate';
import { TemplateEditor } from './TemplateEditor';
import { AudioTestCard } from './AudioTestCard';
import { createSilenceTracker, LIVE_SILENCE_ALERT_MS } from '../lib/audioCheck';
import { describeVideoState, isVideoReady, LIVE_VIDEO_ALERT_MS } from '../lib/videoCheck';
import { api } from '../lib/api';

type StudioStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

const KIND_META: Record<AudioSourceKind, { label: string; color: string }> = {
  microphone: { label: 'Mic', color: 'blue' },
  desktop: { label: 'Desktop', color: 'grape' },
  slides: { label: 'Slides', color: 'teal' },
};

interface StudioSourcePanelProps {
  onStatusChange: (status: StudioStatus) => void;
  onConnectRef?: React.MutableRefObject<(() => void) | null>;
  onDisconnectRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * When true, run the bandwidth test once on mount to pre-select a stream quality the operator's
   * connection can sustain. The parent passes this only while the stream is "ready" — never while
   * live, because the probe saturates the uplink for several seconds and would disrupt a broadcast.
   */
  autoTestConnection?: boolean;
  /**
   * The BROADCAST is live server-side (distinct from the studio socket merely being connected).
   *
   * Drives two things: the transport never stops auto-reconnecting, so a longer network dip self-heals
   * instead of going terminal; and the quality-lock wording, which has to differ because ending a live
   * broadcast is irreversible whereas disconnecting an idle studio is not.
   */
  streamIsLive?: boolean;
  /** Whether the presenter has passed the audio test with a source that is still in the mix. */
  onAudioConfirmedChange?: (confirmed: boolean) => void;
  /** Whether both the camera and the slides are showing a real picture in the layout. */
  onVideoReadyChange?: (ready: boolean) => void;
}

export function StudioSourcePanel({ onStatusChange, onConnectRef, onDisconnectRef, autoTestConnection, streamIsLive, onAudioConfirmedChange, onVideoReadyChange }: StudioSourcePanelProps) {
  const [template, setTemplate] = useState<GridTemplate>(FALLBACK_TEMPLATE);
  const [savedTemplate, setSavedTemplate] = useState<GridTemplate>(FALLBACK_TEMPLATE);

  // Media sources
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [webcamDevices, setWebcamDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null);
  const [webcamEnabled, setWebcamEnabled] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(false);
  const [blurBackground, setBlurBackground] = useState(false);

  // Advanced sections (hidden by default to keep the operator view simple)
  const [showLayout, setShowLayout] = useState(false);

  // Stream quality (Leg-1 / browser encode bitrate). Defaults to Low (see DEFAULT_QUALITY) so a
  // slow/unmeasured connection never over-commits; the bandwidth test — run automatically on
  // arrival, or again via "Test my connection" — then measures the operator's upload and raises
  // this to whatever preset their link can actually sustain.
  const [quality, setQuality] = useState<QualityKey>(DEFAULT_QUALITY);
  const [probing, setProbing] = useState(false);
  // True when the last bandwidth probe failed. Surfaced in the UI: a silently-failed probe leaves the
  // quality at its Low default with nothing on screen to say why, which is exactly the trap that
  // makes a broadcast quietly go out at 2.5 Mbps.
  const [probeFailed, setProbeFailed] = useState(false);
  const [probeMbps, setProbeMbps] = useState<number | null>(null);
  const [recommendedQuality, setRecommendedQuality] = useState<QualityKey | null>(null);

  // Load template
  useEffect(() => {
    api.getTemplate()
      .then((t) => {
        const tpl = t.config_json as unknown as GridTemplate;
        setTemplate(tpl);
        setSavedTemplate(tpl);
      })
      .catch(() => {
        setTemplate(FALLBACK_TEMPLATE);
        setSavedTemplate(FALLBACK_TEMPLATE);
      });
  }, []);

  // Enumerate camera and microphone devices
  useEffect(() => {
    navigator.mediaDevices.enumerateDevices()
      .then((devices) => {
        const video = devices.filter((d) => d.kind === 'videoinput');
        const audio = devices.filter((d) => d.kind === 'audioinput');
        setWebcamDevices(video);
        setMicDevices(audio);
        if (video.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(video[0].deviceId);
        }
        if (audio.length > 0 && !selectedMicId) {
          setSelectedMicId(audio[0].deviceId);
        }
      })
      .catch(() => {});
  }, [selectedDeviceId, selectedMicId]);

  // Keep refs to the live video streams so the unmount cleanup stops the CURRENT tracks. A bare
  // `[]` effect closes over the initial nulls and would stop nothing — leaving the camera and
  // screen share running after the stream ends. (Audio source tracks are owned/stopped by the mixer.)
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  webcamStreamRef.current = webcamStream;
  screenStreamRef.current = screenStream;

  // Stop camera + screen-share video when the panel unmounts — which happens when the stream
  // ends or you leave the page.
  useEffect(() => {
    return () => {
      webcamStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Camera is video-only now (audio is handled entirely by the mixer).
  const webcamVideoStream = useMemo(
    () => webcamStream ? new MediaStream(webcamStream.getVideoTracks()) : null,
    [webcamStream],
  );

  // Optional background blur (MediaPipe Selfie Segmentation, client-side). When off, this is a
  // passthrough with no overhead; when on, it swaps in a blurred-background version of the camera.
  const { outputStream: cameraStream, status: blurStatus } = useSegmentedStream({
    sourceStream: webcamVideoStream,
    enabled: blurBackground,
    blurAmount: 18, // med-high, fixed (no user control for now)
  });

  // Compositor draws whatever camera stream we hand it — raw or blurred.
  const { canvasRef, compositeStream, videoStates } = useCanvasCompositor({
    template,
    webcamStream: cameraStream,
    screenStream,
  });

  const videoReady = isVideoReady(videoStates);
  useEffect(() => { onVideoReadyChange?.(videoReady); }, [videoReady, onVideoReadyChange]);
  const videoProblems = [
    describeVideoState('Your slides', videoStates.slides),
    describeVideoState('Your camera', videoStates.camera),
    videoStates.slides === 'off' ? 'Share your slides (step 1).' : null,
    videoStates.camera === 'off' ? 'Turn on your camera (step 2).' : null,
  ].filter((m): m is string => m !== null);

  // Audio mixer — N independent sources (mics, desktop audio, slide audio), each with its own
  // volume / mute / meter, summed into one track for the encoder.
  const { mixedStream, sources, levels, mixLevel, addSource, removeSource, setGain, setMuted, resume, ensureRunning } = useAudioMixer();

  const [audioConfirmed, setAudioConfirmed] = useState(false);
  const handleAudioConfirmed = useCallback((ok: boolean) => {
    setAudioConfirmed(ok);
    onAudioConfirmedChange?.(ok);
  }, [onAudioConfirmedChange]);

  // Track the slide-audio source so we can drop it from the mix when the screen share stops.
  const slideSourceIdRef = useRef<string | null>(null);


  // Start/stop camera (video only)
  const toggleWebcam = useCallback(async () => {
    if (webcamEnabled && webcamStream) {
      webcamStream.getTracks().forEach((t) => t.stop());
      setWebcamStream(null);
      setWebcamEnabled(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true,
      });
      setWebcamStream(stream);
      setWebcamEnabled(true);
    } catch (err) {
      notifications.show({ title: 'Camera Error', message: String(err), color: 'red' });
    }
  }, [webcamEnabled, webcamStream, selectedDeviceId]);

  // Start/stop screen share. Its tab/system audio (if shared) becomes a "Slides" source in the mix.
  const toggleScreen = useCallback(async () => {
    if (screenEnabled && screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      setScreenStream(null);
      if (slideSourceIdRef.current) {
        removeSource(slideSourceIdRef.current);
        slideSourceIdRef.current = null;
      }
      setScreenEnabled(false);
      return;
    }

    try {
      resume();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      const videoStream = new MediaStream(stream.getVideoTracks());
      setScreenStream(videoStream);

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        slideSourceIdRef.current = addSource({
          stream: new MediaStream(audioTracks),
          label: 'Slide audio',
          kind: 'slides',
        });
      }

      setScreenEnabled(true);

      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        setScreenStream(null);
        if (slideSourceIdRef.current) {
          removeSource(slideSourceIdRef.current);
          slideSourceIdRef.current = null;
        }
        setScreenEnabled(false);
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        notifications.show({ title: 'Screen Share Error', message: String(err), color: 'red' });
      }
    }
  }, [screenEnabled, screenStream, resume, addSource, removeSource]);

  // Add a microphone / input device to the mix. Loopback inputs (Stereo Mix, virtual cables)
  // show up here too — the browser can't tell them apart from a mic.
  const handleAddMic = useCallback(async () => {
    try {
      resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true,
      });
      const track = stream.getAudioTracks()[0];
      const realId = track?.getSettings().deviceId ?? selectedMicId ?? undefined;

      // Don't capture the same device twice.
      if (realId && sources.some((s) => s.kind === 'microphone' && s.deviceId === realId)) {
        stream.getTracks().forEach((t) => t.stop());
        notifications.show({ title: 'Already added', message: 'That microphone is already in the mix.', color: 'yellow' });
        return;
      }

      const label = micDevices.find((d) => d.deviceId === realId)?.label || track?.label || 'Microphone';
      addSource({ stream, label, kind: 'microphone', deviceId: realId });
    } catch (err) {
      notifications.show({ title: 'Microphone Error', message: String(err), color: 'red' });
    }
  }, [selectedMicId, micDevices, sources, addSource, resume]);

  // Add desktop / system audio. getDisplayMedia is the only browser door to "what's playing on
  // this PC", and it always captures a video surface — we keep the audio and discard the picture.
  const handleAddDesktopAudio = useCallback(async () => {
    try {
      resume();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      stream.getVideoTracks().forEach((t) => t.stop());

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        notifications.show({
          title: 'No desktop audio captured',
          message: 'Pick a screen or tab and tick “Share system/tab audio”.',
          color: 'yellow',
        });
        return;
      }

      addSource({ stream: new MediaStream(audioTracks), label: 'Desktop audio', kind: 'desktop' });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        notifications.show({ title: 'Desktop Audio Error', message: String(err), color: 'red' });
      }
    }
  }, [addSource, resume]);

  // Studio stream (WebSocket transport)
  const {
    status: studioStatus,
    connect: studioConnect,
    disconnect: studioDisconnect,
    error: studioError,
    backpressureWarning,
  } = useStudioStream({
    compositeVideoStream: compositeStream,
    mixedAudioStream: mixedStream,
    videoBitsPerSecond: QUALITY_PRESETS[quality].videoBps,
    keepReconnecting: streamIsLive,
  });

  // Watch every capture track for death or silence. Gated on 'connected': before that the operator is
  // legitimately toggling devices on and off, and doesn't need to be told about their own clicks.
  // A track that ENDS is reported by the mixer as it auto-removes the source; this catches the other
  // case — a track that stays attached but goes silent (device claimed by another app, hardware mute).
  const deadTracks = useTrackWatch(
    [
      { label: 'Camera', stream: webcamStream },
      { label: 'Slides (screen share)', stream: screenStream },
      ...sources.map((s) => ({ label: s.label, stream: s.stream })),
    ],
    studioStatus === 'connected',
  );

  // Lift status to parent
  useEffect(() => {
    onStatusChange(studioStatus);
  }, [studioStatus, onStatusChange]);

  const live = studioStatus === 'connected' || studioStatus === 'connecting';

  // Live silence watch. The platforms cannot tell a silent mix from a real one — a silent AAC track
  // still has a bitrate — so a mic that dies quietly mid-broadcast (or was never added) is visible only
  // here. After a minute of digital silence on air, warn the presenter and report it so it reaches the
  // event log and the alert webhook.
  const [airSilent, setAirSilent] = useState(false);
  const watchingSilence = !!streamIsLive && studioStatus === 'connected';
  // Read through a ref on a timer: a mix stuck at exactly 0 never changes state, so an effect keyed on
  // the level itself would stop running at the very moment it needs to keep counting.
  const mixLevelRef = useRef(mixLevel);
  mixLevelRef.current = mixLevel;
  useEffect(() => {
    if (!watchingSilence) {
      setAirSilent(false);
      return;
    }
    const tracker = createSilenceTracker();
    let reportedSilent = false;
    const id = window.setInterval(() => {
      const silentMs = tracker.update(mixLevelRef.current, Date.now());
      const silentNow = silentMs >= LIVE_SILENCE_ALERT_MS;
      if (silentNow === reportedSilent) return;
      reportedSilent = silentNow;
      setAirSilent(silentNow);
      void api.reportStudioAlert({
        kind: 'audio_silent',
        subject: 'Studio audio',
        message: silentNow
          ? `The studio mix has been silent for ${Math.round(silentMs / 1000)}s while live — viewers can't hear anything.`
          : 'Studio audio is back.',
        resolved: !silentNow,
      }).catch(() => { /* never disturb a live stream */ });
    }, 1000);
    return () => window.clearInterval(id);
  }, [watchingSilence]);

  // Live video watch: same reasoning as silence. An empty or black picture still encodes at full
  // bitrate and looks healthy to every platform, so only this tab can notice it.
  const videoReadyRef = useRef(videoReady);
  videoReadyRef.current = videoReady;
  const videoStatesRef = useRef(videoStates);
  videoStatesRef.current = videoStates;
  const [videoMissing, setVideoMissing] = useState(false);
  useEffect(() => {
    if (!watchingSilence) {
      setVideoMissing(false);
      return;
    }
    let badSince: number | null = null;
    let reported = false;
    const id = window.setInterval(() => {
      const now = Date.now();
      if (videoReadyRef.current) badSince = null;
      else if (badSince === null) badSince = now;
      const missing = badSince !== null && now - badSince >= LIVE_VIDEO_ALERT_MS;
      if (missing === reported) return;
      reported = missing;
      setVideoMissing(missing);
      const st = videoStatesRef.current;
      void api.reportStudioAlert({
        kind: 'video_missing',
        subject: 'Studio video',
        message: missing
          ? `Video has been missing for ${LIVE_VIDEO_ALERT_MS / 1000}s while live (camera: ${st.camera}, slides: ${st.slides}).`
          : 'Studio camera and slides are back.',
        resolved: !missing,
      }).catch(() => { /* never disturb a live stream */ });
    }, 1000);
    return () => window.clearInterval(id);
  }, [watchingSilence]);

  // Measure upload bandwidth to the server and pre-select a quality the connection can sustain.
  // `silent` is used by the auto-run on arrival: it sets the default quietly (the inline "Measured
  // upload …" line still shows the result) and swallows failures, since a red toast on every page
  // load would be jarring — the operator can retry explicitly with the button to see any error.
  const handleTestConnection = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    setProbing(true);
    setProbeMbps(null);
    setRecommendedQuality(null);
    setProbeFailed(false);
    try {
      const mbps = await measureUploadMbps();
      setProbeMbps(mbps);
      const rec = recommendQuality(mbps);
      setQuality(rec);
      setRecommendedQuality(rec);
      if (!silent) {
        notifications.show({
          title: 'Connection test complete',
          message: `Upload ~${mbps.toFixed(1)} Mbps → recommended ${QUALITY_PRESETS[rec].label}`,
          color: 'green',
        });
      }
    } catch (err) {
      // Even on the silent auto-run, record the failure — the inline warning below is what tells the
      // operator their quality is an unverified default rather than a measured recommendation.
      setProbeFailed(true);
      if (!silent) {
        notifications.show({ title: 'Connection test failed', message: String(err), color: 'red' });
      }
    } finally {
      setProbing(false);
    }
  }, []);

  // Report leg-1 settings to the server whenever they change while connected, so the chosen quality
  // and the measured uplink land in the server log and event log. Previously these numbers never left
  // the browser, which is why the 2026-08-05 stream's real encode settings were unrecoverable.
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (studioStatus !== 'connected') { lastReportedRef.current = null; return; }
    const key = `${quality}:${probeMbps ?? 'none'}:${probeFailed}`;
    if (lastReportedRef.current === key) return;
    lastReportedRef.current = key;
    void api.reportStudioQuality({
      quality,
      videoBps: QUALITY_PRESETS[quality].videoBps,
      probeMbps,
      probeFailed,
    }).catch(() => { /* telemetry must never disturb a live stream */ });
  }, [studioStatus, quality, probeMbps, probeFailed]);

  // Auto-run the test once on arrival so the quality selector defaults to something the operator's
  // connection can actually carry — no need to remember to click "Test my connection". Gated on
  // `autoTestConnection` (the parent only enables it while the stream is "ready", never live).
  //
  // We wait for the page to go idle before probing: the probe saturates the uplink for several
  // seconds, so firing it during the initial render/data-fetch burst would make other requests
  // queue behind it. requestIdleCallback (timeout-bounded so it still runs promptly on a busy page)
  // lets first paint and the initial fetches land first. The ref keeps it to one run; the cleanup
  // cancels a still-pending probe if the operator leaves — or goes live — before it fires.
  const autoTestedRef = useRef(false);
  useEffect(() => {
    if (autoTestedRef.current || !autoTestConnection) return;

    const run = () => {
      if (autoTestedRef.current) return;
      autoTestedRef.current = true;
      handleTestConnection({ silent: true });
    };

    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(run, 500);
    return () => window.clearTimeout(id);
  }, [autoTestConnection, handleTestConnection]);

  /**
   * Connect, having first made sure the audio mix bus is actually running.
   *
   * MediaRecorder is always handed the mix bus track, even with zero audio sources, and a graph that
   * isn't rendering stalls the muxer — no chunks at all, not merely no audio. Connecting is a user
   * gesture, which is exactly when resuming a suspended context is permitted.
   *
   * (The canvas-only failure was NOT caused by suspension — the context was already running. That was a
   * destination node with no inputs; see the silent keepalive in useAudioMixer. This guard remains
   * because a genuinely suspended context would stall the stream the same way.)
   */
  const connectWithAudioRunning = useCallback(() => {
    void ensureRunning().then((running) => {
      if (!running) {
        // Not fatal — video may still record — but it's the prime suspect if nothing flows.
        console.warn('[studio] Audio mix bus is not running; the browser may not produce any media');
      }
      studioConnect();
    });
  }, [ensureRunning, studioConnect]);

  // Expose connect/disconnect to parent via refs
  useEffect(() => {
    if (onConnectRef) onConnectRef.current = connectWithAudioRunning;
    if (onDisconnectRef) onDisconnectRef.current = studioDisconnect;
    return () => {
      if (onConnectRef) onConnectRef.current = null;
      if (onDisconnectRef) onDisconnectRef.current = null;
    };
  }, [connectWithAudioRunning, studioDisconnect, onConnectRef, onDisconnectRef]);

  // Template editor handlers
  const handleSaveTemplate = useCallback(async () => {
    try {
      await api.updateTemplate('default', { config_json: template as unknown as Record<string, unknown> });
      setSavedTemplate(template);
      notifications.show({ title: 'Saved', message: 'Template layout saved', color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Save Error', message: String(err), color: 'red' });
    }
  }, [template]);

  const handleResetTemplate = useCallback(async () => {
    try {
      const result = await api.resetTemplate();
      const tpl = result.config_json as unknown as GridTemplate;
      setTemplate(tpl);
      setSavedTemplate(tpl);
      notifications.show({ title: 'Reset', message: 'Template reset to default', color: 'blue' });
    } catch (err) {
      notifications.show({ title: 'Reset Error', message: String(err), color: 'red' });
    }
  }, []);

  // Microphones not already in the mix (avoid offering a device that's been added).
  const addedMicIds = new Set(
    sources.filter((s) => s.kind === 'microphone' && s.deviceId).map((s) => s.deviceId as string),
  );
  const availableMics = micDevices.filter((d) => !addedMicIds.has(d.deviceId));

  return (
    <Stack gap="sm">
      {studioError && (
        <Alert color="red" title="Studio Error">{studioError}</Alert>
      )}

      {backpressureWarning && (
        <Alert color="yellow" title="Bandwidth Warning">
          Upload bandwidth may be insufficient. Stream quality may be affected.
        </Alert>
      )}

      {/* A dead capture device is invisible to every downstream signal: the compositor keeps painting
          its last frame and the platforms keep reporting a healthy 6000 kbps ingest. So say it here,
          loudly — and it's also sent to the server so it reaches the alert webhook. */}
      {deadTracks.length > 0 && (
        <Alert color="red" title="A camera or microphone has stopped">
          <Stack gap={4}>
            {deadTracks.map((d) => (
              <Text key={`${d.label}-${d.kind}-${d.problem}`} size="sm">
                <Text span fw={600}>{d.label}</Text> — {d.kind === 'audio' ? 'audio' : 'video'}{' '}
                {d.problem === 'ended' ? 'has stopped (device disconnected)' : 'is silent (muted or in use elsewhere)'}
              </Text>
            ))}
            <Text size="xs" c="dimmed">
              The broadcast is still running and will look healthy to the platforms — reconnect the
              device, or re-add it below, to restore it.
            </Text>
          </Stack>
        </Alert>
      )}

      {videoMissing && (
        <Alert color="red" title="Viewers can’t see your camera or slides">
          <Stack gap={2}>
            {videoProblems.map((m) => <Text key={m} size="sm">{m}</Text>)}
          </Stack>
        </Alert>
      )}

      {airSilent && (
        <Alert color="red" title="Viewers can’t hear anything">
          <Text size="sm">
            No sound has gone out for over a minute. Check that your microphone is plugged in and not
            muted, or add it again under Audio below.
          </Text>
        </Alert>
      )}

      {/* Live preview — exactly what viewers will see */}
      <Card withBorder padding={0} style={{ overflow: 'hidden' }}>
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            aspectRatio: '16/9',
            display: 'block',
            backgroundColor: '#000',
          }}
        />
      </Card>
      <Text size="xs" c="dimmed" ta="center" style={{ marginTop: -4 }}>
        Live preview — what your viewers will see
      </Text>
      {!streamIsLive && videoProblems.length > 0 && (
        <Alert color="orange" variant="light" p="xs">
          <Stack gap={2}>
            {videoProblems.map((m) => <Text key={m} size="xs">{m}</Text>)}
          </Stack>
        </Alert>
      )}

      {/* Step 1 — Share slides */}
      <Card withBorder padding="sm">
        <Group wrap="nowrap" align="flex-start" gap="sm">
          <ThemeIcon
            radius="xl"
            size="md"
            color={videoStates.slides === 'ok' ? 'green' : 'gray'}
            variant={videoStates.slides === 'ok' ? 'filled' : 'light'}
          >
            {videoStates.slides === 'ok' ? <Text size="sm">✓</Text> : <Text size="xs" fw={700}>1</Text>}
          </ThemeIcon>
          <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text size="sm" fw={500}>Share your slides</Text>
              <Badge size="sm" color={screenEnabled ? 'green' : 'gray'} variant="light">
                {screenEnabled ? 'Sharing' : 'Not shared'}
              </Badge>
            </Group>
            <Text size="xs" c="dimmed">
              Open Google Slides, click Present, then share that Chrome tab — and tick “Also share tab audio”.
            </Text>
            <Group gap="xs" mt={2}>
              <Button
                size="xs"
                color={screenEnabled ? 'gray' : 'blue'}
                variant={screenEnabled ? 'outline' : 'filled'}
                onClick={toggleScreen}
              >
                {screenEnabled ? 'Stop sharing' : 'Share slides'}
              </Button>
            </Group>
          </Stack>
        </Group>
      </Card>

      {/* Step 2 — Camera */}
      <Card withBorder padding="sm">
        <Group wrap="nowrap" align="flex-start" gap="sm">
          <ThemeIcon
            radius="xl"
            size="md"
            color={videoStates.camera === 'ok' ? 'green' : 'gray'}
            variant={videoStates.camera === 'ok' ? 'filled' : 'light'}
          >
            {videoStates.camera === 'ok' ? <Text size="sm">✓</Text> : <Text size="xs" fw={700}>2</Text>}
          </ThemeIcon>
          <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text size="sm" fw={500}>Camera</Text>
              <Badge size="sm" color={webcamEnabled ? 'green' : 'gray'} variant="light">
                {webcamEnabled ? 'Camera on' : 'Off'}
              </Badge>
            </Group>

            {!webcamEnabled && (
              <Select
                size="xs"
                label="Camera"
                placeholder="Choose camera..."
                data={webcamDevices.map((d) => ({
                  value: d.deviceId,
                  label: d.label || `Camera ${d.deviceId.slice(0, 8)}`,
                }))}
                value={selectedDeviceId}
                onChange={setSelectedDeviceId}
              />
            )}

            <Group gap="xs" mt={2}>
              <Button
                size="xs"
                color={webcamEnabled ? 'gray' : 'blue'}
                variant={webcamEnabled ? 'outline' : 'filled'}
                onClick={toggleWebcam}
              >
                {webcamEnabled ? 'Turn off camera' : 'Turn on camera'}
              </Button>
              {webcamEnabled && (
                <Button
                  size="xs"
                  variant={blurBackground ? 'filled' : 'light'}
                  color={blurBackground ? 'blue' : 'gray'}
                  loading={blurBackground && blurStatus === 'loading'}
                  onClick={() => setBlurBackground((b) => !b)}
                >
                  {blurBackground ? '✓ Background blurred' : 'Blur background'}
                </Button>
              )}
            </Group>
            {webcamEnabled && blurBackground && blurStatus === 'error' && (
              <Text size="xs" c="red">
                Background blur couldn’t start on this device — showing the normal camera instead.
              </Text>
            )}
          </Stack>
        </Group>
      </Card>

      {/* Step 3 — Audio */}
      <Card withBorder padding="sm">
        <Group wrap="nowrap" align="flex-start" gap="sm">
          <ThemeIcon
            radius="xl"
            size="md"
            color={audioConfirmed ? 'green' : 'gray'}
            variant={audioConfirmed ? 'filled' : 'light'}
          >
            {audioConfirmed ? <Text size="sm">✓</Text> : <Text size="xs" fw={700}>3</Text>}
          </ThemeIcon>
          <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text size="sm" fw={500}>Audio</Text>
              <Badge size="sm" color={sources.length > 0 ? 'green' : 'gray'} variant="light">
                {sources.length > 0 ? `${sources.length} source${sources.length > 1 ? 's' : ''}` : 'No audio'}
              </Badge>
            </Group>

            {sources.length === 0 && (
              <Text size="xs" c="dimmed">
                Add a microphone so your viewers can hear you. You can also add desktop audio — music,
                a video, or another app playing on this PC.
              </Text>
            )}

            {/* Active sources — each with its own level meter, volume, and mute */}
            {sources.map((s) => {
              const level = levels[s.id] ?? 0;
              const meta = KIND_META[s.kind];
              return (
                <Card key={s.id} withBorder padding="xs" radius="sm">
                  <Group justify="space-between" wrap="nowrap" gap="xs" mb={6}>
                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                      <Badge size="xs" variant="light" color={meta.color}>{meta.label}</Badge>
                      <Text size="xs" truncate>{s.label}</Text>
                    </Group>
                    <Group gap={4} wrap="nowrap">
                      <Button
                        size="compact-xs"
                        variant={s.muted ? 'filled' : 'subtle'}
                        color={s.muted ? 'red' : 'gray'}
                        onClick={() => setMuted(s.id, !s.muted)}
                      >
                        {s.muted ? 'Muted' : 'Mute'}
                      </Button>
                      <Button size="compact-xs" variant="subtle" color="gray" onClick={() => removeSource(s.id)}>
                        ✕
                      </Button>
                    </Group>
                  </Group>
                  <Progress
                    value={s.muted ? 0 : level * 100}
                    color={s.muted ? 'gray' : level > 0.8 ? 'red' : 'green'}
                    size="sm"
                    mb={6}
                  />
                  <Slider
                    size="xs"
                    min={0}
                    max={2}
                    step={0.1}
                    value={s.gain}
                    onChange={(v) => setGain(s.id, v)}
                    label={(v) => `${Math.round(v * 100)}%`}
                    disabled={s.muted}
                  />
                </Card>
              );
            })}

            {/* Add sources */}
            <Group gap="xs" wrap="nowrap" align="flex-end" mt={2}>
              <Select
                size="xs"
                label="Microphone"
                placeholder="Default microphone"
                data={availableMics.map((d) => ({
                  value: d.deviceId,
                  label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
                }))}
                value={selectedMicId}
                onChange={setSelectedMicId}
                style={{ flex: 1 }}
              />
              <Button size="xs" variant="light" onClick={handleAddMic}>Add mic</Button>
            </Group>
            <Button size="xs" variant="light" onClick={handleAddDesktopAudio}>
              Add desktop audio
            </Button>
            <Text size="xs" c="dimmed">
              Desktop audio: pick a screen or tab in the share dialog and tick “Share system/tab audio”.
              We only use the sound, not the picture.
            </Text>

            <AudioTestCard
              mixedStream={mixedStream}
              mixLevel={mixLevel}
              levels={levels}
              sources={sources}
              ensureRunning={ensureRunning}
              onConfirmedChange={handleAudioConfirmed}
              streamIsLive={!!streamIsLive}
            />
          </Stack>
        </Group>
      </Card>

      {/* Stream quality */}
      <Card withBorder padding="sm">
        <Stack gap={6}>
          <Group justify="space-between" wrap="nowrap" gap="xs" align="center">
            <Text size="sm" fw={500}>Stream quality</Text>
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => handleTestConnection()}
              loading={probing}
              disabled={live}
            >
              Test my connection
            </Button>
          </Group>
          <Select
            size="xs"
            data={Object.values(QUALITY_PRESETS).map((p) => ({ value: p.key, label: p.label }))}
            value={quality}
            onChange={(v) => v && setQuality(v as QualityKey)}
            disabled={live}
            allowDeselect={false}
          />
          {probeMbps !== null && recommendedQuality && (
            <Text size="xs" c="dimmed">
              Measured upload ~{probeMbps.toFixed(1)} Mbps · recommended {QUALITY_PRESETS[recommendedQuality].label}
            </Text>
          )}
          {probeMbps !== null && probeMbps < MIN_VIABLE_MBPS && (
            <Text size="xs" c="red">
              Your upload looks low — even Low may buffer. A wired connection will help if you have one.
            </Text>
          )}
          {/* An unmeasured connection means the quality above is an untested default, not a
              recommendation. Say so — a silent failure here is how a broadcast goes out at 2.5 Mbps
              without anyone realising the probe never ran. */}
          {probeFailed && (
            <Text size="xs" c="orange">
              Couldn’t measure your upload, so quality is set to a safe default
              ({QUALITY_PRESETS[quality].label}). Run “Test my connection” to pick the best one.
            </Text>
          )}
          {live && (
            <Text size="xs" c="dimmed">
              {streamIsLive
                // Ending a live broadcast is irreversible ("cannot be restarted or resumed"), so never
                // suggest it as the way to change a setting. MediaRecorder's bitrate is fixed at
                // construction, so mid-broadcast really is not possible.
                ? 'Quality can’t be changed mid-broadcast.'
                // Not live yet: disconnecting the studio is safe and is the actual fix.
                : 'Quality is set when you connect — disconnect the studio to change it.'}
            </Text>
          )}
        </Stack>
      </Card>

      {/* Advanced — layout editor (rarely needed; hidden by default) */}
      <Box>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={() => setShowLayout((s) => !s)}
        >
          {showLayout ? '▾' : '▸'} Edit layout
        </Button>
        <Collapse in={showLayout}>
          <Box mt={4}>
            <TemplateEditor
              template={template}
              savedTemplate={savedTemplate}
              onTemplateChange={setTemplate}
              onSave={handleSaveTemplate}
              onReset={handleResetTemplate}
            />
          </Box>
        </Collapse>
      </Box>

      <Alert variant="light" color="blue">
        Use Chrome or Edge. Share a <strong>tab</strong> (not a window) and tick “Also share tab audio” so your slide sound goes out.
      </Alert>
    </Stack>
  );
}
