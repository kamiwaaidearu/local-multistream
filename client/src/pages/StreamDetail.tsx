import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Title,
  Text,
  Badge,
  Button,
  Group,
  Stack,
  Card,
  Code,
  CopyButton,
  ActionIcon,
  Loader,
  Alert,
  Anchor,
  Timeline,
  Modal,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { FFmpegLog } from '../components/FFmpegLog';

interface PlatformStream {
  id: string;
  platform: string;
  status: string;
  broadcast_id: string | null;
  stream_key: string | null;
  error_message: string | null;
  extra_json: string | null;
}

interface EventLogEntry {
  id: number;
  stream_id: string | null;
  platform: string | null;
  event: string;
  detail: string | null;
  ts: number;
}

interface StreamData {
  id: string;
  name: string;
  description: string | null;
  thumbnail_path: string | null;
  scheduled_start: number | null;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  platforms: PlatformStream[];
  events: EventLogEntry[];
}

const statusColors: Record<string, string> = {
  draft: 'gray',
  ready: 'blue',
  live: 'red',
  ended: 'green',
  error: 'orange',
  pending: 'gray',
  created: 'blue',
  reconnecting: 'yellow',
};

function getVodUrl(ps: PlatformStream): string | null {
  if (!ps.extra_json) return null;
  try {
    const extra = JSON.parse(ps.extra_json);
    return extra.vod_url ?? null;
  } catch {
    return null;
  }
}

export function StreamDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [stream, setStream] = useState<StreamData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [obsConnected, setObsConnected] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  // SSE for real-time updates during live
  const { events: sseEvents, connected: sseConnected } = useSSE(
    '/api/stream/events',
    stream?.status === 'live',
  );

  const refreshStream = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.getStream(id);
      setStream(data as StreamData);
    } catch {
      setStream(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { refreshStream(); }, [refreshStream]);

  // Poll OBS status when in ready state
  useEffect(() => {
    if (stream?.status !== 'ready') return;
    const check = () => api.getObsStatus().then((s) => setObsConnected(s.connected)).catch(() => {});
    check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, [stream?.status]);

  // Poll stream status during live to catch status changes
  useEffect(() => {
    if (stream?.status !== 'live') return;
    const interval = setInterval(refreshStream, 5000);
    return () => clearInterval(interval);
  }, [stream?.status, refreshStream]);

  async function handleAction(action: string, fn: () => Promise<unknown>) {
    setActionLoading(action);
    try {
      await fn();
      await refreshStream();
    } catch (err) {
      notifications.show({ title: 'Error', message: String(err), color: 'red' });
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) return <Loader />;
  if (!stream) return <Text>Stream not found</Text>;

  return (
    <Stack>
      <Group justify="space-between">
        <Group>
          <Title order={2}>{stream.name}</Title>
          <Badge size="lg" color={statusColors[stream.status]}>{stream.status}</Badge>
        </Group>
        {(stream.status === 'draft' || stream.status === 'ready') && (
          <Group>
            <Button variant="subtle" onClick={() => navigate(`/streams/${stream.id}/edit`)}>
              Edit
            </Button>
            <Button
              variant="subtle"
              color="red"
              onClick={() => handleAction('delete', async () => {
                await api.deleteStream(stream.id);
                navigate('/');
              })}
              loading={actionLoading === 'delete'}
            >
              Delete
            </Button>
          </Group>
        )}
      </Group>

      {stream.description && <Text c="dimmed">{stream.description}</Text>}
      {stream.scheduled_start && (
        <Text size="sm" c="dimmed">
          Scheduled: {new Date(stream.scheduled_start * 1000).toLocaleString()}
        </Text>
      )}

      {/* Draft phase */}
      {stream.status === 'draft' && (
        <Card withBorder>
          <Stack>
            <Text fw={500}>Setup Platforms</Text>
            <Text size="sm" c="dimmed">
              Create broadcasts on YouTube, Facebook, and update Twitch title.
            </Text>
            <Button
              onClick={() => handleAction('setup', () => api.setupStream(stream.id))}
              loading={actionLoading === 'setup'}
            >
              Setup Platforms
            </Button>
          </Stack>
        </Card>
      )}

      {/* Ready phase */}
      {stream.status === 'ready' && (
        <>
          <Card withBorder>
            <Stack>
              <Group justify="space-between">
                <Text fw={500}>OBS Connection</Text>
                <Badge color={obsConnected ? 'green' : 'gray'} size="sm">
                  {obsConnected ? 'OBS Connected' : 'OBS Not Connected'}
                </Badge>
              </Group>
              <Text size="sm" c="dimmed">
                Configure OBS once -- these settings persist across sessions.
              </Text>
              <Group>
                <Text size="sm">Server:</Text>
                <Code>rtmp://localhost:1935/live</Code>
                <CopyButton value="rtmp://localhost:1935/live">
                  {({ copy, copied }) => (
                    <ActionIcon variant="subtle" onClick={copy} size="sm">
                      {copied ? '✓' : '📋'}
                    </ActionIcon>
                  )}
                </CopyButton>
              </Group>
              <Group>
                <Text size="sm">Stream Key:</Text>
                <Code>multistream-live</Code>
                <CopyButton value="multistream-live">
                  {({ copy, copied }) => (
                    <ActionIcon variant="subtle" onClick={copy} size="sm">
                      {copied ? '✓' : '📋'}
                    </ActionIcon>
                  )}
                </CopyButton>
              </Group>
              <Alert title="Recommended OBS Settings" variant="light">
                1080p, 4500-6000 kbps, H.264, CBR, Keyframe Interval: 2s, 30fps
              </Alert>
            </Stack>
          </Card>

          <Button
            color="red"
            size="lg"
            onClick={() => handleAction('golive', () => api.goLive(stream.id))}
            loading={actionLoading === 'golive'}
            disabled={!obsConnected}
          >
            {obsConnected ? 'Go Live' : 'Go Live (waiting for OBS...)'}
          </Button>
        </>
      )}

      {/* Live phase */}
      {stream.status === 'live' && (
        <>
          <Card withBorder>
            <Stack>
              <Badge color="red" size="xl" variant="filled">LIVE</Badge>
              {stream.started_at && (
                <Text size="sm" c="dimmed">
                  Started: {new Date(stream.started_at).toLocaleTimeString()}
                </Text>
              )}
              <Button
                color="red"
                variant="outline"
                onClick={() => setConfirmEnd(true)}
                loading={actionLoading === 'end'}
              >
                End Stream
              </Button>
            </Stack>
          </Card>

          <FFmpegLog events={sseEvents} connected={sseConnected} />

          <Modal opened={confirmEnd} onClose={() => setConfirmEnd(false)} title="End Stream">
            <Stack>
              <Text>Are you sure you want to end this stream? This will stop all platform broadcasts.</Text>
              <Group justify="flex-end">
                <Button variant="subtle" onClick={() => setConfirmEnd(false)}>Cancel</Button>
                <Button
                  color="red"
                  onClick={() => {
                    setConfirmEnd(false);
                    handleAction('end', () => api.endStream(stream.id));
                  }}
                >
                  End Stream
                </Button>
              </Group>
            </Stack>
          </Modal>
        </>
      )}

      {/* Ended phase */}
      {stream.status === 'ended' && (
        <Card withBorder>
          <Stack>
            <Text fw={500}>Stream Complete</Text>
            {stream.started_at && stream.ended_at && (
              <Text size="sm">
                Duration: {Math.round((stream.ended_at - stream.started_at) / 60000)} minutes
                {' '}({new Date(stream.started_at).toLocaleTimeString()} - {new Date(stream.ended_at).toLocaleTimeString()})
              </Text>
            )}

            {/* VOD Links */}
            {stream.platforms.some((ps) => getVodUrl(ps)) && (
              <>
                <Text fw={500} mt="sm">Recordings</Text>
                <Group>
                  {stream.platforms.map((ps) => {
                    const vodUrl = getVodUrl(ps);
                    if (!vodUrl) return null;
                    return (
                      <Anchor
                        key={ps.id}
                        href={vodUrl}
                        target="_blank"
                        rel="noopener"
                      >
                        <Badge
                          size="lg"
                          variant="light"
                          color={ps.platform === 'youtube' ? 'red' : ps.platform === 'facebook' ? 'blue' : 'violet'}
                          style={{ cursor: 'pointer' }}
                        >
                          {ps.platform} VOD
                        </Badge>
                      </Anchor>
                    );
                  })}
                </Group>
              </>
            )}
          </Stack>
        </Card>
      )}

      {/* Platform statuses */}
      {stream.platforms.length > 0 && (
        <Card withBorder>
          <Stack>
            <Text fw={500}>Platform Status</Text>
            {stream.platforms.map((ps) => (
              <Group key={ps.id} justify="space-between" wrap="nowrap">
                <Group>
                  <Text tt="capitalize" fw={500}>{ps.platform}</Text>
                  <Badge color={statusColors[ps.status] ?? 'gray'} size="sm">{ps.status}</Badge>
                </Group>
                <Group>
                  {ps.error_message && (
                    <Text size="xs" c="red" lineClamp={1}>{ps.error_message}</Text>
                  )}
                  {ps.status === 'error' && (stream.status === 'draft' || stream.status === 'ready') && (
                    <Button
                      size="xs"
                      variant="light"
                      onClick={() => handleAction(`retry-${ps.platform}`, () => api.setupPlatform(stream.id, ps.platform))}
                      loading={actionLoading === `retry-${ps.platform}`}
                    >
                      Retry
                    </Button>
                  )}
                </Group>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      {/* Event log */}
      {stream.events.length > 0 && (
        <Card withBorder>
          <Stack>
            <Text fw={500}>Event Log</Text>
            <Timeline active={stream.events.length - 1} bulletSize={16} lineWidth={2}>
              {stream.events.slice(0, 20).map((event) => (
                <Timeline.Item
                  key={event.id}
                  title={
                    <Text size="xs">
                      {event.platform ? `[${event.platform}] ` : ''}
                      {event.event}
                    </Text>
                  }
                >
                  {event.detail && <Text size="xs" c="dimmed">{event.detail}</Text>}
                  <Text size="xs" c="dimmed">
                    {new Date(event.ts).toLocaleTimeString()}
                  </Text>
                </Timeline.Item>
              ))}
            </Timeline>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
