import { useEffect, useState, useCallback, useMemo } from 'react';
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
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCanvasCompositor, type GridTemplate } from '../hooks/useCanvasCompositor';
import { useAudioMixer } from '../hooks/useAudioMixer';
import { useStudioStream } from '../hooks/useStudioStream';
import { DEFAULT_GRID_TEMPLATE } from '../lib/gridTemplate';
import { TemplateEditor } from './TemplateEditor';
import { api } from '../lib/api';

type StudioStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface StudioSourcePanelProps {
  onStatusChange: (status: StudioStatus) => void;
  onConnectRef?: React.MutableRefObject<(() => void) | null>;
  onDisconnectRef?: React.MutableRefObject<(() => void) | null>;
}

const FALLBACK_TEMPLATE: GridTemplate = DEFAULT_GRID_TEMPLATE;

export function StudioSourcePanel({ onStatusChange, onConnectRef, onDisconnectRef }: StudioSourcePanelProps) {
  const [template, setTemplate] = useState<GridTemplate>(FALLBACK_TEMPLATE);
  const [savedTemplate, setSavedTemplate] = useState<GridTemplate>(FALLBACK_TEMPLATE);

  // Media sources
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [screenAudioStream, setScreenAudioStream] = useState<MediaStream | null>(null);
  const [webcamDevices, setWebcamDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [webcamEnabled, setWebcamEnabled] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(false);

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

  // Enumerate webcam devices
  useEffect(() => {
    navigator.mediaDevices.enumerateDevices()
      .then((devices) => {
        const video = devices.filter((d) => d.kind === 'videoinput');
        setWebcamDevices(video);
        if (video.length > 0 && !selectedDeviceId) {
          setSelectedDeviceId(video[0].deviceId);
        }
      })
      .catch(() => {});
  }, [selectedDeviceId]);

  // Cleanup media tracks on unmount
  useEffect(() => {
    return () => {
      webcamStream?.getTracks().forEach((t) => t.stop());
      screenStream?.getTracks().forEach((t) => t.stop());
      screenAudioStream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only on unmount
  }, []);

  // Start/stop webcam
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
        audio: true,
      });
      setWebcamStream(stream);
      setWebcamEnabled(true);
    } catch (err) {
      notifications.show({ title: 'Camera Error', message: String(err), color: 'red' });
    }
  }, [webcamEnabled, webcamStream, selectedDeviceId]);

  // Start/stop screen share
  const toggleScreen = useCallback(async () => {
    if (screenEnabled && screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      setScreenStream(null);
      setScreenAudioStream(null);
      setScreenEnabled(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      const videoStream = new MediaStream(stream.getVideoTracks());
      setScreenStream(videoStream);

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        setScreenAudioStream(new MediaStream(audioTracks));
      }

      setScreenEnabled(true);

      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        setScreenStream(null);
        setScreenAudioStream(null);
        setScreenEnabled(false);
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        notifications.show({ title: 'Screen Share Error', message: String(err), color: 'red' });
      }
    }
  }, [screenEnabled, screenStream]);

  // Mic stream — useMemo to avoid re-creating on every render
  const micStream = useMemo(
    () => webcamStream ? new MediaStream(webcamStream.getAudioTracks()) : null,
    [webcamStream],
  );

  // Compositor
  const { canvasRef, compositeStream } = useCanvasCompositor({
    template,
    webcamStream: useMemo(
      () => webcamStream ? new MediaStream(webcamStream.getVideoTracks()) : null,
      [webcamStream],
    ),
    screenStream,
  });

  // Audio mixer
  const { mixedStream, micGain, tabGain, setMicGain, setTabGain, audioLevel } = useAudioMixer({
    micStream,
    tabAudioStream: screenAudioStream,
  });

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
  });

  // Lift status to parent
  useEffect(() => {
    onStatusChange(studioStatus);
  }, [studioStatus, onStatusChange]);

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

      {/* Canvas Preview */}
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

      {/* Compact source controls: camera + screen on one row */}
      <Group grow align="flex-start">
        <Group gap="xs" wrap="nowrap">
          <Select
            size="xs"
            placeholder="Camera..."
            data={webcamDevices.map((d) => ({
              value: d.deviceId,
              label: d.label || `Camera ${d.deviceId.slice(0, 8)}`,
            }))}
            value={selectedDeviceId}
            onChange={setSelectedDeviceId}
            disabled={webcamEnabled}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button
            size="xs"
            color={webcamEnabled ? 'red' : 'blue'}
            variant={webcamEnabled ? 'outline' : 'filled'}
            onClick={toggleWebcam}
          >
            {webcamEnabled ? 'Stop Cam' : 'Start Cam'}
          </Button>
        </Group>

        <Group gap="xs" wrap="nowrap">
          <Button
            size="xs"
            color={screenEnabled ? 'red' : 'blue'}
            variant={screenEnabled ? 'outline' : 'filled'}
            onClick={toggleScreen}
            style={{ flex: 1 }}
          >
            {screenEnabled ? 'Stop Share' : 'Share Tab'}
          </Button>
          <Badge
            size="sm"
            color={studioStatus === 'connected' ? 'green' : studioStatus === 'connecting' ? 'yellow' : 'gray'}
          >
            {studioStatus === 'connected' ? 'Connected' : studioStatus === 'connecting' ? 'Connecting' : 'Disconnected'}
          </Badge>
        </Group>
      </Group>

      {/* Template editor */}
      <TemplateEditor
        template={template}
        savedTemplate={savedTemplate}
        onTemplateChange={setTemplate}
        onSave={handleSaveTemplate}
        onReset={handleResetTemplate}
      />

      {/* Audio controls: sliders + level on one row */}
      <Card withBorder padding="xs">
        <Group grow align="center">
          <Stack gap={2}>
            <Text size="xs">Mic</Text>
            <Slider
              size="xs"
              min={0}
              max={2}
              step={0.1}
              value={micGain}
              onChange={setMicGain}
              label={(v) => `${Math.round(v * 100)}%`}
            />
          </Stack>
          <Stack gap={2}>
            <Text size="xs">Tab Audio</Text>
            <Slider
              size="xs"
              min={0}
              max={2}
              step={0.1}
              value={tabGain}
              onChange={setTabGain}
              label={(v) => `${Math.round(v * 100)}%`}
            />
          </Stack>
          <Stack gap={2}>
            <Text size="xs">Level</Text>
            <Progress value={audioLevel * 100} color={audioLevel > 0.8 ? 'red' : 'green'} size="sm" />
          </Stack>
        </Group>
      </Card>

      <Alert variant="light" color="blue">
        Chrome or Edge required. Share a Chrome <strong>tab</strong> (not window) and check "Share tab audio" for presentation audio.
      </Alert>
    </Stack>
  );
}
