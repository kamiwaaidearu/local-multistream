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
import { api, ApiError, type PlatformIngestHealth } from '../lib/api';
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
  /** 0/1 — a private dry run: YouTube private, Facebook never published, Twitch skipped, no posts. */
  is_test?: number;
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

/**
 * Direct links to what a platform is showing right now, stored at go-live (see storeWatchUrls).
 *
 * `watch` is the destination itself; `control` is YouTube's Live Control Room, which reports YouTube's
 * own bitrate and health verdict. Indispensable on a TEST stream, where YouTube is private and Facebook
 * is unpublished — neither appears anywhere browsable, so the direct permalink is the only way to look.
 */
function getWatchUrls(ps: PlatformStream): { watch: string | null; control: string | null } {
  if (!ps.extra_json) return { watch: null, control: null };
  try {
    const extra = JSON.parse(ps.extra_json);
    return { watch: extra.watch_url ?? null, control: extra.control_url ?? null };
  } catch {
    return { watch: null, control: null };
  }
}

const platformColor = (platform: string) =>
  platform === 'youtube' ? 'red' : platform === 'facebook' ? 'blue' : 'violet';

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
  // Studio go-live waits until the presenter has heard their own mic played back (see AudioTestCard).
  // Gates only the ready-phase Go Live button: nothing here can block a live broadcast or its reconnect.
  const [studioAudioConfirmed, setStudioAudioConfirmed] = useState(false);
  // Likewise both the camera and the slides must be showing a real picture (see videoCheck.ts).
  const [studioVideoReady, setStudioVideoReady] = useState(false);

  // UI state
  const [editDrawerOpen, setEditDrawerOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Per-platform auth health (go-live pre-check + live reconnect) and reconnect-in-progress marker.
  const [authHealth, setAuthHealth] = useState<Record<string, { connected: boolean; ok: boolean; error?: string | null }> | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  // The server's go-live pre-flight rejection; non-null opens the modal. `overridable` false means a
  // definitively dead login — the modal then offers only Reconnect, because force won't get through.
  const [authPreflight, setAuthPreflight] = useState<
    { platforms: string[]; overridable: boolean; message: string } | null
  >(null);

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

  // Poll per-platform INGEST health while live. This is the platform's own answer to "are you actually
  // receiving video", which is a different question from whether our ffmpeg leg is alive — and the one
  // nobody could answer during the 2026-08-05 broadcast. The server polls the platforms every 20s, so
  // 10s here is enough to surface a change promptly without adding load.
  const [health, setHealth] = useState<Record<string, PlatformIngestHealth>>({});
  useEffect(() => {
    if (stream?.status !== 'live' || !stream?.id) {
      setHealth({});
      return;
    }
    const streamId = stream.id;
    const check = () => api.getStreamHealth(streamId).then(setHealth).catch(() => { /* transient */ });
    check();
    const interval = setInterval(check, 10000);
    return () => clearInterval(interval);
  }, [stream?.status, stream?.id]);

  // When studio connects and we have a pending go-live, trigger it
  useEffect(() => {
    if (studioStatus === 'connected' && pendingGoLiveRef.current && stream?.id) {
      pendingGoLiveRef.current = false;
      // Goes through the pre-flight like any other go-live: if a connected platform's login is dead
      // this now opens the confirm modal instead of silently going live without that platform, which
      // is what happened on 2026-08-05 (auto-fired go-live, YouTube quietly never transitioned).
      void handleGoLive();
    }
    if (studioStatus === 'error') {
      pendingGoLiveRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioStatus]);

  // NB: a reopened tab does NOT auto-reconnect. A page reload destroys the camera/slide streams
  // (screen-share can only be re-granted by a fresh user gesture), so auto-connecting would push an
  // empty, content-less frame to viewers before the operator is ready. Instead the "Studio source
  // disconnected" banner prompts them to re-share slides + camera and reconnect deliberately.
  // (The tab-stays-open network-drop case is different — media is still in memory there, so the
  // hook's own persistent reconnect resumes real content automatically; see keepReconnecting.)

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

  /**
   * Go live, honoring the server's auth pre-flight.
   *
   * A 409 with code 'auth_preflight' means one or more connected platforms have a dead login and
   * would silently fail to go live (the 2026-08-05 YouTube case). We surface that as a confirmation
   * instead of a failure, then retry with force — the operator must always be able to get on air on
   * whichever platforms do work.
   */
  async function handleGoLive(force = false) {
    if (!stream) return;
    setActionLoading('golive');
    try {
      await api.goLive(stream.id, force);
      await refreshStream();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'auth_preflight') {
        setAuthPreflight({
          platforms: err.platforms ?? [],
          // Default to NOT overridable: if the server didn't say, the safe reading is "don't offer a
          // bypass we can't actually deliver" — force wouldn't get through server-side either.
          overridable: err.overridable === true,
          message: err.message,
        });
        checkAuthHealth(); // refresh the banner so the reconnect buttons are accurate
      } else {
        notifications.show({ title: 'Error', message: String(err), color: 'red' });
      }
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
        {/* Unmissable: the difference between a rehearsal and a real broadcast to the congregation. */}
        {stream.is_test === 1 && (
          <Tooltip label="Private dry run — YouTube is private, Facebook stays unpublished, Twitch is skipped, and no posts are made.">
            <Badge size="lg" color="grape" variant="filled">TEST</Badge>
          </Tooltip>
        )}
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
        {/* Live destination links. Shown for test and real broadcasts alike — on a test stream these are
            the ONLY way to see the result, since YouTube is private and Facebook is unpublished. */}
        {isLive && stream.platforms.some((ps) => getWatchUrls(ps).watch) && (
          <>
            <Text fw={500} mt="sm">
              Watch it live{stream.is_test === 1 ? ' (visible only to you)' : ''}
            </Text>
            <Group>
              {stream.platforms.map((ps) => {
                const { watch, control } = getWatchUrls(ps);
                if (!watch) return null;
                return (
                  <Group key={ps.id} gap={4}>
                    <Anchor href={watch} target="_blank" rel="noopener">
                      <Badge size="lg" color={platformColor(ps.platform)} style={{ cursor: 'pointer' }}>
                        Open {ps.platform}
                      </Badge>
                    </Anchor>
                    {control && (
                      <Tooltip label="YouTube Live Control Room — shows YouTube's own bitrate and stream-health verdict">
                        <Anchor href={control} target="_blank" rel="noopener">
                          <Badge size="lg" variant="outline" color="red" style={{ cursor: 'pointer' }}>
                            health
                          </Badge>
                        </Anchor>
                      </Tooltip>
                    )}
                  </Group>
                );
              })}
            </Group>
            {stream.is_test === 1 && (
              <Text size="xs" c="dimmed">
                This is a test stream: the YouTube broadcast is private and the Facebook video is never
                published, so neither appears on your channel or Page. These links are the only way in.
              </Text>
            )}
          </>
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
                      color={platformColor(ps.platform)}
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

      {/* Pre-go-live auth warning. This is now a BLOCKING condition, not an advisory one: go-live is
          refused until these are reconnected. The old wording promised they'd merely be "skipped",
          which both undersold the problem and described behaviour that no longer exists. */}
      {isReady && unhealthyPlatforms.length > 0 && (
        <Alert color="red" title="Go live is blocked — reconnect these platforms">
          <Stack gap="xs">
            <Text size="sm">
              These platforms have an expired or revoked login. Going live is prevented until they're
              reconnected, because a platform with a dead login goes live in name only and silently
              broadcasts nothing:
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
              The stream is still live on the platforms. Re-share your slides and turn your
              camera/mic back on below, then click Reconnect to resume — the broadcast waits a few
              minutes for you before it ends on its own.
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
          streamIsLive={isLive}
          onAudioConfirmedChange={setStudioAudioConfirmed}
          onVideoReadyChange={setStudioVideoReady}
        />
      )}

      {/* Action button */}
      {isReady && mode === 'obs' && (
        <Button
          color="red"
          size="lg"
          onClick={() => void handleGoLive()}
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
              void handleGoLive();
            } else {
              // Connect first, then go live will auto-trigger via effect
              pendingGoLiveRef.current = true;
              setActionLoading('golive');
              studioConnectRef.current?.();
            }
          }}
          loading={actionLoading === 'golive' || studioStatus === 'connecting'}
          disabled={studioStatus === 'error' || !studioVideoReady || !studioAudioConfirmed}
        >
          {!studioVideoReady
            ? 'Share slides and turn on camera to go live'
            : !studioAudioConfirmed
              ? 'Test your audio to go live'
              : 'Go Live'}
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
        health={health}
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

      {/* Auth pre-flight. For a definitively dead login this is a WALL, not a warning: go-live is
          prevented and the only way forward is reconnecting, because a platform that "goes live" with
          a revoked token just silently does nothing. "Go Live Anyway" appears only when we merely
          couldn't reach the platform to check — blocking on ignorance would be its own outage. */}
      <Modal
        opened={authPreflight !== null}
        onClose={() => setAuthPreflight(null)}
        title={authPreflight?.overridable ? "Couldn't verify a platform login" : 'Go live blocked — platform login expired'}
      >
        <Stack>
          <Alert color={authPreflight?.overridable ? 'yellow' : 'red'} variant="light">
            {authPreflight?.message}
          </Alert>
          {(authPreflight?.platforms ?? []).map((platform) => (
            <Group key={platform} justify="space-between" wrap="nowrap">
              <Text size="sm" c="dimmed">
                {platform}: {authHealth?.[platform]?.error ?? 'login expired'}
              </Text>
              <Button
                size="xs"
                variant="light"
                loading={reconnecting === platform}
                onClick={() => void handleReconnect(platform)}
              >
                Reconnect
              </Button>
            </Group>
          ))}
          <Text size="sm" c="dimmed">
            Reconnecting opens a popup and won't disturb this tab or the Web Studio source. Once it
            succeeds, press Go Live again.
          </Text>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setAuthPreflight(null)}>Close</Button>
            {authPreflight?.overridable && (
              <Button
                color="red"
                loading={actionLoading === 'golive'}
                onClick={() => {
                  setAuthPreflight(null);
                  void handleGoLive(true);
                }}
              >
                Go Live Anyway
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>

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
