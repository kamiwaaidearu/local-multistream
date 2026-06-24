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
import { useAudioMixer, type AudioSourceKind } from '../hooks/useAudioMixer';
import { useStudioStream } from '../hooks/useStudioStream';
import { measureUploadMbps, MIN_VIABLE_MBPS, QUALITY_PRESETS, recommendQuality, type QualityKey } from '../lib/bandwidthProbe';
import { FALLBACK_TEMPLATE } from '../lib/gridTemplate';
import { TemplateEditor } from './TemplateEditor';
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
}

export function StudioSourcePanel({ onStatusChange, onConnectRef, onDisconnectRef }: StudioSourcePanelProps) {
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

  // Advanced sections (hidden by default to keep the operator view simple)
  const [showLayout, setShowLayout] = useState(false);

  // Stream quality (Leg-1 / browser encode bitrate). Defaults to Medium; "Test my connection"
  // measures the operator's upload and pre-selects a preset their link should sustain.
  const [quality, setQuality] = useState<QualityKey>('medium');
  const [probing, setProbing] = useState(false);
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

  // Compositor — camera is video-only now; audio is handled entirely by the mixer.
  const { canvasRef, compositeStream } = useCanvasCompositor({
    template,
    webcamStream: useMemo(
      () => webcamStream ? new MediaStream(webcamStream.getVideoTracks()) : null,
      [webcamStream],
    ),
    screenStream,
  });

  // Audio mixer — N independent sources (mics, desktop audio, slide audio), each with its own
  // volume / mute / meter, summed into one track for the encoder.
  const { mixedStream, sources, levels, addSource, removeSource, setGain, setMuted, resume } = useAudioMixer();

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
  });

  // Lift status to parent
  useEffect(() => {
    onStatusChange(studioStatus);
  }, [studioStatus, onStatusChange]);

  const live = studioStatus === 'connected' || studioStatus === 'connecting';

  // Measure upload bandwidth to the server and pre-select a quality the connection can sustain.
  const handleTestConnection = useCallback(async () => {
    setProbing(true);
    setProbeMbps(null);
    setRecommendedQuality(null);
    try {
      const mbps = await measureUploadMbps();
      setProbeMbps(mbps);
      const rec = recommendQuality(mbps);
      setQuality(rec);
      setRecommendedQuality(rec);
      notifications.show({
        title: 'Connection test complete',
        message: `Upload ~${mbps.toFixed(1)} Mbps → recommended ${QUALITY_PRESETS[rec].label}`,
        color: 'green',
      });
    } catch (err) {
      notifications.show({ title: 'Connection test failed', message: String(err), color: 'red' });
    } finally {
      setProbing(false);
    }
  }, []);

  // Expose connect/disconnect to parent via refs
  useEffect(() => {
    if (onConnectRef) onConnectRef.current = studioConnect;
    if (onDisconnectRef) onDisconnectRef.current = studioDisconnect;
    return () => {
      if (onConnectRef) onConnectRef.current = null;
      if (onDisconnectRef) onDisconnectRef.current = null;
    };
  }, [studioConnect, studioDisconnect, onConnectRef, onDisconnectRef]);

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

      {/* Step 1 — Share slides */}
      <Card withBorder padding="sm">
        <Group wrap="nowrap" align="flex-start" gap="sm">
          <ThemeIcon
            radius="xl"
            size="md"
            color={screenEnabled ? 'green' : 'gray'}
            variant={screenEnabled ? 'filled' : 'light'}
          >
            {screenEnabled ? <Text size="sm">✓</Text> : <Text size="xs" fw={700}>1</Text>}
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
            color={webcamEnabled ? 'green' : 'gray'}
            variant={webcamEnabled ? 'filled' : 'light'}
          >
            {webcamEnabled ? <Text size="sm">✓</Text> : <Text size="xs" fw={700}>2</Text>}
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
            </Group>
          </Stack>
        </Group>
      </Card>

      {/* Step 3 — Audio */}
      <Card withBorder padding="sm">
        <Group wrap="nowrap" align="flex-start" gap="sm">
          <ThemeIcon
            radius="xl"
            size="md"
            color={sources.length > 0 ? 'green' : 'gray'}
            variant={sources.length > 0 ? 'filled' : 'light'}
          >
            {sources.length > 0 ? <Text size="sm">✓</Text> : <Text size="xs" fw={700}>3</Text>}
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
              onClick={handleTestConnection}
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
          {live && (
            <Text size="xs" c="dimmed">Quality is locked while you’re live — stop the stream to change it.</Text>
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
