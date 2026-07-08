import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Title,
  Text,
  Badge,
  Button,
  Group,
  Stack,
  Card,
  Loader,
  Anchor,
  Modal,
  Drawer,
  Menu,
  ActionIcon,
  Grid,
  SegmentedControl,
  Tooltip,
  Alert,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api } from '../lib/api';
import { reconnectPlatform } from '../lib/reauth';
import { useSSE } from '../hooks/useSSE';
import { useStudioLive, isIntentionalExit } from '../lib/studioLive';
import { shouldShowStudioReconnect } from '../lib/studioRecovery';
import { FFmpegLog } from '../components/FFmpegLog';
import { PlatformStatusCard } from '../components/PlatformStatusCard';
import { EventLogCard } from '../components/EventLogCard';
import { ObsSourcePanel } from '../components/ObsSourcePanel';
import { StudioSourcePanel } from '../components/StudioSourcePanel';
import { StreamForm } from '../components/StreamForm';

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

type SourceMode = 'obs' | 'studio';
type StudioStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

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

export function StreamPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  // Stream data
  const [stream, setStream] = useState<StreamData | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Source mode
  const [mode, setMode] = useState<SourceMode>('studio');
  const [modeInitialized, setModeInitialized] = useState(false);
  const [sourceConnected, setSourceConnected] = useState(false);
  const [sourceType, setSourceType] = useState<'obs' | 'studio' | null>(null);
  const [studioStatus, setStudioStatus] = useState<StudioStatus>('disconnected');

  // UI state
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Per-platform auth health (go-live pre-check + live reconnect) and reconnect-in-progress marker.
  const [authHealth, setAuthHealth] = useState<Record<string, { connected: boolean; ok: boolean }> | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  // Refs to call studio connect/disconnect from action button
  const studioConnectRef = useRef<(() => void) | null>(null);
  const studioDisconnectRef = useRef<(() => void) | null>(null);

  // Auto-trigger go-live after studio connects
  const pendingGoLiveRef = useRef(false);

  // SSE for real-time updates during live
  const { events: sseEvents, connected: sseConnected } = useSSE(
    '/api/stream/events',
    stream?.status === 'live',
  );

  // beforeunload guard when live
  const isLiveRef = useRef(false);
  useEffect(() => {
    isLiveRef.current = stream?.status === 'live';
  }, [stream?.status]);

  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      // Skip the native prompt for an intentional logout — the logout modal already confirmed.
      if (isLiveRef.current && !isIntentionalExit()) e.preventDefault();
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // Tell the app shell when THIS tab is the live Web Studio source, so the global guard can
  // intercept in-app navigation away (which would unmount the capture and interrupt the broadcast)
  // and end the stream cleanly. OBS-sourced live streams stay null — OBS publishes independently,
  // so leaving is safe. 'connecting' counts as live too: during a reconnect the broadcast is still
  // up and leaving would still kill it.
  const { setLiveStreamId } = useStudioLive();
  const studioIsLiveSource =
    stream?.status === 'live' && mode === 'studio' &&
    (studioStatus === 'connected' || studioStatus === 'connecting');
  useEffect(() => {
    setLiveStreamId(studioIsLiveSource ? (stream?.id ?? null) : null);
    return () => setLiveStreamId(null);
  }, [studioIsLiveSource, stream?.id, setLiveStreamId]);

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

  // Pre-check / live auth health: know which connected platforms have a working login so we can warn
  // before go-live and offer reconnect while live. Cheap and only fetched in ready/live phases.
  const checkAuthHealth = useCallback(() => {
    api.getAuthHealth().then(setAuthHealth).catch(() => {});
  }, []);
  useEffect(() => {
    if (stream?.status === 'ready' || stream?.status === 'live') checkAuthHealth();
  }, [stream?.status, checkAuthHealth]);

  // Poll source status when in ready state — only when in OBS mode or mode not yet chosen
  useEffect(() => {
    if (stream?.status !== 'ready') return;
    // In studio mode, we have local status — only poll for OBS detection
    if (modeInitialized && mode === 'studio') return;

    const check = () => api.getSourceStatus().then((s) => {
      setSourceConnected(s.connected);
      setSourceType(s.source);
      // Auto-detect initial mode from first source connection
      if (!modeInitialized && s.connected && s.source) {
        setMode(s.source);
        setModeInitialized(true);
      }
    }).catch(() => {});
    check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, [stream?.status, mode, modeInitialized]);

  // In OBS mode, also poll for connection status
  useEffect(() => {
    if (stream?.status !== 'ready' || mode !== 'obs' || !modeInitialized) return;
    const check = () => api.getSourceStatus().then((s) => {
      setSourceConnected(s.connected);
      setSourceType(s.source);
    }).catch(() => {});
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, [stream?.status, mode, modeInitialized]);

  // Poll stream status during live to catch status changes
  useEffect(() => {
    if (stream?.status !== 'live') return;
    const interval = setInterval(refreshStream, 5000);
    return () => clearInterval(interval);
  }, [stream?.status, refreshStream]);

  // When studio connects and we have a pending go-live, trigger it
  useEffect(() => {
    if (studioStatus === 'connected' && pendingGoLiveRef.current && stream?.id) {
      pendingGoLiveRef.current = false;
      handleAction('golive', () => api.goLive(stream.id));
    }
    if (studioStatus === 'error') {
      pendingGoLiveRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioStatus]);

  // Derive effective source connected for studio mode from local hook status
  const effectiveSourceConnected = mode === 'studio'
    ? studioStatus === 'connected'
    : sourceConnected && sourceType === 'obs';

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

  // Reconnect a platform's login via an OAuth popup — safe mid-stream because it doesn't navigate
  // the current tab (which may be the live Web Studio source). Re-checks health + refreshes after.
  async function handleReconnect(platform: string) {
    setReconnecting(platform);
    try {
      const ok = await reconnectPlatform(platform as 'youtube' | 'facebook' | 'twitch');
      if (ok) {
        notifications.show({ title: 'Reconnected', message: `${platform} reconnected`, color: 'green' });
        checkAuthHealth();
        await refreshStream();
      } else {
        notifications.show({ title: 'Not reconnected', message: `${platform} reconnect was cancelled`, color: 'yellow' });
      }
    } catch (err) {
      notifications.show({ title: 'Reconnect failed', message: String(err), color: 'red' });
    } finally {
      setReconnecting(null);
    }
  }

  async function handleEditSave(formData: FormData) {
    if (!stream) return;
    await api.updateStream(stream.id, formData);
    await refreshStream();
    setEditDrawerOpen(false);
  }

  function handleModeChange(value: string) {
    setMode(value as SourceMode);
    setModeInitialized(true);
  }

  if (loading) return <Loader />;
  if (!stream) return <Text>Stream not found</Text>;

  const isReady = stream.status === 'ready';
  const isLive = stream.status === 'live';
  const isDraft = stream.status === 'draft';
  const isEnded = stream.status === 'ended';
  const useTwoCol = isReady || isLive;
  const canEdit = !isLive;
  const canDelete = isDraft || isReady;
  const modeToggleDisabled = isLive;

  // Connected platforms whose login is currently broken — surfaced as a pre-go-live warning.
  const unhealthyPlatforms = authHealth
    ? Object.entries(authHealth).filter(([, v]) => v.connected && !v.ok).map(([p]) => p)
    : [];

  // Marker for the per-platform "Retry go-live" spinner (actionLoading is set to `retrylive-<p>`).
  const retryingLivePlatform = actionLoading?.startsWith('retrylive-')
    ? actionLoading.replace('retrylive-', '')
    : null;

  // --- Header ---
  const header = (
    <Group justify="space-between">
      <Group>
        <Title order={2}>{stream.name}</Title>
        <Badge size="lg" color={statusColors[stream.status]}>{stream.status}</Badge>
      </Group>
      {(canEdit || canDelete) && (
        <Menu shadow="md" width={160}>
          <Menu.Target>
            <ActionIcon variant="subtle" size="lg">⋮</ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {canEdit && (
              <Menu.Item onClick={() => setEditDrawerOpen(true)}>Edit Details</Menu.Item>
            )}
            {canDelete && (
              <Menu.Item color="red" onClick={() => setConfirmDelete(true)}>Delete Stream</Menu.Item>
            )}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );

  // --- Subtitle info ---
  const subtitle = (
    <>
      {stream.description && <Text c="dimmed">{stream.description}</Text>}
      {stream.scheduled_start && (
        <Text size="sm" c="dimmed">
          Scheduled: {new Date(stream.scheduled_start * 1000).toLocaleString()}
        </Text>
      )}
    </>
  );

  // --- Draft content ---
  const draftContent = isDraft && (
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
  );

  // --- Ended content ---
  const endedContent = isEnded && (
    <Card withBorder>
      <Stack>
        <Text fw={500}>Stream Complete</Text>
        {stream.started_at && stream.ended_at && (
          <Text size="sm">
            Duration: {Math.round((stream.ended_at - stream.started_at) / 60000)} minutes
            {' '}({new Date(stream.started_at).toLocaleTimeString()} - {new Date(stream.ended_at).toLocaleTimeString()})
          </Text>
        )}
        {stream.platforms.some((ps) => getVodUrl(ps)) && (
          <>
            <Text fw={500} mt="sm">Recordings</Text>
            <Group>
              {stream.platforms.map((ps) => {
                const vodUrl = getVodUrl(ps);
                if (!vodUrl) return null;
                return (
                  <Anchor key={ps.id} href={vodUrl} target="_blank" rel="noopener">
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
  );

  // --- Mode toggle ---
  const modeToggle = isReady && (
    <Tooltip
      label="Cannot switch modes while live"
      disabled={!modeToggleDisabled}
    >
      <SegmentedControl
        value={mode}
        onChange={handleModeChange}
        disabled={modeToggleDisabled}
        data={[
          { value: 'studio', label: 'Web Studio' },
          { value: 'obs', label: 'OBS' },
        ]}
        fullWidth
      />
    </Tooltip>
  );

  // --- Left column content (ready/live) ---
  const leftColumn = (
    <Stack>
      {modeToggle}

      {/* Pre-go-live auth warning: connected platforms whose login is broken will be skipped at
          go-live until reconnected. Non-blocking — you can still go live on the healthy ones. */}
      {isReady && unhealthyPlatforms.length > 0 && (
        <Alert color="orange" title="Some platforms need reconnecting">
          <Stack gap="xs">
            <Text size="sm">
              These platforms have an expired login and will be skipped at go-live until reconnected:
            </Text>
            <Group>
              {unhealthyPlatforms.map((p) => (
                <Button
                  key={p}
                  size="xs"
                  variant="light"
                  tt="capitalize"
                  loading={reconnecting === p}
                  onClick={() => handleReconnect(p)}
                >
                  Reconnect {p}
                </Button>
              ))}
            </Group>
          </Stack>
        </Alert>
      )}

      {/* Live badge */}
      {isLive && (
        <Group>
          <Badge color="red" size="xl" variant="filled">LIVE</Badge>
          {stream.started_at && (
            <Text size="sm" c="dimmed">
              Started: {new Date(stream.started_at).toLocaleTimeString()}
            </Text>
          )}
        </Group>
      )}

      {/* Studio reconnect: if this tab was closed/reloaded while live, the Studio panel remounts
          disconnected with no "Go Live" button to hang a connect action off (that button only
          exists in the ready phase). Without this, the operator has no way back in — the fan-out
          legs retry for ~35s and then give up while the broadcast sits live but silent. */}
      {shouldShowStudioReconnect(stream.status, mode, studioStatus) && (
        <Alert color="orange" title="Studio source disconnected">
          <Stack gap="xs">
            <Text size="sm">
              This tab lost its connection to the broadcast — likely from closing or reloading it.
              The stream is still live on the platforms; re-enable your camera/mic below if needed,
              then reconnect before the fan-out gives up retrying.
            </Text>
            <Group>
              <Button size="xs" color="orange" onClick={() => studioConnectRef.current?.()}>
                Reconnect Studio
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      {/* Source panels */}
      {mode === 'obs' && (isReady || isLive) && (
        <ObsSourcePanel sourceConnected={sourceConnected} sourceType={sourceType} />
      )}
      {mode === 'studio' && (isReady || isLive) && (
        <StudioSourcePanel
          onStatusChange={setStudioStatus}
          onConnectRef={studioConnectRef}
          onDisconnectRef={studioDisconnectRef}
          autoTestConnection={isReady}
        />
      )}

      {/* Action button */}
      {isReady && mode === 'obs' && (
        <Button
          color="red"
          size="lg"
          onClick={() => handleAction('golive', () => api.goLive(stream.id))}
          loading={actionLoading === 'golive'}
          disabled={!effectiveSourceConnected}
        >
          {effectiveSourceConnected ? 'Go Live' : 'Waiting for OBS...'}
        </Button>
      )}

      {isReady && mode === 'studio' && (
        <Button
          color="red"
          size="lg"
          onClick={() => {
            if (studioStatus === 'connected') {
              // Already connected, go live directly
              handleAction('golive', () => api.goLive(stream.id));
            } else {
              // Connect first, then go live will auto-trigger via effect
              pendingGoLiveRef.current = true;
              setActionLoading('golive');
              studioConnectRef.current?.();
            }
          }}
          loading={actionLoading === 'golive' || studioStatus === 'connecting'}
          disabled={studioStatus === 'error'}
        >
          Go Live
        </Button>
      )}

      {isLive && (
        <Button
          color="red"
          variant="outline"
          size="lg"
          onClick={() => setConfirmEnd(true)}
          loading={actionLoading === 'end'}
        >
          End Stream
        </Button>
      )}
    </Stack>
  );

  // --- Right column content (ready/live) ---
  const rightColumn = (
    <Stack>
      <PlatformStatusCard
        platforms={stream.platforms}
        streamStatus={stream.status}
        onRetry={(platform) => handleAction(`retry-${platform}`, () => api.setupPlatform(stream.id, platform))}
        retryingPlatform={actionLoading?.startsWith('retry-') && !actionLoading.startsWith('retrylive-') ? actionLoading.replace('retry-', '') : null}
        onReconnect={handleReconnect}
        onRetryLive={(platform) => handleAction(`retrylive-${platform}`, () => api.retryPlatformLive(stream.id, platform))}
        reconnectingPlatform={reconnecting}
        retryingLivePlatform={retryingLivePlatform}
      />
      <EventLogCard events={stream.events} />
      {isLive && <FFmpegLog events={sseEvents} connected={sseConnected} />}
    </Stack>
  );

  return (
    <Stack>
      {header}
      {subtitle}

      {/* Single-column phases */}
      {draftContent}
      {endedContent}

      {/* Two-column phases */}
      {useTwoCol && (
        <Grid>
          <Grid.Col span={{ base: 12, md: 7 }}>{leftColumn}</Grid.Col>
          <Grid.Col span={{ base: 12, md: 5 }}>{rightColumn}</Grid.Col>
        </Grid>
      )}

      {/* Platform + events for single-col phases */}
      {!useTwoCol && (
        <>
          <PlatformStatusCard
            platforms={stream.platforms}
            streamStatus={stream.status}
            onRetry={(platform) => handleAction(`retry-${platform}`, () => api.setupPlatform(stream.id, platform))}
            retryingPlatform={actionLoading?.startsWith('retry-') ? actionLoading.replace('retry-', '') : null}
          />
          <EventLogCard events={stream.events} />
        </>
      )}

      {/* Edit Drawer */}
      <Drawer
        opened={editDrawerOpen}
        onClose={() => setEditDrawerOpen(false)}
        title="Edit Stream"
        position="right"
        size="md"
      >
        <StreamForm
          initialData={{
            name: stream.name,
            description: stream.description,
            thumbnail_path: stream.thumbnail_path,
            scheduled_start: stream.scheduled_start,
          }}
          onSave={handleEditSave}
          onCancel={() => setEditDrawerOpen(false)}
          saveLabel="Save Changes"
        />
      </Drawer>

      {/* End Stream Confirmation */}
      <Modal opened={confirmEnd} onClose={() => setConfirmEnd(false)} title="End Stream">
        <Stack>
          <Text>
            Are you sure you want to end this stream? This stops all platform broadcasts and
            finalizes the recordings.
          </Text>
          <Text fw={600} c="red">
            This cannot be undone — once ended, the broadcast cannot be restarted or resumed. You'd
            need to create and set up a new stream to go live again.
          </Text>
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

      {/* Delete Confirmation */}
      <Modal opened={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Stream">
        <Stack>
          <Text>Are you sure you want to delete this stream? This cannot be undone.</Text>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              color="red"
              loading={actionLoading === 'delete'}
              onClick={() => {
                setConfirmDelete(false);
                handleAction('delete', async () => {
                  await api.deleteStream(stream.id);
                  navigate('/');
                });
              }}
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
